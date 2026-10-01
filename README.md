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
- `tests/trash-seller-safety.test.mjs` : vérifie qu'arriver sur `/collection` ne met
  RIEN en vente tout seul, et qu'une carte n'est vendue que si la fenêtre ouverte affiche
  bien son titre. Validé par mutation (rétablir l'ancien comportement fait échouer le test).
- `tests/snipe-race.test.mjs` : le mode Fourbe tire bien dans sa fenêtre, un blocage par
  l'interrupteur maître est expliqué dans le log, et une mise refusée parce qu'un autre
  joueur a misé en même temps repart au nouveau minimum sans dépasser le plafond.
- `tests/selling-count-unknown.test.mjs` : quand le site ne renvoie plus son compteur de
  ventes actives (`sellingCount: null`), le bot doit le recompter en base et ne rien
  tenter si le plafond est déjà atteint.
- `tests/market-search-probe.test.mjs` : une recherche serveur qui filtre sur un champ
  absent de la réponse ne doit pas être déclarée cassée, le verdict « cassée » doit
  expirer, et les annonces ramenées par `q=` doivent remonter dans les résultats.
- `tests/bid-mode-ui.test.mjs` : le bouton Manuel/Auto-bid/Fourbe doit se mettre à jour
  même quand le re-render de la liste est suspendu, nommer la bonne carte, et la mise
  manuelle doit rattraper une surenchère simultanée comme les mises automatiques.
- `tests/collection-overlay-robust.test.mjs` : carte sans illustration décorée, cote
  refusée redemandée d'elle-même, carte jamais vendue affichée « — » sans boucle, et
  titres non indexés (espace insécable, page non interceptée) résolus.
- `tests/trash-seller-pricing.test.mjs` : % de la cote par rareté, plancher limité aux
  premières mises en vente, baisse par invendu bornée, mise de côté réversible.
- `tests/trash-seller-ui-robust.test.mjs` : titre à apostrophe typographique et fiche
  lente à s'ouvrir — la bonne carte est vendue, le garde-fou reste actif.
- `tests/trash-pool-scan.test.mjs` : collection de 4 pages — toutes les cartes Trash
  sont trouvées même vendeur arrêté (aperçu, refresh).
- `tests/legend-hunt.test.mjs` : Chasse Légendaire — mise minimale dans la fenêtre de
  fin, riposte jusqu'au max puis arrêt, L trop chère ignorée, rien en pause.
- `tests/opti-hunt.test.mjs` : 🎯 Chasse opti — mise sous le plafond min(cote × 60 %, cote − 20,
  mise max), riposte puis arrêt, raretés décochées et propres ventes ignorées.
- `tests/network-efficiency.test.mjs` : horloge serveur juste malgré un site lent, suivi ciblé
  sans mot-clé, mise manuelle captée, purge prudente, une seule boucle après Stop/Start.
- `tests/top-cards.test.mjs` : 💎 Cartes les plus chères — collection entière, cote de la
  rareté de chaque exemplaire, sans cote à part, filtre par rareté.
- `tests/low-balance.test.mjs` : solde insuffisant — aucune mise auto au-delà du solde,
  une seule tentative quand le site refuse pour manque de fonds, réserve de la Chasse.
- `tests/legend-resell.test.mjs` : Revente Légendaire — L gagnées après l'activation remises
  en vente à la moyenne L, jamais sous payé + 50 %, sans cote ignorées, invendue relistée
  sans tag Trash, restes nettoyés (vendue ailleurs, vente supprimée, retrait manuel).
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
- [x] Trash Seller : plus de reprise silencieuse après un rechargement, et refus de
      vendre si la fenêtre ouverte n'affiche pas la carte visée (audit #35)
- [x] Trash Seller : succès de la mise en vente lu sur la réponse du site (plus de vente
      créée comptée comme échec, ni de double mise en vente), retour automatique sur
      /collection, aperçu de tout le pool (audit #36)
- [x] Mises : relance automatique au nouveau minimum quand un autre joueur mise en même
      temps, blocage par l'interrupteur maître rendu visible, Hunter soumis aux mêmes
      plafonds que les autres chemins (audit #37)
- [x] Trash Seller : compteur de ventes actives recompté quand le site ne le donne plus,
      barre de recherche attendue, coupe-circuit sur échecs en rafale (audit #38)
- [x] Market Watcher : sonde de la recherche serveur fiable et réversible, résultats du
      serveur honorés tels quels — fini le balayage de 277 pages en boucle (audit #39)
- [x] Boutons de mode : état visible immédiatement, carte correctement nommée, et mise
      manuelle passée par le même chemin que les mises auto (audit #40)
- [x] Collection : toutes les cartes décorées (y compris sans illustration), cotes qui se
      réparent seules, 4× moins de travail par passage (audit #41)
- [x] Trash Seller : % de la cote par rareté, plancher puis marché, -10 %/invendu,
      mise de côté des invendables, et fiabilité de la mise en vente (audit #42)
- [x] Market Watcher : recherche refusée retentée au lieu du balayage complet, scan en cours
      annulé au changement de mot-clé ou au STOP (audit #43)
- [x] Trash Seller : toute la collection lue même vendeur arrêté, 🗑️ de la Collection
      synchronisé avec le pool (audit #44)
- [x] Chasse Légendaire : mise sur les L bradées en fin d'enchère, riposte jusqu'au
      prix max (audit #45)
- [x] Revente Légendaire : les L gagnées remises en vente à la moyenne du marché, jamais
      sous le prix payé + marge ; boutons « Chasse » / « Chasse + Revente » (audit #46)
- [x] Revente Légendaire : liste synchronisée avec le site (retraits, ventes hors bot) (audit #47)
- [x] Mises auto : jamais au-delà du solde, pas de rafale après un refus « solde insuffisant » (audit #48)
- [x] Chasse : réserve de solde ; bouton « Revente seule » (audit #49)
- [x] Panneau « 💎 Cartes les plus chères » : ma collection classée par cote (audit #50)
- [x] Revente Légendaire : -Y % toutes les X invendues, jamais sous payé + marge (audit #51)
- [x] 🎯 Chasse opti (achat sous la cote) ; Revente limitée aux achats de la Chasse (audit #52)
- [x] Optimisation réseau d'après captures F12 : horloge, relance immédiate, suivi ciblé sans
      mot-clé, lectures partagées, file des cotes, boucles uniques (audit #55)
- [ ] Découpage du monolithe en modules
- [ ] Passage en extension MV3 (interception réseau + handlers = le gros du travail)

## Usage responsable

Le jeu est modéré par des humains. Un volume de packs très élevé attire l'attention.
L'alerte de volume (Paramètres → Comportement) est là pour ça : garder un rythme
raisonnable.
