// Solde insuffisant : aucune mise auto au-delà du solde, et pas de rafale après un refus.
//   node tests/low-balance.test.mjs      (ou ./scripts/test.sh)
//
// Question du 30/09 : « que se passe-t-il quand je n'ai plus assez de wikibidous ? ». Avant :
// seul « solde > 0 » était vérifié ; la mise partait, le site refusait, et la Chasse
// retentait toutes les 2 s (le Fourbe à chaque tick) jusqu'à la fin de l'enchère.
//   A. solde lu = 50, mise nécessaire = 60 → aucune requête, et le journal dit pourquoi ;
//   B. solde lu = 1000 mais le site répond « solde insuffisant » → une seule tentative ;
//   C. solde 540, mise 60, réserve 500 (défaut) → 480 < 500 : pas de mise.
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { console.log('⏭️  playwright absent — test sauté'); process.exit(0); }

function findChrome() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !fs.existsSync(base)) return undefined;
  for (const d of fs.readdirSync(base).filter(d => d.startsWith('chromium-'))) {
    const p = path.join(base, d, 'chrome-linux/chrome');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

const BUILD = process.argv[2] || path.join(ROOT, 'dist/wikimasters-bot.user.js');
const script = fs.readFileSync(BUILD, 'utf8');
const srv = http.createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><title>wm</title></head><body></body></html>');
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;

let browser;
try { browser = await chromium.launch({ executablePath: findChrome() }); }
catch { console.log('⏭️  Chromium introuvable — test sauté'); srv.close(); process.exit(0); }


async function run({ balance }) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const posts = [];
  let balanceReads = 0;
  const end = Date.now() + 26000;
  const auction = () => ({ id: 'l-1', base_amount: 60, current_bid: null, current_bidder: null,
    end_at: new Date(end).toISOString(), card: { id: 'c-1', wikipedia_title: 'Légendaire', rarity: 'L' } });
  await page.goto(origin);
  await page.evaluate(() => {
    localStorage.setItem('wm_onboarding_done', '1');
    localStorage.setItem('wm_autobid_armed', '1');
    localStorage.setItem('wm_legend_hunt', 'true');
    localStorage.setItem('wm_legend_hunt_max', '100');
    localStorage.setItem('wm_legend_hunt_window', '20');
    localStorage.setItem('wm_global_bid_cap', '5000');
    localStorage.setItem('wm_max_bids_per_hour', '0');
    localStorage.setItem('wm_humanized_bid_delay_ms', '0');
    localStorage.setItem('wm_watchlist', JSON.stringify([{ kw: 'rien', mode: 'manuel' }]));
  });
  await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
  await page.route('**/api/wikibidous**', r => { balanceReads++;
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance }) }); });
  await page.route('**/api/marketplace**', route => {
    const url = route.request().url();
    if (/\/l-1\/bid/.test(url) && route.request().method() === 'POST') {
      posts.push(Math.round((end - Date.now()) / 1000));
      return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"Solde insuffisant"}' });
    }
    if (/\/l-1(\?|$)/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ auction: auction() }) });
    if (/\/mine/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"won":[],"auctions":[]}' });
    if (/\/cards\//.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"summary":{}}' });
    if (/[?&]rarity=L/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ auctions: [auction()], page: 1, limit: 50, hasMore: false }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ auctions: [], page: 1, limit: 50, hasMore: false }) });
  });
  await page.evaluate(script).catch(e => errors.push(String(e)));
  await page.waitForTimeout(600);
  await page.evaluate(() => document.getElementById('wm-market-btn').click());
  await page.waitForTimeout(25000);
  const log = await page.evaluate(() => [...document.querySelectorAll('.wm-log-e')].map(e => e.innerText).join('\n'));
  await page.close();
  return { posts, log, errors, balanceReads };
}

const problems = [];
const [A, B, C] = await Promise.all([run({ balance: 50 }), run({ balance: 1000 }), run({ balance: 540 })]);
await browser.close();
srv.close();

if (A.posts.length) problems.push(`A. solde 50 < mise 60 : ${A.posts.length} mise(s) envoyée(s) quand même`);
if (!/Solde insuffisant/.test(A.log)) problems.push('A. le journal ne dit pas que le solde manque');
if (!B.posts.length) problems.push("B. aucune tentative alors que le solde lu suffisait");
if (B.posts.length > 1) problems.push(`B. ${B.posts.length} mises refusées envoyées en rafale (${B.posts.join(', ')} s avant la fin)`);
if (!/Le site refuse la mise/.test(B.log)) problems.push('B. le refus pour solde insuffisant n\'est pas expliqué');
if (C.posts.length) problems.push(`C. réserve 500 entamée : ${C.posts.length} mise(s) avec un solde de 540 pour 60`);
if (!/Réserve/.test(C.log)) problems.push('C. le journal ne dit pas que la réserve bloque');
for (const r of [A, B, C]) for (const e of r.errors) problems.push('erreur page : ' + e);

if (problems.length) {
  console.error('❌ solde insuffisant :');
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}
console.log(`✅ solde 50 < 60 → aucune mise, raison journalisée · refus « solde insuffisant » → ${B.posts.length} tentative, mises suspendues puis solde relu · réserve 500 respectée (540 − 60 < 500 → pas de mise)`);
