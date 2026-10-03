// Les boutons de mode (Manuel / Auto-bid / Fourbe) et la mise manuelle, dans les 3 vues.
//   node tests/bid-mode-ui.test.mjs      (ou ./scripts/test.sh)
//
// Retour d'usage : « le mode manuel / fourbe / auto-bid ne fonctionne pas, au niveau de
// l'affichage ou même au niveau de la mise ». Les logs montraient des cycles en rafale
// (Manuel → Auto-bid → Fourbe → Manuel…) avec un titre « ? » : le bouton ne se repeignait
// pas, donc l'utilisateur recliquait, et chaque clic faisait bien avancer le mode d'un cran
// sans que rien ne le montre.
//
// Deux causes : le re-render complet de la liste est VOLONTAIREMENT ignoré tant qu'un champ
// du panneau a le focus (le champ « plafond » est juste à côté du bouton) — et c'est sur lui
// seul que reposait la mise à jour du bouton. Et le titre ne venait que d'activeHitsMap,
// vidée à chaque redémarrage du Market Watcher alors que les cartes restent affichées.
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

const AUCTION = {
  id: 'a-eiffage', base_amount: 40, current_bid: null, current_bidder: null,
  end_at: new Date(Date.now() + 4 * 3600_000).toISOString(),
  card: { id: 'c1', wikipedia_title: 'Eiffage', rarity: 'SR', category: 'entreprise' },
};

// `race` : le 1er POST est refusé comme si un autre joueur venait de miser.
async function run({ view, race, clicks }) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const bids = [];
  let rival = null;

  await page.goto(origin);
  await page.evaluate(v => {
    localStorage.setItem('wm_onboarding_done', '1');
    localStorage.setItem('wm_autobid_armed', '1');
    localStorage.setItem('wm_global_bid_cap', '5000');
    localStorage.setItem('wm_market_view', v);
    localStorage.setItem('wm_watchlist', JSON.stringify([{ kw: 'eiffage', mode: 'manuel' }]));
  }, view);

  await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
  await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200,
    contentType: 'application/json', body: '{"balance":10000}' }));
  await page.route('**/api/marketplace**', route => {
    const url = route.request().url();
    if (route.request().method() === 'POST' && /\/bid$/.test(url)) {
      let amount = null;
      try { amount = JSON.parse(route.request().postData() || '{}').amount; } catch {}
      bids.push(amount);
      if (race && bids.length === 1) {
        rival = 60; // sa mise passe, le minimum bouge
        return route.fulfill({ status: 400, contentType: 'application/json',
          body: '{"error":"Le montant doit etre superieur a la mise actuelle"}' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    const live = { ...AUCTION, current_bid: rival,
      current_bidder: rival ? { username: 'seloutou' } : null };
    if (/\/marketplace\/a-eiffage(\?|$)/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ auction: live }) });
    }
    if (/\/mine/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"won":[],"auctions":[]}' });
    }
    if (/\/cards\//.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"summary":{}}' });
    }
    const u = new URL(url);
    const p = Number(u.searchParams.get('page') || 1);
    const q = u.searchParams.get('q');
    const pool = q ? [live] : [{ ...live, id: 'other', card: { ...live.card, wikipedia_title: 'Autre' } }];
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ auctions: p === 1 ? pool : [], page: p, limit: 50, hasMore: false }) });
  });

  await page.evaluate(script).catch(e => errors.push(String(e)));
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    document.getElementById('wm-market-btn').click();
    const f = document.getElementById('wm-fab'); if (f) f.click();
  });
  await page.waitForTimeout(5000);

  // Le champ « plafond » est juste à côté du bouton : on lui donne le focus, exactement
  // comme quand l'utilisateur vient d'y taper un montant. C'est cet état qui faisait
  // sauter le re-render de la liste.
  const labels = [];
  // « Cadres » : un seul bouton à 3 états. « Détaillée » : deux boutons ON/OFF séparés.
  const modeBtnSel = view === 'cards' ? '[data-wm-mode-btn]' : '#wm-autobid-a-eiffage';
  await page.evaluate(() => {
    const cap = document.getElementById('wm-autobidmax-a-eiffage');
    if (cap) cap.focus();
    /* Un (re)démarrage du Market Watcher vide activeHitsMap alors que les cartes restent
       affichées à l'écran : c'est l'état exact dans lequel les logs de l'utilisateur
       nommaient les cartes « ? ». Le titre doit rester résoluble via le cache de rendu. */
    if (window.activeHitsMap) window.activeHitsMap.clear();
  });
  labels.push(await page.evaluate(sel => {
    const b = document.querySelector(sel);
    return b ? b.innerText.trim() : '(bouton absent)';
  }, modeBtnSel));
  for (let i = 0; i < (clicks || 1); i++) {
    await page.evaluate(sel => {
      const b = document.querySelector(sel);
      if (b) b.click();
    }, modeBtnSel);
    await page.waitForTimeout(400);
    labels.push(await page.evaluate(sel => {
      const b = document.querySelector(sel);
      return b ? b.innerText.trim() : '(bouton absent)';
    }, modeBtnSel));
  }

  const state = await page.evaluate(() => ({
    autoBid: [...(window.autoBidSet || [])],
    snipe: [...(window.snipeSet || [])],
    log: [...document.querySelectorAll('.wm-log-e')].map(e => e.innerText).join('\n'),
  }));

  // Mise manuelle
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /Miser|^🔨$/.test(x.innerText));
    if (b) b.click();
  });
  await page.waitForTimeout(3000);
  const afterBid = await page.evaluate(() =>
    [...document.querySelectorAll('.wm-log-e')].map(e => e.innerText).join('\n'));

  await page.close();
  errors.forEach(e => problems.push(`[${view}] erreur page : ${e}`));
  return { labels, bids, ...state, afterBid };
}

const problems = [];
const results = {};

// « Cadres » : 2 clics mènent au Fourbe. « Détaillée » : 1 clic arme l'auto-bid.
// (La vue « compacte » n'affiche volontairement aucun bouton de mode sur sa ligne :
//  elle réutilise le balisage détaillé une fois la ligne dépliée.)
for (const [view, clicks] of [['cards', 2], ['detailed', 1]]) {
  const r = await run({ view, race: false, clicks });
  results[view] = r;
  // Le mode doit AVANCER dans les données…
  if (!r.autoBid.length && !r.snipe.length) {
    problems.push(`[${view}] aucun mode armé après ${clicks} clic(s) (auto-bid et fourbe vides)`);
  }
  // …ET se voir sur le bouton, même avec le focus dans le champ plafond.
  if (r.labels[0] === r.labels[r.labels.length - 1]) {
    problems.push(`[${view}] le bouton affiche « ${r.labels[0]} » avant ET après le clic — rien ne bouge à l'écran`);
  }
  if (/: \?/.test(r.log)) {
    problems.push(`[${view}] le log nomme la carte « ? » au lieu de son titre`);
  }
  if (!/Eiffage/.test(r.log)) {
    problems.push(`[${view}] le titre de la carte n'apparaît nulle part dans le log`);
  }
}

/* La mise manuelle doit rattraper une surenchère simultanée, comme les mises auto. */
const raced = await run({ view: 'cards', race: true, clicks: 1 });
if (raced.bids.length < 2) {
  problems.push(`mise manuelle refusée par une surenchère simultanée : ${raced.bids.length} essai — elle est perdue`);
} else if (!(raced.bids[1] > raced.bids[0])) {
  problems.push(`mise manuelle : la relance ne monte pas (${raced.bids.join(' → ')})`);
}
if (!/Mise manuelle/.test(raced.afterBid)) {
  problems.push("la mise manuelle n'est pas journalisée");
}

await browser.close();
srv.close();

if (problems.length) {
  console.error('❌ boutons de mode / mise manuelle :');
  for (const p of problems) console.error('  · ' + p);
  for (const [v, r] of Object.entries(results)) {
    console.error(`  — ${v} : libellés ${JSON.stringify(r.labels)} · auto-bid ${JSON.stringify(r.autoBid)} · fourbe ${JSON.stringify(r.snipe)}`);
  }
  console.error('  — mise manuelle en course : ' + JSON.stringify(raced.bids));
  process.exit(1);
}
console.log(`✅ 2 vues à boutons : bouton repeint malgré le focus dans le plafond · titre résolu · mise manuelle rattrapée (${raced.bids.join(' → ')})`);
