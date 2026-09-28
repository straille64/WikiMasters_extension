// Mise en vente par l'interface : titres typographiques et fiche lente à s'ouvrir.
//   node tests/trash-seller-ui-robust.test.mjs      (ou ./scripts/test.sh)
//
// Logs du 28/09 : `card_not_found` sur « Équipe de voltige de l'Armée de l'air » et
// consorts, `no_sell_button` sur d'autres. Deux causes reproduites ici :
//   1. le site affiche l'apostrophe TYPOGRAPHIQUE (’) quand l'API renvoie la forme ASCII
//      ('). La recherche tapée ne trouvait rien, la comparaison exacte non plus — et, si
//      elle avait trouvé, le garde-fou « la fenêtre affiche-t-elle la bonne carte ? »
//      aurait refusé la vente pour la même raison ;
//   2. le bouton « Mettre aux enchères » était cherché UNE fois, 600 ms après le clic ;
//      une fiche plus lente à s'ouvrir donnait un échec.
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

const API_TITLE = "Équipe de voltige de l'Armée de l'air";      // ce que renvoie l'API
const SITE_TITLE = 'Équipe de voltige de l’Armée de l’air'; // ce qu'affiche le site

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>wm</title></head><body>
  <input placeholder="Rechercher par titre ou catégorie...">
  <div class="cursor-pointer" id="tile"><span>${SITE_TITLE}</span></div>
  <div id="sell-modal" role="dialog" style="position:fixed;display:none;">
    <p class="font-semibold text-sm truncate" id="modal-title"></p>
    <input aria-label="Mise de départ">
    <button id="launch">Lancer l'enchère</button>
    <button>Annuler</button>
  </div>
  <script>
    window.__typed = [];
    window.__launched = [];
    const input = document.querySelector('input[placeholder^="Rechercher"]');
    input.addEventListener('input', () => window.__typed.push(input.value));
    // La fiche met 1,2 s à afficher son bouton « Mettre aux enchères ».
    document.getElementById('tile').addEventListener('click', () => {
      setTimeout(() => {
        if (document.getElementById('open-sell')) return;
        const b = document.createElement('button');
        b.id = 'open-sell';
        b.textContent = 'Mettre aux enchères';
        b.onclick = () => {
          document.getElementById('modal-title').textContent = ${JSON.stringify(SITE_TITLE)};
          document.getElementById('sell-modal').style.display = 'block';
        };
        document.body.appendChild(b);
      }, 1200);
    });
    // Échap referme la fiche : son bouton disparaît, et le prochain clic sur la tuile
    // repart de zéro (1,2 s d'attente). Sans ça, un second essai trouverait le bouton déjà
    // là et masquerait un bot qui n'attend pas.
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const b = document.getElementById('open-sell');
      if (b) b.remove();
    });
    document.getElementById('launch').onclick = () => {
      window.__launched.push(document.getElementById('modal-title').textContent);
      fetch('/api/marketplace', { method: 'POST', headers: { 'x-fixture': '1' }, body: '{}' });
    };
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

const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(origin + '/collection');
await page.evaluate(() => {
  localStorage.setItem('wm_onboarding_done', '1');
  localStorage.setItem('wm_autobid_armed', '0');
  localStorage.setItem('wm_watchlist', '[]');
  localStorage.setItem('wm_max_active_sales', '5');
  localStorage.setItem('wm_sell_undercut_market', 'false');
  localStorage.setItem('wm_sell_use_market_price', 'false');
  localStorage.setItem('wm_sell_auto_resume', 'true');
  sessionStorage.setItem('wm_trashseller_active', '1');
});

await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"balance":1000}' }));
await page.route('**/api/my-collection**', r => r.fulfill({ status: 200, contentType: 'application/json',
  body: JSON.stringify({ total: 1, collection: [{ card_id: 'c-eq', tags: [{ name: 'Trash' }],
    card: { id: 'c-eq', wikipedia_title: API_TITLE, rarity: 'R' } }] }) }));
await page.route('**/api/marketplace**', route => {
  const url = route.request().url();
  if (route.request().method() === 'POST') {
    if (route.request().headers()['x-fixture']) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"auction_id":"auc-1"}' });
    }
    return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"ko"}' });
  }
  if (/\/mine/.test(url)) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"sellingCount":0,"maxConcurrentAuctions":5}' });
  }
  if (/cards\/[^/?]+\/sales/.test(url)) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"summary":{}}' });
  }
  return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ auctions: [], page: 1, limit: 50, hasMore: false }) });
});

await page.evaluate(script).catch(e => errors.push(String(e)));
await page.waitForTimeout(16000);

const state = await page.evaluate(() => ({
  typed: window.__typed,
  launched: window.__launched,
  log: [...document.querySelectorAll('.wm-log-e')].map(e => e.innerText).join('\n'),
}));
await browser.close();
srv.close();

const problems = [];
if (!state.launched.length) {
  problems.push("la carte n'a pas été mise en vente");
  const why = (state.log.match(/(card_not_found|no_sell_button|Vente annulée[^\n]*)/) || [])[0];
  if (why) problems.push('motif : ' + why);
}
const typed = state.typed.find(v => v) || '';
if (/['’]/.test(typed)) {
  problems.push(`terme tapé « ${typed} » : il contient l'apostrophe, que le site peut stocker sous une autre forme`);
}
if (/Vente annulée/.test(state.log)) {
  problems.push("le garde-fou a refusé la BONNE carte (apostrophe typographique contre apostrophe ASCII)");
}
if (!/Mis en vente/.test(state.log)) problems.push("aucune ligne « Mis en vente » dans le log");
if (/no_sell_button/.test(state.log)) problems.push('« no_sell_button » : la fiche lente n\'a pas été attendue');
for (const e of errors) problems.push('erreur page : ' + e);

if (problems.length) {
  console.error('❌ mise en vente par l’interface :');
  for (const p of problems) console.error('  · ' + p);
  console.error('  — tapé : ' + JSON.stringify(state.typed));
  console.error('  — log :\n' + state.log.split('\n').slice(0, 10).map(l => '      ' + l).join('\n'));
  process.exit(1);
}
console.log(`✅ titre typographique vendu (recherche « ${typed} ») · fiche lente attendue · garde-fou satisfait sans être contourné`);
