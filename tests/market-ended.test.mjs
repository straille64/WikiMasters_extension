// Non-régression : le Market Watcher ne doit jamais miser sur une enchère terminée.
//   node tests/market-ended.test.mjs      (ou ./scripts/test.sh)
//
// Bug constaté en production : l'API marketplace continue de lister une enchère tant
// que le serveur ne l'a pas SOLDÉE, et le scan demande `sort=ending_soon` — les
// enchères finies, ayant le end_at le plus ancien, remontaient donc EN TÊTE. Le
// watcher « trouvait » celles-là, et chaque mise repartait avec « Cette enchère est
// terminée ». Ce test rejoue le scénario : une annonce morte et une vivante, toutes
// deux matchant le mot-clé, et vérifie qu'une seule reçoit une mise.
//
// Playwright n'est pas une dépendance du dépôt : test sauté proprement s'il manque.
import fs from 'fs';
import path from 'path';
import http from 'http';
import assert from 'assert';
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

// Argument optionnel : un autre build à tester (utile pour vérifier qu'un test
// échoue bien sur la version d'avant le correctif).
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
catch (e) { console.log('⏭️  Chromium introuvable — test sauté'); srv.close(); process.exit(0); }

const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

const iso = ms => new Date(Date.now() + ms).toISOString();
const card = (id, title) => ({ id, wikipedia_title: title, rarity: 'SR', category: 'Histoire' });
// Même forme que la vraie API : l'ended a le end_at le plus ancien, donc il arrive
// en premier avec sort=ending_soon — exactement ce qui trompait le watcher.
const ENDED = { id: 'auction-ended', card: card('c1', 'Massacre test (1929)'), base_amount: 100,
                current_bid: 100, current_bidder: { username: 'QuelquUnDautre' },
                end_at: iso(-45000), status: 'active' };
const LIVE  = { id: 'auction-live',  card: card('c2', 'Bataille test (1815)'), base_amount: 50,
                current_bid: null, current_bidder: null,
                end_at: iso(20 * 60 * 1000), status: 'active' };

const bidsAttempted = [];

await page.goto(origin);
await page.evaluate(() => {
  localStorage.setItem('wm_onboarding_done', '1');
  localStorage.setItem('wm_keywords_priority', JSON.stringify(['test'])); // mise forcée
  localStorage.setItem('wm_autosnipe_min_balance', '0'); // pas de plancher de solde
  localStorage.setItem('wm_humanized_bid_delay_ms', '0'); // pas d'attente avant la mise
});

// ⚠️ Playwright applique les routes de la PLUS RÉCENTE à la plus ancienne : le
// filet « tout le reste est coupé » doit donc être posé EN PREMIER, sinon il avale
// aussi les appels à l'API simulée ci-dessous.
await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());

await page.route('**/api/marketplace**', async route => {
  const url = route.request().url();
  if (route.request().method() === 'POST' && /\/bid$/.test(url)) {
    bidsAttempted.push(url.match(/marketplace\/([^/]+)\/bid/)[1]);
    // Le vrai serveur refuse une enchère finie : on le reproduit fidèlement.
    return route.fulfill({ status: 400, contentType: 'application/json',
      body: JSON.stringify({ error: 'Cette enchère est terminée' }) });
  }
  if (/\/mine/.test(url)) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"won":[],"auctions":[]}' });
  }
  return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ auctions: [ENDED, LIVE], total: 2, page: 1 }) });
});
// Solde : sans lui, wikibidousBalance reste à 0 et tous les chemins de mise se
// coupent avant le POST — le test passerait alors sans rien prouver.
await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200, contentType: 'application/json',
  body: '{"balance":100000}' }));

await page.evaluate(script).catch(e => pageErrors.push(String(e)));
await page.waitForTimeout(1000);

// Démarre le Market Watcher. Clic programmatique et non pointeur : le panneau est
// replié au chargement, donc le bouton est masqué par l'overlay pour Playwright.
await page.evaluate(() => document.getElementById('wm-market-btn').click());
await page.waitForTimeout(6000);

const botLog = await page.evaluate(() =>
  [...document.querySelectorAll('.wm-log-e')].slice(0, 15).map(e => e.innerText));
const shownIds = await page.evaluate(() =>
  [...document.querySelectorAll('#wm-market-alert [data-title], #wm-market-alert a')]
    .map(e => e.getAttribute('href') || e.getAttribute('data-title') || '').join(' '));

await browser.close();
srv.close();

const problems = [];
if (bidsAttempted.includes('auction-ended')) {
  problems.push(`mise tentée sur l'enchère TERMINÉE (${bidsAttempted.join(', ')})`);
}
// Contrôle inverse, sans lequel le test passerait aussi si le watcher ne faisait
// rien du tout : l'annonce VIVANTE doit bien recevoir une mise.
if (!bidsAttempted.includes('auction-live')) {
  problems.push("aucune mise sur l'enchère vivante — le filtre est trop large, ou le "
    + 'scénario ne déclenche plus de mise (mises vues : ' + (bidsAttempted.join(', ') || 'aucune') + ')');
}
if (/auction-ended/.test(shownIds)) {
  problems.push("l'enchère terminée est encore affichée comme annonce trouvée");
}
for (const e of pageErrors) problems.push('erreur page : ' + e);

if (problems.length) {
  console.error('❌ non-régression « enchère terminée » échouée :');
  for (const p of problems) console.error('  · ' + p);
  console.error('  — log du bot :');
  for (const l of botLog) console.error('      ' + l);
  process.exit(1);
}
console.log(`✅ aucune mise sur l'enchère terminée (mises tentées : ${bidsAttempted.length ? bidsAttempted.join(', ') : 'aucune'})`);
