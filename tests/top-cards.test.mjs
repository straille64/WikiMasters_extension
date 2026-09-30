// Cartes les plus chères : ma collection classée par cote du marché.
//   node tests/top-cards.test.mjs      (ou ./scripts/test.sh)
//
// Demande du 30/09 : un bouton qui charge la cote de toutes mes cartes et les liste de la plus
// chère à la moins chère. Choix : ma collection, top 50 + valeur totale, filtre par rareté,
// cartes sans cote comptées à part. Vérifie : les 2 pages de la collection sont lues, la cote
// est celle de la RARETÉ de l'exemplaire (même carte en SR et en C → deux cotes), les
// exemplaires multiples comptent dans la valeur, une cote refusée une fois est redemandée, et
// les cartes jamais vendues sont comptées à part.
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


const FILL = Array.from({ length: 46 }, (_, i) => ({ id: 'c-f' + (i + 1), title: 'Commune ' + (i + 1), rar: 'C', cote: i + 1 }));
const PAGE0 = [
  ...FILL.map(f => ({ card_id: f.id, card: { id: f.id, wikipedia_title: f.title, rarity: 'C' } })),
  { card_id: 'c-L1', card: { id: 'c-L1', wikipedia_title: 'Joyau', rarity: 'L' } },
  { card_id: 'c-UR1', card: { id: 'c-UR1', wikipedia_title: 'Rare UR', rarity: 'UR' } },
  { card_id: 'c-UR1', card: { id: 'c-UR1', wikipedia_title: 'Rare UR', rarity: 'UR' } },
  { card_id: 'c-mix', card: { id: 'c-mix', wikipedia_title: 'Double rareté', rarity: 'SR' } },
];
const PAGE1 = [
  { card_id: 'c-none', card: { id: 'c-none', wikipedia_title: 'Jamais vendue', rarity: 'R' } },
  { card_id: 'c-none', card: { id: 'c-none', wikipedia_title: 'Jamais vendue', rarity: 'R' } },
  { card_id: 'c-none', card: { id: 'c-none', wikipedia_title: 'Jamais vendue', rarity: 'R' } },
  { card_id: 'c-403', card: { id: 'c-403', wikipedia_title: 'Refusée une fois', rarity: 'R' } },
  { card_id: 'c-mix', card: { id: 'c-mix', wikipedia_title: 'Double rareté', rarity: 'C' } },
];
const COTE = {
  'c-L1': { L: 900 }, 'c-UR1': { UR: 300 }, 'c-mix': { SR: 50, C: 5 }, 'c-none': {}, 'c-403': { R: 40 },
};
FILL.forEach(f => { COTE[f.id] = { C: f.cote }; });
const EXPECTED_TOTAL = 900 + 2 * 300 + 50 + 5 + 40 + FILL.reduce((s, f) => s + f.cote, 0);

const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const pagesRead = new Set();
let refused = 0;
await page.goto(origin + '/collection');
await page.evaluate(() => {
  localStorage.setItem('wm_onboarding_done', '1');
  localStorage.setItem('wm_autobid_armed', '0');
  localStorage.setItem('wm_watchlist', '[]');
});
await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"balance":1000}' }));
await page.route('**/api/my-collection**', route => {
  const p = parseInt(new URL(route.request().url()).searchParams.get('page') || '0', 10);
  pagesRead.add(p);
  const items = p === 0 ? PAGE0 : p === 1 ? PAGE1 : [];
  return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ total: PAGE0.length + PAGE1.length, collection: items }) });
});
await page.route('**/api/marketplace**', route => {
  const url = route.request().url();
  const m = url.match(/cards\/([^/?]+)\/sales/);
  if (m) {
    if (m[1] === 'c-403' && refused === 0) { refused++; return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"ko"}' }); }
    const summary = {};
    for (const [r, v] of Object.entries(COTE[m[1]] || {})) summary[r] = { average: v };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ summary }) });
  }
  if (/\/mine/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"sellingCount":0,"maxConcurrentAuctions":5}' });
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ auctions: [], page: 1, limit: 50, hasMore: false }) });
});

await page.evaluate(script).catch(e => errors.push(String(e)));
await page.waitForTimeout(600);
await page.evaluate(() => { document.getElementById('wm-top-hdr').click(); document.getElementById('wm-top-run').click(); });
let done = false;
for (let i = 0; i < 60 && !done; i++) {
  await page.waitForTimeout(500);
  done = await page.evaluate(() => /Terminé|Erreur|Arrêté/.test((document.getElementById('wm-top-status') || {}).innerText || ''));
}
const res = await page.evaluate(() => {
  const r = window.wmTopCards();
  return r && { rated: r.rated.map(x => [x.title, x.rarity, x.cote, x.count]), noCote: r.noCote, unreadable: r.unreadable,
    total: r.rated.reduce((s, x) => s + x.value, 0), status: document.getElementById('wm-top-status').innerText,
    text: document.getElementById('wm-top-result').innerText };
});
await page.evaluate(() => document.querySelector('[data-wm-top-rar="L"]').click());
const onlyL = await page.evaluate(() => document.getElementById('wm-top-result').innerText);
await browser.close();
srv.close();

const problems = [];
if (!res) problems.push('aucun résultat');
else {
  if (!pagesRead.has(1)) problems.push('2e page de la collection jamais lue');
  const top3 = res.rated.slice(0, 3).map(r => r[0] + ' ' + r[2]).join(' > ');
  if (top3 !== 'Joyau 900 > Rare UR 300 > Double rareté 50') problems.push(`classement inattendu : ${top3}`);
  const mixC = res.rated.find(r => r[0] === 'Double rareté' && r[1] === 'C');
  if (!mixC || mixC[2] !== 5) problems.push(`même carte en C : cote ${mixC ? mixC[2] : 'absente'} au lieu de 5 (cote de SA rareté)`);
  const ur = res.rated.find(r => r[0] === 'Rare UR');
  if (!ur || ur[3] !== 2) problems.push('les 2 exemplaires de « Rare UR » ne sont pas comptés');
  if (!res.rated.some(r => r[0] === 'Refusée une fois' && r[2] === 40)) problems.push('cote refusée une fois jamais redemandée');
  if (res.noCote !== 3) problems.push(`${res.noCote} carte(s) sans cote au lieu de 3`);
  if (res.total !== EXPECTED_TOTAL) problems.push(`valeur totale ${res.total} au lieu de ${EXPECTED_TOTAL}`);
  if (!/3 carte\(s\) sans cote/.test(res.text)) problems.push("les cartes sans cote ne sont pas annoncées");
  if (!/Joyau/.test(onlyL) || /Rare UR|Commune/.test(onlyL)) problems.push('le filtre L ne montre pas que les Légendaires');
}
for (const e of errors) problems.push('erreur page : ' + e);

if (problems.length) {
  console.error('❌ cartes les plus chères :');
  for (const p of problems) console.error('  · ' + p);
  if (res) console.error('  — top : ' + JSON.stringify(res.rated.slice(0, 6)) + ' · statut : ' + res.status);
  process.exit(1);
}
console.log(`✅ 2 pages lues · Joyau 900 > Rare UR 300 > Double rareté 50 · cote par rareté (même carte SR 50 / C 5) · ×2 compté · cote refusée redemandée · 3 sans cote à part · total ${res.total} 💰 · filtre L`);
