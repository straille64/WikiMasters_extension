// Non-régression : le mode d'un mot-clé décide, à lui seul, si le bot dépense.
//   node tests/watchlist-modes.test.mjs      (ou ./scripts/test.sh)
//
// Retour d'usage : « il mise sur tout maintenant ». Trois causes cumulées —
//   1. le bouton « Hunter ≤N 💰 » misait sur TOUTE nouvelle annonce sous ce seuil,
//      quel que soit le mot-clé qui l'avait fait remonter ;
//   2. les mots-clés « prioritaires » misaient sans AUCUN plafond ;
//   3. rien ne bornait le nombre de mises.
// Ce test verrouille les trois : un mot-clé MANUEL ne déclenche jamais de mise, un
// mot-clé AUTO en déclenche une, le plafond global coupe, et la limite horaire aussi.
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
const auction = (id, title, base) => ({
  id, base_amount: base, current_bid: null, current_bidder: null,
  card: { id: 'c-' + id, wikipedia_title: title, rarity: 'SR', category: 'divers' },
  end_at: iso(4 * 3600_000), status: 'active',
});

// Un scénario = un réglage de liste + les annonces vues ; on relève les mises tentées.
async function run(label, storage) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const bids = [];
  await page.goto(origin);
  await page.evaluate(st => {
    localStorage.setItem('wm_onboarding_done', '1');
    localStorage.setItem('wm_humanized_bid_delay_ms', '0');
    localStorage.setItem('wm_autosnipe_min_balance', '0');
    for (const [k, v] of Object.entries(st)) localStorage.setItem(k, v);
  }, storage);

  await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
  await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200,
    contentType: 'application/json', body: '{"balance":100000}' }));
  await page.route('**/api/marketplace**', route => {
    const url = route.request().url();
    if (route.request().method() === 'POST' && /\/bid$/.test(url)) {
      bids.push(url.match(/marketplace\/([^/]+)\/bid/)[1]);
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (/\/mine/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"won":[],"auctions":[]}' });
    }
    const p = Number(new URL(url).searchParams.get('page') || 1);
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ auctions: p === 1 ? [auction('a1', 'Chose surveillee', 80),
                                                  auction('a2', 'Autre surveillee', 90)] : [], page: p }) });
  });

  await page.evaluate(script).catch(e => errors.push(String(e)));
  await page.waitForTimeout(800);
  await page.evaluate(() => document.getElementById('wm-market-btn').click());
  await page.waitForTimeout(5000);
  const log = await page.evaluate(() =>
    [...document.querySelectorAll('.wm-log-e')].slice(0, 12).map(e => e.innerText));
  await page.close();
  return { label, bids, errors, log };
}

const WL = (mode, extra = {}) => JSON.stringify([Object.assign({ kw: 'surveillee', mode }, extra)]);
const scenarios = [
  ['MANUEL ne mise jamais', { wm_watchlist: WL('manuel'), wm_autobid_armed: '1',
                              wm_global_bid_cap: '5000', wm_max_bids_per_hour: '0' }, 0],
  ['AUTO mise',             { wm_watchlist: WL('auto'),   wm_autobid_armed: '1',
                              wm_global_bid_cap: '5000', wm_max_bids_per_hour: '0' }, 2],
  ['interrupteur en pause', { wm_watchlist: WL('auto'),   wm_autobid_armed: '0',
                              wm_global_bid_cap: '5000', wm_max_bids_per_hour: '0' }, 0],
  ['plafond global coupe',  { wm_watchlist: WL('auto'),   wm_autobid_armed: '1',
                              wm_global_bid_cap: '10', wm_max_bids_per_hour: '0' }, 0],
  ['limite horaire = 1',    { wm_watchlist: WL('auto'),   wm_autobid_armed: '1',
                              wm_global_bid_cap: '5000', wm_max_bids_per_hour: '1' }, 1],
];

const results = [];
for (const [label, storage] of scenarios) results.push(await run(label, storage));
await browser.close();
srv.close();

const problems = [];
results.forEach((r, i) => {
  const expected = scenarios[i][2];
  const uniq = [...new Set(r.bids)];
  if (uniq.length !== expected) {
    problems.push(`${r.label} : ${uniq.length} mise(s) au lieu de ${expected} (${uniq.join(', ') || 'aucune'})`);
    r.log.forEach(l => problems.push('      ' + l));
  }
  r.errors.forEach(e => problems.push(`${r.label} : erreur page — ${e}`));
});

if (problems.length) {
  console.error('❌ non-régression « modes de la liste » échouée :');
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}
console.log('✅ ' + results.map(r => `${r.label} → ${new Set(r.bids).size}`).join(' · '));
