#!/usr/bin/env bash
# Vérifie la syntaxe puis lance les tests (node >= 14).
# Usage : ./scripts/test.sh
#
# tests/smoke.mjs a besoin du build à jour et de playwright ; il se saute tout
# seul si playwright n'est pas installé.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null 2>&1 || { echo "⏭️  node absent — tests sautés"; exit 0; }
node --check src/open_cards.js && echo "✅ syntaxe src/open_cards.js OK"
node --check dist/wikimasters-bot.user.js && echo "✅ syntaxe dist/ OK"
for f in tests/*.test.mjs tests/smoke.mjs; do
  [ -f "$f" ] || continue
  echo "▶ $f"
  node "$f"
done
