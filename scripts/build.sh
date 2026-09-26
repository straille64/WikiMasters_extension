#!/usr/bin/env bash
# Concatène l'en-tête userscript + le code en un seul fichier installable.
# Usage : ./scripts/build.sh
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=dist/wikimasters-bot.user.js
mkdir -p dist
{
  cat src/header.user.js
  echo
  cat src/open_cards.js
} > "$OUT"

VERSION=$(grep -oE '^// @version\s+\S+' src/header.user.js | awk '{print $3}')
LINES=$(wc -l < "$OUT")
BYTES=$(wc -c < "$OUT")
echo "✅ $OUT — v$VERSION, $LINES lignes, $BYTES octets"

# Garde-fou : la version affichée dans l'UI (WM_VERSION) doit suivre l'en-tête.
WM=$(grep -oE "WM_VERSION = '[^']+'" src/open_cards.js | head -1 | cut -d"'" -f2 || true)
[ "$WM" = "$VERSION" ] || echo "⚠️  WM_VERSION ($WM) ≠ @version ($VERSION) — pense à aligner src/open_cards.js"

# Vérif syntaxe si node est dispo (attrape les régressions type ReferenceError de portée).
if command -v node >/dev/null 2>&1; then
  node --check "$OUT" && echo "✅ syntaxe OK"
fi
