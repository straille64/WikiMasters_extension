// Non-régression : le scan ne doit pas traverser les pages d'enchères déjà terminées.
//   node tests/market-dead-pages.test.mjs      (ou ./scripts/test.sh)
//
// Relevé en production (capture réseau du 27/09) : 10 820 annonces terminées sur
// 12 137 relevées, soit 89 %. Le site laisse en liste ce qu'il n'a pas encore soldé, et
// le scan demande sort=ending_soon : ces annonces mortes ont le end_at le plus ancien et
// occupent donc les premières pages. Le scan en traversait ~217 avant d'atteindre la
// première annonce vivante, et se tronquait au plafond de 300 pages avant la fin — d'où
// à la fois les résultats manquants et les 403 par sur-sollicitation.
//
// « Est terminée » étant monotone dans cet ordre de tri, la première page vivante se
// trouve par dichotomie. Ce test vérifie les deux choses qui comptent : on trouve bien
// les annonces vivantes, ET on ne télécharge pas les pages mortes pour y arriver.
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

// 40 pages mortes puis 3 pages vivantes : proportion voisine du marché réel.
const DEAD_PAGES = 40, LIVE_PAGES = 3, TOTAL = DEAD_PAGES + LIVE_PAGES;
const iso = ms => new Date(Date.now() + ms).toISOString();
const mk = (id, title, endMs) => ({
  id, base_amount: 10, current_bid: null, current_bidder: null, status: 'active',
  end_at: iso(endMs),
  card: { id: 'card-' + id, wikipedia_title: title, rarity: 'C', category: 'cible' },
});
function pageOf(p) {
  if (p > TOTAL) return [];
  const dead = p <= DEAD_PAGES;
  return Array.from({ length: 50 }, (_, i) =>
    mk(`p${p}-${i}`, dead ? `Morte ${p}-${i}` : `Cible vivante ${p}-${i}`,
       dead ? -(TOTAL - p) * 60000 - 1000 : (p - DEAD_PAGES) * 3600_000));
}

const pagesAsked = [];
await page.goto(origin);
await page.evaluate(() => {
  localStorage.setItem('wm_onboarding_done', '1');
  localStorage.setItem('wm_autobid_armed', '0');
  localStorage.setItem('wm_watchlist', JSON.stringify([{ kw: 'cible vivante', mode: 'manuel' }]));
});
await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200,
  contentType: 'application/json', body: '{"balance":1000}' }));
await page.route('**/api/marketplace**', route => {
  const url = route.request().url();
  if (/\/mine/.test(url)) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"won":[],"auctions":[]}' });
  }
  const p = Number(new URL(url).searchParams.get('page') || 1);
  pagesAsked.push(p);
  const list = pageOf(p);
  return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ auctions: list, page: p, limit: 50, hasMore: p < TOTAL }) });
});

await page.evaluate(script).catch(e => errors.push(String(e)));
await page.waitForTimeout(800);
await page.evaluate(() => document.getElementById('wm-market-btn').click());
await page.waitForTimeout(16000);

const found = await page.evaluate(() => {
  const txt = (document.getElementById('wm-market-alert') || {}).innerText || '';
  const m = txt.match(/(\d+)\s+ANNONCES?\s+TROUV/i);
  return m ? Number(m[1]) : -1;
});
const log = await page.evaluate(() =>
  [...document.querySelectorAll('.wm-log-e')].slice(0, 12).map(e => e.innerText));
await browser.close();
srv.close();

const distinctPages = new Set(pagesAsked).size;
const problems = [];
// Les 3 pages vivantes = 150 annonces. Une page de marge est relue, donc >= 150.
if (found < LIVE_PAGES * 50) {
  problems.push(`${found} annonces trouvées, attendu au moins ${LIVE_PAGES * 50} (les pages vivantes)`);
}
// Le cœur du test : sans dichotomie il faudrait les 43 pages. Avec, une quinzaine suffit.
if (distinctPages > 20) {
  problems.push(`${distinctPages} pages téléchargées sur ${TOTAL} — les pages mortes ne sont pas sautées`);
}
if (distinctPages < 4) {
  problems.push(`${distinctPages} page(s) seulement : le scénario ne prouve rien`);
}
for (const e of errors) problems.push('erreur page : ' + e);

if (problems.length) {
  console.error('❌ non-régression « pages mortes » échouée :');
  for (const p of problems) console.error('  · ' + p);
  console.error('  — log du bot :');
  for (const l of log) console.error('      ' + l);
  process.exit(1);
}
console.log(`✅ ${found} annonces vivantes trouvées en ne téléchargeant que ${distinctPages} pages sur ${TOTAL}`);
