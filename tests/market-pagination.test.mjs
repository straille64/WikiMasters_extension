// Non-régression : le scan marché doit paginer même quand l'API n'annonce pas de total.
//   node tests/market-pagination.test.mjs      (ou ./scripts/test.sh)
//
// Bug constaté en production : `total = first.total || 0` donnait 0 (le champ a changé
// de nom ou disparu), donc `Math.ceil(0/50) = 0` page à paginer et le scan s'arrêtait
// à la page 1. Or le scan demande `sort=ending_soon` : cette page 1 ne contient que
// les enchères les plus anciennes, donc les déjà terminées. Résultat côté utilisateur :
// « 49 annonces déjà terminées ignorées » puis « Aucune carte recherchée en vente »,
// alors que le site affichait des dizaines d'annonces vivantes correspondantes.
//
// Ce test reproduit exactement ça : 3 pages de 50, sans champ `total`, la seule annonce
// vivante qui matche le mot-clé étant en page 3.
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
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

const iso = ms => new Date(Date.now() + ms).toISOString();
// 50 par page (MARKET_PAGE_LIMIT) : pages 1 et 2 pleines de mortes, page 3 = 50 vivantes.
// La cible porte le mot-clé dans `category`, comme sur le vrai site
// (titre « Bree Daniels », sous-titre « actrice pornographique américaine »).
const dead = i => ({ id: `dead-${i}`, base_amount: 100, current_bid: null, current_bidder: null,
  card: { id: `cd${i}`, wikipedia_title: `Terminee ${i}`, rarity: 'C', category: 'divers' },
  end_at: iso(-60000 - i * 1000), status: 'active' });
const live = i => ({ id: `live-${i}`, base_amount: 50, current_bid: null, current_bidder: null,
  card: { id: `cl${i}`, wikipedia_title: `Vivante ${i}`, rarity: 'C', category: 'divers' },
  end_at: iso(3600_000 + i * 1000), status: 'active' });
const TARGET = { id: 'live-cible', base_amount: 100, current_bid: null, current_bidder: null,
  card: { id: 'cible', wikipedia_title: 'Bree Daniels', rarity: 'SR',
          category: 'actrice pornographique américaine' },
  end_at: iso(5 * 3600_000), status: 'active' };

const PAGES = {
  1: Array.from({ length: 50 }, (_, i) => dead(i)),
  2: Array.from({ length: 50 }, (_, i) => dead(100 + i)),
  3: [TARGET, ...Array.from({ length: 49 }, (_, i) => live(i))], // dernière page : pleine
  4: [], // page vide → fin de pagination
};
const pagesServed = new Set();

await page.goto(origin);
await page.evaluate(() => {
  localStorage.setItem('wm_onboarding_done', '1');
  // Mode MANUEL : ce test ne vérifie que la pagination et l'affichage, pas les mises.
  localStorage.setItem('wm_watchlist', JSON.stringify([{ kw: 'porno', mode: 'manuel' }]));
  localStorage.setItem('wm_autosnipe_min_balance', '0');
});

await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200,
  contentType: 'application/json', body: '{"balance":100000}' }));
await page.route('**/api/marketplace**', route => {
  const url = route.request().url();
  if (/\/mine/.test(url)) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"won":[],"auctions":[]}' });
  }
  const p = Number(new URL(url).searchParams.get('page') || 1);
  pagesServed.add(p);
  // ⚠️ Le cœur du test : la réponse ne porte AUCUN champ de total, comme l'API réelle.
  return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ auctions: PAGES[p] || [], page: p }) });
});

await page.evaluate(script).catch(e => pageErrors.push(String(e)));
await page.waitForTimeout(1000);
await page.evaluate(() => document.getElementById('wm-market-btn').click());
await page.waitForTimeout(8000);

const botLog = await page.evaluate(() =>
  [...document.querySelectorAll('.wm-log-e')].slice(0, 20).map(e => e.innerText));
const panel = await page.evaluate(() => (document.getElementById('wm-market-alert') || {}).innerText || '');

await browser.close();
srv.close();

const problems = [];
if (!pagesServed.has(2) || !pagesServed.has(3)) {
  problems.push(`pagination arrêtée trop tôt — pages demandées : ${[...pagesServed].sort((a, b) => a - b).join(', ')}`);
}
if (!/Bree Daniels/.test(panel) && !botLog.some(l => /Bree Daniels/.test(l))) {
  problems.push("la carte vivante de la page 3 n'a pas été trouvée");
}
for (const e of pageErrors) problems.push('erreur page : ' + e);

if (problems.length) {
  console.error('❌ non-régression « pagination marché » échouée :');
  for (const p of problems) console.error('  · ' + p);
  console.error('  — log du bot :');
  for (const l of botLog) console.error('      ' + l);
  process.exit(1);
}
console.log(`✅ pagination jusqu'à la page ${Math.max(...pagesServed)} sans champ total, carte vivante trouvée`);
