// Garde-fou d'échappement HTML (audit #4).
//   node tests/escaping.test.mjs      (ou ./scripts/test.sh)
//
// Le bug d'origine n'était pas l'absence d'échappement mais sa dispersion : trois
// implémentations partielles (htmlEsc sans ', taggerEsc sans > ni ', escH idem) plus
// six `.replace(/"/g, '&quot;')` écrits à la main. Ces tests échouent si une
// quatrième réapparaît, ou si une donnée serveur connue repart brute dans du HTML.
import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'src/open_cards.js'), 'utf8');
const lines = src.split('\n');

// ── 1. Un seul échappeur : les alias délèguent, ils ne réimplémentent pas ──
for (const alias of ['htmlEsc', 'taggerEsc', 'escH']) {
  const re = new RegExp('(?:const|let|var)\\s+' + alias + '\\s*=\\s*(.+)');
  const m = src.match(re);
  assert(m, alias + ' introuvable');
  assert.strictEqual(m[1].split(';')[0].trim(), 'esc',
    `${alias} doit être un alias de esc(), trouvé : ${m[1].slice(0, 60)}`);
}

// ── 2. Plus aucun échappement partiel écrit à la main ──
const PARTIAL = /\.replace\(\s*\/[&<>"']\/g\s*,\s*['"]&(?:amp|lt|gt|quot|#39);['"]\s*\)/;
const offenders = lines
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => PARTIAL.test(l))
  // La seule implémentation légitime est esc() lui-même, qui passe par ESC_MAP.
  .filter(([, l]) => !l.includes('ESC_MAP'));
assert.deepStrictEqual(offenders, [],
  'échappement partiel réintroduit :\n' + offenders.map(([n, l]) => `  ${n}: ${l.trim()}`).join('\n'));

// ── 3. Aucune donnée serveur connue injectée brute dans du HTML ──
// Même heuristique que le sweep : une ligne qui produit du HTML (balise, innerHTML,
// wmLog) ne doit pas interpoler ces expressions sans esc()/htmlEsc()/taggerEsc().
const RAW = /\$\{\s*(title|titleOb|titleAb|titleSn|bidder|seller|currentUsername|tagName|s\.title|h\.title|row\.error|result\.error|e\.message)\s*\}/;
const HTML_LINE = /<[a-zA-Z/]|innerHTML|wmLog\(/;
const NON_HTML = /sendToDiscord|fetchWithTimeout|fetch\(|SUPABASE_URL|encodeURIComponent|console\.|localStorage|confirm\(|alert\(/;
const rawHits = lines
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => RAW.test(l) && HTML_LINE.test(l) && !NON_HTML.test(l));
assert.deepStrictEqual(rawHits, [],
  'donnée serveur non échappée dans du HTML :\n' + rawHits.map(([n, l]) => `  ${n}: ${l.trim().slice(0, 120)}`).join('\n'));

// ── 4. Tout href interpolé passe par escUrl() (refuse javascript: / data:) ──
// Convention : une variable préfixée `safe` porte déjà une valeur échappée.
const badHref = lines
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /href="\$\{(?!escUrl\(|safe)/.test(l));
assert.deepStrictEqual(badHref, [],
  'href interpolé sans escUrl() :\n' + badHref.map(([n, l]) => `  ${n}: ${l.trim().slice(0, 120)}`).join('\n'));

console.log('✅ 4 garde-fous d\'échappement OK');
