// Pool du Trash Seller : toute la collection est lue, même vendeur arrêté.
//   node tests/trash-pool-scan.test.mjs      (ou ./scripts/test.sh)
//
// Retour du 29/09 : « il ne détecte que 2 cartes Trash, j'en ai une quinzaine ». Le scan
// de la collection s'arrêtait après la 1re page dès que le Trash Seller n'était pas
// démarré (aperçu, « Refresh ventes »). Triée par rareté, la 1re page ne contient que les
// cartes les plus rares : les Trash (surtout des R) étaient plus loin. Et ce pool tronqué
// restait 12 min en cache, y compris pour le vendeur une fois lancé.
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

// 150 cartes (3 pages de 50). Page 1 = 50 cartes rares, dont 2 Trash ; les 13 autres
// Trash sont en pages 2 et 3 — exactement la répartition qui donnait « 2 cartes ».
const COLL = Array.from({ length: 150 }, (_, i) => {
  const rarity = i < 50 ? 'SR' : 'R';
  const trash = i === 3 || i === 7 || (i >= 60 && i < 73);
  return { card_id: 'c' + i, tags: trash ? [{ name: 'Trash' }] : [],
           card: { id: 'c' + i, wikipedia_title: 'Carte ' + i, rarity } };
});
const EXPECTED = COLL.filter(c => c.tags.length).length; // 15

const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(origin + '/collection');
await page.evaluate(() => {
  localStorage.setItem('wm_onboarding_done', '1');
  localStorage.setItem('wm_autobid_armed', '0');
  localStorage.setItem('wm_watchlist', '[]');
  localStorage.setItem('wm_sell_undercut_market', 'false');
  localStorage.setItem('wm_sell_use_market_price', 'false');
});
await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"balance":1000}' }));
const collPages = [];
await page.route('**/api/my-collection**', r => {
  const u = new URL(r.request().url());
  const p = Number(u.searchParams.get('page') || 0);
  collPages.push(p);
  // L'API ne donne pas de total fiable : pagination « dynamique », comme en production.
  return r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ collection: COLL.slice(p * 50, p * 50 + 50) }) });
});
await page.route('**/api/marketplace**', r => {
  const url = r.request().url();
  if (/\/mine/.test(url)) return r.fulfill({ status: 200, contentType: 'application/json', body: '{"sellingCount":0,"maxConcurrentAuctions":5}' });
  if (/\/cards\//.test(url)) return r.fulfill({ status: 200, contentType: 'application/json', body: '{"summary":{}}' });
  return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ auctions: [], hasMore: false }) });
});

await page.evaluate(script).catch(e => errors.push(String(e)));
await page.waitForTimeout(800);
// Trash Seller ARRÊTÉ : on demande l'aperçu, comme l'utilisateur.
await page.evaluate(() => document.getElementById('wm-preview-sales-btn').click());
await page.waitForTimeout(6000);
const header = await page.evaluate(() => (document.getElementById('wm-sale-preview') || {}).innerText || '');
const log = await page.evaluate(() => [...document.querySelectorAll('.wm-log-e')].map(e => e.innerText).join('\n'));
await browser.close();
srv.close();

const problems = [];
const m = header.match(/(\d+)\s*carte\(s\) dans le pool/);
const inPool = m ? Number(m[1]) : null;
if (inPool !== EXPECTED) {
  problems.push(`aperçu vendeur arrêté : ${inPool} carte(s) dans le pool au lieu de ${EXPECTED} — pages lues : ${JSON.stringify([...new Set(collPages)])}`);
}
if (!new RegExp(`Scan Trash : ${EXPECTED} cartes`).test(log)) {
  problems.push(`le log ne compte pas les ${EXPECTED} cartes Trash`);
}
for (const e of errors) problems.push('erreur page : ' + e);

if (problems.length) {
  console.error('❌ pool du Trash Seller :');
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}
console.log(`✅ vendeur arrêté : collection lue en entier (${[...new Set(collPages)].length} pages) · ${EXPECTED}/${EXPECTED} cartes Trash dans l'aperçu`);
