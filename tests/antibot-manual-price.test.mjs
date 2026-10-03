// Vérification anti-bot du site + prix manuel dans la Revente (demandes du 03/10).
//   node tests/antibot-manual-price.test.mjs      (ou ./scripts/test.sh)
//
// A. Anti-bot : le site refuse une mise par 403 {"code":"human_verification_required"} ; sa
//    vérification se fait seule en 1 à 2 s. Le bot ne la contourne pas : il cesse de miser
//    10 s (bandeau rouge, journal), puis reprend. Avant : nouvel essai toutes les 4 à 5 s
//    pendant plus de 3 min (capture du 03/10).
// B. Prix manuel (✏️) : utilisé tel quel, même sous le prix payé, sans cote, sans baisse sur
//    invendu ; vide = retour au prix automatique ; carte déjà en vente → retirée puis remise
//    au nouveau prix si l'utilisateur confirme.
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

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: typeof body === 'string' ? body : JSON.stringify(body) });
const blockOthers = (page) => page.route(new RegExp('^(?!' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'), r => r.abort());
const logOf = (page) => page.evaluate(() => [...document.querySelectorAll('.wm-log-e')].map(e => e.innerText).join('\n'));

// ── A. Vérification anti-bot
async function scenarioAntiBot() {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const t0 = Date.now();
  const st = { cur: null, bidder: null, end: t0 + 42000 };
  const bids = [];          // { t, amount, status }
  const reqs = [];          // toutes les requêtes du bot vers le site : { t, url }
  let firstRefusal = 0;
  page.on('request', r => { const u = r.url(); if (/\/api\/|\/rest\/v1\//.test(u)) reqs.push({ t: Date.now(), url: u }); });
  await page.goto(origin);
  await page.evaluate(() => {
    for (const [k, v] of Object.entries({
      wm_onboarding_done: '1', wm_autobid_armed: '1', wm_legend_hunt: 'true',
      wm_legend_hunt_max: '10', wm_legend_hunt_window: '30', wm_global_bid_cap: '5000',
      wm_max_bids_per_hour: '0', wm_humanized_bid_delay_ms: '0', wm_legend_hunt_reserve: '0',
      wm_watchlist: '[]',
    })) localStorage.setItem(k, v);
  });
  await blockOthers(page);
  await page.route('**/api/wikibidous**', r => json(r, { balance: 1000 }));
  const auction = () => ({ id: 'l-ab', base_amount: 5, current_bid: st.cur,
    current_bidder: st.bidder ? { username: st.bidder } : null, end_at: new Date(st.end).toISOString(),
    card: { id: 'c-ab', wikipedia_title: 'Légendaire vérifiée', rarity: 'L' } });
  await page.route('**/api/marketplace**', route => {
    const url = route.request().url();
    if (/\/l-ab\/bid/.test(url) && route.request().method() === 'POST') {
      let amount = null;
      try { amount = JSON.parse(route.request().postData() || '{}').amount; } catch {}
      // Le site exige sa vérification ; elle se fait seule et dure ~2 s.
      if (!firstRefusal || Date.now() - firstRefusal < 2000) {
        if (!firstRefusal) firstRefusal = Date.now();
        bids.push({ t: Date.now(), amount, status: 403 });
        return json(route, { error: 'Vérification anti-bot requise.', code: 'human_verification_required' }, 403);
      }
      bids.push({ t: Date.now(), amount, status: 200 });
      st.cur = amount; st.bidder = 'moi';
      return json(route, { ok: true });
    }
    if (/\/l-ab(\?|$)/.test(url)) return json(route, { auction: auction() });
    if (/\/mine/.test(url)) return json(route, { sellingCount: 0, maxConcurrentAuctions: 5 });
    if (/\/cards\//.test(url)) return json(route, { summary: {} });
    if (/[?&]rarity=L/.test(url)) return json(route, { auctions: [auction()], page: 1, limit: 50, hasMore: false });
    return json(route, { auctions: [], page: 1, limit: 50, hasMore: false });
  });
  await page.evaluate(script).catch(e => errors.push(String(e)));
  await page.waitForTimeout(600);
  await page.evaluate(() => document.getElementById('wm-market-btn').click());
  // Attend le premier refus, puis lit le bandeau pendant la pause.
  for (let i = 0; i < 150 && !firstRefusal; i++) await page.waitForTimeout(200);
  await page.waitForTimeout(3000);
  const banner = await page.evaluate(() => {
    const b = document.getElementById('wm-antibot-banner');
    return b && b.style.display !== 'none' ? b.innerText : '';
  });
  await page.waitForTimeout(12000);
  const bannerAfter = await page.evaluate(() => {
    const b = document.getElementById('wm-antibot-banner');
    return b && b.style.display !== 'none' ? b.innerText : '';
  });
  const log = await logOf(page);
  await page.close();
  return { bids, reqs, firstRefusal, banner, bannerAfter, log, errors };
}

// ── B. Prix manuel
async function scenarioManualPrice() {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const posts = [];       // { cardId, price }
  const deletes = [];
  const endedListings = new Set();
  await page.goto(origin + '/collection');
  await page.evaluate(() => {
    const now = Date.now();
    localStorage.setItem('wm_onboarding_done', '1');
    localStorage.setItem('wm_autobid_armed', '0');
    localStorage.setItem('wm_watchlist', '[]');
    localStorage.setItem('wm_max_active_sales', '5');
    localStorage.setItem('wm_legend_resell_on', 'true');
    localStorage.setItem('wm_legend_resell_since', String(now - 3600000));
    localStorage.setItem('wm_legend_resell', JSON.stringify([
      // Prix manuel sous le prix payé (cote 1000) : 150 tel quel ; invendue → encore 150.
      { wonAuctionId: 'w-m1', cardId: 'c-m1', title: 'L à prix manuel', paid: 300, wonAt: now, status: 'waiting', listings: 1, unsold: 1 },
      // Sans cote : invendable en automatique, vendue à 500 avec un prix manuel.
      { wonAuctionId: 'w-nc', cardId: 'c-nc', title: 'L sans cote', paid: 100, wonAt: now, status: 'no_cote', checkedAt: now, listings: 0 },
      // Déjà en vente à 1754 : retirée puis remise à 400 après confirmation.
      { wonAuctionId: 'w-lst', cardId: 'c-lst', title: 'L déjà en vente', paid: 100, wonAt: now, status: 'listed',
        listedAuctionId: 'lst-old', listedPrice: 1754, listedAt: now, listedDuration: 180, listings: 1 },
      // Prix manuel effacé : retour au prix automatique (cote 400).
      { wonAuctionId: 'w-auto', cardId: 'c-auto', title: 'L retour auto', paid: 10, wonAt: now, status: 'waiting', listings: 0, manualPrice: 777 },
    ]));
    const payload = btoa(JSON.stringify({ sub: 'user-test-1', exp: 4102444800 }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    localStorage.setItem('sb-cyrxjeppjqsxxjayfrur-auth-token',
      JSON.stringify({ access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.sig` }));
  });
  await blockOthers(page);
  await page.route('**/api/wikibidous**', r => json(r, { balance: 1000 }));
  await page.route('**/api/my-collection**', r => json(r, { total: 0, collection: [] }));
  await page.route('**/rest/v1/**', r => json(r, []));
  await page.route('**/rest/v1/user_cards**', route => {
    const m = decodeURIComponent(route.request().url()).match(/card_id=in\.\(([^)]*)\)/);
    return json(route, (m ? m[1].split(',') : []).map(card_id => ({ card_id })));
  });
  await page.route('**/rest/v1/auctions**', route => {
    const url = decodeURIComponent(route.request().url());
    const m = url.match(/id=in\.\(([^)]*)\)/);
    if (m && !/winner_id=eq\./.test(url)) {
      // Ventes de la revente : terminées sans acheteur (endedListings) ou encore en cours.
      return json(route, m[1].split(',').map(id => endedListings.has(id)
        ? { id, status: 'ended', winner_id: null, final_price: null,
            end_at: new Date(Date.now() - 1000).toISOString(), settled_at: new Date().toISOString() }
        : { id, status: 'active', winner_id: null, end_at: new Date(Date.now() + 3600000).toISOString() }));
    }
    return json(route, []);
  });
  const COTE = { 'c-m1': { L: { average: 1000 } }, 'c-auto': { L: { average: 400 } }, 'c-lst': { L: { average: 2000 } } };
  await page.route('**/api/marketplace**', route => {
    const url = route.request().url();
    const method = route.request().method();
    if (method === 'DELETE') { deletes.push(url.split('/').pop()); return json(route, { ok: true }); }
    if (method === 'POST' && /\/api\/marketplace(\?|$)/.test(url)) {
      let b = {};
      try { b = JSON.parse(route.request().postData() || '{}'); } catch {}
      const n = posts.filter(p => p.cardId === b.card_id).length;
      posts.push({ cardId: b.card_id, price: b.base_amount });
      const id = `lst-${b.card_id}-${n}`;
      if (b.card_id === 'c-m1' && n === 0) endedListings.add(id);   // 1re vente sans acheteur
      return json(route, { auction_id: id });
    }
    if (/\/mine/.test(url)) return json(route, { sellingCount: 0, maxConcurrentAuctions: 5 });
    const s = url.match(/cards\/([^/?]+)\/sales/);
    if (s) return json(route, { summary: COTE[s[1]] || {} });
    return json(route, { auctions: [], page: 1, limit: 50, hasMore: false });
  });
  // Réponses aux fenêtres du bouton ✏️ (prompt) et de la confirmation de retrait.
  const ANSWERS = { 'L à prix manuel': '150', 'L sans cote': '500', 'L déjà en vente': '400', 'L retour auto': '' };
  const dialogs = [];
  page.on('dialog', d => {
    dialogs.push(d.type());
    if (d.type() === 'confirm') return d.accept();
    const title = Object.keys(ANSWERS).find(t => d.message().includes(t));
    return title !== undefined ? d.accept(ANSWERS[title]) : d.dismiss();
  });
  await page.evaluate(script).catch(e => errors.push(String(e)));
  await page.waitForTimeout(800);
  for (const id of ['w-m1', 'w-nc', 'w-lst', 'w-auto']) {
    await page.evaluate(id => document.querySelector(`[data-wm-lresell-price="${id}"]`).click(), id)
      .catch(e => errors.push('bouton ✏️ absent : ' + id));
    await page.waitForTimeout(400);
  }
  const queueAfterEdit = await page.evaluate(() => JSON.parse(localStorage.getItem('wm_legend_resell') || '[]'));
  await page.evaluate(() => document.getElementById('wm-legend-resellonly-btn').click());
  await page.waitForTimeout(16000);
  await page.evaluate(() => window.wmReconcileLegendResell && window.wmReconcileLegendResell());
  await page.waitForTimeout(9000);
  const list = await page.evaluate(() => (document.getElementById('wm-lresell-list') || {}).textContent || '');
  const log = await logOf(page);
  await page.close();
  return { posts, deletes, dialogs, queueAfterEdit, list, log, errors };
}

const [A, B] = await Promise.all([scenarioAntiBot(), scenarioManualPrice()]);
await browser.close();
srv.close();

const problems = [];
// A
const refusals = A.bids.filter(b => b.status === 403);
const okBid = A.bids.find(b => b.status === 200);
if (!A.firstRefusal) problems.push('A. aucune mise tentée (scénario non déroulé)');
else {
  const early = A.bids.filter(b => b.t > A.firstRefusal + 50 && b.t < A.firstRefusal + 9500);
  if (early.length) problems.push(`A. ${early.length} mise(s) renvoyée(s) pendant la vérification (${early.map(b => Math.round((b.t - A.firstRefusal) / 100) / 10 + ' s').join(', ')} après le refus) — attendu : pause de 10 s`);
  if (!okBid) problems.push('A. les mises ne reprennent pas après la pause');
  // fork.42 : pendant la pause, AUCUNE requête du bot (scan, Chasse, voie rapide, solde…).
  const during = A.reqs.filter(r => r.t > A.firstRefusal + 500 && r.t < A.firstRefusal + 9500);
  if (during.length) problems.push(`A. ${during.length} requête(s) pendant la pause : ${[...new Set(during.map(r => r.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]))].slice(0, 6).join(', ')}`);
  const after = A.reqs.filter(r => r.t > A.firstRefusal + 10000);
  if (!after.length) problems.push('A. aucune requête après la pause : le bot ne reprend pas');
  if (refusals.length > 1) problems.push(`A. ${refusals.length} refus anti-bot : la vérification a été sollicitée en boucle`);
}
if (!/reprise dans/.test(A.banner)) problems.push(`A. bandeau rouge absent pendant la pause (« ${A.banner} »)`);
if (A.bannerAfter) problems.push(`A. bandeau encore affiché après la reprise (« ${A.bannerAfter} »)`);
if (!/vérification anti-bot/i.test(A.log)) problems.push('A. la pause anti-bot n\'est pas expliquée dans le journal');
if (!/Fin de la pause anti-bot/.test(A.log)) problems.push('A. la reprise n\'est pas journalisée');
if (/Chasse Légendaire échouée/.test(A.log)) problems.push('A. « échouée » journalisé en plus de la pause');
// B
const of = (id) => B.posts.filter(p => p.cardId === id).map(p => p.price);
const q = (id) => B.queueAfterEdit.find(e => e.wonAuctionId === id) || {};
if (q('w-m1').manualPrice !== 150) problems.push(`B. prix manuel non enregistré (${q('w-m1').manualPrice})`);
if (q('w-auto').manualPrice) problems.push(`B. prix manuel non effacé par une saisie vide (${q('w-auto').manualPrice})`);
if (of('c-m1')[0] !== 150) problems.push(`B. « L à prix manuel » mise en vente à ${of('c-m1')[0] ?? 'rien'} au lieu de 150 (prix manuel, même sous le payé)`);
if (of('c-m1').length < 2) problems.push(`B. invendue non remise en vente (${of('c-m1').join(', ')})`);
else if (of('c-m1')[1] !== 150) problems.push(`B. remise en vente à ${of('c-m1')[1]} au lieu de 150 (prix manuel fixe, pas de baisse)`);
if (of('c-nc')[0] !== 500) problems.push(`B. « L sans cote » : ${of('c-nc').join(', ') || 'pas mise en vente'} au lieu de 500`);
if (!B.deletes.includes('lst-old')) problems.push(`B. vente en cours (1754) non retirée après confirmation (DELETE : ${B.deletes.join(', ') || 'aucun'})`);
if (of('c-lst')[0] !== 400) problems.push(`B. « L déjà en vente » remise à ${of('c-lst').join(', ') || 'rien'} au lieu de 400`);
if (of('c-auto')[0] !== 400) problems.push(`B. « L retour auto » : ${of('c-auto').join(', ') || 'pas mise en vente'} au lieu de 400 (cote)`);
if (!/prix manuel/.test(B.log)) problems.push('B. le prix manuel n\'apparaît pas dans le journal');
if (!/perte de 150/.test(B.log)) problems.push('B. pas d\'avertissement pour un prix sous le prix payé');
if (!/✋ 150/.test(B.list)) problems.push(`B. la liste n'affiche pas le prix manuel : ${B.list.slice(0, 200)}`);
for (const [k, r] of [['A', A], ['B', B]]) for (const e of r.errors) problems.push(`${k}. erreur page : ${e}`);

if (problems.length) {
  console.error('❌ anti-bot / prix manuel :');
  for (const p of problems) console.error('  · ' + p);
  console.error('  — mises A : ' + JSON.stringify(A.bids.map(b => ({ dt: b.t - (A.firstRefusal || b.t), amount: b.amount, status: b.status }))));
  console.error('  — ventes B : ' + JSON.stringify(B.posts) + ' · DELETE ' + JSON.stringify(B.deletes));
  process.exit(1);
}
const resume = okBid ? Math.round((okBid.t - A.firstRefusal) / 100) / 10 : '?';
console.log(`✅ anti-bot : 1 refus, pause 10 s sans aucune requête (bandeau + journal), mise reprise ${resume} s après · prix manuel : 150 sous le payé (invendue → 150 encore), sans cote → 500, en vente à 1754 → retirée puis 400, vide → retour à la cote (400)`);
