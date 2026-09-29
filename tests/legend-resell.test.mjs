// Revente Légendaire : les L gagnées sont remises en vente à la moyenne L, jamais sous
// payé + marge.
//   node tests/legend-resell.test.mjs      (ou ./scripts/test.sh)
//
// Demande du 29/09, choix de l'utilisateur : seulement les L gagnées APRÈS l'activation
// (bouton « 👑 Chasse + Revente »), prix = moyenne réelle du marché en L, plancher = prix
// payé + 50 %, pas de moyenne → pas de vente, invendue → remise au même calcul (et surtout
// pas de tag Trash), priorité sur le Trash Seller.
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

// Victoires en base. `recent` : gagnée après le clic (date future à la lecture).
const WON = [
  { id: 'w-old', card: 'c-old', title: 'Vieille L',        rar: 'L',  paid: 5,   recent: false },
  { id: 'w-a',   card: 'c-a',   title: 'L bien cotée',     rar: 'L',  paid: 10,  recent: true },
  { id: 'w-b',   card: 'c-b',   title: 'L payée cher',     rar: 'L',  paid: 300, recent: true },
  { id: 'w-c',   card: 'c-c',   title: 'L jamais vendue',  rar: 'L',  paid: 10,  recent: true },
  { id: 'w-e',   card: 'c-e',   title: 'L cotée en SR',    rar: 'L',  paid: 10,  recent: true },
  { id: 'w-d',   card: 'c-d',   title: 'SR gagnée',        rar: 'SR', paid: 5,   recent: true },
];
const COTE = {
  'c-a': '{"summary":{"L":{"average":400}}}',
  'c-b': '{"summary":{"L":{"average":250}}}',
  'c-c': '{"summary":{}}',
  'c-e': '{"summary":{"SR":{"average":100}}}',
  'c-old': '{"summary":{"L":{"average":999}}}',
  'c-d': '{"summary":{"SR":{"average":999}}}',
};

const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const posts = [];        // { cardId, price, t }
const tagWrites = [];    // écritures de tags (re-tag Trash interdit ici)
const endedListings = new Set();

await page.goto(origin + '/collection');
await page.evaluate(() => {
  localStorage.setItem('wm_onboarding_done', '1');
  localStorage.setItem('wm_autobid_armed', '0');
  localStorage.setItem('wm_watchlist', '[]');
  localStorage.setItem('wm_max_active_sales', '5');
  const payload = btoa(JSON.stringify({ sub: 'user-test-1', exp: 4102444800 }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem('sb-cyrxjeppjqsxxjayfrur-auth-token',
    JSON.stringify({ access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.sig` }));
});

await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"balance":1000}' }));
await page.route('**/api/my-collection**', r => r.fulfill({ status: 200, contentType: 'application/json',
  body: '{"total":0,"collection":[]}' }));
await page.route('**/rest/v1/**', route => {
  if (route.request().method() !== 'GET') tagWrites.push(route.request().url());
  return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
});
await page.route('**/rest/v1/auctions**', route => {
  const url = decodeURIComponent(route.request().url());
  if (/winner_id=eq\./.test(url)) {
    const now = Date.now();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(WON.map(w => ({
      id: w.id, card_id: w.card, snapshot_rarity: w.rar, final_price: w.paid, current_bid: w.paid,
      winner_id: 'user-test-1', status: 'settled',
      settled_at: new Date(w.recent ? now + 60000 : now - 86400000).toISOString(),
      end_at: new Date(w.recent ? now + 60000 : now - 86400000).toISOString(),
      cards: { id: w.card, wikipedia_title: w.title, rarity: w.rar },
    }))) });
  }
  // Suivi des ventes par id : la 1re vente de « L bien cotée » se termine SANS acheteur.
  const m = url.match(/id=in\.\(([^)]*)\)/);
  if (m) {
    const rows = m[1].split(',').filter(id => endedListings.has(id)).map(id => ({
      id, status: 'ended', winner_id: null, final_price: null,
      end_at: new Date(Date.now() - 1000).toISOString(), settled_at: new Date().toISOString(),
    }));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
});
await page.route('**/api/marketplace**', route => {
  const url = route.request().url();
  if (route.request().method() === 'POST' && /\/api\/marketplace(\?|$)/.test(url)) {
    let b = {};
    try { b = JSON.parse(route.request().postData() || '{}'); } catch {}
    const n = posts.filter(p => p.cardId === b.card_id).length;
    posts.push({ cardId: b.card_id, price: b.base_amount });
    const id = `lst-${b.card_id}-${n}`;
    if (b.card_id === 'c-a' && n === 0) endedListings.add(id);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ auction_id: id }) });
  }
  if (/\/mine/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"sellingCount":0,"maxConcurrentAuctions":5}' });
  const s = url.match(/cards\/([^/?]+)\/sales/);
  if (s) return route.fulfill({ status: 200, contentType: 'application/json', body: COTE[s[1]] || '{"summary":{}}' });
  return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ auctions: [], page: 1, limit: 50, hasMore: false }) });
});

await page.evaluate(script).catch(e => errors.push(String(e)));
await page.waitForTimeout(800);
// Rien ne doit partir avant le clic.
const before = posts.length;
await page.evaluate(() => document.getElementById('wm-legend-resell-btn').click());
await page.waitForTimeout(24000);

const mid = await page.evaluate(() => ({
  hunt: localStorage.getItem('wm_legend_hunt'),
  resell: localStorage.getItem('wm_legend_resell_on'),
  list: (document.getElementById('wm-lresell-list') || {}).textContent || '',
  log: [...document.querySelectorAll('.wm-log-e')].map(e => e.innerText).join('\n'),
}));
// Bouton « Chasse » seul : la revente s'arrête, la chasse reste.
await page.evaluate(() => document.getElementById('wm-legend-hunt-btn').click());
await page.waitForTimeout(300);
const after = await page.evaluate(() => ({
  hunt: localStorage.getItem('wm_legend_hunt'),
  resell: localStorage.getItem('wm_legend_resell_on'),
}));
await browser.close();
srv.close();

const problems = [];
const of = (id) => posts.filter(p => p.cardId === id);
if (before) problems.push(`${before} mise(s) en vente AVANT le clic`);
if (!of('c-a').length) problems.push('« L bien cotée » jamais mise en vente');
else if (of('c-a')[0].price !== 400) problems.push(`« L bien cotée » à ${of('c-a')[0].price} au lieu de 400 (moyenne L)`);
if (!of('c-b').length) problems.push('« L payée cher » jamais mise en vente');
else if (of('c-b')[0].price !== 450) problems.push(`« L payée cher » à ${of('c-b')[0].price} au lieu de 450 (payée 300 + 50 %)`);
if (of('c-c').length) problems.push('« L jamais vendue » mise en vente sans moyenne');
if (of('c-e').length) problems.push('« L cotée en SR » vendue sur une cote SR');
if (of('c-old').length) problems.push("L gagnée AVANT l'activation remise en vente");
if (of('c-d').length) problems.push('SR gagnée remise en vente');
if (of('c-a').length < 2) problems.push(`invendue non remise en vente (${of('c-a').length} mise(s) en vente de « L bien cotée »)`);
else if (of('c-a')[1].price !== 400) problems.push(`remise en vente à ${of('c-a')[1].price} au lieu de 400`);
if (tagWrites.length) problems.push(`écriture de tag pendant la revente (re-tag Trash ?) : ${tagWrites.join(', ')}`);
if (mid.hunt !== 'true' || mid.resell !== 'true') problems.push(`« Chasse + Revente » n'active pas les deux (chasse ${mid.hunt}, revente ${mid.resell})`);
if (after.hunt !== 'true' || after.resell !== 'false') problems.push(`« Chasse » seule : chasse ${after.hunt}, revente ${after.resell}`);
if (!/pas de cote/.test(mid.list)) problems.push("la liste n'affiche pas les L sans cote");
if (!/aucune vente connue en L/.test(mid.log)) problems.push("l'absence de cote n'est pas expliquée dans le journal");
for (const e of errors) problems.push('erreur page : ' + e);

if (problems.length) {
  console.error('❌ Revente Légendaire :');
  for (const p of problems) console.error('  · ' + p);
  console.error('  — ventes : ' + JSON.stringify(posts));
  console.error('  — log :\n' + mid.log.split('\n').filter(l => /👑|❌|⚠/.test(l)).slice(0, 15).map(l => '      ' + l).join('\n'));
  process.exit(1);
}
console.log(`✅ moyenne L (400) · plancher payé +50 % (300 → 450) · sans cote / cote SR / ancienne / SR ignorées · invendue remise à 400 sans tag Trash · boutons exclusifs`);
