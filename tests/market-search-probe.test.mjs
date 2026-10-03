// La sonde qui décide « la recherche serveur marche-t-elle ? » ne doit pas se tromper.
//   node tests/market-search-probe.test.mjs      (ou ./scripts/test.sh)
//
// Retour d'usage : « les recherches tournent à l'infini, ça ne donne pas les résultats ».
// Le bandeau affichait « p.277/277 · 13105 annonces » : le bot balayait le marché ENTIER
// au lieu d'interroger `q=`. Deux défauts derrière ça :
//   1. l'ancienne sonde jugeait sur le titre / la catégorie / le résumé des annonces —
//      des champs que la réponse du marché ne contient pas toujours. Quand le site
//      cherchait dans un champ absent de la réponse, une recherche qui MARCHAIT était
//      déclarée cassée ;
//   2. le verdict était définitif : une fois posé, plus jamais de nouvelle tentative.
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

const end = () => new Date(Date.now() + 4 * 3600_000).toISOString();
// Le cas réel : le site trouve ces cartes pour « eiffage », mais le mot n'apparaît dans
// AUCUN champ que la réponse du marché renvoie (il est indexé ailleurs).
const MATCHES = [
  { id: 'e1', base_amount: 10, current_bid: null, current_bidder: null, end_at: end(),
    card: { id: 'ce1', wikipedia_title: 'Tours Mercuriales', rarity: 'SR' } },
  { id: 'e2', base_amount: 12, current_bid: null, current_bidder: null, end_at: end(),
    card: { id: 'ce2', wikipedia_title: 'Benoît de Ruffray', rarity: 'R' } },
];
// Le marché non filtré : des centaines d'annonces sans rapport.
const MARKET = Array.from({ length: 600 }, (_, i) => ({
  id: 'm' + i, base_amount: 5, current_bid: null, current_bidder: null, end_at: end(),
  card: { id: 'cm' + i, wikipedia_title: 'Autre ' + i, rarity: 'C' },
}));

// honourQ=false : l'API ignore `q` et sert le marché entier — le seul cas où le balayage
// complet est justifié.
async function run({ honourQ, advanceMs }) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const listUrls = [];
  // Horloge pilotable : permet de vérifier que le verdict « recherche cassée » EXPIRE,
  // sans attendre 10 minutes pour de vrai.
  await page.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    window.__timeShift = 0;
    Date.now = () => realNow() + window.__timeShift;
  });
  await page.goto(origin);
  await page.evaluate(() => {
    localStorage.setItem('wm_onboarding_done', '1');
    localStorage.setItem('wm_autobid_armed', '0');
    localStorage.setItem('wm_watchlist', JSON.stringify([{ kw: 'eiffage', mode: 'manuel' }]));
  });
  await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
  await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200,
    contentType: 'application/json', body: '{"balance":1000}' }));
  await page.route('**/api/marketplace**', route => {
    const url = route.request().url();
    if (/\/mine/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"won":[],"auctions":[]}' });
    }
    if (/\/cards\//.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ summary: { SR: { average: 42 } } }) });
    }
    listUrls.push(url);
    const u = new URL(url);
    const p = Number(u.searchParams.get('page') || 1);
    const q = u.searchParams.get('q');
    const pool = (q && honourQ) ? MATCHES : MARKET;
    const slice = pool.slice((p - 1) * 50, p * 50);
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ auctions: slice, page: p, limit: 50, hasMore: p * 50 < pool.length }) });
  });

  await page.evaluate(script).catch(e => errors.push(String(e)));
  await page.waitForTimeout(700);
  await page.evaluate(() => document.getElementById('wm-market-btn').click());
  await page.waitForTimeout(7000);

  let secondPassUrls = null;
  if (advanceMs) {
    // On avance l'horloge : le verdict doit être réexaminé au scan suivant.
    listUrls.length = 0;
    await page.evaluate(ms => { window.__timeShift = ms; }, advanceMs);
    await page.waitForTimeout(12000);
    secondPassUrls = [...listUrls];
  }

  const log = await page.evaluate(() =>
    [...document.querySelectorAll('.wm-log-e')].map(e => e.innerText).join('\n'));
  await page.close();
  errors.forEach(e => problems.push(`[honourQ=${honourQ}] erreur page : ${e}`));
  return { listUrls: [...listUrls], secondPassUrls, log };
}

const problems = [];

/* ── 1. Le site filtre, mais le mot n'est dans aucun champ renvoyé ─────────── */
// C'est le cas de production. Le bot doit RESTER sur `q=`.
const hidden = await run({ honourQ: true });
const qCalls = hidden.listUrls.filter(u => /[?&]q=/.test(u)).length;
const plainCalls = hidden.listUrls.filter(u => !/[?&]q=/.test(u)).length;
if (!qCalls) problems.push("la recherche serveur n'est pas utilisée du tout");
if (/balayage complet/.test(hidden.log)) {
  problems.push('une recherche qui filtre est déclarée cassée — le bot repart sur le marché entier');
}
if (plainCalls > 2) {
  problems.push(`${plainCalls} requêtes non filtrées : c'est un balayage, pas une recherche`);
}
if (!/Tours Mercuriales|Benoît de Ruffray/.test(hidden.log)) {
  problems.push('aucune des annonces trouvées par la recherche serveur ne remonte dans les résultats');
}

/* ── 2. L'API ignore vraiment `q` : le repli doit se déclencher ────────────── */
// Témoin négatif : sans lui, une sonde qui dirait toujours « ça marche » passerait le 1.
const ignored = await run({ honourQ: false });
if (!/balayage complet/.test(ignored.log)) {
  problems.push("une API qui ignore q n'est pas détectée — le bot croit chercher alors qu'il reçoit tout");
}

/* ── 3. Le verdict « cassé » doit EXPIRER ──────────────────────────────────── */
// Même API cassée au départ, puis on avance l'horloge de 11 min : le bot doit re-sonder.
const recovered = await run({ honourQ: false, advanceMs: 11 * 60 * 1000 });
if (!/Nouvelle tentative de recherche serveur/.test(recovered.log)) {
  problems.push('le verdict « recherche cassée » est définitif : plus aucune tentative, balayage complet à vie');
}
if (recovered.secondPassUrls && !recovered.secondPassUrls.some(u => /[?&]q=/.test(u))) {
  problems.push("après expiration du verdict, aucune requête q= n'est retentée");
}

await browser.close();
srv.close();

if (problems.length) {
  console.error('❌ sonde de la recherche serveur :');
  for (const p of problems) console.error('  · ' + p);
  console.error(`  — filtrée : ${qCalls} requête(s) q=, ${plainCalls} sans q`);
  console.error('  — log (cas réel) :\n' + hidden.log.split('\n').slice(0, 10).map(l => '      ' + l).join('\n'));
  process.exit(1);
}
console.log(`✅ recherche indexée sur un champ absent → toujours q= (${qCalls} requête(s)) · q ignoré → repli détecté · verdict réexaminé après 10 min`);
