// Mode Fourbe (snipe) et course à la mise.
//   node tests/snipe-race.test.mjs      (ou ./scripts/test.sh)
//
// Deux retours d'usage :
//   1. « le mode fourbe ne fonctionne pas, on était en dessous de 60s et ça n'a pas misé » —
//      l'interrupteur maître était en pause et bloquait TOUT en silence : la carte affichait
//      « Fourbe activé » et rien ne disait pourquoi aucune mise ne partait.
//   2. « je peux miser en même temps que quelqu'un d'autre et c'est la sienne qui passe » —
//      le site refusait alors notre montant (devenu trop bas) et on abandonnait sur un log.
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

// L'enchère se termine dans 25 s. Avec un snipe réglé à 60 s, la fenêtre de tir est DÉJÀ
// ouverte : le premier tick de la hot-lane doit miser — c'est la situation décrite
// (« on était en dessous de 60 »).
const ENDS_IN_MS = 25_000;

// `race` : le 1er POST est refusé comme si un autre joueur venait de miser, et la relecture
// de l'enchère renvoie sa mise. Le bot doit repartir au nouveau minimum.
async function run({ armed, race, cap, hunter }) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const bids = [];      // montants réellement postés, dans l'ordre
  let rivalBid = null;  // mise adverse une fois la course déclenchée

  await page.goto(origin);
  await page.evaluate(st => {
    localStorage.setItem('wm_onboarding_done', '1');
    localStorage.setItem('wm_humanized_bid_delay_ms', '0');
    localStorage.setItem('wm_autosnipe_min_balance', '0');
    localStorage.setItem('wm_snipe_seconds', '60');
    // Mot-clé en mode MANUEL : le scan trouve l'annonce (et alimente la hot-lane) sans
    // qu'aucun autre chemin ne mise. Seul le Fourcbe armé ci-dessous peut tirer.
    localStorage.setItem('wm_watchlist', JSON.stringify([
      { kw: 'surveillee', mode: st.hunter ? 'auto' : 'manuel', cap: 5000 }]));
    if (!st.hunter) localStorage.setItem('wm_snipe_set', JSON.stringify(['a1']));
    localStorage.setItem('wm_autobid_armed', st.armed ? '1' : '0');
    localStorage.setItem('wm_global_bid_cap', String(st.cap));
    localStorage.setItem('wm_max_bids_per_hour', '0');
  }, { armed, cap, hunter: !!hunter });

  const auction = () => ({
    id: 'a1',
    base_amount: 39,
    current_bid: rivalBid,
    current_bidder: rivalBid ? { username: 'seloutou' } : null,
    card: { id: 'c-a1', wikipedia_title: 'Chose surveillee', rarity: 'SR', category: 'divers' },
    end_at: new Date(Date.now() + (hunter ? 4 * 3600_000 : ENDS_IN_MS)).toISOString(),
    status: 'active',
  });

  await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
  await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200,
    contentType: 'application/json', body: '{"balance":100000}' }));
  await page.route('**/api/marketplace**', route => {
    const url = route.request().url();
    if (route.request().method() === 'POST' && /\/bid$/.test(url)) {
      let amount = null;
      try { amount = JSON.parse(route.request().postData() || '{}').amount; } catch {}
      bids.push(amount);
      // La course : le premier envoi arrive juste après celui d'un autre joueur.
      if (race && bids.length === 1) {
        rivalBid = 60; // sa mise est passée, le minimum a bougé
        return route.fulfill({ status: 400, contentType: 'application/json',
          body: '{"error":"Le montant doit etre superieur a la mise actuelle"}' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    // Enchère seule (relecture par la hot-lane et par placeBid)
    if (/\/marketplace\/a1(\?|$)/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ auction: auction() }) });
    }
    if (/\/mine/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"won":[],"auctions":[]}' });
    }
    const p = Number(new URL(url).searchParams.get('page') || 1);
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ auctions: p === 1 ? [auction()] : [], page: p }) });
  });

  await page.evaluate(script).catch(e => errors.push(String(e)));
  await page.waitForTimeout(800);
  await page.evaluate(() => document.getElementById('wm-market-btn').click());
  await page.waitForTimeout(8000);
  const log = await page.evaluate(() =>
    [...document.querySelectorAll('.wm-log-e')].map(e => e.innerText).join('\n'));
  await page.close();
  return { bids, log, errors };
}

const problems = [];

/* ── 1. Interrupteur ARMÉ : le snipe part sous les 60 s ─────────────────────── */
const fires = await run({ armed: true, race: false, cap: 5000 });
if (!fires.bids.length) {
  problems.push('snipe armé, enchère à 25 s de la fin, réglage 60 s → aucune mise envoyée');
}
if (!/Fourbe \(snipe/.test(fires.log)) {
  problems.push("le log ne mentionne pas le snipe — ce n'est pas le mode Fourbe qui a misé");
}

/* ── 2. Interrupteur EN PAUSE : rien ne part, MAIS on dit pourquoi ──────────── */
const paused = await run({ armed: false, race: false, cap: 5000 });
if (paused.bids.length) {
  problems.push(`interrupteur en pause : ${paused.bids.length} mise(s) partie(s) quand même`);
}
if (!/EN PAUSE/.test(paused.log)) {
  problems.push("blocage silencieux : rien dans le log ne dit que l'interrupteur maître bloque la mise");
}

/* ── 3. Course : notre mise repart au nouveau minimum ───────────────────────── */
const raced = await run({ armed: true, race: true, cap: 5000 });
if (raced.bids.length < 2) {
  problems.push(`mise refusée pour cause de surenchère simultanée : ${raced.bids.length} essai(s), on abandonne au lieu de repartir au nouveau minimum`);
} else if (!(raced.bids[1] > raced.bids[0])) {
  problems.push(`la relance ne monte pas : ${raced.bids[0]} puis ${raced.bids[1]}`);
}
if (!/rattrap/.test(raced.log)) {
  problems.push("le log ne signale pas que la mise n'est passée qu'après rattrapage");
}

/* ── 4. Une mise SANS deuxième chance doit être rattrapée sur-le-champ ──────── */
// Chasseur ciblé : mise unique à la découverte, enchère qui finit dans 4 h. Si la relance
// n'est pas dans l'envoi lui-même, la mise est perdue — aucun tick ne repassera derrière.
const oneShot = await run({ armed: true, race: true, cap: 5000, hunter: true });
if (oneShot.bids.length < 2) {
  problems.push(`mise unique (chasseur) refusée par une surenchère simultanée : ${oneShot.bids.length} essai — la mise est perdue, rien ne repasse derrière`);
} else if (!(oneShot.bids[1] > oneShot.bids[0])) {
  problems.push(`chasseur : la relance ne monte pas (${oneShot.bids.join(' → ')})`);
}

/* ── 5. Le rattrapage reste sous le plafond global ──────────────────────────── */
// Plafond à 45 : la 1re mise (41) passe la barrière, la relance à 61 doit être refusée.
const capped = await run({ armed: true, race: true, cap: 45 });
if (capped.bids.some(b => b > 45)) {
  problems.push(`le rattrapage a dépassé le plafond global : ${capped.bids.join(', ')}`);
}
if (!/plafond/i.test(capped.log)) {
  problems.push("le plafond coupe la relance mais ne le dit pas");
}

for (const r of [fires, paused, raced, capped, oneShot]) r.errors.forEach(e => problems.push('erreur page : ' + e));

await browser.close();
srv.close();

if (problems.length) {
  console.error('❌ snipe / course à la mise :');
  for (const p of problems) console.error('  · ' + p);
  console.error('  — armé : ' + JSON.stringify(fires.bids) + ' · pause : ' + JSON.stringify(paused.bids)
    + ' · course : ' + JSON.stringify(raced.bids) + ' · plafonné : ' + JSON.stringify(capped.bids));
  console.error('  — log (course) :\n' + raced.log.split('\n').slice(0, 10).map(l => '      ' + l).join('\n'));
  process.exit(1);
}
console.log(`✅ snipe tire sous la fenêtre (${fires.bids.join(',')}) · pause expliquée · course rattrapée (${raced.bids.join(' → ')}) · mise unique rattrapée (${oneShot.bids.join(' → ')}) · plafond tenu (${capped.bids.join(',')})`);
