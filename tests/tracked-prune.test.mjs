// Enchères suivies terminées depuis longtemps : purgées, et plus relues (capture du 03/10).
//   node tests/tracked-prune.test.mjs      (ou ./scripts/test.sh)
//
// Capture F12 du 03/10 : avec un mot-clé actif, 27 enchères où j'avais misé, finies depuis
// des heures, étaient relues en boucle (119 lectures en 29 s). Causes : l'API renvoie une
// enchère finie par son id → elle comptait comme « présente » et n'était jamais purgée ; un
// mot-clé refusé par le site sautait toute purge ; la voie rapide relisait toutes les 2 s
// une enchère finie, sans limite.
// Scénarios (en parallèle) : A. mot-clé qui répond ; B. mot-clé refusé (403) à chaque scan.
// Chaque fois : 3 enchères finies il y a 2 h + 1 vivante, toutes dans mes mises.
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

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function run(refuseSearch) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const now = Date.now();
  const OLD = ['o-1', 'o-2', 'o-3'];
  const auction = (id) => ({ id, base_amount: 50, current_bid: 80,
    current_bidder: { username: id === 'o-2' ? 'rival' : 'moi' },
    end_at: new Date(id === 'live' ? now + 600000 : now - 2 * 3600000).toISOString(),
    card: { id: 'c-' + id, wikipedia_title: 'Carte ' + id, rarity: 'R' } });
  await page.goto(origin);
  await page.evaluate(() => {
    for (const [k, v] of Object.entries({
      wm_onboarding_done: '1', wm_autobid_armed: '0', wm_username_override: 'moi',
      wm_watchlist: JSON.stringify([{ kw: 'rien', mode: 'manuel' }]),
      wm_my_bids: JSON.stringify(['o-1', 'o-2', 'o-3', 'live']),
    })) localStorage.setItem(k, v);
  });
  await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
  await page.route('**/api/wikibidous**', r => json(r, { balance: 1000 }));
  const reads = {};
  await page.route('**/api/marketplace**', route => {
    const url = route.request().url();
    if (/\/mine/.test(url)) return json(route, { sellingCount: 0, maxConcurrentAuctions: 5 });
    const one = url.match(/\/marketplace\/(o-\d|live)(\?|$)/);
    if (one) { (reads[one[1]] ||= []).push(Date.now()); return json(route, { auction: auction(one[1]) }); }
    if (/[?&]q=/.test(url)) {
      if (refuseSearch) return json(route, { error: 'refusé' }, 403);
      return json(route, { auctions: [], page: 1, limit: 50, hasMore: false });
    }
    return json(route, { auctions: [], page: 1, limit: 50, hasMore: false });
  });
  await page.evaluate(script).catch(e => errors.push(String(e)));
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('wm-market-btn').click());
  await page.waitForTimeout(12000);
  const mid = Date.now();
  await page.waitForTimeout(20000);
  const st = await page.evaluate(() => ({
    bids: JSON.parse(localStorage.getItem('wm_my_bids') || '[]'),
    log: [...document.querySelectorAll('.wm-log-e')].map(e => e.innerText).join('\n'),
  }));
  await page.close();
  const lateOld = OLD.reduce((n, id) => n + (reads[id] || []).filter(t => t > mid).length, 0);
  return { ...st, lateOld, errors };
}

const [A, B] = await Promise.all([run(false), run(true)]);
await browser.close();
srv.close();

const problems = [];
for (const [k, r] of [['A (mot-clé OK)', A], ['B (mot-clé refusé)', B]]) {
  const kept = r.bids.filter(id => id.startsWith('o-'));
  if (kept.length) problems.push(`${k} : enchères finies depuis 2 h toujours suivies : ${kept.join(', ')}`);
  if (!r.bids.includes('live')) problems.push(`${k} : enchère vivante purgée à tort`);
  if (r.lateOld) problems.push(`${k} : ${r.lateOld} relecture(s) d'enchères finies après la purge`);
  if (!/Enchère perdue[^\n]*Carte o-2[^\n]*rival/.test(r.log)) problems.push(`${k} : pas de journal « Enchère perdue … rival » pour o-2`);
  for (const e of r.errors) problems.push(`${k} : erreur page : ${e}`);
}

if (problems.length) {
  console.error('❌ purge des enchères finies :');
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}
console.log('✅ enchères finies depuis 2 h purgées (mot-clé OK et mot-clé refusé), journal « perdue » avec le gagnant, plus aucune relecture ensuite · enchère vivante conservée');
