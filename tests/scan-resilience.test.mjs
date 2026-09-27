// Non-régression : un scan sous refus 403 ne doit ni perdre d'annonces, ni marteler.
//   node tests/scan-resilience.test.mjs      (ou ./scripts/test.sh)
//
// Deux bugs observés ensemble en production (console du navigateur) :
//   1. GET /api/marketplace/cards/{id}/sales 403 répété à l'identique en boucle —
//      fetchCardSales ne mémorisait pas l'échec, donc la carte était remise en file
//      à chaque scan et redemandée indéfiniment. C'est ce qui saturait l'API et
//      faisait tomber POST /api/packs/open en 403 par ricochet.
//   2. Les pages de scan refusées étaient silencieusement abandonnées : ~50 annonces
//      perdues par page, sans aucun signal — le « il ne trouve pas tout ».
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

const iso = ms => new Date(Date.now() + ms).toISOString();
const mk = (id, title) => ({
  id, base_amount: 10, current_bid: null, current_bidder: null, status: 'active',
  end_at: iso(3600_000),
  card: { id: 'card-' + id, wikipedia_title: title, rarity: 'C', category: 'cible' },
});
// 2 pages pleines + une 3e partielle. hasMore pilote la fin, comme la vraie API.
const PAGES = {
  1: Array.from({ length: 50 }, (_, i) => mk('p1-' + i, `Cible A${i}`)),
  2: Array.from({ length: 50 }, (_, i) => mk('p2-' + i, `Cible B${i}`)),
  3: [mk('p3-0', 'Cible C0')],
};

let page2Attempts = 0;
const salesCalls = [];

await page.goto(origin);
await page.evaluate(() => {
  localStorage.setItem('wm_onboarding_done', '1');
  localStorage.setItem('wm_autobid_armed', '0');
  localStorage.setItem('wm_watchlist', JSON.stringify([{ kw: 'cible', mode: 'manuel' }]));
  localStorage.setItem('wm_market_view', 'detailed'); // c'est cette vue qui demande les cotes
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
  // La page 2 est refusée au PREMIER essai seulement : le scan doit la rejouer.
  if (p === 2 && ++page2Attempts === 1) {
    return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Forbidden"}' });
  }
  const list = PAGES[p] || [];
  return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ auctions: list, page: p, limit: 50, hasMore: list.length >= 50 }) });
});

// ⚠️ Enregistrée APRÈS la route générale : Playwright applique les routes de la plus
// récente à la plus ancienne, donc `**/api/marketplace**` avalerait sinon les /sales.
await page.route('**/api/marketplace/cards/*/sales**', route => {
  // Le site refuse SYSTÉMATIQUEMENT cet endpoint : le bot ne doit pas s'acharner.
  salesCalls.push(route.request().url());
  return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Forbidden"}' });
});

await page.evaluate(script).catch(e => errors.push(String(e)));
await page.waitForTimeout(800);
await page.evaluate(() => document.getElementById('wm-market-btn').click());
await page.waitForTimeout(14000); // laisse le temps du scan + reprise + file des cotes

const found = await page.evaluate(() => {
  const txt = (document.getElementById('wm-market-alert') || {}).innerText || '';
  const m = txt.match(/(\d+)\s+ANNONCES?\s+TROUV/i);
  return m ? Number(m[1]) : -1;
});
const log = await page.evaluate(() =>
  [...document.querySelectorAll('.wm-log-e')].slice(0, 25).map(e => e.innerText));

await browser.close();
srv.close();

// Nombre de cartes DISTINCTES demandées vs nombre total d'appels : c'est le rapport
// qui révèle l'acharnement (une même carte redemandée en boucle).
const distinctSales = new Set(salesCalls).size;
const problems = [];
if (found !== 101) {
  problems.push(`${found} annonces affichées au lieu de 101 — la page refusée n'a pas été récupérée`);
}
if (page2Attempts < 2) problems.push('la page refusée n\'a pas été rejouée');
// Sans au moins un appel, la moitié « acharnement » du test ne prouverait rien.
if (salesCalls.length === 0) {
  problems.push("aucun appel à /sales : le scénario n'exerce pas la file des cotes, le test ne prouve rien");
}
if (salesCalls.length > distinctSales + 1) {
  problems.push(`endpoint /sales martelé : ${salesCalls.length} appels pour ${distinctSales} carte(s) distincte(s)`);
}
for (const e of errors) problems.push('erreur page : ' + e);

if (problems.length) {
  console.error('❌ non-régression « résilience du scan » échouée :');
  for (const p of problems) console.error('  · ' + p);
  console.error('  — log du bot :');
  for (const l of log) console.error('      ' + l);
  process.exit(1);
}
console.log(`✅ ${found} annonces (page refusée récupérée) · /sales : ${salesCalls.length} appel(s) pour ${distinctSales} carte(s), pas d'acharnement`);
