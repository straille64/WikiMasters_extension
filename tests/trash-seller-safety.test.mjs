// Garde-fous du Trash Seller : ne jamais vendre une carte qu'on n'a pas visée.
//   node tests/trash-seller-safety.test.mjs      (ou ./scripts/test.sh)
//
// Deux comportements dangereux constatés en production :
//   1. le drapeau sessionStorage relançait le Trash Seller à CHAQUE chargement du script :
//      arriver sur /collection suffisait pour que le bot clique sur des cartes et les mette
//      en vente sans aucune action de l'utilisateur ;
//   2. sellCardViaUI cliquait « Lancer l'enchère » sans vérifier quelle carte la fenêtre
//      affichait — n'importe quel décalage de la grille vendait la mauvaise carte.
// Une mise en vente est irréversible : ces deux points se testent, pas se relisent.
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

// Fausse page collection : barre de recherche + 2 tuiles cliquables + la fenêtre de vente.
// La fenêtre affiche le titre cherché SAUF pour « Carte piégée » : elle affiche alors une
// AUTRE carte, ce qui reproduit exactement le décalage de grille observé.
const PAGE_HTML = `<!doctype html><html><head><title>wm</title></head><body>
  <input placeholder="Rechercher par titre ou catégorie...">
  <div class="cursor-pointer" data-tile="1"><span>Carte sûre</span></div>
  <div class="cursor-pointer" data-tile="2"><span>Carte piégée</span></div>
  <button id="open-sell">Mettre aux enchères</button>
  <div id="sell-modal" role="dialog" style="position:fixed;display:none;">
    <p class="font-semibold text-sm truncate" id="modal-title"></p>
    <input aria-label="Mise de départ">
    <button id="launch">Lancer l'enchère</button>
    <button>Annuler</button>
  </div>
  <script>
    window.__launched = [];
    window.__dismissed = 0;
    document.getElementById('open-sell').addEventListener('click', () => {
      const q = document.querySelector('input[placeholder^="Rechercher"]').value;
      // Le décalage : pour cette carte la fenêtre montre autre chose que ce qui est cherché.
      document.getElementById('modal-title').textContent = (q === 'Carte piégée') ? 'Carte sûre' : q;
      document.getElementById('sell-modal').style.display = 'block';
      armLaunch();
    });
    function armLaunch() {
      // Le bouton est recréé à chaque ouverture : côté site il disparaît avec la page après
      // une vente réussie, mais la carte SUIVANTE doit retrouver une fenêtre utilisable.
      let b = document.getElementById('launch');
      if (!b) {
        b = document.createElement('button');
        b.id = 'launch';
        b.textContent = "Lancer l'enchère";
        document.getElementById('sell-modal').insertBefore(b, document.getElementById('sell-modal').lastElementChild);
      }
      b.onclick = () => {
        window.__launched.push(document.getElementById('modal-title').textContent);
        // Le site poste lui-même l'enchère. En production, le bouton peut rester monté
        // plusieurs secondes après : on reproduit CE cas, celui qui faisait déclarer
        // « modal_still_open » des ventes pourtant bien créées.
        fetch('/api/marketplace', { method: 'POST', headers: { 'x-fixture': '1' }, body: '{}' });
      };
    }
    armLaunch();
    document.querySelectorAll('#sell-modal button').forEach(b => {
      if (b.textContent.trim() === 'Annuler') b.addEventListener('click', () => {
        window.__dismissed++;
        document.getElementById('sell-modal').style.display = 'none';
      });
    });
  </script>
</body></html>`;

const srv = http.createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE_HTML);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;

let browser;
try { browser = await chromium.launch({ executablePath: findChrome() }); }
catch { console.log('⏭️  Chromium introuvable — test sauté'); srv.close(); process.exit(0); }

const POOL = [
  { cardId: 'sure', title: 'Carte sûre', rarity: 'SR' },      // témoin positif : doit être vendue
  { cardId: 'piege', title: 'Carte piégée', rarity: 'C' },     // doit être REFUSÉE
];

const problems = [];

async function run({ autoResume }) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/collection');
  await page.evaluate(auto => {
    localStorage.setItem('wm_onboarding_done', '1');
    localStorage.setItem('wm_autobid_armed', '0');
    localStorage.setItem('wm_watchlist', '[]');
    localStorage.setItem('wm_trash_sell_strategy', 'rarity'); // SR avant C : ordre prévisible
    localStorage.setItem('wm_max_active_sales', '5');
    localStorage.setItem('wm_sell_undercut_market', 'false');  // prix stables, moins de requêtes
    localStorage.setItem('wm_sell_use_market_price', 'false');
    if (auto) localStorage.setItem('wm_sell_auto_resume', 'true');
    // LE point du test : le Trash Seller « tournait » avant le rechargement.
    sessionStorage.setItem('wm_trashseller_active', '1');
  }, autoResume);

  await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
  await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200,
    contentType: 'application/json', body: '{"balance":1000}' }));
  await page.route('**/api/my-collection**', r => r.fulfill({ status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ total: POOL.length, collection: POOL.map(p => ({
      card_id: p.cardId, tags: [{ name: 'Trash' }],
      card: { id: p.cardId, wikipedia_title: p.title, rarity: p.rarity },
    })) }) }));
  await page.route('**/api/marketplace**', route => {
    const url = route.request().url();
    // POST = mise en vente par l'API : on la casse pour forcer le contournement DOM,
    // qui est le chemin où vit le garde-fou qu'on teste.
    if (route.request().method() === 'POST') {
      // Le POST du SITE (déclenché par la fenêtre) réussit ; celui que le bot tente en
      // direct échoue, ce qui le force sur le contournement DOM — le chemin testé ici.
      if (route.request().headers()['x-fixture']) {
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: '{"auction_id":"auction-fixture-1"}' });
      }
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"ko"}' });
    }
    if (/cards\/[^/?]+\/sales/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"summary":{}}' });
    }
    if (/\/mine/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"won":[],"auctions":[]}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ auctions: [], page: 1, limit: 50, hasMore: false }) });
  });

  await page.evaluate(script).catch(e => errors.push(String(e)));
  await page.waitForTimeout(autoResume ? 22000 : 6000);

  const state = await page.evaluate(() => ({
    launched: window.__launched,
    dismissed: window.__dismissed,
    log: (document.getElementById('wm-log') || {}).innerText || '',
    flag: sessionStorage.getItem('wm_trashseller_active'),
    running: (document.getElementById('dot-trash') || { classList: { contains: () => false } })
      .classList.contains('on'),
  }));
  await page.close();
  for (const e of errors) problems.push(`[${autoResume ? 'reprise auto' : 'défaut'}] erreur page : ${e}`);
  return state;
}

/* ── 1. Par défaut : arriver sur /collection ne doit RIEN vendre ───────────────── */
const off = await run({ autoResume: false });
if (off.launched.length) {
  problems.push(`sans action de l'utilisateur, ${off.launched.length} carte(s) ont été mises en vente : ${off.launched.join(', ')}`);
}
if (off.running) problems.push('le Trash Seller est reparti tout seul alors que la reprise auto est désactivée');
if (off.flag) problems.push("le drapeau de reprise n'est pas effacé : la prochaine page redémarrerait encore le Trash Seller");
if (!/rechargement/.test(off.log)) {
  problems.push("rien n'indique à l'utilisateur que le Trash Seller ne repart pas après le rechargement");
}

/* ── 2. Reprise auto explicite : il repart, MAIS refuse la carte piégée ───────── */
const on = await run({ autoResume: true });
if (!on.launched.includes('Carte sûre')) {
  // Témoin positif : sans lui, un test « aucune vente » passerait même si tout est cassé.
  problems.push("la carte visée n'a pas été mise en vente — le test ne prouve rien sur le garde-fou");
}
if (on.launched.includes('Carte piégée')) {
  problems.push('la carte piégée a été mise en vente alors que la fenêtre affichait une autre carte');
}
// La fenêtre affichait « Carte sûre » pendant qu'on visait « Carte piégée » : si le garde-fou
// avait sauté, c'est « Carte sûre » qui serait relancée une 2e fois.
if (on.launched.filter(t => t === 'Carte sûre').length > 1) {
  problems.push('« Carte sûre » a été mise en vente deux fois — la mauvaise carte a été vendue');
}
// La vente créée doit être ENREGISTRÉE : c'est ce qui alimente « Ventes (aujourd'hui) »
// et le suivi de l'enchère. Une vente réussie mais comptée comme échec est invisible.
if (!/Mis en vente/.test(on.log)) {
  problems.push("la vente créée n'est pas enregistrée (« Mis en vente » absent du log) — la fenêtre encore montée la fait passer pour un échec");
}
if (/modal_still_open/.test(on.log)) {
  problems.push('une vente pourtant créée est déclarée en échec (modal_still_open)');
}
if (!/Vente annulée/.test(on.log)) {
  problems.push("l'abandon n'est pas journalisé (« Vente annulée » attendu dans le log)");
}
if (!on.dismissed) {
  problems.push("la fenêtre ouverte par erreur n'a pas été refermée : la carte suivante resterait bloquée");
}

await browser.close();
srv.close();

if (problems.length) {
  console.error('❌ garde-fous Trash Seller :');
  for (const p of problems) console.error('  · ' + p);
  console.error('  — défaut : ' + JSON.stringify(off));
  console.error('  — reprise auto : ' + JSON.stringify(on));
  process.exit(1);
}
console.log('✅ pas de reprise silencieuse sur /collection · carte non conforme à la fenêtre refusée (témoin positif OK)');
