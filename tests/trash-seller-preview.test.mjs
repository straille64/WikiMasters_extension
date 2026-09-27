// Trash Seller : prix = moyenne du marché (bonne rareté), et aperçu de l'ordre de vente.
//   node tests/trash-seller-preview.test.mjs      (ou ./scripts/test.sh)
//
// Deux points se vérifient ensemble, parce que l'aperçu n'a de valeur que s'il annonce
// LE prix qui sera réellement pratiqué :
//   · la cote du site est donnée par rareté ({"SR":{"average":668}}) — vendre une SR au
//     prix moyen d'une commune serait une perte sèche ;
//   · sans cote connue, on retombe sur le prix par défaut du tableau par rareté.
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

// Trois cartes : une SR cotée, une C cotée, une SR SANS cote (repli sur le tableau).
const POOL = [
  { cardId: 'sr-cote', title: 'Carte SR cotée', rarity: 'SR' },
  { cardId: 'c-cote', title: 'Carte C cotée', rarity: 'C' },
  { cardId: 'sr-sans', title: 'Carte SR sans cote', rarity: 'SR' },
];
// La même carte vaut 668 en SR et 7 en C : c'est ce qui piège une lecture naïve.
const SUMMARY = {
  'sr-cote': { SR: { average: 668 }, C: { average: 7 } },
  'c-cote': { SR: { average: 668 }, C: { average: 7 } },
};

await page.goto(origin + '/collection');
await page.evaluate(pool => {
  localStorage.setItem('wm_onboarding_done', '1');
  localStorage.setItem('wm_autobid_armed', '0');
  localStorage.setItem('wm_watchlist', '[]');
  localStorage.setItem('wm_trash_sell_strategy', 'rarity'); // ordre prévisible : SR avant C
  localStorage.setItem('wm_max_active_sales', '5');
  // Prix par défaut du tableau : c'est le repli attendu pour la carte sans cote.
  localStorage.setItem('wm_sell_config', JSON.stringify({
    L: { price: 900, duration: 720 }, UR: { price: 500, duration: 720 },
    SR: { price: 123, duration: 360 }, R: { price: 40, duration: 60 },
    PC: { price: 20, duration: 60 }, C: { price: 11, duration: 30 },
  }));
}, POOL);

await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200,
  contentType: 'application/json', body: '{"balance":1000}' }));
// Le pool du Trash Seller se construit depuis la collection, en ne gardant que les
// cartes dont l'étiquette de vente est le SEUL tag.
await page.route('**/api/my-collection**', r => r.fulfill({ status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ total: POOL.length, collection: POOL.map(p => ({
    card_id: p.cardId, tags: [{ name: 'Trash' }],
    card: { id: p.cardId, wikipedia_title: p.title, rarity: p.rarity },
  })) }) }));
await page.route('**/api/marketplace**', route => {
  const url = route.request().url();
  const m = url.match(/cards\/([^/?]+)\/sales/);
  if (m) {
    const sum = SUMMARY[m[1]];
    // Carte sans cote : résumé vide, donc repli sur le tableau.
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(sum ? { summary: sum } : { summary: {} }) });
  }
  if (/\/mine/.test(url)) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"won":[],"auctions":[]}' });
  }
  return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ auctions: [], page: 1, limit: 50, hasMore: false }) });
});

await page.evaluate(script).catch(e => errors.push(String(e)));
await page.waitForTimeout(1200);
// Bouton absent → on le dit clairement plutôt que de planter sur un null.
const hasButton = await page.evaluate(() => {
  const b = document.getElementById('wm-preview-sales-btn');
  if (b) b.click();
  return !!b;
});
await page.waitForTimeout(6000);

const preview = await page.evaluate(() => {
  const el = document.getElementById('wm-sale-preview');
  return el ? el.innerText : '';
});
await browser.close();
srv.close();

const problems = [];
if (!hasButton) problems.push("le bouton « Aperçu » n'existe pas dans le panneau Trash Seller");
if (!preview) problems.push("l'aperçu ne s'affiche pas");
// Prix attendus : SR cotée → 668 (sa rareté), C cotée → 11 (plancher tableau > 7),
// SR sans cote → 123 (tableau).
if (!/668/.test(preview)) {
  problems.push("la SR cotée n'est pas à 668 — la moyenne de SA rareté n'est pas utilisée");
}
if (/\b7\s*💰/.test(preview)) {
  problems.push('un prix de 7 apparaît : c\'est la moyenne de la rareté C appliquée à une SR');
}
if (!/123/.test(preview)) {
  problems.push("la carte sans cote n'est pas à 123 — le repli sur le prix par défaut ne marche pas");
}
for (const t of ['Carte SR cotée', 'Carte C cotée', 'Carte SR sans cote']) {
  if (!preview.includes(t)) problems.push(`« ${t} » absente de l'aperçu`);
}
// L'aperçu doit dire d'où vient chaque prix, sinon il n'apprend rien.
if (!/marché/.test(preview) || !/défaut|plancher/.test(preview)) {
  problems.push("l'aperçu n'indique pas l'origine des prix (marché / défaut / plancher)");
}
// Ordre : stratégie « rareté » → les SR avant la C.
const iC = preview.indexOf('Carte C cotée');
const iSR = Math.max(preview.indexOf('Carte SR cotée'), preview.indexOf('Carte SR sans cote'));
if (iC >= 0 && iSR >= 0 && iC < iSR) problems.push("l'ordre ne suit pas la stratégie « rareté »");
for (const e of errors) problems.push('erreur page : ' + e);

if (problems.length) {
  console.error('❌ aperçu Trash Seller :');
  for (const p of problems) console.error('  · ' + p);
  console.error('  — aperçu rendu :\n' + preview.split('\n').map(l => '      ' + l).join('\n'));
  process.exit(1);
}
console.log('✅ prix par rareté (SR 668, repli 123) · origine des prix affichée · ordre conforme à la stratégie');
