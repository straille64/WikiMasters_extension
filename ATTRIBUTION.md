# Attribution

Ce dépôt part du travail de **Sephiroth-ctrl** :

- Projet d'origine : https://github.com/Sephiroth-ctrl/Wiki-Masters-Bot
- Commit importé : `3ef2719a37e662effdf33b4b83befa3f87cd7661` (21 août 2026)
- Version importée : `1.3.13` (en-tête userscript) / `1.3.13-prod` (`WM_VERSION`)

Le code d'origine est conservé **verbatim** dans `upstream/` pour pouvoir diffuser
nos modifications et resynchroniser plus tard. Ne pas l'éditer.

## Statut licence

Le dépôt d'origine **ne contient aucun fichier LICENSE**. En l'absence de licence,
le code reste sous le droit d'auteur de son auteur, tous droits réservés — être
public sur GitHub ne le rend pas libre de réutilisation.

Conséquences pratiques retenues pour ce dépôt :

- Ce dépôt est **privé**, usage strictement personnel.
- **Pas de rediffusion publique** : ni republication du dépôt, ni publication sur
  le Chrome Web Store / Firefox Add-ons / Greasy Fork, ni distribution à des tiers.
- Avant toute publication, deux voies : demander à l'auteur d'ajouter une licence
  (MIT par ex.) ou lui proposer nos correctifs en pull request sur son dépôt.

## Dépendances tierces chargées à l'exécution

- Police `Rajdhani` depuis `fonts.googleapis.com`
- API REST de `wiki-masters.com` (session du navigateur, cookies de l'utilisateur)
- `wikimedia.org` (API pageviews, pour la détection de changement de rareté)
- `discord.com` (webhook de notification, si configuré par l'utilisateur)
