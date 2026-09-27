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
- `tests/trash-seller-preview.test.mjs` : vérifie que le prix de vente suit la moyenne
  de la BONNE rareté, retombe sur le prix par défaut sans cote, et que l'aperçu annonce
  l'ordre, les prix et leur origine.
- `tests/market-filters.test.mjs` : vérifie que les filtres rareté et mot-clé se
  cumulent, sont réversibles, et que le bouton de vidage vide bien la liste.
- `tests/market-server-search.test.mjs` : vérifie que le scan interroge `q=`, suit sa
  pagination, et retombe sur le balayage complet si l'API cesse d'honorer le paramètre.
- `tests/market-dead-pages.test.mjs` : 40 pages d'enchères terminées puis 3 vivantes —
  vérifie que les vivantes sont trouvées sans télécharger les mortes.
- `tests/collection-overlay.test.mjs` : reproduit la grille Collection du site (classes
  et structure réelles) et vérifie que la cote s'affiche, que le bouton de défausse pose
  bien le tag, et que seules les cartes visibles déclenchent une requête de cote.
- `tests/scan-resilience.test.mjs` : sous refus 403, vérifie qu'une page rejetée est
  bien rejouée (aucune annonce perdue) et que l'endpoint des cotes n'est pas martelé.
- `tests/keyword-extended.test.mjs` : vérifie qu'un mot présent uniquement dans la
  description est bien trouvé en recherche étendue, et ignoré en recherche stricte.
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
- [x] Cadence de scan auto-adaptative — le scan complet ne provoque plus de 403 sur
      l'ouverture de paquets (audit #19)
- [x] Recherche étendue aux descriptions, réglable par mot-clé (audit #20)
- [x] Scan résilient aux refus 403 : pages rejouées, historique des ventes plus
      redemandé en boucle (audit #21, #22, #23)
- [x] Surcouche Collection : cote du marché sur chaque carte + bouton de défausse
      réversible (audit #24, #26)
- [x] Scan : recherche côté serveur (`q=`) par mot-clé — mêmes résultats que la
      recherche du site, quelques requêtes au lieu de ~300 pages (audit #32)
- [x] Filtres d'affichage du marché : pastilles de rareté, liste déroulante par
      mot-clé, bouton de vidage de la liste
- [x] Trash Seller : prix = moyenne du marché de la bonne rareté (repli sur le prix
      par défaut), et aperçu de l'ordre de vente (audit #33)
- [x] Scan : saut par dichotomie des pages d'enchères déjà terminées, en repli
      (audit #25)
- [x] Cotes : même endpoint que le site (`?scope=summary`), moyenne lue par rareté,
      chargement en parallèle (~1,5 s pour 40 cartes) (audit #27, #29, #30, #31)
- [x] Échappement HTML systématique — `esc()`/`escUrl()` uniques, 166 points
      d'injection couverts, verrouillé par un test (audit #4)
- [ ] Découpage du monolithe en modules
- [ ] Passage en extension MV3 (interception réseau + handlers = le gros du travail)

## Usage responsable

Le jeu est modéré par des humains. Un volume de packs très élevé attire l'attention.
L'alerte de volume (Paramètres → Comportement) est là pour ça : garder un rythme
raisonnable.
