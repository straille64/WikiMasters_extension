# Audit du code importé — v1.3.13

Relevé à l'import (commit upstream `3ef2719`), avant toute correction.
Les numéros de ligne renvoient à la version **importée** de `src/open_cards.js`
(elles ont bougé depuis les correctifs).

Chaque entrée traitée porte une ligne de statut avec la version du fork.

## 🔴 Bugs

### 1. Toute erreur d'ouverture = attente du cooldown complet, en silence
`src/open_cards.js:11333` — `if (data.packs_remaining === 0 || data.error)` traite
de la même façon « plus de packs » et **n'importe quelle** erreur serveur : session
expirée, 401, maintenance, rate-limit. Le bot attend alors le cooldown entier
(jusqu'à 10 min) et reboucle indéfiniment sans rien signaler. Une session expirée
la nuit = bot qui tourne dans le vide jusqu'au matin.

**Correctif** : distinguer les cas. `packs_remaining === 0` → cooldown. Erreur
d'auth → arrêt du module + alerte visible (+ Discord). Erreur inconnue → backoff.

**✅ Corrigé (1.3.13-fork.1, ajusté en fork.6)** — la loop classe désormais la réponse :
auth avérée (HTTP 401, ou `PACK_AUTH_ERROR_RE` sur le message d'API) → `haltPackOpener()`
qui arrête le module, affiche l'alerte et notifie Discord ; `packs_remaining === 0`
→ cooldown ; tout le reste (403, 5xx, réseau, erreur applicative) → backoff exponentiel
plafonné, **sans jamais arrêter le module**.

⚠️ Retour d'usage (fork.6) : la version fork.1 arrêtait aussi le module au 3ᵉ 403
consécutif et au 8ᵉ échec. En production ça coupait une ouverture automatique qui
repartait très bien toute seule — le 403 est ici une protection anti-bot **transitoire**,
pas une perte de droits. `forbidden` et `403` ont donc été retirés de
`PACK_AUTH_ERROR_RE`, et les deux seuils d'arrêt supprimés : seul le 401 arrête le
module, parce que lui seul ne se débloquera jamais en attendant. Le seuil restant
(`PACK_WARN_FAILURES`) ne fait que prévenir une fois, log + Discord. Les logs d'échec
répétés sont throttlés (3 premiers, puis un sur dix).
Effet de bord corrigé au passage : une réponse sans carte **et** sans erreur (avec
`packs_remaining > 0`) repartait au bout de 1,2–3 s, donc martelait l'API ; elle
passe maintenant par l'attente de regen.

### 2. Cooldown jamais lu depuis le serveur
Même bloc : la durée vient uniquement du réglage utilisateur (`getSetting('packCooldown')`),
avec une marge fixe de 2 s. Aucune lecture d'un temps restant renvoyé par l'API.
Si le site change ses cooldowns, ou si l'utilisateur se trompe de type de compte,
on perd des slots (trop lent) ou on tape trop tôt en boucle (trop rapide).

**Correctif** : lire le temps restant renvoyé par l'API quand il existe, garder le
réglage utilisateur en repli, et borner par un plancher de sécurité.

**✅ Corrigé (1.3.13-fork.1)** — `readServerCooldownMs()` sonde les noms de champs
plausibles (`PACK_CD_ABS_KEYS` pour un instant absolu ISO/epoch, `PACK_CD_REL_KEYS`
pour une durée relative), y compris imbriqués dans `data.user` / `data.pack`. Valeur
serveur prioritaire, réglage utilisateur en repli, tout borné par
`PACK_WAIT_FLOOR_MS` (5 s) et `PACK_WAIT_CEIL_MS` (30 min) pour qu'une valeur
aberrante ne gèle pas le module. Le log indique la source retenue.

### 3. Pas de gestion du 429, pas de backoff exponentiel
`src/open_cards.js:11374-11380` — seul le `403` est traité (pause 60 s) ; tout le
reste tombe sur `await sleep(5000)`. Un `502`/page HTML de Cloudflare fait échouer
`res.json()` dans `openPack()` (`src/open_cards.js:10656`) → retry toutes les 5 s
en boucle. C'est le comportement qui fait repérer un bot par la modération.

**Correctif** : vérifier `res.ok` et `content-type` avant `res.json()`, respecter
`Retry-After`, backoff exponentiel plafonné, arrêt au bout de N échecs consécutifs.

**✅ Corrigé (1.3.13-fork.1)** — `openPack()` vérifie `res.ok` **et** le
`content-type` avant de parser, et lève une `PackApiError` portant `status`,
`retryAfterMs` (secondes ou date HTTP) et un extrait du corps. La loop respecte
`Retry-After` quand il est fourni, sinon `packBackoffMs()` (5 s → 5 min max, avec
jitter pour ne pas retomber en rythme régulier), et s'arrête au bout de 8 échecs
consécutifs avec alerte + Discord.

### 4. Aucun échappement HTML
Les titres de cartes et leurs URL partent bruts dans `innerHTML`
(ex. `src/open_cards.js:10820-10835` : `href="${url}"`, `title="${title}"`).
Un titre Wikipédia contenant `"` casse l'attribut et l'affichage ; un `<` dans un
titre injecte du HTML dans la page.

Le vrai problème n'était pas l'absence totale d'échappement mais sa **dispersion** :
trois implémentations partielles (`htmlEsc` sans `'`, `taggerEsc` sans `>` ni `'`,
`escH` idem) plus six `.replace(/"/g, '&quot;')` écrits à la main, chacun oubliant
un caractère différent — et ~150 interpolations qui n'en utilisaient aucune.

**Correctif** : un helper `esc()` unique, appliqué à toute donnée serveur injectée.

**✅ Corrigé (1.3.13-fork.2)** — `esc()` couvre les 5 caractères (contenu **et**
attributs délimités par `"` ou `'`) et `escUrl()` refuse les schémas exécutables
(`javascript:`, `data:`) avant d'échapper. `htmlEsc`, `taggerEsc` et `escH` sont
devenus des alias de `esc()` — les ~50 appels existants gagnent les caractères qui
leur manquaient sans rien réécrire. Les 6 échappements ad hoc ont été remplacés, et
149 interpolations de données serveur ou de saisie utilisateur (titres, pseudos,
messages d'API, noms de tags, noms de fichiers) ont été enrobées, soit 166 points
d'injection échappés au total.

Écartés volontairement : les messages Discord (markdown, l'échappement HTML y
afficherait `&amp;`), les chaînes de `confirm()` / `alert()`, la construction d'URL
et de requêtes. `tests/escaping.test.mjs` verrouille l'ensemble : alias qui délèguent
bien à `esc()`, aucun échappeur partiel réintroduit, aucune donnée serveur connue
injectée brute dans du HTML, tout `href` interpolé passant par `escUrl()`.

### 5. Stats de session comptées avant vérification
`handlePackOpened()` (`src/open_cards.js:10758`) sort tôt si `cards` est vide, mais
n'inspecte jamais `data.error`. Une réponse partielle ou inattendue qui porterait
quand même un tableau `cards` serait comptée comme un pack réussi.

**Correctif** : refuser de comptabiliser une réponse portant une erreur, et renvoyer
à l'appelant si le pack a été compté.

**✅ Corrigé (1.3.13-fork.1)** — `handlePackOpened()` sort sur `apiErrorText(data)`
non vide (avec log explicite « pack non comptabilisé ») et retourne un booléen dont
la loop se sert pour choisir entre cooldown et backoff.

### 15. Market Watcher : mises sur des enchères déjà terminées
Signalé en production le 26/09. Aucun chemin de mise ne vérifiait `end_at` avant de
poster. Or l'API marketplace continue de lister une enchère tant que le serveur ne l'a
pas **soldée**, et le scan demande `sort=ending_soon` : les enchères finies, ayant le
`end_at` le plus ancien, remontaient donc **en tête** du scan. Résultat : c'étaient
elles que le watcher « trouvait » en premier, et chaque mise repartait avec
« Cette enchère est terminée » — match, son, notification Discord, chasseur, mot-clé
prioritaire, armement du mode fourbe et riposte auto-bid, tous sur des enchères mortes.

À noter : le repli Supabase filtrait déjà (`status=eq.active&end_at=gt.${nowIso}`),
seul le chemin REST principal ne le faisait pas.

**✅ Corrigé (1.3.13-fork.4)** — `isAuctionOver()` tranche contre l'heure **serveur**
(`serverNow()`, pas l'horloge du PC : un PC décalé raterait la fin de plusieurs
secondes). Les enchères terminées sont écartées en un point unique, juste avant le
calcul des `hits`, ce qui couvre d'un coup l'affichage et tous les chemins d'action ;
leur dernier état connu reste rafraîchi pour que le log « gagnée / perdue » garde son
gagnant. `skipIfAuctionOver()` ajoute un garde-fou juste avant chaque POST de mise —
l'enchère peut expirer pendant le délai humanisé — avec dé-doublonnage du log, la hot
lane repassant sur la même enchère à chaque tick. `auctionLikelyStillLive()` passe lui
aussi à `serverNow()`, pour que pruning et filtrage partagent la même référence de temps.

`tests/market-ended.test.mjs` rejoue le scénario dans un vrai navigateur, API simulée :
une annonce morte et une vivante matchant toutes deux le mot-clé. Il vérifie qu'aucune
mise ne part sur la morte **et** qu'une mise part bien sur la vivante — sans ce second
contrôle, le test passerait aussi si le bot ne faisait plus rien. Vérifié : il échoue
sur le build d'avant le correctif, avec les mêmes lignes de log qu'en production.

### 16. Market Watcher : une seule page scannée, donc aucune carte trouvée
Signalé en production le 26/09, juste après le correctif #15. `fetchAllMarketAuctions`
faisait `const total = first.total || 0` puis `totalPages = Math.ceil(total / 50)`.
Le champ `total` de l'API a changé de nom (ou disparu) : il valait 0, donc **0 page à
paginer** et le scan s'arrêtait à la page 1.

Or le scan demande `sort=ending_soon` : cette page 1 ne contient que les enchères au
`end_at` le plus ancien, c'est-à-dire les déjà terminées. Le bot ne voyait donc
**jamais** une seule annonce vivante. Les deux bugs se masquaient l'un l'autre : avant
#15 le bot misait sur ces mortes (donc « il trouvait »), après #15 il les écartait
correctement et il ne restait plus rien. Symptôme utilisateur : `🧹 49 annonce(s) déjà
terminée(s) ignorée(s)`, `✅ 0 annonce`, « Aucune carte recherchée en vente », alors
que le site affichait des dizaines d'annonces correspondantes à 5–11 h de la fin.

Le panneau affichait aussi « 0 annonces » en plein scan, ce qui aurait dû mettre la
puce à l'oreille : c'était `total` qui était lu, pas ce qui avait été récupéré.

**✅ Corrigé (1.3.13-fork.5)** — la pagination ne dépend plus d'un total annoncé : on
continue tant que les pages reviennent **pleines**, une page incomplète étant la
dernière, avec plafond dur `MARKET_MAX_PAGES` (60 × 50 = 3000) et arrêt si un lot
entier n'apporte aucune nouveauté (API qui ignorerait `page`). Une page en erreur
n'est plus confondue avec une page incomplète, sinon un hoquet réseau tronquerait tout
le scan. `readMarketTotal()` sonde les noms plausibles mais ne sert plus qu'à
l'affichage, et le total affiché retombe sur le nombre d'annonces réellement vues.
Un log de diagnostic liste une fois les champs racine de la réponse, pour repérer le
prochain renommage côté API.

`tests/market-pagination.test.mjs` rejoue le scénario : 3 pages de 50 sans champ
`total`, page 1 et 2 pleines d'enchères mortes, la carte recherchée en page 3.
Vérifié : échoue sur le build d'avant (« pages demandées : 1 »), passe après.

## 🟠 Fragilités structurelles

### 6. `window.fetch` monkey-patché globalement
`src/open_cards.js:11164`. Casse si le site passe à XHR ou garde sa propre
référence à `fetch`. Surtout : **impossible dans un content script MV3** (monde
isolé). Une conversion en extension impose un script injecté en monde MAIN + un
pont `postMessage`.

### 7. 151 `innerHTML` avec des `onclick` inline
Les handlers sont générés dans des template literals (ex. `src/open_cards.js:3961`)
et appellent 48 globaux `window.wmXxx`. En MV3, les handlers inline sont bloqués
par la CSP de l'extension et les globaux du monde isolé sont invisibles depuis la
page : **tous les boutons seraient morts**. C'est le gros du travail de conversion.

### 8. Quota localStorage
~30 clés, 61 `setItem`, dont les caches collection et ventes. Le code embarque déjà
un diagnostic de quota (`src/open_cards.js:6908`) et un export qui exclut les gros
caches : le plafond des ~5 Mo a été atteint en production.
`chrome.storage.local` côté extension supprime le problème.

### 9. Clé Supabase en dur
`src/open_cards.js:6009-6011`. Clé `anon` publique du site (pas un secret), mais
une rotation ou un durcissement RLS casse l'étiquetage et le Trash Seller sans
préavis. À isoler derrière une couche d'accès unique.

### 10. Monolithe de 11 876 lignes dans une seule IIFE
Trois fonctions `fetchPage` distinctes dans trois portées, deux `onUp`/`onMove`,
état global partagé. Le CHANGELOG upstream documente au moins une régression née
exactement de ça (`ReferenceError` de portée sur `method`, cf. entrée du 20/08).
Aucun test, aucun lint.

**🟡 En cours (1.3.13-fork.1)** — `tests/helpers.test.mjs` + `scripts/test.sh` : les
helpers purs sont extraits de la source par équilibrage d'accolades puis évalués, donc
testés tels qu'ils sont livrés. Couvre `esc`/`escUrl`, `parseRetryAfterMs`,
`apiErrorText`, `readServerCooldownMs`, `PACK_AUTH_ERROR_RE` et `packBackoffMs`.
`tests/escaping.test.mjs` y ajoute quatre garde-fous statiques sur l'échappement.
Le découpage en modules reste à faire.

### 11. Versions incohérentes en amont
En-tête `@version 1.3.13` mais CHANGELOG en `v1.4.x` : le fichier distribué a
plusieurs jours de retard sur les notes. `scripts/build.sh` vérifie désormais
l'alignement `@version` ↔ `WM_VERSION`.

## 🟡 Ergonomie / distribution

### 12. Tampermonkey + mode développeur obligatoire
Depuis Chrome 138 / Edge équivalent (tout le §2 du README upstream). Une vraie
extension MV3 chargée non empaquetée n'a pas cette contrainte.

### 13. `@require` depuis la branche `main` d'un tiers
L'en-tête d'origine chargeait le code depuis
`raw.githubusercontent.com/Sephiroth-ctrl/.../main/open_cards.js` à chaque
chargement de page : tout code poussé là s'exécutait sur le compte de
l'utilisateur. Supprimé dans notre build (`dist/` est autonome).

### 14. Onglet devant rester ouvert et actif
Toute la logique vit dans la page. Un service worker d'extension + `chrome.alarms`
rendrait l'ouverture des packs indépendante de l'onglet.
