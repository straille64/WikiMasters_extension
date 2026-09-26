# WikiMasters Extension

Assistant d'automatisation pour **wiki-masters.com** : ouverture de packs,
surveillance du marché, enchères automatiques, mise en vente et étiquetage en
masse de la collection.

Ce dépôt reprend l'intégralité du bot de **Sephiroth-ctrl** comme base de travail,
pour le corriger puis le faire évoluer vers une véritable extension de navigateur.
Origine, commit importé et statut licence : voir [ATTRIBUTION.md](ATTRIBUTION.md).

> ⚠️ Dépôt **privé**, usage personnel. Pas de rediffusion publique — le code
> d'origine n'a pas de licence.

## Structure

```
upstream/   Copie verbatim du code d'origine (commit 3ef2719) + sa doc
            (README.md, CHANGELOG.md). NE PAS ÉDITER — sert de référence pour
            diffuser nos modifications et resynchroniser plus tard.
src/        Notre copie de travail : header.user.js (en-tête) + open_cards.js.
dist/       Build généré, installable tel quel dans Tampermonkey.
scripts/    build.sh — concatène src/ vers dist/ et vérifie la syntaxe.
            test.sh  — vérifie la syntaxe et lance tests/.
tests/      Tests unitaires des helpers purs (node, sans dépendance).
docs/       API.md (surface réseau relevée), AUDIT.md (bugs et fragilités
            relevés à l'import).
```

## Build

```bash
./scripts/build.sh
```

Produit `dist/wikimasters-bot.user.js`, vérifie l'alignement des versions et passe
`node --check` si node est disponible.

## Tests

```bash
./scripts/test.sh
```

- `tests/helpers.test.mjs` et `tests/escaping.test.mjs` : le code étant un monolithe
  dans une seule IIFE, il n'y a rien à importer — les tests extraient les helpers de
  `src/open_cards.js` par équilibrage d'accolades puis les évaluent. Ils portent donc
  sur le code réellement livré, pas sur une copie.
- `tests/watchlist-modes.test.mjs` : vérifie dans un navigateur qu'un mot-clé en mode
  manuel ne déclenche jamais de mise, qu'un mot-clé en auto en déclenche une, et que
  l'interrupteur maître, le plafond de prix et la limite horaire coupent bien.
- `tests/market-pagination.test.mjs` : vérifie que le scan pagine jusqu'au bout même
  quand l'API n'annonce aucun total, et trouve bien une carte située en page 3.
- `tests/market-ended.test.mjs` : rejoue un scan marché avec API simulée et vérifie
  qu'aucune mise ne part sur une enchère terminée — ni, à l'inverse, que le filtre
  n'assèche les enchères vivantes.
- `tests/smoke.mjs` : charge `dist/` dans un vrai Chromium et vérifie que l'UI se
  monte (bouton ⚙ compris) sans erreur d'exécution. `node --check` ne valide que la
  syntaxe : une exception à l'init tue l'IIFE entière et **rien** n'apparaît — c'est
  le seul test qui attrape ça. Il se saute tout seul si `playwright` n'est pas
  installé (`npm i -D playwright`).

> ⚠️ Lancer `./scripts/build.sh` **puis** `./scripts/test.sh` avant de coller un build
> dans Tampermonkey : le test de fumée porte sur `dist/`, pas sur `src/`.

## Installation (état actuel : userscript)

1. Installer **Tampermonkey** ([Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) · [Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) · [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/)).
2. Chrome / Edge : activer le **mode développeur** des extensions (`chrome://extensions`)
   — obligatoire depuis Chrome 138 pour que Tampermonkey fonctionne pleinement.
3. Tampermonkey → **Créer un nouveau script**, tout effacer, coller le contenu de
   `dist/wikimasters-bot.user.js`, **Ctrl+S**.
4. Aller sur https://www.wiki-masters.com connecté, recharger en **Ctrl+Shift+R**.
   Un bouton **⚙** apparaît en bas à droite.

L'installation par URL (avec mise à jour automatique) **ne marche pas** ici : le
dépôt est privé, `raw.githubusercontent.com` exige un token. C'est aussi pour ça
que notre build n'a plus de `@require` — le code est autonome.

Le mode d'emploi détaillé de chaque module (Pack Opener, Market Watcher, Trash
Seller, étiquetage, paramètres) est dans [upstream/README.md](upstream/README.md).

## État

- [x] Import complet du bot d'origine, build reproductible
- [x] Suppression du `@require` distant (le build est autonome)
- [x] Audit des bugs et fragilités → [docs/AUDIT.md](docs/AUDIT.md)
- [x] Correction des bugs de la boucle d'ouverture (erreurs, cooldown, 429) — audit #1, #2, #3, #5
- [x] Tests : helpers, garde-fous d'échappement, test de fumée navigateur et
      non-régression Market Watcher (`./scripts/test.sh`)
- [x] Market Watcher : ne plus miser sur des enchères déjà terminées (audit #15)
- [x] Market Watcher : scanner toutes les pages, pas seulement la première (audit #16)
- [x] Market Watcher : une seule liste de mots-clés, mode 🤖 auto / 👁️ manuel par
      mot-clé, plafond de prix et limite de mises par heure (audit #17, #18)
- [x] Échappement HTML systématique — `esc()`/`escUrl()` uniques, 166 points
      d'injection couverts, verrouillé par un test (audit #4)
- [ ] Découpage du monolithe en modules
- [ ] Passage en extension MV3 (interception réseau + handlers = le gros du travail)

## Usage responsable

Le jeu est modéré par des humains. Un volume de packs très élevé attire l'attention.
L'alerte de volume (Paramètres → Comportement) est là pour ça : garder un rythme
raisonnable.
