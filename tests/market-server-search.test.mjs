// Le scan doit utiliser la recherche du SITE (q=) plutôt que balayer tout le marché.
//   node tests/market-server-search.test.mjs      (ou ./scripts/test.sh)
//
// Relevé dans l'onglet Réseau de l'utilisateur, en tapant « femme » sur le marché :
//   GET /api/marketplace?page=1&limit=50&sort=recent&q=femme   → 200
//   GET /api/marketplace?page=2&limit=50&sort=recent&q=femme   → 200  (charger la suite)
// L'API sait donc filtrer côté serveur. Le bot balayait au lieu de demander : plusieurs
// centaines de pages, un scan tronqué au plafond, des 403 en cascade, et des résultats
// qui ne correspondaient pas à ce que le site affiche.
//
// Ce test vérifie les trois choses qui comptent : le bot interroge bien `q=`, il suit la
// pagination de cette recherche, et il ne balaye PAS le marché entier. Plus le repli :
// si l'API ignore `q`, on doit revenir au balayage complet plutôt qu'afficher n'importe quoi.
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

const iso = ms => new Date(Date.now() + ms).toISOString();
const mk = (id, title, cat) => ({
  id, base_amount: 10, current_bid: null, current_bidder: null, status: 'active',
  end_at: iso(3 * 3600_000),
  card: { id: 'card-' + id, wikipedia_title: title, rarity: 'SR', category: cat },
});
// 60 correspondances réparties sur 2 pages, + un marché « complet » bien plus gros.
const MATCHES = Array.from({ length: 60 }, (_, i) =>
  mk('m' + i, `Personne ${i}`, 'femme politique française'));
const NOISE = Array.from({ length: 500 }, (_, i) => mk('n' + i, `Autre ${i}`, 'divers'));

async function run({ honourQ }) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const urls = [];
  await page.goto(origin);
  await page.evaluate(() => {
    localStorage.setItem('wm_onboarding_done', '1');
    localStorage.setItem('wm_autobid_armed', '0');
    localStorage.setItem('wm_watchlist', JSON.stringify([{ kw: 'femme', mode: 'manuel' }]));
  });
  await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
  await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200,
    contentType: 'application/json', body: '{"balance":1000}' }));
  await page.route('**/api/marketplace**', route => {
    const url = route.request().url();
    if (/\/mine/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"won":[],"auctions":[]}' });
    }
    // Les cotes : réponse au format résumé, pour ne pas polluer le comptage.
    if (/\/cards\//.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ summary: { SR: { average: 42 } } }) });
    }
    // On ne compte que les requêtes de LISTE : /cards/{id}/sales passe aussi par ici.
    if (!/\/cards\//.test(url)) urls.push(url);
    const u = new URL(url);
    const p = Number(u.searchParams.get('page') || 1);
    const q = u.searchParams.get('q');
    /* honourQ=false simule une API qui IGNORE q : elle renvoie le marché entier, dans
       son ordre naturel. Le bruit vient donc EN TÊTE — c'est ce qui distingue une
       recherche ignorée d'une recherche qui fonctionne. Mettre les correspondances en
       premier aurait produit une page 1 parfaitement filtrée en apparence, et le test
       n'aurait rien prouvé. */
    const pool = (q && honourQ) ? MATCHES : [...NOISE, ...MATCHES];
    const slice = pool.slice((p - 1) * 50, p * 50);
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ auctions: slice, page: p, limit: 50, hasMore: p * 50 < pool.length }) });
  });

  await page.evaluate(script).catch(e => errors.push(String(e)));
  await page.waitForTimeout(800);
  await page.evaluate(() => document.getElementById('wm-market-btn').click());
  await page.waitForTimeout(12000);

  const found = await page.evaluate(() => {
    const txt = (document.getElementById('wm-market-alert') || {}).innerText || '';
    const m = txt.match(/(\d+)\s+ANNONCES?\s+TROUV/i);
    return m ? Number(m[1]) : -1;
  });
  // Log ENTIER : la ligne de repli est écrite avant les « Nouveau match », qui sont
  // nombreux et la repousseraient hors d'un extrait des dernières lignes.
  const log = await page.evaluate(() =>
    [...document.querySelectorAll('.wm-log-e')].map(e => e.innerText));
  await page.close();
  return { found, urls, errors, log };
}

const withQ = await run({ honourQ: true });
const ignored = await run({ honourQ: false });
await browser.close();
srv.close();

const problems = [];
const qUrls = withQ.urls.filter(u => /[?&]q=/.test(u));
if (!qUrls.length) problems.push("le bot n'utilise pas la recherche serveur (aucune requête avec q=)");
if (!qUrls.some(u => /[?&]page=2/.test(u))) {
  problems.push("la pagination de la recherche n'est pas suivie (pas de page=2 avec q=)");
}
if (withQ.found !== MATCHES.length) {
  problems.push(`${withQ.found} annonces affichées au lieu de ${MATCHES.length}`);
}
// Le cœur du gain : on ne balaye plus tout le marché.
if (withQ.urls.length > 6) {
  problems.push(`${withQ.urls.length} requêtes marché pour un seul mot-clé — la recherche serveur doit en demander une poignée`);
}
// Repli : si q est ignoré, on doit le détecter et revenir au balayage complet.
if (!ignored.log.some(l => /recherche serveur/i.test(l))) {
  problems.push("q ignoré par l'API : le repli sur le balayage complet n'est pas signalé");
}
for (const e of [...withQ.errors, ...ignored.errors]) problems.push('erreur page : ' + e);

if (problems.length) {
  console.error('❌ recherche serveur :');
  for (const p of problems) console.error('  · ' + p);
  console.error('  — log du bot :');
  for (const l of ignored.log.filter(l => /recherche|balayage|scan/i.test(l)).slice(0, 5)) {
    console.error('      [q ignoré] ' + l);
  }
  for (const l of withQ.log.slice(0, 5)) console.error('      ' + l);
  process.exit(1);
}
console.log(`✅ ${withQ.found} annonces via q= en ${withQ.urls.length} requête(s) · repli détecté si q est ignoré`);
