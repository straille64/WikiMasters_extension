// « sellingCount: null » ne doit PAS se lire « 0 vente active ».
//   node tests/selling-count-unknown.test.mjs      (ou ./scripts/test.sh)
//
// Logs du 27/09 : le site a cessé de renvoyer son compteur —
//   {"sellingCount":null,"maxConcurrentAuctions":5}
// `firstFinite(null)` ne rendant rien, le bot retombait sur la longueur d'une liste vide,
// concluait « 0 vente active / 5 créneaux libres » et enchaînait les mises en vente dans un
// plafond déjà plein : 50 minutes d'échecs en rafale, et le site qui refuse tout.
// Ici on vérifie qu'un compteur inconnu est RECOMPTÉ (base d'abord) et qu'aucune mise ne
// part quand le plafond est déjà atteint.
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
  res.end(`<!doctype html><html><head><title>wm</title></head><body>
    <input placeholder="Rechercher par titre ou catégorie...">
  </body></html>`);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;

let browser;
try { browser = await chromium.launch({ executablePath: findChrome() }); }
catch { console.log('⏭️  Chromium introuvable — test sauté'); srv.close(); process.exit(0); }

const POOL = [
  { cardId: 'p1', title: 'Carte une', rarity: 'R' },
  { cardId: 'p2', title: 'Carte deux', rarity: 'R' },
];

// `activeInDb` = ce que la BASE dit réellement de mes ventes en cours.
async function run({ activeInDb }) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const listings = [];   // tentatives de mise en vente (POST /api/marketplace)
  let dbAsked = 0;

  await page.goto(origin + '/collection');
  await page.evaluate(() => {
    localStorage.setItem('wm_onboarding_done', '1');
    localStorage.setItem('wm_autobid_armed', '0');
    localStorage.setItem('wm_watchlist', '[]');
    localStorage.setItem('wm_max_active_sales', '5');
    localStorage.setItem('wm_sell_use_market_price', 'false');
    localStorage.setItem('wm_sell_undercut_market', 'false');
    // JWT factice : sans `sub`, la lecture en base sort avant d'avoir posé sa question.
    const payload = btoa(JSON.stringify({ sub: 'user-test-1', exp: 4102444800 }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    localStorage.setItem('sb-cyrxjeppjqsxxjayfrur-auth-token',
      JSON.stringify({ access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.sig` }));
  });

  await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
  await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200,
    contentType: 'application/json', body: '{"balance":1000}' }));
  await page.route('**/api/my-collection**', r => r.fulfill({ status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ total: POOL.length, collection: POOL.map(p => ({
      card_id: p.cardId, tags: [{ name: 'Trash' }],
      card: { id: p.cardId, wikipedia_title: p.title, rarity: p.rarity },
    })) }) }));
  await page.route('**/rest/v1/**', r => r.fulfill({ status: 200,
    contentType: 'application/json', body: '[]' }));
  // (le générique est posé AVANT : Playwright fait gagner la route enregistrée en dernier)
  // La base : mes ventes actives, la seule source exacte quand /mine ne compte plus.
  await page.route('**/rest/v1/auctions**', route => {
    const url = route.request().url();
    if (/seller_id=eq/.test(url) && /status=eq\.active/.test(url)) {
      dbAsked++;
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(Array.from({ length: activeInDb }, (_, i) => ({
          id: 'sale-' + i, seller_id: 'user-test-1', status: 'active',
          base_amount: 20, current_bid: null,
          end_at: new Date(Date.now() + 600000).toISOString(),
        }))) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/api/marketplace**', route => {
    const url = route.request().url();
    if (route.request().method() === 'POST') {
      listings.push(url);
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"ko"}' });
    }
    if (/\/mine/.test(url)) {
      // LA réponse relevée en production : le compteur a disparu.
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: '{"sellingCount":null,"maxConcurrentAuctions":5}' });
    }
    if (/cards\/[^/?]+\/sales/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"summary":{}}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ auctions: [], page: 1, limit: 50, hasMore: false }) });
  });

  await page.evaluate(script).catch(e => errors.push(String(e)));
  await page.waitForTimeout(600);
  const started = await page.evaluate(() => {
    const b = document.getElementById('wm-trash-btn');
    if (b) b.click();
    return !!b;
  });
  await page.waitForTimeout(9000);

  const state = await page.evaluate(() => ({
    status: (document.getElementById('wm-trash-status') || {}).innerText || '',
    log: [...document.querySelectorAll('.wm-log-e')].map(e => e.innerText).join('\n'),
  }));
  await page.close();
  errors.forEach(e => problems.push(`[${activeInDb} en base] erreur page : ${e}`));
  return { listings, dbAsked, started, ...state };
}

const problems = [];

/* ── Plafond DÉJÀ plein (5/5) : aucune mise ne doit partir ─────────────────── */
const full = await run({ activeInDb: 5 });
if (!full.started) problems.push("le bouton du Trash Seller est introuvable — le test ne prouve rien");
if (full.listings.length) {
  problems.push(`5 ventes actives en base, plafond 5 : ${full.listings.length} mise(s) tentée(s) quand même`);
}
if (!full.dbAsked) {
  problems.push("le compteur inconnu n'a pas été recompté : la base n'a jamais été interrogée");
}
if (!/5\/5|5 ventes|plafond|actives/i.test(full.status + full.log)) {
  problems.push("rien n'indique que les 5 ventes actives ont été vues");
}

/* ── Un créneau libre (4/5) : la mise doit bien être tentée ────────────────── */
// Témoin positif : sans lui, un bot totalement cassé passerait le test ci-dessus.
const room = await run({ activeInDb: 4 });
if (!room.listings.length) {
  problems.push('4 ventes actives sur 5 : aucune mise tentée alors qu’un créneau est libre');
}

await browser.close();
srv.close();

if (problems.length) {
  console.error('❌ compteur de ventes actives :');
  for (const p of problems) console.error('  · ' + p);
  console.error('  — plein : ' + JSON.stringify({ listings: full.listings.length, dbAsked: full.dbAsked, status: full.status }));
  console.error('  — libre : ' + JSON.stringify({ listings: room.listings.length, dbAsked: room.dbAsked }));
  console.error('  — log (plein) :\n' + full.log.split('\n').slice(0, 12).map(l => '      ' + l).join('\n'));
  process.exit(1);
}
console.log(`✅ compteur inconnu recompté en base · 5/5 → 0 mise tentée · 4/5 → ${room.listings.length} mise(s) tentée(s)`);
