// Tests unitaires des helpers purs de src/open_cards.js.
//   node tests/helpers.test.mjs      (ou ./scripts/test.sh)
//
// Le code étant un monolithe dans une seule IIFE, il n'y a rien à importer : on
// extrait les déclarations voulues de la source par équilibrage d'accolades et on
// les évalue. Les tests portent donc sur le code réellement livré, pas sur une copie.
import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'src/open_cards.js'), 'utf8');

// Extrait une déclaration (function ou const) de la source par équilibrage d'accolades.
function grab(decl) {
  const i = src.indexOf(decl);
  assert(i >= 0, 'introuvable : ' + decl);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('non fermé : ' + decl);
}
function grabLine(prefix) {
  const i = src.indexOf(prefix);
  assert(i >= 0, 'introuvable : ' + prefix);
  return src.slice(i, src.indexOf('\n', i));
}
function grabConstArray(name) {
  const i = src.indexOf('const ' + name + ' =');
  assert(i >= 0, name);
  return src.slice(i, src.indexOf('];', i) + 2);
}

const code = [
  grabLine("const ESC_MAP ="),
  grab('function esc(v)'),
  grab('function escUrl(v)'),
  grabLine("const PACK_WAIT_FLOOR_MS"),
  grabLine("const PACK_WAIT_CEIL_MS"),
  grabLine("const PACK_BACKOFF_BASE_MS"),
  grabLine("const PACK_BACKOFF_MAX_MS"),
  grab('function parseRetryAfterMs(header)'),
  grab('function apiErrorText(data)'),
  grabConstArray('PACK_CD_ABS_KEYS'),
  grabConstArray('PACK_CD_REL_KEYS'),
  grab('function packCdFromAbsolute(v)'),
  grab('function packCdFromRelative(v, key)'),
  grab('function readServerCooldownMs(data)'),
  grabLine("const PACK_AUTH_ERROR_RE"),
  grab('function packBackoffMs(failures)'),
].join('\n');

const api = new Function(code + '\nreturn { esc, escUrl, parseRetryAfterMs, apiErrorText, readServerCooldownMs, PACK_AUTH_ERROR_RE, packBackoffMs };')();
const { esc, escUrl, parseRetryAfterMs, apiErrorText, readServerCooldownMs, PACK_AUTH_ERROR_RE, packBackoffMs } = api;

let n = 0;
const t = (label, fn) => { fn(); n++; };

// ── esc ──
t('esc caractères dangereux', () => {
  assert.strictEqual(esc('Tom & Jerry <b>"x"</b>'), 'Tom &amp; Jerry &lt;b&gt;&quot;x&quot;&lt;/b&gt;');
  assert.strictEqual(esc("L'Étoile"), 'L&#39;Étoile');
  assert.strictEqual(esc(null), '');
  assert.strictEqual(esc(undefined), '');
  assert.strictEqual(esc(0), '0');
});
t('escUrl refuse les schémas exécutables', () => {
  assert.strictEqual(escUrl('javascript:alert(1)'), '');
  assert.strictEqual(escUrl('  JaVaScRiPt:alert(1)'), '');
  assert.strictEqual(escUrl('data:text/html,<script>'), '');
  assert.strictEqual(escUrl('https://fr.wikipedia.org/wiki/Été_"1"'), 'https://fr.wikipedia.org/wiki/Été_&quot;1&quot;');
  assert.strictEqual(escUrl('/wiki/Paris'), '/wiki/Paris'); // relatif → accepté
  assert.strictEqual(escUrl(''), '');
});

// ── parseRetryAfterMs ──
t('Retry-After secondes et date', () => {
  assert.strictEqual(parseRetryAfterMs('30'), 30000);
  assert.strictEqual(parseRetryAfterMs(null), 0);
  assert.strictEqual(parseRetryAfterMs('pouet'), 0);
  assert.strictEqual(parseRetryAfterMs('999999'), 30 * 60 * 1000); // plafonné
  const future = new Date(Date.now() + 45000).toUTCString();
  const ms = parseRetryAfterMs(future);
  assert(ms > 43000 && ms <= 46000, 'date HTTP → ' + ms);
  assert.strictEqual(parseRetryAfterMs(new Date(Date.now() - 60000).toUTCString()), 0); // passé → 0
});

// ── apiErrorText ──
t('apiErrorText', () => {
  assert.strictEqual(apiErrorText({ cards: [] }), '');
  assert.strictEqual(apiErrorText({ error: 'Unauthorized' }), 'Unauthorized');
  assert.strictEqual(apiErrorText({ message: '  maintenance  ' }), 'maintenance');
  assert.strictEqual(apiErrorText({ error: { message: 'JWT expired' } }), 'JWT expired');
  assert.strictEqual(apiErrorText({ error: true }), 'error');
  assert.strictEqual(apiErrorText({ error: '' }), '');
  assert.strictEqual(apiErrorText(null), '');
});

// ── détection auth ──
t('PACK_AUTH_ERROR_RE', () => {
  for (const m of ['Unauthorized', 'not authenticated', 'JWT expired', 'session expired',
                   'Forbidden', 'invalid token', 'HTTP 401 dans le message']) {
    assert(PACK_AUTH_ERROR_RE.test(m), 'devrait matcher : ' + m);
  }
  for (const m of ['no packs remaining', 'maintenance en cours', 'internal server error', 'rate limited']) {
    assert(!PACK_AUTH_ERROR_RE.test(m), 'ne devrait pas matcher : ' + m);
  }
});

// ── cooldown serveur ──
t('cooldown relatif en secondes', () => {
  assert.deepStrictEqual(readServerCooldownMs({ next_pack_in: 120 }), { ms: 120000, source: 'next_pack_in' });
  assert.deepStrictEqual(readServerCooldownMs({ cooldown_seconds: '90' }), { ms: 90000, source: 'cooldown_seconds' });
  assert.deepStrictEqual(readServerCooldownMs({ cooldown_ms: 4500 }), { ms: 4500, source: 'cooldown_ms' });
});
t('cooldown absolu ISO et epoch', () => {
  const iso = new Date(Date.now() + 300000).toISOString();
  const r = readServerCooldownMs({ next_pack_at: iso });
  assert(r && r.source === 'next_pack_at' && r.ms > 298000 && r.ms <= 300000, JSON.stringify(r));
  const epochS = Math.floor((Date.now() + 200000) / 1000);
  const r2 = readServerCooldownMs({ regen_at: epochS });
  assert(r2 && r2.ms > 198000 && r2.ms <= 201000, JSON.stringify(r2));
  const r3 = readServerCooldownMs({ regen_at: Date.now() + 100000 });
  assert(r3 && r3.ms > 98000 && r3.ms <= 100000, JSON.stringify(r3));
});
t('cooldown imbriqué et valeurs aberrantes ignorées', () => {
  assert.deepStrictEqual(readServerCooldownMs({ user: { next_pack_in: 60 } }), { ms: 60000, source: 'next_pack_in' });
  assert.strictEqual(readServerCooldownMs({ next_pack_in: 99999 }), null);        // > plafond 30 min
  assert.strictEqual(readServerCooldownMs({ next_pack_in: -5 }), null);           // négatif
  assert.strictEqual(readServerCooldownMs({ next_pack_at: 'jamais' }), null);     // date illisible
  assert.strictEqual(readServerCooldownMs({ next_pack_at: new Date(Date.now() - 60000).toISOString() }), null); // passé
  assert.strictEqual(readServerCooldownMs({ packs_remaining: 3 }), null);         // rien d'exploitable
  assert.strictEqual(readServerCooldownMs(null), null);
  assert.deepStrictEqual(readServerCooldownMs({ next_pack_in: 0 }), { ms: 0, source: 'next_pack_in' }); // dispo → sera clampé au plancher
});

// ── backoff ──
t('backoff exponentiel plafonné', () => {
  const at = (f) => packBackoffMs(f);
  assert(at(1) >= 5000 && at(1) < 6000, at(1));
  assert(at(2) >= 10000 && at(2) < 11000);
  assert(at(3) >= 20000 && at(3) < 21000);
  assert(at(5) >= 80000 && at(5) < 81000);
  for (let f = 7; f < 20; f++) assert(at(f) <= 5 * 60 * 1000 + 1000, 'plafond à f=' + f);
});

console.log(`✅ ${n} groupes de tests OK`);
