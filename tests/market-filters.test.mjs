// Filtres d'affichage du Market Watcher : rareté, mot-clé, et vidage de la liste.
//   node tests/market-filters.test.mjs      (ou ./scripts/test.sh)
//
// Ces trois commandes ne touchent PAS au scan : elles ne changent que ce qui est montré.
// Le test vérifie donc à la fois qu'elles filtrent correctement ET qu'elles se combinent,
// puis que le bouton « Vider » efface bien la liste.
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
const mk = (id, title, cat, rarity) => ({
  id, base_amount: 10, current_bid: null, current_bidder: null, status: 'active',
  end_at: iso(3 * 3600_000),
  card: { id: 'card-' + id, wikipedia_title: title, rarity, category: cat },
});
// Deux mots-clés × plusieurs raretés : de quoi vérifier chaque filtre et leur combinaison.
const BY_KW = {
  femme: [mk('f1', 'Alpha', 'femme politique', 'UR'),
          mk('f2', 'Beta', 'femme politique', 'SR'),
          mk('f3', 'Gamma', 'femme politique', 'C')],
  chat:  [mk('c1', 'Delta', 'chat domestique', 'UR'),
          mk('c2', 'Epsilon', 'chat sauvage', 'C')],
};

await page.goto(origin);
await page.evaluate(() => {
  localStorage.setItem('wm_onboarding_done', '1');
  localStorage.setItem('wm_autobid_armed', '0');
  localStorage.setItem('wm_watchlist', JSON.stringify([
    { kw: 'femme', mode: 'manuel' }, { kw: 'chat', mode: 'manuel' },
  ]));
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
  const q = (new URL(url).searchParams.get('q') || '').toLowerCase();
  return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ auctions: BY_KW[q] || [], page: 1, limit: 50, hasMore: false }) });
});

await page.evaluate(script).catch(e => errors.push(String(e)));
await page.waitForTimeout(800);
await page.evaluate(() => document.getElementById('wm-market-btn').click());
await page.waitForTimeout(6000);

// Titres réellement affichés dans le panneau, quelle que soit la vue.
const shown = () => page.evaluate(() => {
  const txt = (document.getElementById('wm-market-alert') || {}).innerText || '';
  return ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].filter(t => txt.includes(t));
});

const all = await shown();

// 1) Filtre rareté : ne garder que UR.
await page.evaluate(() => document.querySelector('#wm-rarity-filter button[data-rar="UR"]').click());
await page.waitForTimeout(600);
const onlyUR = await shown();

// 2) Rareté UR + mot-clé « femme » : les deux filtres doivent se cumuler.
await page.evaluate(() => {
  const sel = document.getElementById('wm-keyword-filter');
  sel.value = 'femme';
  sel.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(600);
const urAndFemme = await shown();

// 3) Retour à tout : on éteint les deux filtres.
await page.evaluate(() => {
  document.querySelector('#wm-rarity-filter button[data-rar="UR"]').click();
  const sel = document.getElementById('wm-keyword-filter');
  sel.value = '';
  sel.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(600);
const backToAll = await shown();

// 4) Vider la liste.
await page.evaluate(() => document.getElementById('wm-clear-hits').click());
await page.waitForTimeout(600);
const afterClear = await shown();

await browser.close();
srv.close();

const eq = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const problems = [];
if (!eq(all, ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'])) {
  problems.push(`départ : ${all.join(', ') || 'aucune'} — attendu les 5 annonces`);
}
if (!eq(onlyUR, ['Alpha', 'Delta'])) {
  problems.push(`filtre UR : ${onlyUR.join(', ') || 'aucune'} — attendu Alpha et Delta`);
}
if (!eq(urAndFemme, ['Alpha'])) {
  problems.push(`UR + « femme » : ${urAndFemme.join(', ') || 'aucune'} — attendu Alpha seule (les filtres doivent se cumuler)`);
}
if (!eq(backToAll, ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'])) {
  problems.push(`retour à tout : ${backToAll.join(', ') || 'aucune'} — les filtres doivent être réversibles`);
}
if (afterClear.length) problems.push(`après vidage : ${afterClear.join(', ')} — la liste doit être vide`);
for (const e of errors) problems.push('erreur page : ' + e);

if (problems.length) {
  console.error('❌ filtres du Market Watcher :');
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}
console.log(`✅ ${all.length} annonces · UR → ${onlyUR.length} · UR+femme → ${urAndFemme.length} · réversible · vidage OK`);
