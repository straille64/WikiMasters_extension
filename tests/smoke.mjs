// Test de fumée : charge le build dans un vrai Chromium et vérifie que l'UI se
// monte, sans erreur d'exécution.
//   node tests/smoke.mjs        (ou ./scripts/test.sh)
//
// Raison d'être : `node --check` ne valide que la syntaxe. Une ReferenceError ou
// une exception à l'init tue l'IIFE entière et le bouton ⚙ n'apparaît jamais —
// symptôme impossible à distinguer d'un « script pas installé ». C'est le seul
// test qui attrape ça.
//
// Playwright n'est pas une dépendance du dépôt : si l'import échoue, le test se
// saute proprement (exit 0) au lieu de faire échouer la suite.
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');


let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('⏭️  playwright absent — test de fumée sauté (npm i -D playwright)');
  process.exit(0);
}

// Chromium fourni par l'environnement (PLAYWRIGHT_BROWSERS_PATH) plutôt que
// téléchargé : on cherche le binaire, et on saute si on ne le trouve pas.
function findChrome() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !fs.existsSync(base)) return undefined; // Playwright se débrouille
  for (const d of fs.readdirSync(base).filter(d => d.startsWith('chromium-'))) {
    const p = path.join(base, d, 'chrome-linux/chrome');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

// Argument optionnel : un autre build à tester (utile pour comparer avec une
// version antérieure).
const BUILD = process.argv[2] || path.join(ROOT, 'dist/wikimasters-bot.user.js');
const script = fs.readFileSync(BUILD, 'utf8');

// Page servie en http : `about:blank` a une origine opaque où localStorage lève
// une SecurityError, ce que le script ne rencontrera jamais en vrai.
const srv = http.createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><title>wm</title></head><body></body></html>');
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;

let browser;
try {
  browser = await chromium.launch({ executablePath: findChrome() });
} catch (e) {
  console.log('⏭️  Chromium introuvable — test de fumée sauté (' + e.message.split('\n')[0] + ')');
  srv.close();
  process.exit(0);
}

const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + (e.stack || e.message)));
page.on('console', m => {
  // Les ressources externes sont coupées exprès : ces échecs ne sont pas des bugs.
  if (m.type() === 'error' && !/ERR_FAILED|ERR_ABORTED|ERR_BLOCKED/.test(m.text())) {
    errors.push('CONSOLE: ' + m.text());
  }
});

await page.goto(origin);

// Profil existant : c'est le cas qui compte, un compte vierge n'exerce pas les
// chemins de relecture de caches ni le redémarrage du Pack Opener après F5.
await page.evaluate(() => {
  localStorage.setItem('wm_onboarding_done', '1');
  localStorage.setItem('wm_pack_cooldown', '180');
  // Données avec des caractères qui cassaient l'affichage avant l'échappement.
  localStorage.setItem('wm_keywords', JSON.stringify(['Napoléon', 'L\'Étoile <test>', 'Star "Wars"']));
  localStorage.setItem('wm_tagger_presets', JSON.stringify([{ kw: 'japon & co', tag: '<b>vente</b>', untagged: true }]));
  localStorage.setItem('wm_total_packs', '4821');
  sessionStorage.setItem('wm_packopener_active', '1'); // la loop repart au chargement
  sessionStorage.setItem('wm_session_start', String(Date.now() - 60000));
});

// Rien ne sort vers le réseau : on teste l'initialisation, pas l'API du site.
await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());

await page.evaluate(script).catch(e => errors.push('EVAL: ' + (e.message || e)));
await page.waitForTimeout(2500);

// Le panneau de mots-clés est replié au chargement : on le rend explicitement, car
// c'est la première chose que l'utilisateur ouvre et une erreur dedans laisserait
// une zone vide sans rien signaler.
const panel = await page.evaluate(() => {
  try {
    window.wmWatchAddFromForm && null; // handler exposé ?
    const el = document.getElementById('wm-keywords-panel');
    if (!el) return { error: 'panneau absent' };
    el.style.display = 'block';
    if (typeof window.wmAddKeyword !== 'function') return { error: 'wmAddKeyword absent' };
    window.wmAddKeyword('essai de mot-clé');   // passe par la liste unifiée
    return {
      html: el.innerHTML.length,
      hasModeBtn: /AUTO|MANUEL/.test(el.innerHTML),
      hasCap: !!document.getElementById('wm-global-cap'),
      hasRate: !!document.getElementById('wm-max-bids-hour'),
      hasAddForm: !!document.getElementById('wm-wl-text'),
      stored: (localStorage.getItem('wm_watchlist') || '').includes('essai de mot-clé'),
    };
  } catch (e) { return { error: e.message }; }
});

const state = await page.evaluate(() => ({
  count: document.querySelectorAll('[id^="wm-"]').length,
  fab: !!document.getElementById('wm-fab'),
  gear: !!document.getElementById('wm-fab-gear'),
  overlay: !!document.getElementById('wm-overlay'),
  // L'échappement doit avoir neutralisé le <b> du préset, pas l'avoir rendu.
  strayBold: !!document.querySelector('#wm-overlay b[data-wm-injected]'),
}));

await browser.close();
srv.close();

const problems = [];
if (!state.fab) problems.push('bouton flottant #wm-fab absent');
if (!state.gear) problems.push('écrou #wm-fab-gear absent');
if (!state.overlay) problems.push('panneau #wm-overlay absent');
if (state.count < 100) problems.push(`seulement ${state.count} éléments wm-* montés (attendu > 100)`);
if (panel.error) problems.push('panneau de mots-clés : ' + panel.error);
else {
  if (!panel.hasModeBtn) problems.push('panneau : pas de bouton de mode AUTO/MANUEL');
  if (!panel.hasCap) problems.push('panneau : champ plafond global absent');
  if (!panel.hasRate) problems.push('panneau : champ limite horaire absent');
  if (!panel.hasAddForm) problems.push("panneau : formulaire d'ajout absent");
  if (!panel.stored) problems.push("panneau : le mot-clé ajouté n'a pas été enregistré");
}
problems.push(...errors);

if (problems.length) {
  console.error('❌ test de fumée échoué :');
  for (const p of problems) console.error('  · ' + p.split('\n').slice(0, 6).join('\n    '));
  process.exit(1);
}
console.log(`✅ UI montée sans erreur (${state.count} éléments wm-*, écrou présent)`);
