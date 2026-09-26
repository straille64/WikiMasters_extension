#!/usr/bin/env bash
# Lance les tests unitaires des helpers (node >= 14).
# Usage : ./scripts/test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null 2>&1 || { echo "⏭️  node absent — tests sautés"; exit 0; }
node --check src/open_cards.js && echo "✅ syntaxe src/open_cards.js OK"
for f in tests/*.test.mjs; do
  echo "▶ $f"
  node "$f"
done
