// Trafic des Chasses (demande du 03/10 : « laisser mon navigateur respirer »).
//   node tests/hunt-traffic.test.mjs      (ou ./scripts/test.sh)
//
// A. Voie rapide par enchère : une Chasse L dans ses 30 dernières secondes ne doit plus faire
//    relire toutes les autres enchères suivies (ici 4, à ~4 min de leur fin) au même rythme.
//    Rythme le plus serré : 0,5 s (avant : 0,15 s).
// B. Chasse opti : au plus 6 cotes lues par passage, seulement pour les enchères qui finissent
//    dans les 90 s (avant : 12, sur tout l'horizon de 3 min).
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
const blockOthers = (page) => page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());

async function open(storage) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin);
  await page.evaluate(st => { for (const [k, v] of Object.entries(st)) localStorage.setItem(k, v); },
    { wm_onboarding_done: '1', wm_autobid_armed: '0', wm_watchlist: '[]', wm_global_bid_cap: '5000',
      wm_max_bids_per_hour: '0', wm_legend_hunt_reserve: '0', ...storage });
  await blockOthers(page);
  await page.route('**/api/wikibidous**', r => json(r, { balance: 1000 }));
  return { page, errors };
}

// ── A. Voie rapide
async function scenarioHotLane() {
  const t0 = Date.now();
  const end = { 'l-hot': t0 + 28000, 'm-1': t0 + 240000, 'm-2': t0 + 245000, 'm-3': t0 + 250000, 'm-4': t0 + 255000 };
  const auction = (id) => ({ id, base_amount: 50, current_bid: id === 'l-hot' ? 500 : 60,
    current_bidder: { username: id === 'l-hot' ? 'rival' : 'moi' }, end_at: new Date(end[id]).toISOString(),
    card: { id: 'c-' + id, wikipedia_title: 'Carte ' + id, rarity: id === 'l-hot' ? 'L' : 'R' } });
  // Mises auto en pause : la Chasse lit sans miser (on ne mesure que les lectures).
  const { page, errors } = await open({ wm_legend_hunt: 'true', wm_legend_hunt_max: '10000', wm_legend_hunt_window: '20',
    wm_username_override: 'moi', wm_my_bids: JSON.stringify(['m-1', 'm-2', 'm-3', 'm-4']) });
  const reads = {};   // id → horodatages des lectures
  let measureFrom = 0;
  await page.route('**/api/marketplace**', route => {
    const url = route.request().url();
    if (/\/mine/.test(url)) return json(route, { sellingCount: 0, maxConcurrentAuctions: 5 });
    const one = url.match(/\/marketplace\/(l-hot|m-\d)(\?|$)/);
    if (one) { (reads[one[1]] ||= []).push(Date.now()); return json(route, { auction: auction(one[1]) }); }
    if (/[?&]rarity=L/.test(url)) return json(route, { auctions: [auction('l-hot')], page: 1, limit: 50, hasMore: false });
    return json(route, { auctions: [], page: 1, limit: 50, hasMore: false });
  });
  await page.evaluate(script).catch(e => errors.push(String(e)));
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('wm-market-btn').click());
  // l-hot entre dans la fenêtre rapide (20 + 10 s) dès le départ ; mesure sur 10 s.
  await page.waitForTimeout(6000);
  measureFrom = Date.now();
  await page.waitForTimeout(10000);
  const to = Date.now();
  await page.close();
  const count = (id) => (reads[id] || []).filter(t => t >= measureFrom && t < to).length;
  return { hot: count('l-hot'), far: ['m-1', 'm-2', 'm-3', 'm-4'].map(count), errors };
}

// ── B. Cotes de la Chasse opti
async function scenarioCotes() {
  const t0 = Date.now();
  // 10 UR bradées : 3 finissent dans ~60 s, 7 dans ~150 s (au-delà de 90 s).
  const ids = Array.from({ length: 10 }, (_, i) => 'u-' + i);
  const endOf = (i) => t0 + (i < 3 ? 60000 : 150000) + i * 1000;
  const auction = (id) => { const i = +id.slice(2); return { id, base_amount: 10, current_bid: null, current_bidder: null,
    end_at: new Date(endOf(i)).toISOString(), card: { id: 'c-' + id, wikipedia_title: 'UR ' + i, rarity: 'UR' } }; };
  const { page, errors } = await open({ wm_opti_hunt: 'true', wm_opti_rarities: 'UR', wm_opti_max_bid: '1000' });
  const cotes = [];   // { cardId, t }
  await page.route('**/api/marketplace**', route => {
    const url = route.request().url();
    if (/\/mine/.test(url)) return json(route, { sellingCount: 0, maxConcurrentAuctions: 5 });
    const s = url.match(/cards\/([^/?]+)\/sales/);
    if (s) { cotes.push({ cardId: s[1], t: Date.now() }); return json(route, { summary: { UR: { average: 400 } } }); }
    const one = url.match(/\/marketplace\/(u-\d)(\?|$)/);
    if (one) return json(route, { auction: auction(one[1]) });
    if (/[?&]rarity=UR/.test(url)) return json(route, { auctions: ids.map(auction), page: 1, limit: 50, hasMore: false });
    return json(route, { auctions: [], page: 1, limit: 50, hasMore: false });
  });
  await page.evaluate(script).catch(e => errors.push(String(e)));
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('wm-market-btn').click());
  await page.waitForTimeout(9000);   // un seul passage de découverte (le suivant vient à +15 s)
  await page.close();
  const far = cotes.filter(c => +c.cardId.slice(4) >= 3);
  return { total: cotes.length, far: far.length, errors };
}

const [A, B] = await Promise.all([scenarioHotLane(), scenarioCotes()]);
await browser.close();
srv.close();

const problems = [];
// 10 s à 0,5 s = ~20 lectures (marge pour la latence) ; avant : ~65 (0,15 s).
if (A.hot < 8) problems.push(`A. Chasse dans sa fin : seulement ${A.hot} lecture(s) en 10 s — sa surveillance ne doit pas être ralentie`);
if (A.hot > 25) problems.push(`A. Chasse dans sa fin : ${A.hot} lectures en 10 s (rythme le plus serré attendu : 0,5 s → ~20)`);
// À ~4 min de leur fin : une lecture toutes les 5 s → 2 à 3 en 10 s chacune.
for (const [i, n] of A.far.entries()) if (n > 4) problems.push(`A. enchère m-${i + 1} (fin dans ~4 min) relue ${n} fois en 10 s au rythme de la Chasse (attendu : ~2, une toutes les 5 s)`);
if (B.total > 6) problems.push(`B. ${B.total} cotes lues en un passage (attendu : 6 au plus)`);
if (B.far) problems.push(`B. ${B.far} cote(s) lue(s) pour des enchères qui finissent dans plus de 90 s`);
if (B.total < 3) problems.push(`B. seulement ${B.total} cote(s) lue(s) : les 3 enchères proches de leur fin n'ont pas été évaluées`);
for (const [k, r] of [['A', A], ['B', B]]) for (const e of r.errors) problems.push(`${k}. erreur page : ${e}`);

if (problems.length) {
  console.error('❌ trafic des Chasses :');
  for (const p of problems) console.error('  · ' + p);
  console.error(`  — lectures en 10 s : Chasse ${A.hot}, autres ${A.far.join('/')} · cotes ${B.total} (dont ${B.far} > 90 s)`);
  process.exit(1);
}
console.log(`✅ voie rapide par enchère : Chasse en fin ${A.hot} lectures/10 s, enchères lointaines ${A.far.join('/')} · cotes ${B.total} (aucune > 90 s)`);
