// Chasse opti : miser en fin d'enchère sur les cartes bien sous leur cote du marché.
//   node tests/opti-hunt.test.mjs      (ou ./scripts/test.sh)
//
// Demande du 30/09 : « le but est de faire de l'argent » — scruter les enchères qui finissent
// bientôt et miser si la cote est bien au-dessus du prix. Choix de l'utilisateur : raretés
// cochées (L, UR, SR par défaut), mise ≤ 60 % de la cote, gain ≥ 20 💰, mise max 200 💰.
// Plafond par enchère = min(cote × 60 %, cote − 20, 200). Vérifie : mise et riposte sous ce
// plafond, arrêt au-dessus, gain trop faible ignoré, mise max respectée, rareté décochée
// ignorée même si le site la renvoie, et jamais sur ses propres ventes.
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


const END = Date.now() + 30000;
// id → { rar, cote, cur, seller }
const A = {
  'o-good': { rar: 'UR', cote: 400, cur: 100, bidder: 'rival' },          // plafond 200 : 110, riposte 165, stop à 209
  'o-sr':   { rar: 'SR', cote: 100, cur: 20,  bidder: 'rival' },          // plafond 60 : 22
  'o-thin': { rar: 'SR', cote: 30,  cur: 10,  bidder: 'rival' },          // plafond 10 (gain 20) : 11 refusé
  'o-dear': { rar: 'L',  cote: 1000, cur: 700, bidder: 'rival' },         // 770 > mise max 200
  'o-own':  { rar: 'UR', cote: 400, cur: null, bidder: null, seller: 'moi' }, // ma propre vente
  'o-r':    { rar: 'R',  cote: 400, cur: 50,  bidder: 'rival' },          // R décochée (renvoyée quand même)
};
const toAuction = (id) => {
  const s = A[id];
  return { id, base_amount: 50, current_bid: s.cur, current_bidder: s.bidder ? { username: s.bidder } : null,
    seller: { username: s.seller || 'vendeur' }, end_at: new Date(END).toISOString(),
    card: { id: 'c-' + id, wikipedia_title: 'Carte ' + id, rarity: s.rar } };
};

const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const bids = [];
await page.goto(origin);
await page.evaluate(() => {
  localStorage.setItem('wm_onboarding_done', '1');
  localStorage.setItem('wm_autobid_armed', '1');
  localStorage.setItem('wm_opti_hunt', 'true');
  localStorage.setItem('wm_legend_hunt_window', '20');
  localStorage.setItem('wm_global_bid_cap', '5000');
  localStorage.setItem('wm_max_bids_per_hour', '0');
  localStorage.setItem('wm_humanized_bid_delay_ms', '0');
  localStorage.setItem('wm_username_override', 'moi');
  localStorage.setItem('wm_watchlist', JSON.stringify([{ kw: 'rien', mode: 'manuel' }]));
});
await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"balance":1000}' }));
await page.route('**/api/marketplace**', route => {
  const url = route.request().url();
  const sales = url.match(/cards\/c-(o-[a-z]+)\/sales/);
  if (sales) {
    const s = A[sales[1]];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ summary: { [s.rar]: { average: s.cote } } }) });
  }
  const m = url.match(/\/marketplace\/(o-[a-z]+)(\/bid)?(\?|$)/);
  if (m && m[2] && route.request().method() === 'POST') {
    let amount = null;
    try { amount = JSON.parse(route.request().postData() || '{}').amount; } catch {}
    bids.push({ id: m[1], amount });
    const s = A[m[1]];
    s.cur = amount; s.bidder = 'moi';
    if (m[1] === 'o-good') {
      const n = bids.filter(b => b.id === 'o-good').length;
      setTimeout(() => { s.cur = n === 1 ? 150 : 190; s.bidder = 'rival'; }, 1200);
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  }
  if (m) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ auction: toAuction(m[1]) }) });
  if (/\/mine/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"won":[],"auctions":[]}' });
  const r = url.match(/[?&]rarity=([A-Z]+)/);
  if (r) {
    // Le site renvoie la rareté demandée… et, pour UR, glisse aussi la R (filtre à refaire).
    const ids = Object.keys(A).filter(id => A[id].rar === r[1] || (r[1] === 'UR' && id === 'o-r'));
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ auctions: ids.map(toAuction), page: 1, limit: 50, hasMore: false }) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ auctions: [], page: 1, limit: 50, hasMore: false }) });
});

await page.evaluate(script).catch(e => errors.push(String(e)));
await page.waitForTimeout(600);
await page.evaluate(() => document.getElementById('wm-market-btn').click());
await page.waitForTimeout(29000);
const log = await page.evaluate(() => [...document.querySelectorAll('.wm-log-e')].map(e => e.innerText).join('\n'));
await browser.close();
srv.close();

const problems = [];
const of = (id) => bids.filter(b => b.id === id).map(b => b.amount);
if (of('o-good').join(',') !== '110,165') problems.push(`UR cote 400 : mises ${of('o-good').join(', ') || 'aucune'} au lieu de 110 puis 165 (et arrêt : 209 > plafond 200)`);
if (of('o-sr').join(',') !== '22') problems.push(`SR cote 100 : mises ${of('o-sr').join(', ') || 'aucune'} au lieu de 22`);
if (of('o-thin').length) problems.push('gain < 20 💰 : mise quand même');
if (of('o-dear').length) problems.push('au-delà de la mise max 200 : mise quand même');
if (of('o-own').length) problems.push('mise sur ma propre vente');
if (of('o-r').length) problems.push('rareté R décochée : mise quand même');
if (bids.some(b => b.amount > 200)) problems.push('une mise dépasse la mise max');
if (!/Opportunité/.test(log)) problems.push("les opportunités ne sont pas journalisées");
for (const e of errors) problems.push('erreur page : ' + e);

if (problems.length) {
  console.error('❌ Chasse opti :');
  for (const p of problems) console.error('  · ' + p);
  console.error('  — mises : ' + JSON.stringify(bids));
  console.error('  — log :\n' + log.split('\n').filter(l => /🎯|⚠|💸/.test(l)).slice(0, 12).map(l => '      ' + l).join('\n'));
  process.exit(1);
}
console.log('✅ UR cote 400 : 110 → 165 puis arrêt (plafond 200) · SR cote 100 : 22 · gain < 20, > mise max, ma vente, R décochée : ignorées');
