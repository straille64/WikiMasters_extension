// Non-régression : la recherche étendue trouve les cartes dont le mot n'est que
// dans la description.
//   node tests/keyword-extended.test.mjs      (ou ./scripts/test.sh)
//
// Retour d'usage : « ça n'affiche pas tous les résultats où notre mot est ». Le bot
// ne cherchait que dans `wikipedia_title` et `category`, alors que la recherche du
// site porte aussi sur le résumé — d'où des cartes bien visibles sur le marché que
// le panneau ne remontait pas.
//
// Vérifie les deux sens : étendu → trouve les trois cartes ; strict → n'en trouve
// que deux. Sans ce second contrôle, le test passerait aussi si le filtre avait
// simplement disparu.
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
// Trois formes réelles rencontrées sur le site, pour le mot « femme » :
const AUCTIONS = [
  // 1. dans le titre
  { id: 'a-titre', base_amount: 10, current_bid: null, current_bidder: null, status: 'active',
    end_at: iso(3600_000),
    card: { id: 'c1', wikipedia_title: 'Les Femmes savantes', rarity: 'SR',
            category: 'comédie de Molière', summary: 'pièce de théâtre en cinq actes.' } },
  // 2. dans la catégorie (le sous-titre affiché par le site)
  { id: 'a-categorie', base_amount: 20, current_bid: null, current_bidder: null, status: 'active',
    end_at: iso(3600_000),
    card: { id: 'c2', wikipedia_title: 'Indira Gandhi', rarity: 'UR',
            category: "femme d'État indienne", summary: 'Première ministre de l\'Inde.' } },
  // 3. UNIQUEMENT dans la description — le cas qui manquait
  { id: 'a-description', base_amount: 30, current_bid: null, current_bidder: null, status: 'active',
    end_at: iso(3600_000),
    card: { id: 'c3', wikipedia_title: 'Hidjab', rarity: 'R', category: 'vêtement',
            summary: 'Voile porté par certaines femmes musulmanes en public.' } },
];

async function run(extended) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin);
  await page.evaluate(ext => {
    localStorage.setItem('wm_onboarding_done', '1');
    localStorage.setItem('wm_autobid_armed', '0'); // aucune mise : on teste l'affichage
    localStorage.setItem('wm_watchlist', JSON.stringify([
      { kw: 'femme', mode: 'manuel', extended: ext },
    ]));
  }, extended);

  await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
  await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200,
    contentType: 'application/json', body: '{"balance":1000}' }));
  await page.route('**/api/marketplace**', route => {
    const url = route.request().url();
    if (/\/mine/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"won":[],"auctions":[]}' });
    }
    const p = Number(new URL(url).searchParams.get('page') || 1);
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ auctions: p === 1 ? AUCTIONS : [], page: p }) });
  });

  await page.evaluate(script).catch(e => errors.push(String(e)));
  await page.waitForTimeout(800);
  await page.evaluate(() => document.getElementById('wm-market-btn').click());
  await page.waitForTimeout(4500);
  const found = await page.evaluate(() => {
    const txt = (document.getElementById('wm-market-alert') || {}).innerText || '';
    return ['Femmes savantes', 'Indira Gandhi', 'Hidjab'].filter(t => txt.includes(t));
  });
  await page.close();
  return { found, errors };
}

const ext = await run(true);
const strict = await run(false);
await browser.close();
srv.close();

const problems = [];
if (ext.found.length !== 3) {
  problems.push(`étendu : ${ext.found.length}/3 cartes trouvées (${ext.found.join(', ') || 'aucune'}) — il manque celle dont le mot n'est que dans la description`);
}
if (strict.found.length !== 2 || strict.found.includes('Hidjab')) {
  problems.push(`strict : ${strict.found.length} carte(s) (${strict.found.join(', ') || 'aucune'}) — attendu exactement les 2 dont le mot est dans le titre ou la catégorie`);
}
for (const e of [...ext.errors, ...strict.errors]) problems.push('erreur page : ' + e);

if (problems.length) {
  console.error('❌ non-régression « recherche étendue » échouée :');
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}
console.log(`✅ étendu → ${ext.found.length}/3 · strict → ${strict.found.length}/3 (description exclue)`);
