// Chasse Légendaire : mise sur les L bradées en toute fin d'enchère, riposte jusqu'au max.
//   node tests/legend-hunt.test.mjs      (ou ./scripts/test.sh)
//
// Demande du 29/09 : « on scanne les Légendaires dont l'enchère finit bientôt, par exemple
// dans 20 s, et si elle est à 10 wikibidous, on mise ». Choix de l'utilisateur : riposte
// jusqu'au prix max, Légendaires déjà possédées comprises, L seulement.
// Vérifie : la mise part DANS la fenêtre (pas avant), la riposte s'arrête au max, une L
// trop chère n'est jamais touchée, et rien ne part si les mises auto sont en pause.
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

async function run({ armed, strict = false }) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const bids = [];        // { id, amount, remainingS, ok }
  // Enchère « bradée » : base 5, fin dans 30 s. Enchère « chère » : déjà à 500.
  const t0 = Date.now();
  const state = {
    cheap: strict ? { cur: 5, bidder: 'rival', end: t0 + 30000 } : { cur: null, bidder: null, end: t0 + 30000 },
    dear:  { cur: 500, bidder: 'quelqu_un', end: t0 + 26000 },
    mute:  { cur: 4, bidder: 'rival', end: t0 + 28000 },
  };
  const key = (id) => id.slice(2);
  const toAuction = (id) => {
    const s = state[key(id)];
    return { id, base_amount: 5, current_bid: s.cur,
      current_bidder: s.bidder ? { username: s.bidder } : null,
      end_at: new Date(s.end).toISOString(),
      card: { id: 'c-' + id, wikipedia_title: { 'l-cheap': 'Légendaire bradée', 'l-dear': 'Légendaire chère', 'l-mute': 'Légendaire muette' }[id], rarity: 'L' } };
  };

  await page.goto(origin);
  await page.evaluate(armed => {
    localStorage.setItem('wm_onboarding_done', '1');
    localStorage.setItem('wm_autobid_armed', armed ? '1' : '0');
    localStorage.setItem('wm_legend_hunt', 'true');
    localStorage.setItem('wm_legend_hunt_max', '10');
    localStorage.setItem('wm_legend_hunt_window', '20');
    localStorage.setItem('wm_global_bid_cap', '5000');
    localStorage.setItem('wm_max_bids_per_hour', '0');
    localStorage.setItem('wm_humanized_bid_delay_ms', '0');
    localStorage.setItem('wm_watchlist', JSON.stringify([{ kw: 'rien', mode: 'manuel' }]));
  }, armed);

  await page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
  await page.route('**/api/wikibidous**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"balance":1000}' }));
  await page.route('**/api/marketplace**', route => {
    const url = route.request().url();
    const m = url.match(/\/marketplace\/(l-cheap|l-dear|l-mute)(\/bid)?(\?|$)/);
    if (m && m[2] && route.request().method() === 'POST') {
      let amount = null;
      try { amount = JSON.parse(route.request().postData() || '{}').amount; } catch {}
      const st = state[key(m[1])];
      // Règle du site plus stricte que +10 % : l-cheap exige +3 et le DIT dans le refus,
      // l-mute exige +2 et refuse sans donner de chiffre.
      if (strict) {
        const required = st.cur + (m[1] === 'l-cheap' ? 3 : 2);
        const ok = amount >= required;
        bids.push({ id: m[1], amount, remainingS: Math.round((st.end - Date.now()) / 1000), ok, t: Date.now() });
        // l-cheap : le refus RÉEL du site (capture du 01/10) — 409 {"code":"bid_too_low","min":N}.
        if (!ok) return route.fulfill({ status: m[1] === 'l-cheap' ? 409 : 400, contentType: 'application/json',
          body: JSON.stringify(m[1] === 'l-cheap'
            ? { error: `Mise trop basse (minimum ${required} wikibidous)`, code: 'bid_too_low', min: required }
            : { error: 'Montant trop bas' }) });
        st.cur = amount; st.bidder = 'moi';
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      }
      bids.push({ id: m[1], amount, remainingS: Math.round((state.cheap.end - Date.now()) / 1000), ok: true });
      if (m[1] === 'l-cheap') {
        state.cheap.cur = amount;
        state.cheap.bidder = 'moi';
        // Un rival surenchérit peu après : 8, puis 12 (au-delà du max de 10).
        const nextRival = bids.filter(b => b.id === 'l-cheap').length === 1 ? 8 : 12;
        setTimeout(() => { state.cheap.cur = nextRival; state.cheap.bidder = 'rival'; }, 1200);
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (m) {
      // Mode strict : relire l'enchère coûte 3 s (le site réel : 3 à 8 s). Une relance qui
      // attend cette relecture arrive trop tard face aux autres enchérisseurs.
      if (strict && m[1] === 'l-cheap') return new Promise(res => setTimeout(res, 3000)).then(() =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ auction: toAuction(m[1]) }) }));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ auction: toAuction(m[1]) }) });
    }
    if (/\/mine/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"won":[],"auctions":[]}' });
    if (/\/cards\//.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"summary":{}}' });
    // Le site honore le filtre de rareté : uniquement des L.
    if (/[?&]rarity=L/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ auctions: [toAuction('l-dear'), toAuction('l-cheap'), ...(strict ? [toAuction('l-mute')] : [])], page: 1, limit: 50, hasMore: false }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ auctions: [], page: 1, limit: 50, hasMore: false }) });
  });

  await page.evaluate(script).catch(e => errors.push(String(e)));
  await page.waitForTimeout(600);
  await page.evaluate(() => document.getElementById('wm-market-btn').click());
  await page.waitForTimeout(29000);
  const log = await page.evaluate(() => [...document.querySelectorAll('.wm-log-e')].map(e => e.innerText).join('\n'));
  await page.close();
  errors.forEach(e => problems.push(`[${armed ? 'armé' : 'pause'}] erreur page : ${e}`));
  return { bids, log };
}

const problems = [];

const armed = await run({ armed: true });
const cheap = armed.bids.filter(b => b.id === 'l-cheap');
if (!cheap.length) problems.push('aucune mise sur la Légendaire bradée');
else {
  if (cheap[0].remainingS > 21) problems.push(`1re mise à ${cheap[0].remainingS} s de la fin — attendu dans les 20 dernières secondes`);
  if (cheap[0].amount !== 5) problems.push(`1re mise à ${cheap[0].amount} au lieu de 5 (mise minimale)`);
  // Riposte au rival à 8 → 9 ; le rival passe à 12 → 14 > 10 : on s'arrête.
  if (!cheap.some(b => b.amount === 9)) problems.push(`pas de riposte à 9 après la surenchère à 8 (mises : ${cheap.map(b => b.amount).join(', ')})`);
  if (cheap.some(b => b.amount > 10)) problems.push(`mise au-delà du max de 10 : ${cheap.map(b => b.amount).join(', ')}`);
}
if (armed.bids.some(b => b.id === 'l-dear')) problems.push('mise sur la Légendaire à 500 alors que le max est 10');
if (!/Légendaire repérée/.test(armed.log)) problems.push("le repérage n'est pas journalisé");

const paused = await run({ armed: false });
if (paused.bids.length) problems.push(`mises auto en pause : ${paused.bids.length} mise(s) partie(s) quand même`);
if (!/EN PAUSE/.test(paused.log)) problems.push("en pause, rien ne dit pourquoi la chasse ne mise pas");

// Règle du site plus stricte que notre +10 % : la mise doit finir par passer.
const strict = await run({ armed: true, strict: true });
const sCheap = strict.bids.filter(b => b.id === 'l-cheap');
const sMute = strict.bids.filter(b => b.id === 'l-mute');
if (!sCheap.some(b => b.ok && b.amount === 8)) problems.push(`minimum annoncé par le site (8) non repris : ${JSON.stringify(sCheap)}`);
if (sCheap.filter(b => !b.ok && b.amount === 6).length > 1) problems.push(`montant refusé (6) renvoyé plusieurs fois : ${JSON.stringify(sCheap)}`);
// Le site a donné son minimum (min: 8) : la relance part tout de suite, sans relire l'enchère (3 s).
const refused = sCheap.find(b => !b.ok), retried = refused && sCheap.find(b => b.t > refused.t);
const rebidGap = refused && retried ? retried.t - refused.t : null;
if (rebidGap == null) problems.push('pas de relance après le refus « bid_too_low »');
else if (rebidGap > 1500) problems.push(`relance ${rebidGap} ms après le refus : l'enchère a été relue (3 s) au lieu d'utiliser le minimum donné par le site`);
if (!sMute.some(b => b.ok)) problems.push(`refus « trop bas » sans chiffre : jamais passé (${JSON.stringify(sMute)})`);
if (strict.bids.some(b => b.amount > 10)) problems.push(`règle stricte : mise au-delà du max de 10 (${JSON.stringify(strict.bids)})`);

await browser.close();
srv.close();

if (problems.length) {
  console.error('❌ Chasse Légendaire :');
  for (const p of problems) console.error('  · ' + p);
  console.error('  — mises (armé) : ' + JSON.stringify(armed.bids));
  process.exit(1);
}
console.log(`✅ mise dans la fenêtre (${cheap[0].remainingS} s) · riposte ${cheap.map(b => b.amount).join(' → ')} puis arrêt au max · L trop chère ignorée · rien en pause · minimum du site repris en ${rebidGap} ms (${sCheap.map(b => b.amount + (b.ok ? '✓' : '✗')).join(' → ')} ; sans chiffre ${sMute.map(b => b.amount + (b.ok ? '✓' : '✗')).join(' → ')})`);
