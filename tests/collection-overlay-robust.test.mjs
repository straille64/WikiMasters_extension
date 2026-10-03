// Surcouche Collection : les cas qui laissaient des cartes sans cote ni bouton.
//   node tests/collection-overlay-robust.test.mjs      (ou ./scripts/test.sh)
//
// Retour d'usage (capture du 28/09) : « il y a des cartes qui ne possèdent pas le prix
// moyen ni même le logo trash » — et « parfois le prix ne charge pas ou j'ai un “?”,
// pourtant quand je regarde à la main il y a bien un prix ». Quatre causes :
//   1. les cartes SANS illustration (logo « WM » à la place) n'étaient jamais reconnues :
//      la détection partait de l'image dont l'alt égale le titre ;
//   2. une cote refusée une fois (ou écartée pendant une pause du site) n'était plus
//      jamais redemandée : l'observateur de visibilité se désabonnait après 1 passage ;
//   3. une carte jamais vendue ({"summary":{}}) n'était pas mémorisée : « ⋯ » à vie, et
//      redemandée à chaque passage ;
//   4. un titre absent de l'index (espace insécable, réponse non interceptée) laissait
//      la tuile nue.
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

const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
// Tuile réelle du site. `withImage=false` : carte sans illustration Wikipédia — le site
// affiche alors son logo « WM » (un SVG), et l'<img alt="titre"> n'existe PAS.
const tile = (title, rarity, withImage) => `
<div class="relative isolate group"><div class="w-[10rem] h-[14rem] relative rounded-2xl overflow-hidden cursor-pointer">
  <img alt="" decoding="async" class="object-cover" src="${GIF}">
  <div class="absolute top-0 left-0 right-0 h-[45%] z-20 bg-black/20"><div class="relative h-full w-full min-h-0">
    ${withImage
      ? `<img alt="${title}" loading="lazy" class="object-cover" src="${GIF}">`
      : `<svg class="wm-logo-placeholder" viewBox="0 0 24 24" aria-hidden="true"><path d="M0 0h24v24H0z"/></svg>`}
  </div></div>
  <div class="absolute top-2 left-2 px-2 py-0.5 rounded-md text-xs font-bold z-30">${rarity}</div>
  <div class="absolute top-2 right-2 z-30 flex flex-col items-end gap-1">
    <button type="button" class="p-0.5 rounded-md" aria-label="Ajouter aux favoris"><svg viewBox="0 0 24 24"></svg></button>
  </div>
  <div class="absolute top-[45%] left-0 right-0 bottom-0 flex min-h-0 flex-col p-3 z-20">
    <h3 class="text-xs shrink-0 font-bold leading-tight line-clamp-2 text-black">${title}</h3>
    <p class="min-h-0 leading-snug text-[9px] shrink-0">sous-titre</p>
  </div>
</div></div>`;

// id interne → [titre affiché dans le <h3>, rareté, a une image ?, cote]
const CARDS = {
  'c-image':   ['Tomb Raider III', 'R', true,  { R: { average: 18 } }],
  'c-noimg':   ['Pierre Berger (homme d\'affaires)', 'R', false, { R: { average: 12 } }],   // cause 1
  'c-heal':    ['Molinisme', 'R', true,  { R: { average: 31 } }],                            // cause 2
  'c-empty':   ['Rydge Conseil', 'R', false, null],                                           // cause 3
  // cause 4 : le <h3> porte une espace insécable ; l'API, une espace normale.
  'c-nbsp':    ['Véra Belmont', 'R', false, { R: { average: 9 } }],
  // cause 4 bis : carte absente de la réponse /api/my-collection interceptée.
  'c-missing': ['DoTerra', 'R', false, { R: { average: 22 } }],
};
const apiTitle = id => CARDS[id][0].replace(/ /g, ' ');

const srv = http.createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>wm</title></head><body>
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      ${Object.values(CARDS).map(([t, r, img]) => tile(t, r, img)).join('')}
    </div>
  </body></html>`);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;

let browser;
try { browser = await chromium.launch({ executablePath: findChrome() }); }
catch { console.log('⏭️  Chromium introuvable — test sauté'); srv.close(); process.exit(0); }

const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
// Horloge pilotable : on vérifie que le blocage d'une cote refusée EXPIRE et qu'elle
// est alors redemandée, sans attendre une vraie minute.
await page.addInitScript(() => {
  const realNow = Date.now.bind(Date);
  window.__timeShift = 0;
  Date.now = () => realNow() + window.__timeShift;
});

const salesAsked = {};          // card id → nombre de demandes
let healFailsLeft = 1;          // la 1re demande pour c-heal échoue (500)
let titleLookups = 0;

await page.goto(origin + '/collection');
await page.evaluate(() => {
  localStorage.setItem('wm_onboarding_done', '1');
  localStorage.setItem('wm_autobid_armed', '0');
  localStorage.setItem('wm_trash_tag_id', 'tag-trash-1');
  const payload = btoa(JSON.stringify({ sub: 'user-test-1', exp: 4102444800 }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem('sb-cyrxjeppjqsxxjayfrur-auth-token',
    JSON.stringify({ access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.sig` }));
});

await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
// La collection interceptée contient toutes les cartes SAUF c-missing.
await page.route('**/api/my-collection**', r => r.fulfill({ status: 200, contentType: 'application/json',
  body: JSON.stringify({ collection: Object.keys(CARDS).filter(id => id !== 'c-missing').map(id => ({
    card_id: id, count: 1, card: { id, wikipedia_title: apiTitle(id), rarity: CARDS[id][1] } })) }) }));
await page.route('**/api/marketplace/cards/*/sales**', r => {
  const id = r.request().url().match(/cards\/([^/]+)\/sales/)[1];
  salesAsked[id] = (salesAsked[id] || 0) + 1;
  // 500 (pas 403) : blocage de CETTE carte seulement, sans pause globale du site.
  if (id === 'c-heal' && healFailsLeft-- > 0) {
    return r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
  }
  const summary = CARDS[id] ? (CARDS[id][3] || {}) : {};
  return r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ wikipedia_title: 'x', summary, isPro: false }) });
});
await page.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
// Repli pour les titres inconnus : la table `cards`, interrogée en un seul lot.
await page.route('**/rest/v1/cards?**', r => {
  const url = decodeURIComponent(r.request().url());
  if (!/wikipedia_title=in\./.test(url)) {
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  }
  titleLookups++;
  const rows = Object.keys(CARDS)
    .filter(id => url.includes(`"${apiTitle(id)}"`))
    .map(id => ({ id, wikipedia_title: apiTitle(id) }));
  return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
});

await page.evaluate(script).catch(e => errors.push(String(e)));
await page.evaluate(() => fetch('/api/my-collection?page=0&limit=200').catch(() => {}));
await page.waitForTimeout(7000);

const badgeOf = () => page.evaluate(() => {
  const out = {};
  for (const h3 of document.querySelectorAll('h3')) {
    const tile = h3.closest('[data-wm-decorated="1"]');
    const b = tile && tile.querySelector('.wm-coll-price');
    const t = tile && tile.querySelector('.wm-coll-trash');
    out[h3.textContent.replace(/ /g, ' ')] = { badge: b ? b.textContent : null, trash: !!t };
  }
  return out;
});

const first = await badgeOf();
const healBefore = first['Molinisme'] && first['Molinisme'].badge;
const emptyAskedBefore = salesAsked['c-empty'] || 0;

// On avance l'horloge au-delà du blocage (1 min après un 1er refus) et on laisse passer
// deux tics de réparation (5 s chacun).
await page.evaluate(() => { window.__timeShift = 2 * 60 * 1000; });
await page.waitForTimeout(11000);
const after = await badgeOf();
const emptyAskedAfter = salesAsked['c-empty'] || 0;

await browser.close();
srv.close();

const problems = [];
const expectPrice = (title, value) => {
  const b = after[title];
  if (!b || !b.badge) { problems.push(`« ${title} » : aucune cote affichée`); return; }
  if (!b.badge.includes(`≈ ${value}`)) problems.push(`« ${title} » : « ${b.badge} » au lieu de ≈ ${value}`);
};

// 1. La carte SANS image est décorée comme les autres.
if (!after["Pierre Berger (homme d'affaires)"] || !after["Pierre Berger (homme d'affaires)"].trash) {
  problems.push("carte sans illustration : pas de bouton de défausse — elle n'est pas reconnue");
}
expectPrice("Pierre Berger (homme d'affaires)", 12);
// Contre-épreuve : la carte AVEC image reste décorée (rien de cassé pour le cas courant).
expectPrice('Tomb Raider III', 18);

// 2. Cote refusée une fois → redemandée d'elle-même et affichée.
if (!/\?/.test(healBefore || '')) {
  problems.push(`« Molinisme » affichait « ${healBefore} » après le refus — attendu « ? » (le scénario ne prouve rien sinon)`);
}
expectPrice('Molinisme', 31);
if ((salesAsked['c-heal'] || 0) < 2) {
  problems.push(`« Molinisme » demandée ${salesAsked['c-heal'] || 0} fois — la cote refusée n'est jamais redemandée`);
}

// 3. Carte jamais vendue : « — » (réponse connue), pas « ⋯ », et pas redemandée en boucle.
const empty = after['Rydge Conseil'];
if (!empty || !/—/.test(empty.badge || '')) {
  problems.push(`carte jamais vendue : « ${empty && empty.badge} » au lieu de « — »`);
}
if (emptyAskedAfter > emptyAskedBefore) {
  problems.push(`carte jamais vendue redemandée ${emptyAskedAfter - emptyAskedBefore} fois de plus — la réponse vide n'est pas mémorisée`);
}

// 4. Titres : espace insécable, et carte absente de la réponse interceptée.
expectPrice('Véra Belmont', 9);
if (!after['DoTerra'] || !after['DoTerra'].trash) {
  problems.push('carte absente de la réponse interceptée : jamais décorée (le repli par titre ne marche pas)');
}
expectPrice('DoTerra', 22);
if (titleLookups > 2) problems.push(`${titleLookups} recherches de titres — le repli doit rester groupé et rare`);

for (const e of errors) problems.push('erreur page : ' + e);

if (problems.length) {
  console.error('❌ surcouche Collection (cas limites) :');
  for (const p of problems) console.error('  · ' + p);
  console.error('  — état final : ' + JSON.stringify(after));
  console.error('  — demandes de cote : ' + JSON.stringify(salesAsked));
  process.exit(1);
}
console.log(`✅ carte sans image décorée · « ? » réparé tout seul (${salesAsked['c-heal']} demandes) · jamais vendue → « — » sans boucle · espace insécable et titre manquant résolus (${titleLookups} recherche groupée)`);
