// Optimisations réseau du 01/10 (captures F12) : moins de requêtes, moins d'erreurs, plus vite.
//   node tests/network-efficiency.test.mjs      (ou ./scripts/test.sh)
//
// Trois scénarios en parallèle, chacun dans son onglet :
//   A. Horloge : le site date sa réponse à la FIN de son traitement. Une réponse de 6 s ne
//      doit plus décaler l'estimation de 3 s (l'ancien calcul prenait le milieu de la requête).
//   B. Aucun mot-clé : AUCUNE page de marché, même au démarrage (fork.40) — seules
//      les enchères suivies sont relues. Une mise faite à la main sur le site est suivie ; une
//      enchère relue terminée est purgée ; une relecture ratée ne purge rien.
//   C. Trash Seller arrêté puis relancé pendant une pause : une seule boucle (avant : deux
//      boucles, donc deux fois plus de requêtes et des mises en vente en double).
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

const json = (route, body, status = 200, headers = {}) =>
  route.fulfill({ status, contentType: 'application/json', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const blockOthers = (page) => page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());

async function open(pathname, storage) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + pathname);
  await page.evaluate(st => { for (const [k, v] of Object.entries(st)) localStorage.setItem(k, v); },
    { wm_onboarding_done: '1', wm_autobid_armed: '0', ...storage });
  await blockOthers(page);
  await page.route('**/api/wikibidous**', r => json(r, { balance: 1000 }));
  return { page, errors };
}

// ── A. Horloge
async function scenarioClock() {
  // Un mot-clé : c'est la recherche (pages de marché) qui répond lentement ici.
  const { page, errors } = await open('/', { wm_watchlist: JSON.stringify([{ kw: 'rien', mode: 'manuel' }]) });
  await page.route('**/api/marketplace**', async route => {
    const url = route.request().url();
    if (/\/mine/.test(url)) return json(route, { sellingCount: 0, maxConcurrentAuctions: 5 });
    if (/[?&]page=/.test(url)) {
      // Réponse lente (6 s), datée par le « serveur » 3 s en avance, au moment où il répond.
      await new Promise(r => setTimeout(r, 6000));
      // (Le test tourne sur 127.0.0.1 : requête cross-origin, d'où l'exposition explicite de
      // l'en-tête — sur le vrai site, même origine, il est toujours lisible.)
      return json(route, { auctions: [], page: 1, limit: 50, hasMore: false }, 200,
        { date: new Date(Date.now() + 3000).toUTCString(), 'access-control-expose-headers': 'date' });
    }
    return json(route, { auctions: [] });
  });
  await page.evaluate(script).catch(e => errors.push(String(e)));
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('wm-market-btn').click());
  await page.waitForTimeout(9000);
  const offset = await page.evaluate(() => window.wmClockOffset ? window.wmClockOffset() : NaN);
  await page.close();
  return { offset, errors };
}

// ── B. Aucun mot-clé
async function scenarioNoKeyword() {
  const now = Date.now();
  const auction = (id, endInMs, bidder) => ({ id, base_amount: 50, current_bid: 60,
    current_bidder: bidder ? { username: bidder } : null, end_at: new Date(now + endInMs).toISOString(),
    card: { id: 'c-' + id, wikipedia_title: 'Carte ' + id, rarity: 'R' } });
  const { page, errors } = await open('/', {
    wm_watchlist: '[]',
    wm_username_override: 'moi',
    // m-1 vivante · m-2 vivante au démarrage, finie 10 s plus tard (relue terminée → purgée
    // par le SUIVI CIBLÉ, avec le bon gagnant) · m-3 vivante mais relecture en 404.
    wm_my_bids: JSON.stringify(['m-1', 'm-2', 'm-3']),
  });
  const listCalls = [];   // horodatage des pages de marché (balayage)
  const t0 = Date.now();
  // Sans page de marché, l'horloge serveur se recale sur la lecture du solde (serveur +3 s).
  await page.route('**/api/wikibidous**', r => json(r, { balance: 1000 }, 200,
    { date: new Date(Date.now() + 3000).toUTCString(), 'access-control-expose-headers': 'date' }));
  await page.route('**/api/marketplace**', route => {
    const url = route.request().url();
    const method = route.request().method();
    if (/\/mine/.test(url)) return json(route, { sellingCount: 0, maxConcurrentAuctions: 5 });
    const bid = url.match(/\/marketplace\/([^/?]+)\/bid/);
    if (bid && method === 'POST') return json(route, { auction_id: bid[1], current_bid: 70, bidder_balance: 930 });
    const one = url.match(/\/marketplace\/(m-\d|x-\d)(\?|$)/);
    if (one) {
      if (one[1] === 'm-3') return json(route, { error: 'introuvable' }, 404);
      if (one[1] === 'm-2') return json(route, { auction: auction('m-2', 10000, 'rival') });
      return json(route, { auction: auction(one[1], 600000, 'moi') });
    }
    if (/[?&]page=/.test(url)) {
      listCalls.push(Date.now() - t0);
      return json(route, { auctions: [auction('m-1', 600000, 'moi'), auction('m-2', 10000, 'moi'), auction('m-3', 600000, 'moi')], page: 1, limit: 50, hasMore: false });
    }
    return json(route, { auctions: [] });
  });
  await page.evaluate(script).catch(e => errors.push(String(e)));
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('wm-market-btn').click());
  await page.waitForTimeout(5000);
  // Mise faite « à la main » sur le site (même onglet) : passe par fetch, comme le site.
  await page.evaluate(() => fetch('/api/marketplace/x-9/bid', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 70 }) }));
  await page.waitForTimeout(40000);
  const st = await page.evaluate(() => ({
    offset: window.wmClockOffset ? window.wmClockOffset() : NaN,
    bids: JSON.parse(localStorage.getItem('wm_my_bids') || '[]'),
    status: (document.querySelector('#wm-market-status') || document.body).innerText,
    log: [...document.querySelectorAll('.wm-log-e')].map(e => e.innerText).join('\n'),
  }));
  await page.close();
  return { listCalls, ...st, errors };
}

// ── C. Trash Seller : Stop puis Start pendant une pause
async function scenarioTrashRestart() {
  const { page, errors } = await open('/collection', {
    wm_watchlist: '[]', wm_max_active_sales: '5', wm_sell_use_market_price: 'false',
    wm_sell_undercut_market: 'false',
  });
  const mine = [];
  const t0 = Date.now();
  await page.route('**/api/my-collection**', r => json(r, { total: 1, collection: [{ card_id: 'c-t', tags: [{ name: 'Trash' }],
    card: { id: 'c-t', wikipedia_title: 'Carte Trash', rarity: 'C' } }] }));
  await page.route('**/api/marketplace**', route => {
    const url = route.request().url();
    if (/\/mine/.test(url)) { mine.push(Date.now() - t0); return json(route, { sellingCount: 5, maxConcurrentAuctions: 5 }); }
    if (/\/sales/.test(url)) return json(route, { summary: {} });
    return json(route, { auctions: [] });
  });
  await page.evaluate(script).catch(e => errors.push(String(e)));
  await page.waitForTimeout(500);
  const click = () => page.evaluate(() => document.getElementById('wm-trash-btn').click());
  await click();                       // START : 5/5 ventes → la boucle part en pause 15 s
  await page.waitForTimeout(4000);
  await click();                       // STOP pendant la pause…
  await page.waitForTimeout(300);
  const restartAt = Date.now() - t0;
  await click();                       // …puis START aussitôt
  await page.waitForTimeout(31000);
  await page.close();
  const after = mine.filter(t => t > restartAt + 500);
  return { after, errors };
}

const [A, B, C] = await Promise.all([scenarioClock(), scenarioNoKeyword(), scenarioTrashRestart()]);
await browser.close();
srv.close();

const problems = [];
if (!(A.offset >= 2000 && A.offset <= 4200)) problems.push(`A. décalage d'horloge estimé ${A.offset} ms pour un serveur en avance de 3 000 ms (réponse de 6 s)`);
if (!(B.offset >= 2000 && B.offset <= 4200)) problems.push(`B. horloge non recalée sans page de marché (décalage estimé ${B.offset} ms pour un serveur en avance de 3 000 ms)`);
if (B.listCalls.length) problems.push(`B. ${B.listCalls.length} page(s) de marché lue(s) sans mot-clé (à ${B.listCalls.map(t => Math.round(t / 1000) + ' s').join(', ')}) — balayage inutile`);
if (!/enchère\(s\) suivie\(s\)/.test(B.status)) problems.push(`B. statut du suivi ciblé absent : « ${B.status.slice(0, 120)} »`);
if (!B.bids.includes('x-9')) problems.push('B. mise faite à la main sur le site non suivie');
if (B.bids.includes('m-2')) problems.push('B. enchère terminée (relue) jamais purgée');
else if (!/Enchère perdue[^\n]*Carte m-2[^\n]*rival/.test(B.log)) problems.push('B. m-2 purgée sans le journal « Enchère perdue … rival » (état final relu)');
if (!B.bids.includes('m-1')) problems.push('B. enchère vivante purgée à tort');
if (!B.bids.includes('m-3')) problems.push('B. enchère purgée sur une simple relecture ratée (404)');
if (C.after.length > 4) problems.push(`C. ${C.after.length} lectures /mine en 31 s après Stop/Start (deux boucles ?) : ${C.after.map(t => Math.round(t / 1000)).join(', ')} s`);
for (const [k, r] of [['A', A], ['B', B], ['C', C]]) for (const e of r.errors) problems.push(`${k}. erreur page : ${e}`);

if (problems.length) {
  console.error('❌ efficacité réseau :');
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}
console.log(`✅ horloge ${Math.round(A.offset)} ms (vrai : 3000) malgré une réponse de 6 s · sans mot-clé : aucune page de marché, suivi ciblé seulement · mise manuelle suivie · terminée purgée, 404 conservée · Stop/Start : une seule boucle (${C.after.length} /mine en 31 s)`);
