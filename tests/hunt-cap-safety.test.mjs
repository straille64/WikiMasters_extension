// Une Chasse qui abandonne une enchère ne doit pas emporter le plafond posé par quelqu'un d'autre.
//   node tests/hunt-cap-safety.test.mjs      (ou ./scripts/test.sh)
//
// Relecture du 01/10 (fork.38) : quand la mise suivante dépasse son plafond, la Chasse lâche
// l'enchère et retire le plafond qu'elle avait posé. Mais entre-temps un AUTRE plafond a pu le
// remplacer (Chasseur ciblé, Hunter, plafond tapé à la main). Le supprimer libérait l'auto-bid
// jusqu'au seul plafond global : riposte à 275 au lieu de s'arrêter à 200.
// Scénario : Chasse L (max 10) repère z1 → l'utilisateur arme l'auto-bid avec un plafond de 200
// → la Chasse mise 6 → un rival passe à 250 → la Chasse abandonne (275 > 10) → l'auto-bid ne
// doit PAS riposter à 275 (son plafond de 200 doit tenir).
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


const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const bids = [];
const END = Date.now() + 30000;
const st = { cur: 5, bidder: 'rival' };
const auction = () => ({ id: 'z1', base_amount: 5, current_bid: st.cur, current_bidder: { username: st.bidder },
  end_at: new Date(END).toISOString(), card: { id: 'c-z1', wikipedia_title: 'Légendaire disputée', rarity: 'L' } });
await page.goto(origin);
await page.evaluate(() => {
  localStorage.setItem('wm_onboarding_done', '1');
  localStorage.setItem('wm_autobid_armed', '1');
  localStorage.setItem('wm_legend_hunt', 'true');
  localStorage.setItem('wm_legend_hunt_max', '10');
  localStorage.setItem('wm_legend_hunt_window', '20');
  localStorage.setItem('wm_legend_hunt_reserve', '0');
  localStorage.setItem('wm_global_bid_cap', '5000');
  localStorage.setItem('wm_max_bids_per_hour', '0');
  localStorage.setItem('wm_humanized_bid_delay_ms', '0');
  localStorage.setItem('wm_username_override', 'moi');
  localStorage.setItem('wm_watchlist', JSON.stringify([{ kw: 'rien', mode: 'manuel' }]));
});
await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"balance":5000}' }));
await page.route('**/api/marketplace**', route => {
  const url = route.request().url();
  if (/\/z1\/bid/.test(url) && route.request().method() === 'POST') {
    let amount = null;
    try { amount = JSON.parse(route.request().postData() || '{}').amount; } catch {}
    bids.push(amount);
    st.cur = amount; st.bidder = 'moi';
    // Le rival passe largement devant juste après la mise de la Chasse.
    if (bids.length === 1) setTimeout(() => { st.cur = 250; st.bidder = 'rival'; }, 1500);
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  }
  if (/\/z1(\?|$)/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ auction: auction() }) });
  if (/\/mine/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"sellingCount":0,"maxConcurrentAuctions":5}' });
  if (/[?&]rarity=L/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ auctions: [auction()], page: 1, limit: 50, hasMore: false }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ auctions: [], page: 1, limit: 50, hasMore: false }) });
});
await page.evaluate(script).catch(e => errors.push(String(e)));
await page.waitForTimeout(600);
await page.evaluate(() => document.getElementById('wm-market-btn').click());
// La Chasse repère z1 (≈ 2 s) ; l'utilisateur arme alors l'auto-bid avec SON plafond de 200.
await page.waitForTimeout(4500);
const armed = await page.evaluate(() => {
  const hadHuntCap = window.autoBidMaxMap.get('z1');
  window.wmSetAutoBidMax('z1', 200);
  window.autoBidSet.add('z1');
  return hadHuntCap;
});
await page.waitForTimeout(16000);
const capAfter = await page.evaluate(() => window.autoBidMaxMap.get('z1') ?? null);
await browser.close();
srv.close();

const problems = [];
if (armed !== 10) problems.push(`la Chasse n'avait pas posé son plafond de 10 (lu : ${armed})`);
if (bids[0] !== 6) problems.push(`1re mise de la Chasse : ${bids[0]} au lieu de 6`);
if (bids.some(b => b > 200)) problems.push(`riposte au-delà du plafond de 200 de l'utilisateur : ${bids.join(', ')}`);
if (capAfter !== 200) problems.push(`plafond de l'utilisateur supprimé ou modifié par la Chasse : ${capAfter}`);
for (const e of errors) problems.push('erreur page : ' + e);
if (problems.length) {
  console.error('❌ plafond partagé Chasse / auto-bid :');
  for (const p of problems) console.error('  · ' + p);
  console.error('  — mises : ' + JSON.stringify(bids));
  process.exit(1);
}
console.log(`✅ Chasse : 6 puis abandon (275 > 10) · plafond de 200 posé ailleurs conservé · aucune riposte au-delà (mises : ${bids.join(', ')})`);
