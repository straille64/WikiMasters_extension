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
docs/       API.md (surface réseau relevée), AUDIT.md (bugs et fragilités
            relevés à l'import).
```

## Build

```bash
./scripts/build.sh
```

Produit `dist/wikimasters-bot.user.js` (~11 900 lignes), vérifie l'alignement des
versions et passe `node --check` si node est disponible.

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
- [ ] Correction des bugs de la boucle d'ouverture (erreurs, cooldown, 429)
- [ ] Échappement HTML systématique
- [ ] Découpage du monolithe en modules
- [ ] Passage en extension MV3 (interception réseau + handlers = le gros du travail)

## Usage responsable

Le jeu est modéré par des humains. Un volume de packs très élevé attire l'attention.
L'alerte de volume (Paramètres → Comportement) est là pour ça : garder un rythme
raisonnable.
