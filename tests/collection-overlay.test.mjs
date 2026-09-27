// Surcouche Collection : cote du marché + bouton de défausse sur chaque carte.
//   node tests/collection-overlay.test.mjs      (ou ./scripts/test.sh)
//
// La grille du site est en Tailwind, sans le moindre identifiant de carte dans le DOM
// (structure relevée sur wiki-masters.com/collection, reproduite telle quelle ci-dessous).
// La tuile est donc reconnue par un invariant de CONTENU — l'image porte un `alt`
// identique au titre du <h3> — et reliée à sa carte via l'index titre → card_id que
// l'intercepteur remplit en lisant la réponse /api/my-collection du site.
//
// Vérifie : la cote s'affiche, le bouton pose bien le tag, et surtout que les cotes ne
// sont demandées QUE pour les cartes visibles — une collection de 500 cartes ne doit pas
// déclencher 500 requêtes sur l'endpoint qui se fait déjà refuser en 403.
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

// Réplique fidèle d'une tuile de la grille Collection (classes et structure réelles).
const tile = (title, subtitle) => `
<div class="relative isolate group"><div class="w-[clamp(8.4rem,43vw,10rem)] h-[clamp(11.8rem,60vw,14rem)] glow-sr relative rounded-2xl overflow-hidden cursor-pointer hover:z-10 transition-all duration-300 hover:scale-105">
  <img alt="" decoding="async" class="object-cover scale-[1.8]" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">
  <div class="absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-transparent pointer-events-none z-10"></div>
  <div class="absolute top-0 left-0 right-0 h-[45%] z-20 bg-black/20"><div class="relative h-full w-full min-h-0">
    <img alt="${title}" crossorigin="anonymous" loading="lazy" decoding="async" class="object-cover" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">
  </div></div>
  <div class="absolute top-2 left-2 px-2 py-0.5 rounded-md text-xs font-bold z-30" style="background-color: var(--color-rarity-sr);">SR</div>
  <div class="absolute top-2 right-2 z-30 flex flex-col items-end gap-1">
    <button type="button" class="p-0.5 rounded-md" aria-label="Ajouter aux favoris"><svg viewBox="0 0 24 24"></svg></button>
  </div>
  <div class="absolute top-[45%] left-0 right-0 bottom-0 flex min-h-0 flex-col p-3 z-20">
    <h3 class="text-xs shrink-0 font-bold leading-tight line-clamp-2 text-black">${title}</h3>
    <p class="min-h-0 leading-snug text-neutral-900/90 line-clamp-2 text-[9px] shrink-0">${subtitle}</p>
  </div>
</div></div>`;

// 3 cartes visibles en haut, 40 repoussées très bas : seules les premières doivent
// déclencher une requête de cote.
const VISIBLE = [['Felipe de Marichalar y Borbón', "grand d'Espagne"],
                 ['Chauchat', 'arme à feu'],
                 ['Indira Gandhi', "femme d'État indienne"]];
const FAR = Array.from({ length: 40 }, (_, i) => [`Carte lointaine ${i}`, 'hors écran']);

const srv = http.createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>wm</title></head><body>
    <div style="display:flex;flex-wrap:wrap;gap:8px">${VISIBLE.map(c => tile(c[0], c[1])).join('')}</div>
    <div style="height:4000px"></div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">${FAR.map(c => tile(c[0], c[1])).join('')}</div>
    <!-- Fenêtre modale « Mettre aux enchères » : même structure de carte, en position
         fixe. Elle ne doit PAS être décorée (le site y affiche déjà sa MOYENNE). -->
    <div style="position:fixed;inset:0;z-index:60;background:rgba(0,0,0,0.7)">
      ${tile('Hassidisme', 'mouvement religieux juif')}
    </div>
  </body></html>`);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;

let browser;
try { browser = await chromium.launch({ executablePath: findChrome() }); }
catch { console.log('⏭️  Chromium introuvable — test sauté'); srv.close(); process.exit(0); }

const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const salesAsked = [];
const tagPosts = [];

// Le script ne s'active que sur une URL de collection.
await page.goto(origin + '/collection');
await page.evaluate(() => {
  localStorage.setItem('wm_onboarding_done', '1');
  localStorage.setItem('wm_autobid_armed', '0');
  localStorage.setItem('wm_trash_tag_id', 'tag-trash-1'); // étiquette déjà connue
  // Jeton Supabase factice : la pose d'un tag passe par PostgREST, qui exige un JWT
  // porteur d'un `sub`. Sans lui, findCurrentUserCardId sort en « JWT manquant » et le
  // test échouerait pour une raison de décor, pas de code.
  const payload = btoa(JSON.stringify({ sub: 'user-test-1', exp: 4102444800 }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem('sb-cyrxjeppjqsxxjayfrur-auth-token',
    JSON.stringify({ access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.sig` }));
});

const ALL = [...VISIBLE, ...FAR];
const cardId = t => 'card-' + ALL.findIndex(c => c[0] === t);

await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
// C'est le SITE qui charge sa collection ; l'intercepteur du bot lit la réponse au vol.
await page.route('**/api/my-collection**', r => r.fulfill({ status: 200, contentType: 'application/json',
  body: JSON.stringify({ collection: ALL.map(([t]) => ({ card_id: cardId(t), count: 1,
    card: { id: cardId(t), wikipedia_title: t, rarity: 'SR' } })) }) }));
let refuseSales = true; // le site refuse d'abord au bot, comme en production
await page.route('**/api/marketplace/cards/*/sales**', r => {
  const id = r.request().url().match(/cards\/([^/]+)\/sales/)[1];
  salesAsked.push(id);
  if (refuseSales) return r.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Forbidden"}' });
  return r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ sales: [{ final_price: 40, settled_at: new Date().toISOString() },
                                   { final_price: 48, settled_at: new Date().toISOString() }] }) });
});
// Supabase : état des étiquettes, pose et retrait. On tient un état serveur simulé
// pour vérifier la BASCULE, et pas seulement qu'une requête part.
let taggedOnServer = false;
const tagDeletes = [];
await page.route('**/rest/v1/user_cards**', r => r.fulfill({ status: 200, contentType: 'application/json',
  body: JSON.stringify([{ id: 'uc-1', user_card_tags: taggedOnServer ? [{ tag_id: 'tag-trash-1' }] : [] }]) }));
await page.route('**/rest/v1/user_card_tags**', r => {
  const m = r.request().method();
  if (m === 'DELETE') {
    tagDeletes.push(r.request().url());
    taggedOnServer = false;
    // `return=representation` : le serveur renvoie les lignes supprimées.
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'link-1' }]) });
  }
  if (m === 'POST') {
    tagPosts.push(r.request().postData() || '');
    taggedOnServer = true;
    return r.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
  }
  // GET : liste des cartes étiquetées du compte (état initial des boutons).
  return r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(taggedOnServer ? [{ user_cards: { card_id: 'card-0' } }] : []) });
});

await page.evaluate(script).catch(e => errors.push(String(e)));
// Le site déclenche lui-même le chargement de sa collection.
await page.evaluate(() => fetch('/api/my-collection?page=0&limit=200').catch(() => {}));
await page.waitForTimeout(9000);

// Le bot s'est fait refuser la cote : le badge doit dire « ? », pas un faux prix.
const refusedText = await page.evaluate(() =>
  (document.querySelector('.wm-coll-price') || {}).textContent || '');

// Maintenant le SITE récupère lui-même la cote (c'est ce qu'il fait en ouvrant
// « Mettre aux enchères »). L'intercepteur doit la capter et remplir le badge,
// sans que le bot ait à redemander quoi que ce soit.
refuseSales = false;
const askedBefore = salesAsked.length;
await page.evaluate(id => fetch(`/api/marketplace/cards/${id}/sales`).catch(() => {}), 'card-0');
await page.waitForTimeout(1500);
const adoptedText = await page.evaluate(() =>
  (document.querySelector('.wm-coll-price') || {}).textContent || '');
const askedAfter = salesAsked.length;

const state = await page.evaluate(() => {
  const badges = [...document.querySelectorAll('.wm-coll-price')];
  const first = badges[0];
  return {
    badges: badges.length,
    firstText: first ? first.textContent : '',
    buttons: document.querySelectorAll('.wm-coll-trash').length,
    // Le bouton doit avoir rejoint la pile d'icônes du site, à côté de l'étoile.
    nextToFav: !!document.querySelector('button[aria-label="Ajouter aux favoris"] + .wm-coll-trash'),
    inModal: document.querySelectorAll('div[style*="fixed"] .wm-coll-price').length,
  };
});

// 1er clic : pose l'étiquette. 2e clic : la retire. C'est la bascule qui est testée,
// pas seulement le fait qu'une requête parte.
await page.evaluate(() => document.querySelector('.wm-coll-trash').click());
await page.waitForTimeout(2500);
const btnAfter = await page.evaluate(() => document.querySelector('.wm-coll-trash').textContent);
await page.evaluate(() => document.querySelector('.wm-coll-trash').click());
await page.waitForTimeout(2500);
const btnAfter2 = await page.evaluate(() => document.querySelector('.wm-coll-trash').textContent);

await browser.close();
srv.close();

const problems = [];
if (state.badges !== ALL.length) problems.push(`${state.badges} badges de prix au lieu de ${ALL.length}`);
if (state.buttons !== ALL.length) problems.push(`${state.buttons} boutons de défausse au lieu de ${ALL.length}`);
if (!state.nextToFav) problems.push("le bouton n'est pas placé à côté de l'étoile favoris du site");
if (!/\?/.test(refusedText)) problems.push(`cote « ${refusedText} » après refus — attendu « ? », jamais un faux prix`);
if (!/≈\s*44/.test(adoptedText)) problems.push(`cote « ${adoptedText} » après la requête du SITE — la réponse du site n'a pas été captée`);
// Le bot ne doit pas avoir redemandé : c'est la requête du site qui a servi.
if (askedAfter - askedBefore !== 1) problems.push(`${askedAfter - askedBefore} requête(s) /sales pendant la reprise — une seule, celle du site, est attendue`);
// La mini-carte de la fenêtre modale ne doit pas être décorée.
if (state.inModal > 0) problems.push(`${state.inModal} carte(s) décorée(s) dans la fenêtre modale`);
// Le contrôle qui compte : seules les cartes VISIBLES sont interrogées.
if (salesAsked.length === 0) problems.push('aucune cote demandée — le scénario ne prouve rien');
if (salesAsked.length > VISIBLE.length + 2) {
  problems.push(`${salesAsked.length} cotes demandées pour ${VISIBLE.length} cartes visibles — les cartes hors écran ne doivent pas être interrogées`);
}
if (btnAfter !== '♻️') problems.push(`bouton en « ${btnAfter} » après la pose — attendu ♻️ (étiquetée)`);
if (btnAfter2 !== '🗑️') problems.push(`bouton en « ${btnAfter2} » après le retrait — attendu 🗑️ (non étiquetée)`);
if (tagPosts.length !== 1) problems.push(`${tagPosts.length} pose(s) de tag au lieu de 1`);
if (tagDeletes.length !== 1) problems.push(`${tagDeletes.length} retrait(s) de tag au lieu de 1 — la bascule ne retire pas l'étiquette`);
for (const e of errors) problems.push('erreur page : ' + e);

if (problems.length) {
  console.error('❌ surcouche Collection :');
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}
console.log(`✅ ${state.badges} cartes décorées (modale ignorée) · cote reprise du site après refus · cote ${state.firstText.trim()} · ${salesAsked.length} cote(s) demandée(s) (visibles seulement) · bascule étiquette : pose + retrait OK`);
