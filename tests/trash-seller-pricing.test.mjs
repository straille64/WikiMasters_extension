// Trash Seller : % par rareté, plancher limité dans le temps, baisse par invendu,
// mise de côté.   node tests/trash-seller-pricing.test.mjs      (ou ./scripts/test.sh)
//
// Logs du 28/09 : 26 mises en vente, 2 ventes. La plupart des R partaient au plancher
// (15 💰) pour une cote de 1 à 10 💰, revenaient invendues et repartaient au même prix.
// Règles demandées :
//   · prix de départ = cote × % PROPRE À LA RARETÉ ;
//   · le plancher ne protège que les N premières mises en vente (défaut 2) ;
//   · -10 % par invendu, jamais sous 50 % du prix de départ ;
//   · au bout de 6 invendus, la carte sort de la file (« mise de côté »), réversible.
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

// id → [titre, rareté, cote (dans sa rareté), invendus déjà subis, prix attendu]
// Tableau : SR 25, R 15, PC 15. % : SR 120, PC 80, les autres 100 (défaut).
const CARDS = {
  'sr-120':   ['Carte SR 120 pourcent', 'SR', 100, 0, 120],  // % par rareté, au-dessus de la cote
  'pc-80':    ['Carte PC 80 pourcent',  'PC', 100, 0, 80],   // % par rareté, sous la cote
  'r-floor0': ['Carte R plancher 1er',  'R',  7,   0, 15],   // 1re mise : plancher
  'r-floor1': ['Carte R plancher 2e',   'R',  7,   1, 15],   // 2e mise : plancher encore
  'r-lifted': ['Carte R plancher leve', 'R',  10,  2, 8],    // 3e : plancher levé, 10 × 0,8
  'r-min':    ['Carte R minimum 50',    'R',  100, 9, 50],   // -90 % demandé, bloqué à 50 %
  'sr-decay': ['Carte SR baisse',       'SR', 100, 3, 84],   // 120 × 0,7
  'r-aside':  ['Carte R mise de cote',  'R',  50,  10, null], // 10 invendus → hors file
};

const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(origin + '/collection');
await page.evaluate(cards => {
  localStorage.setItem('wm_onboarding_done', '1');
  localStorage.setItem('wm_autobid_armed', '0');
  localStorage.setItem('wm_watchlist', '[]');
  localStorage.setItem('wm_max_active_sales', '5');
  localStorage.setItem('wm_sell_undercut_market', 'false');
  // Seuil de mise de côté remonté à 10 : le cas « r-min » (9 invendus) doit rester dans
  // la file pour vérifier la borne à 50 %.
  localStorage.setItem('wm_sell_set_aside_after', '10');
  localStorage.setItem('wm_sell_config', JSON.stringify({
    L: { price: 900, duration: 60 }, UR: { price: 500, duration: 60 },
    SR: { price: 25, duration: 60, pct: 120 }, R: { price: 15, duration: 10 },
    PC: { price: 15, duration: 10, pct: 80 }, C: { price: 5, duration: 10 },
  }));
  const retag = {};
  for (const [id, c] of Object.entries(cards)) if (c[3]) retag[id] = { title: c[0], rarity: c[1], count: c[3] };
  localStorage.setItem('wm_retag_counts', JSON.stringify(retag));
}, CARDS);

await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"balance":1000}' }));
await page.route('**/api/my-collection**', r => r.fulfill({ status: 200, contentType: 'application/json',
  body: JSON.stringify({ total: Object.keys(CARDS).length, collection: Object.entries(CARDS).map(([id, c]) => ({
    card_id: id, tags: [{ name: 'Trash' }], card: { id, wikipedia_title: c[0], rarity: c[1] } })) }) }));
await page.route('**/api/marketplace**', route => {
  const url = route.request().url();
  const m = url.match(/cards\/([^/?]+)\/sales/);
  if (m) {
    const c = CARDS[m[1]];
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ summary: c ? { [c[1]]: { average: c[2] } } : {} }) });
  }
  if (/\/mine/.test(url)) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"sellingCount":0,"maxConcurrentAuctions":5}' });
  }
  return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ auctions: [], page: 1, limit: 50, hasMore: false }) });
});

await page.evaluate(script).catch(e => errors.push(String(e)));
await page.waitForTimeout(1000);

// Lit l'aperçu : titre → { prix, texte de la ligne }.
async function preview() {
  await page.evaluate(() => document.getElementById('wm-preview-sales-btn').click());
  await page.waitForTimeout(5000);
  return page.evaluate(titles => {
    const out = {};
    const box = document.getElementById('wm-sale-preview');
    for (const row of (box ? box.querySelectorAll('div') : [])) {
      const lines = row.innerText.split('\n').map(s => s.trim()).filter(Boolean);
      const title = titles.find(t => lines.includes(t));
      if (!title || out[title]) continue;
      const priceLine = lines.find(l => /^\d[\d\s  ]*💰$/.test(l));
      out[title] = { price: priceLine ? Number(priceLine.replace(/\D/g, '')) : null, text: lines.join(' | ') };
    }
    return out;
  }, Object.values(CARDS).map(c => c[0]));
}

const first = await preview();
// textContent : la liste est dans un <details> replié, dont innerText ne lit que le résumé.
const setAsideText = await page.evaluate(() => (document.getElementById('wm-set-aside') || {}).textContent || '');

// Le % se règle depuis le PANNEAU, pas seulement dans Paramètres.
const pctUi = await page.evaluate(() => {
  const inp = document.querySelector('[data-wm-sell-pct="R"]');
  if (!inp) return null;
  inp.value = '90';
  inp.dispatchEvent(new Event('change'));
  return JSON.parse(localStorage.getItem('wm_sell_config') || '{}').R?.pct ?? null;
});

// Remettre la carte en vente depuis la liste : elle revient, compteur remis à zéro.
await page.evaluate(() => {
  const b = document.querySelector('[data-wm-restore]');
  if (b) b.click();
});
const second = await preview();
const retagAfter = await page.evaluate(() =>
  (JSON.parse(localStorage.getItem('wm_retag_counts') || '{}')['r-aside'] || { count: 0 }).count);

await browser.close();
srv.close();

const problems = [];
for (const [id, [title, , , k, expected]] of Object.entries(CARDS)) {
  if (expected == null) continue;
  const got = first[title];
  if (!got) { problems.push(`« ${title} » absente de l'aperçu`); continue; }
  if (got.price !== expected) problems.push(`« ${title} » (${k} invendu(s)) : ${got.price} 💰 au lieu de ${expected} — ${got.text}`);
}
if (first['Carte R plancher 1er'] && !/\(2×\)/.test(first['Carte R plancher 1er'].text)) {
  problems.push("le 1er passage au plancher n'indique pas combien de fois il s'appliquera encore");
}
if (first['Carte R plancher leve'] && !/plancher levé/.test(first['Carte R plancher leve'].text)) {
  problems.push("le plancher levé n'est pas signalé dans l'aperçu");
}
// Mise de côté
if (first['Carte R mise de cote']) problems.push('la carte à 10 invendus est encore dans la file de vente');
if (!/Carte R mise de cote/.test(setAsideText)) problems.push("la carte mise de côté n'apparaît pas dans la liste « Mises de côté »");
if (pctUi !== 90) problems.push(`le % par rareté du panneau n'est pas enregistré (R.pct = ${pctUi})`);
// Après « Remettre » : de retour dans la file, au prix plein (plus d'invendus), R à 90 %.
if (!second['Carte R mise de cote']) problems.push('après « Remettre », la carte ne revient pas dans la file');
else if (second['Carte R mise de cote'].price !== 45) {
  problems.push(`après « Remettre » : ${second['Carte R mise de cote'].price} 💰 au lieu de 45 (cote 50 × 90 %, compteur remis à zéro)`);
}
if (retagAfter !== 0) problems.push(`compteur d'invendus à ${retagAfter} après « Remettre » — attendu 0`);
for (const e of errors) problems.push('erreur page : ' + e);

if (problems.length) {
  console.error('❌ prix du Trash Seller :');
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}
console.log('✅ % par rareté (120 / 80) · plancher 2× puis levé · -10 %/invendu borné à 50 % · mise de côté au seuil, réversible (45 💰 au retour)');
