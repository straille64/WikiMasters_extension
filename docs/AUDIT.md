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

### 17. Market Watcher : il misait sur tout
Signalé en production le 26/09, une fois la pagination réparée (#16). Trois causes
cumulées, qui ne se voyaient pas tant que le scan ne ramenait que des enchères mortes :

1. le bouton **⚡ Hunter ≤N 💰** faisait miser sur **toute** nouvelle annonce passant
   sous ce seuil, quel que soit le mot-clé qui l'avait fait remonter — un mot-clé
   ajouté pour simplement *surveiller* déclenchait donc des mises ;
2. les mots-clés **⭐ Prioritaires** misaient sans **aucun** plafond
   (`autoBidWithinCap` retourne `true` quand aucun plafond n'est défini) et
   activaient la riposte auto-bid, donc l'escalade était illimitée ;
3. rien ne bornait le **nombre** de mises.

S'y ajoutait le matching par sous-chaîne : `CHAT` attrape « château », « achat »,
« chatte ». Et quatre listes de mots-clés (Standards / Prioritaires / Fourbe /
Chasseur ciblé) qu'il fallait connaître par cœur pour savoir laquelle dépensait.

**✅ Corrigé (1.3.13-fork.7)** — une **seule liste** (`wm_watchlist`), chaque entrée
portant son mode : `manuel` (affichage seul) ou `auto` (mise, plafonnée). Le moteur
de scan n'est pas réécrit : `compileWatchlist()` compile la liste vers les tableaux
internes existants, les entrées `auto` empruntant le chemin du Chasseur ciblé, seul
chemin qui sache déjà gérer mode + plafond + rareté requise. `KEYWORDS_PRIORITY` et
`KEYWORDS_FOURBE` sont vidés : c'étaient précisément les deux chemins sans plafond.
Migration automatique depuis les 4 anciennes listes, dont les clés sont conservées
en secours.

`autoBidAllowed()` devient la porte unique de **toutes** les mises automatiques
(chasse, riposte, snipe, hot-lane) : interrupteur maître, puis plafond de prix global
(`globalBidCap`, 500 par défaut), puis limite horaire glissante (`maxBidsPerHour`, 10
par défaut), puis plafond propre à l'enchère. Le comptage se fait dans
`markAuctionAsMine()`, point de passage unique d'une mise réussie.

Le bouton « Hunter ≤N 💰 » devient l'**interrupteur maître** des mises automatiques,
désormais mémorisé : depuis qu'il commande toutes les mises, le remettre à zéro à
chaque rechargement désarmait le bot sans prévenir.

`tests/watchlist-modes.test.mjs` verrouille les cinq comportements dans un vrai
navigateur : manuel → 0 mise, auto → 1 mise par annonce, interrupteur en pause → 0,
plafond global dépassé → 0, limite horaire à 1 → 1 seule mise.

### 18. Scan tronqué à 3 000 annonces
Le plafond de pagination introduit en fork.5 (`MARKET_MAX_PAGES = 60`, soit 60 × 50)
coupait le scan à 3 000 annonces. Comme le scan trie par `ending_soon`, ce sont les
annonces qui **durent le plus longtemps** qui tombaient hors du scan — donc
précisément celles qu'on a le temps de gagner. Symptôme : « ça ne m'affiche pas tous
les résultats ».

**✅ Corrigé (1.3.13-fork.7)** — plafond porté à 300 pages (15 000 annonces), et le
scan **dit** désormais qu'il a été tronqué au lieu de l'avaler en silence.

### 19. Le scan marché provoquait des 403 sur l'ouverture de paquets
Signalé en production le 26/09 : « l'ouverture de paquet ne fonctionne plus », avec
`⛔ 403 — pause` en boucle. Cause : `MARKET_REFRESH_MS = 10000` et
`MARKET_MIN_GAP_MS = 1500` étaient calibrés pour un scan d'**une seule page** — le
site ne voyait alors que ~6 requêtes/min. Depuis que la pagination fonctionne (#16),
un marché à 5 500 annonces fait **136 pages par scan** ; le scan dure plus longtemps
que l'intervalle visé, donc il repartait 1,5 s après avoir fini : le marché était
interrogé **en continu**, des centaines de requêtes par minute. Le site répondait 403,
y compris sur `/api/packs/open`, sans rapport avec le Pack Opener lui-même.

**✅ Corrigé (1.3.13-fork.8)** — l'espacement entre deux scans est désormais
**proportionnel au coût du scan** (`lastScanPageCount × MARKET_MS_PER_PAGE`), et non
plus une constante. Concurrence ramenée de 5 à 3 pages en parallèle, pause entre lots
de 100 ms à 350 ms. Surtout, un **régime auto-adaptatif** : `marketThrottleFactor`
double dès qu'une page est refusée (403/429) et redescend après un scan propre — le
bot trouve lui-même le débit que le site tolère plutôt que de dépendre d'une constante
devinée. La réactivité ne souffre pas : les enchères suivies restent rafraîchies à la
seconde par la hot lane, qui ne requête que celles-là.

### 20. Mots-clés : la moitié des résultats manquait
Signalé en production le 26/09 : « ça n'affiche pas tous les résultats où notre mot
est ». `keywordFields(card, false)` ne regardait que `wikipedia_title` et `category`,
alors que la recherche du site porte aussi sur le résumé (`summary`, visible dans les
champs de carte relevés au log). Une carte comme « Hidjab » — dont la description dit
« voile porté par certaines **femmes** musulmanes » — était donc invisible pour le
mot-clé `femme`, tout en étant bien listée sur le marché.

**✅ Corrigé (1.3.13-fork.8)** — chaque entrée de la liste porte un champ `extended` :
recherche étendue (titre + catégorie + description) ou stricte. Défaut **activé en
mode manuel** (on veut tout voir, l'affichage ne coûte rien) et **désactivé en mode
auto** (ne pas miser sur une carte qui ne fait que *mentionner* le mot). Réglable
entrée par entrée via le badge 🔎. Les entrées existantes prennent ce défaut au
chargement, sans intervention.

Au passage, le matching passe par un **matcher partagé unique** (`watchEntryMatches`) :
la classification du scan, la chasse (`matchedHunterEntry`) et l'affichage du mot-clé
trouvé (`matchedKeyword`) s'appuyaient sur trois implémentations distinctes, si bien
qu'un réglage comme `extended` se serait appliqué à moitié — une annonce affichée mais
jamais prise en charge par la mise. L'**exclusion** reste volontairement stricte sur
titre + catégorie : une exclusion qui pioche dans les descriptions masquerait des
annonces sans qu'on comprenne pourquoi.

`tests/keyword-extended.test.mjs` vérifie les deux sens : étendu → les 3 cartes
(titre, catégorie, description), strict → seulement les 2 premières.

### 21. `/sales` refusé en 403 → redemandé indéfiniment
Relevé dans la console du navigateur (capture utilisateur du 27/09) :
`GET /api/marketplace/cards/{id}/sales 403` répété **à l'identique** des dizaines de
fois pour la même carte, entremêlé de `POST /api/packs/open 403`.

`fetchCardSales()` faisait `if (!res.ok) return null;` **sans rien mémoriser**.
`getCachedSales()` restait donc vide pour cette carte, `queueSalesFetch()` la remettait
en file au scan suivant, et une carte refusée était redemandée à chaque scan, pour
toujours. Avec un marché à plusieurs milliers d'annonces, c'est ce qui saturait l'API —
et faisait tomber l'ouverture de paquets en 403 par ricochet, sans que le Pack Opener
n'ait quoi que ce soit à se reprocher.

**✅ Corrigé (1.3.13-fork.9)** — l'échec est mémorisé (`failed: true`,
`SALES_FAIL_TTL` = 10 min). Une entrée d'échec est invisible pour `getCachedSales()`
(l'affichage reste « en chargement », jamais une fausse cote) mais bien vue par
`queueSalesFetch()`, qui n'insiste plus. Sur 403/429, `salesEndpointCooldownUntil`
met toute la récupération des cotes en pause 5 min et vide la file, au lieu de
continuer à taper toutes les 2 s.

### 22. Pages de scan refusées, silencieusement perdues
Même capture : le scan affichait 1 annonce trouvée là où le marché en contenait
beaucoup plus. `fetchAllMarketAuctions` traitait une page en erreur comme
`{ ok: false, list: [] }` et passait à la suivante — soit **~50 annonces perdues par
page refusée**, sans le moindre signal. Sous rafale de 403, des pans entiers du marché
disparaissaient du scan.

**✅ Corrigé (1.3.13-fork.9)** — les pages refusées sont collectées puis **rejouées**
une par une après une pause, et ce qui reste irrécupérable est **dit** :
« Scan incomplet : N page(s) refusée(s) […] il manque jusqu'à N × 50 annonces ».

La même capture a aussi livré les champs racine réels de la réponse :
`auctions, page, limit, hasMore`. La pagination s'appuie désormais sur **`hasMore`**,
signal faisant autorité, au lieu de déduire la fin du scan d'une page incomplète ;
le repli heuristique reste en place si le champ disparaît.

`tests/scan-resilience.test.mjs` rejoue les deux : une page refusée au premier essai
doit être récupérée (101 annonces attendues, contre 51 sur le build d'avant — soit
exactement les 50 perdues), et l'endpoint `/sales` refusé en boucle ne doit jamais
recevoir plus d'un appel par carte.

### 23. Correctif #21 appliqué à moitié
En appliquant le correctif #21, le script de patch s'est arrêté sur une ancre ambiguë
(`if (!res.ok) return null;`, présent 5 fois) **avant d'écrire le fichier**. Seule la
partie réappliquée ensuite à la main — l'écriture de l'entrée d'échec dans
`fetchCardSales` — a survécu. Les trois garde-fous qui l'exploitent
(`salesFetchBlocked`, le filtre dans `getCachedSales`, la mise en pause de l'endpoint)
n'étaient **pas** dans le build livré en fork.9.

Le plus gênant : `tests/scan-resilience.test.mjs` **passait quand même**, la mise en
cache seule suffisant à couper la boucle de requêtes. Le test mesurait le symptôme, pas
le mécanisme. Conséquences réelles qui subsistaient : un 403 se lisait « aucune vente »
à l'écran (au lieu de « en chargement ») et restait figé pendant tout le TTL normal.

**✅ Corrigé (1.3.13-fork.10)** — les quatre morceaux sont en place et vérifiés un par
un après écriture. Le test descend de 4 appels `/sales` à 1, ce qui montre que la mise
en pause de l'endpoint mord réellement.

**Leçon retenue** : un script de patch qui échoue sur une ancre doit échouer **bruyamment
et intégralement**. Ceux utilisés ici écrivent le fichier en une seule fois à la fin,
donc un `sys.exit` en cours de route n'écrit rien — mais rien ne le signalait. La
vérification systématique, après écriture, que chaque morceau est bien présent est
désormais la règle.

### 24. Surcouche Collection : cote du marché et défausse sur les cartes
Demande utilisateur. Le DOM du site (relevé le 27/09) ne contient **aucun identifiant
de carte** : la tuile est un empilement de classes Tailwind autour d'un `<h3>` et d'une
image. Deux choix en découlent :

- **Liaison par le titre.** L'image de la carte porte un `alt` identique au texte du
  `<h3>` : la tuile est le plus petit ancêtre qui contient les deux. C'est un invariant
  de contenu, bien plus solide qu'un nom de classe utilitaire — le site est en Tailwind,
  ses classes changent à chaque retouche de style.
- **Index alimenté gratuitement.** Le site charge lui-même `/api/my-collection` ;
  l'intercepteur réseau lit cette réponse au passage pour construire l'index
  titre → `card_id`. Aucune requête ajoutée.

La cote vient de `/api/marketplace/cards/{id}/sales`, l'endpoint qui s'est déjà fait
refuser en 403 (#21). Une collection de 500 cartes ne doit donc surtout pas déclencher
500 requêtes : un `IntersectionObserver` ne met en file que les cartes **réellement
visibles**, et la file reste celle, étalée, du reste du bot. `tests/collection-overlay.test.mjs`
le vérifie explicitement — 43 cartes décorées, 3 cotes demandées.

Le bouton de défausse pose l'étiquette de vente sur un exemplaire
(`ensureTrashTagId` → `findCurrentUserCardId` → `addTagToUserCard`) ; le Trash Seller
s'occupe de la vente. Rien n'est supprimé.

### 25. Le scan traversait ~217 pages d'enchères mortes
Capture réseau du 27/09 : **10 820 annonces terminées sur 12 137** relevées, soit 89 %,
et `⚠️ Scan tronqué au plafond de 300 pages`. Le site laisse en liste ce qu'il n'a pas
encore soldé, et le scan demande `sort=ending_soon` : ces annonces mortes ont le
`end_at` le plus ancien et occupent donc **les premières pages**. Le scan les
téléchargeait toutes — ~217 pages — avant d'atteindre la première annonce vivante, puis
se tronquait au plafond avant d'avoir tout vu. Double conséquence : des résultats
manquants, et 207 requêtes par cycle qui provoquaient les 403 en cascade.

**✅ Corrigé (1.3.13-fork.11)** — « est terminée » est **monotone** dans cet ordre de
tri : dès qu'une page contient du vivant, toutes les suivantes en contiennent. La
première page vivante se trouve donc par recherche exponentielle puis dichotomie
(`findFirstLivePage`), soit une dizaine de requêtes au lieu de deux cents. Le scan
démarre une page avant la frontière, par sécurité — des enchères expirent pendant le
scan et la frontière bouge. La dichotomie n'est tentée que si la page 1 est *entièrement*
morte, donc elle ne coûte rien dans le cas normal. La cadence du scan suivant est
calculée sur les pages **réellement téléchargées**, pas sur le numéro de la dernière
page : sauter 200 pages ne doit pas être facturé comme si on les avait chargées.

`tests/market-dead-pages.test.mjs` : 40 pages mortes puis 3 vivantes → les 150 annonces
vivantes sont trouvées en ne téléchargeant que 14 pages sur 43. Sur le build d'avant,
le test en télécharge 43 sur 43.

### 26. Défausse à sens unique
L'étiquette de vente posée depuis la page Collection ne pouvait plus être retirée par le
même bouton : un second clic la reposait. Or défausser est une décision qu'on révise.

**✅ Corrigé (1.3.13-fork.11)** — `toggleTrashTag()` relit l'état réel côté serveur puis
pose ou retire, et le bouton **montre** cet état (🗑️ libre / ♻️ étiquetée) au lieu de
laisser deviner ce qu'un clic va faire. L'état initial de toute la collection vient
d'**une seule** requête (`loadTrashTaggedCardIds`), pas d'une par carte. Un retrait
accepté mais sans ligne touchée (règle RLS) est signalé comme un échec, et non comme un
succès silencieux.

`tests/collection-overlay.test.mjs` simule l'état serveur et vérifie la bascule dans les
deux sens : pose → ♻️, retrait → 🗑️, avec exactement un POST et un DELETE.

### 27. La cote restait « ? » alors que le site l'affichait
Capture utilisateur : dans « Mettre aux enchères », le site affiche **MOYENNE 82** et,
juste à côté, le badge du bot affiche **?**. La donnée était donc accessible — c'est la
récupération du bot qui restait bloquée sur un refus antérieur.

**✅ Corrigé (1.3.13-fork.12)** — trois changements :

- **On capte la cote que le site récupère lui-même.** Le parsing de `/sales` est extrait
  dans `storeSalesEntry()`, que l'intercepteur réseau appelle aussi. Ouvrir « Mettre aux
  enchères » (ou n'importe quelle vue du site qui demande l'historique) remplit donc le
  cache du bot — zéro requête ajoutée, et ça contourne un refus sur notre propre appel.
- **Le blocage après refus devient progressif** : 1 min, 2, 4… plafonné à 30 min, au lieu
  d'un forfait plat de 10 min qui laissait un « ? » affiché bien après que le site eut
  recommencé à répondre.
- **Les fenêtres modales ne sont plus décorées.** Elles contiennent une mini-carte de
  même structure : le bot y ajoutait un badge en doublon de la MOYENNE du site, et un
  bouton par-dessus ses commandes. Reconnues à leur conteneur en position fixe.

`tests/collection-overlay.test.mjs` couvre la séquence complète : refus → badge « ? »
(jamais un faux prix), puis requête du **site** → badge rempli **sans** que le bot
redemande quoi que ce soit, et mini-carte de modale laissée intacte.

### 28. Détection de modale trop large : plus rien n'était décoré
Le correctif #27 écartait les mini-cartes des fenêtres modales en regardant si **un**
ancêtre avait `position: fixed`. Beaucoup trop large : la page Collection enveloppe sa
grille dans une colonne de contenu en position fixe, donc **toutes** les cartes étaient
prises pour des cartes de modale et plus rien n'était décoré — l'inverse exact du but.

**✅ Corrigé (1.3.13-fork.13)** — une modale se reconnaît à son fond qui **couvre le
viewport** (≥ 90 % en largeur ET en hauteur), pas à `position: fixed` seul.

Le test précédent ne pouvait pas l'attraper : son conteneur fixe était un **voisin** des
cartes, pas un **ancêtre**. Il enveloppe désormais la grille, et porte une contre-épreuve
explicite — « la grille dans une colonne fixe DOIT être décorée ».

### 29. Le site appelle `/sales?scope=summary`, pas `/sales`
Onglet Réseau de l'utilisateur, en ouvrant « Mettre aux enchères » :
`GET /api/marketplace/cards/{id}/sales?scope=summary` → **200 OK**, une seule requête.
Le bot, lui, appelait `/sales` sans paramètre — et se faisait refuser en 403.

**✅ Corrigé (1.3.13-fork.13)** — le bot emprunte exactement le même chemin que le site.
Et `storeSalesEntry()` accepte désormais **les deux formes** de réponse : la liste
complète (`sales[]`) et le **résumé** que renvoie `?scope=summary`. Sans ce second cas, un
résumé se lisait « aucune vente » — un tableau `sales` absent donnant un compte de zéro,
ce qui est exactement ce que montrait le badge `💰 —`. Les noms de champs du résumé
n'étant pas documentés, les plus plausibles sont sondés et les clés reçues tracées une
fois, pour repérer un renommage futur.

### 30. La moyenne est imbriquée sous la rareté
Réponse réelle relevée par l'utilisateur en ouvrant l'URL directement :

```json
{"wikipedia_title":"Game Boy Advance","summary":{"SR":{"average":668}},"isPro":false}
```

Le correctif #29 sondait `average` / `avg` / `median` **à la racine**. Ils n'y sont pas :
la moyenne vit sous `summary.<RARETÉ>.average`. Le badge affichait donc `—` alors que la
requête répondait parfaitement — exactement ce que montrait la capture.

Ce n'est pas un détail de nommage : **une même carte n'a pas la même cote selon sa
rareté** (`{C: 7, SR: 44}`). Afficher la première venue serait faux.

**✅ Corrigé (1.3.13-fork.14)** — toutes les raretés sont conservées dans `byRarity`, et
l'affichage choisit celle de l'exemplaire. La rareté est lue sur la tuile (`tileRarity`)
en cherchant le badge dont le texte est exactement l'un des six codes — plus robuste
qu'un nom de classe Tailwind. L'infobulle liste les autres raretés.

### 31. Les cotes mettaient plusieurs minutes à se remplir
`processSalesQueue` traitait **une carte toutes les 2 à 4 secondes**. Sur une page de
collection, remplir 40 cotes demandait plus de deux minutes : inutilisable.

Ce rythme datait d'une époque où le bot tapait le mauvais endpoint et se faisait refuser.
La capture réseau montre que **le site lui-même** tire des dizaines de
`sales?scope=summary` en parallèle au chargement de la page — c'est donc le rythme qu'il
tolère.

**✅ Corrigé (1.3.13-fork.14)** — lots de 5 en parallèle, 200 ms entre deux lots : ~1,5 s
pour 40 cartes au lieu de ~2 min. Le garde-fou reste `salesEndpointCooldownUntil` : au
premier refus, toute la file s'arrête. Et comme l'intercepteur capte déjà les requêtes que
le site émet pour sa propre grille, une bonne part des cotes arrive sans que le bot ait
quoi que ce soit à demander.

### 32. L'API sait chercher — le bot balayait au lieu de demander
Relevé dans l'onglet Réseau de l'utilisateur, en tapant « femme » dans la recherche du
marché :

```
GET /api/marketplace?page=1&limit=50&sort=recent&q=femme   → 200, 14,4 ko
GET /api/marketplace?page=2&limit=50&sort=recent&q=femme   → 200   (charger la suite)
```

L'API accepte un paramètre **`q=`** et filtre côté serveur. Le bot, lui, téléchargeait le
marché entier (~300 pages, 12 000 annonces dont 89 % de terminées) pour refaire ce filtre
en JavaScript. D'où tout le reste : scans tronqués au plafond, 403 en cascade jusque sur
l'ouverture de paquets, et surtout un écart permanent entre « ce que je vois sur le site »
et « ce que le bot trouve ».

**✅ Corrigé (1.3.13-fork.15)** — une recherche serveur par mot-clé de la liste
(`fetchWatchedAuctions`), paginée via `hasMore`. Sur le test : **60 annonces en 4
requêtes** au lieu de plusieurs centaines. Et les résultats sont, par construction,
exactement ceux que le site affiche.

Trois précautions :

- **Repli automatique.** Si l'API cessait d'honorer `q`, elle renverrait le marché entier
  et le bot afficherait n'importe quoi. Une sonde mesure la **proportion** d'annonces
  ramenées qui contiennent réellement le mot — se contenter de « au moins une correspond »
  ne suffit pas, un marché entier en contient forcément quelques-unes. Sous 50 %, retour
  au balayage complet, signalé dans le log. La sonde tranche **dès la première page** :
  sans ça, on téléchargeait jusqu'à 20 pages par mot-clé avant de s'en apercevoir.
- **Pages refusées rejouées sur place.** Abandonner une page perdrait aussi toutes les
  suivantes (`hasMore` devient inconnu), soit un trou silencieux — le défaut déjà corrigé
  côté balayage complet (#22), qu'il aurait été absurde de réintroduire ici.
- **Enchères suivies protégées.** Une enchère où je mise mais qui ne correspond à aucun
  mot-clé serait absente du scan, et le pruning la déclarerait terminée à tort. Les ids de
  `myBidsSet` manquants sont donc récupérés un par un.

`tests/market-server-search.test.mjs` vérifie les trois : `q=` utilisé, pagination suivie,
poignée de requêtes — et le repli déclenché quand l'API ignore `q` (scénario où le bruit
arrive en tête, sinon une page 1 accidentellement filtrée ne prouverait rien).

### 33. Trash Seller : prix au marché, et aperçu de l'ordre de vente
Demande utilisateur. Deux points, liés : l'aperçu n'a de valeur que s'il annonce **le**
prix réellement pratiqué.

**Prix = moyenne du marché, repli sur le tableau.** `resolveSellBasePrice()` savait déjà
le faire, mais l'option était **désactivée par défaut** — elle passe à activée. Surtout,
un défaut de correction : depuis que la cote vient de `?scope=summary`, elle est donnée
**par rareté** (`{"SR":{"average":668},"C":{"average":7}}`). Lire `entry.avg` (la première
rareté rencontrée) revenait à vendre une SR au prix moyen d'une commune — une perte
sèche. La moyenne de la rareté demandée est désormais choisie explicitement, et
`entry.avg` n'est utilisé que pour les entrées de cache à l'ancien format.

**Aperçu de l'ordre de vente.** Bouton 👁️ Aperçu dans le panneau : liste, sans rien
vendre, les prochaines cartes qui partiraient — rang, rareté, titre, **origine du prix**
(💹 marché / 📋 défaut / 🛡️ plancher / 📉 dégressif), prix et durée, avec le total et la
stratégie en cours.

Il réutilise `selectTrashBatch()` et `resolveSellBasePrice()` — les fonctions du vrai
parcours de vente, pas une réimplémentation. Un aperçu qui calculerait le prix autrement
que la vente elle-même serait pire qu'aucun aperçu : il donnerait confiance dans un
chiffre faux. Seule différence assumée : rien n'est envoyé.

`tests/trash-seller-preview.test.mjs` monte trois cartes — une SR cotée, une C cotée
(même carte, cotes 668 et 7) et une SR sans cote — et vérifie que la SR part à 668, que
7 n'apparaît jamais, que la carte sans cote retombe sur les 123 du tableau, que l'origine
de chaque prix est affichée et que l'ordre suit la stratégie choisie.

### 34. « Plancher » se lisait comme « prix par défaut »
Retour utilisateur : « pour le prix moyen de vente ce n'est pas bon, ça met le prix par
défaut de la rareté ». Vérification faite sur ses propres chiffres, **le calcul était
juste** : cote R à 7, minimum de tableau à 20 → 7 < 20 → on vend à 20. C'est exactement
la règle demandée (prix du marché, relevé au minimum s'il passe dessous).

Le défaut était l'**affichage**. L'aperçu écrivait `🛡️ plancher · 20 💰` sans jamais
montrer la cote trouvée : impossible de distinguer « cote de 7 relevée à 20 » de « aucune
cote, prix par défaut ». Les deux aboutissent au même nombre, et on ne peut pas faire
confiance à un prix dont on ne voit pas la provenance.

Deuxième angle mort : le réglage `sellMarketPricePct` valait **110 %** chez l'utilisateur
(valeur d'origine en amont, conservée puisque déjà en localStorage). À 110 %, le prix
n'est plus « la moyenne du marché » — et rien ne le rappelait une fois les Paramètres
refermés.

**✅ Corrigé (1.3.13-fork.18)** — aucun changement de règle, seulement de lisibilité :

- `resolveSellBasePrice()` conserve `marketPrice`, le prix issu de la règle marché **avant**
  plancher. Sans cette valeur, expliquer le résultat était impossible.
- L'aperçu affiche les deux chiffres : `🛡️ marché 7 → min 20`, `💹 marché 668`, ou
  `📋 pas de cote → min`. L'infobulle donne la cote, le nombre de ventes et le minimum.
- Un bandeau apparaît quand le pourcentage n'est pas 100 %, avec la valeur appliquée.
- Une ligne rappelle la règle en toutes lettres, au-dessus de la liste.

`tests/trash-seller-preview.test.mjs` rejoue le cas exact remonté (cote 7 en R, minimum 20)
et exige que l'aperçu affiche « marché 7 → min 20 » — pas seulement le bon prix final.

### 35. Arriver sur /collection suffisait à mettre des cartes en vente
Retour utilisateur : « quand je vais dans collection, sans que je touche à quoi que ce
soit, ça clique sur des cartes et ça les met en vente automatiquement ». Ce n'était pas
une impression : le comportement était **écrit dans le code**, et deux mécanismes s'y
ajoutaient.

**1. Reprise silencieuse.** `startTrashSeller()` posait `sessionStorage.wm_trashseller_active`,
et le script, à **chaque** chargement, relançait le Trash Seller si ce drapeau était là.
Un F5, une navigation qui recharge la page, un onglet restauré : le bot repartait, cliquait
sur les tuiles et listait des cartes sans qu'on ait rien demandé. Une mise en vente est
irréversible — c'est précisément le genre d'action qui ne doit jamais démarrer seule.

**2. Aucune vérification de la carte ouverte.** `sellCardViaUI()` cherchait le titre dans
le DOM, remontait jusqu'à un ancêtre `.cursor-pointer`, cliquait, puis cliquait
« Mettre aux enchères » et enfin **« Lancer l'enchère » sans jamais regarder quelle carte
la fenêtre affichait**. Tout décalage (grille encore en cours de filtrage, tuile recyclée
par React, recherche non appliquée) vendait donc une carte qu'on ne visait pas — y compris
une carte sans le tag de vente, puisque le filtre par tag agit en amont, sur le pool, pas
sur ce qui est réellement cliqué.

**3. Le bot pouvait se cliquer lui-même.** `findLeafByExactText()` balayait tout le
document ; or le dashboard affiche aussi des titres de cartes (aperçu de vente, résultats
du Market Watcher, logs). Un match dans notre propre panneau, et la remontée vers
`.cursor-pointer` désignait un élément de l'interface du bot. Même remarque pour
`findButtonByText()` sur les libellés de durée (« 1 h », « 30 min »), présents des deux côtés.

**✅ Corrigé (1.3.13-fork.19)**

- La reprise après rechargement est **opt-in** : nouveau réglage `sellAutoResume`, **désactivé
  par défaut**. Sans lui, le drapeau est effacé et le panneau affiche « Arrêté par le
  rechargement de la page — ▶ START pour reprendre ».
- Filet de sécurité avant le clic irréversible : la fenêtre ouverte doit afficher le titre
  visé (`p.font-semibold.text-sm.truncate`, replis sur le texte de la modale). Sinon la vente
  est abandonnée, la fenêtre refermée, et le log dit quelle carte était affichée à la place.
- Contrôle intermédiaire : la tuile résolue doit contenir le titre attendu avant le clic.
- `findLeafByExactText()` et `findButtonByText()` ignorent le DOM du bot (`isBotOwnNode`,
  tout ce qui est sous un `id`/`class` préfixé `wm-`). `findModalRoot()` borne la recherche
  au conteneur de la modale : remonter jusqu'à `<body>` aurait validé n'importe quoi, la
  grille derrière contenant forcément le titre.
- `sellMarketPricePct` : le 110 % hérité de l'amont est ramené au défaut **100 %** (une
  seule fois, drapeau `wm_sell_market_pct_100_v1`, et uniquement si la valeur stockée est
  exactement 110 — un réglage choisi volontairement n'est pas écrasé).

`tests/trash-seller-safety.test.mjs` couvre les deux volets et a été validé par mutation :
en rétablissant la reprise inconditionnelle, le test constate une carte vendue sans action
utilisateur ; en neutralisant le contrôle de la fenêtre, il constate la carte affichée
vendue **deux fois** — le symptôme exact remonté. Un témoin positif (la carte visée doit
bien partir en vente) empêche le test de passer parce que rien ne se vend.

### 36. Des ventes créées étaient comptées comme des échecs
Logs du 27/09 : `modal_still_open`, puis `no_sell_button`, puis `no_search_input` en
cascade — alors que le site affichait bien 5 ventes actives et que « Ventes (aujourd'hui) »
restait vide. Trois défauts qui s'enchaînent.

**1. Le succès était jugé sur le DOM.** Après le clic sur « Lancer l'enchère »,
`sellCardViaUI()` attendait 900 ms puis concluait : bouton encore présent → échec. Or le
démontage du composant React prend parfois plus longtemps que la requête. Une vente
**créée** était donc déclarée en échec : pas de `recordSale()`, donc absente de
`sellHistory`, donc absente du panneau du jour et jamais réconciliée — et le retry
immédiat pouvait **la remettre en vente une seconde fois**.

**2. Le site navigue après une mise en vente.** Il part sur `/marketplace/{id}`.
`ensureOnCollectionPage()` ne connaissait qu'un bouton « Retour au marché » : absent, elle
rendait `false`, d'où le `no_search_input` sur la carte suivante et la mise en pause du
module. Constaté par l'utilisateur : « quand une mise en vente est faite ça m'emmène sur
une autre vue que la page collection ».

**3. L'aperçu ne montrait que la prochaine fournée.** `Math.max(slots, 1)` : créneaux
pleins → **une seule ligne** pour un pool de 8. La question posée (« lesquelles vont être
vendues, dans quel ordre ») restait sans réponse.

**✅ Corrigé (1.3.13-fork.20)**

- Le succès se lit sur la **réponse du site** : l'intercepteur remplit
  `_lastUiListingAuctionId` quand le `POST /api/marketplace` de la fenêtre répond OK. On
  l'attend jusqu'à 8 s, avec un délai de grâce si la fenêtre se ferme sans identifiant
  lisible (vente enregistrée, mais signalée comme non suivable).
- `ensureOnCollectionPage()` essaie dans l'ordre : `history.back()` (la page de l'enchère
  est empilée par-dessus la collection — navigation SPA, le bot reste en vie), le bouton du
  site, un lien `/collection`, puis en dernier recours une navigation dure. Celle-ci
  recharge la page : un marqueur horodaté à usage unique (`wm_trashseller_selfnav`, 60 s)
  fait reprendre le Trash Seller **uniquement** parce que c'est lui qui a navigué — un F5
  de l'utilisateur ne relance toujours rien (cf. #35).
- L'aperçu liste **tout le pool** dans l'ordre de passage (borné à 60 lignes cotées), et
  surligne celles qui partent immédiatement.
- « Ventes (aujourd'hui) » affiche aussi les ventes **en cours** lancées le jour même :
  le panneau ne reste plus vide tant que rien n'est conclu.

`tests/trash-seller-safety.test.mjs` couvre le cas : la fenêtre reste montée après le POST,
et le test exige que la vente soit enregistrée. Mutation de contrôle (retour à l'attente de
900 ms) : le test voit l'échec ET la double mise en vente de la même carte.

### 37. Le Fourbe « activé » qui ne misait jamais, et la mise perdue à égalité
Deux retours du 27/09, deux mécanismes différents.

**1. L'interrupteur maître bloquait en silence.** `autoBidAllowed()` commençait par
`if (!autoSnipeEnabled) return false;` — sans un mot. Or la carte, elle, affichait
« 🕵️ Fourbe activé (snipe à ~60s de la fin) ». L'utilisateur voyait l'enchère passer sous
les 60 s et aucune mise partir, sans la moindre ligne pour relier les deux. Le bandeau
disait bien « ⏸️ Mises auto EN PAUSE », mais rien ne le rattachait à la carte armée.

**2. À mise simultanée, c'est l'autre qui passait.** Entre le calcul du montant et
l'arrivée du POST, un autre joueur peut miser : le site refuse alors le nôtre (« montant
trop bas ») et les cinq chemins de mise se contentaient d'un `wmLog('… échoué')`. Sur le
snipe, un tick suivant pouvait repasser ; sur le Chasseur, le Hunter ou un mot-clé
prioritaire — une mise unique à la découverte — **la mise était simplement perdue**.

**3. Angle mort trouvé en vérifiant l'auto-bid.** `runHunterAutoBidPass()` ne passait pas
par le garde-fou commun : il ne consultait que son propre seuil (`autoSnipePrice`). Ni le
plafond global ni la limite de mises par heure ne s'y appliquaient — le seul des cinq
chemins dans ce cas, et justement celui qui avait causé le « il mise sur tout » (#17).

**4. Précision du snipe.** `computeHotLaneInterval()` figeait à **20 s** la fenêtre de
polling serré (150 ms) et calculait le temps restant sur `Date.now()`. Avec un snipe réglé
à 60 s, la décision de tir tombait donc sur un tick lent (jusqu'à 2 s de retard), et le
décalage PC↔serveur (3,0 s mesurés chez l'utilisateur) s'ajoutait à l'erreur.

**✅ Corrigé (1.3.13-fork.21)**

- `warnAutoBidsPaused()` : une ligne de log explicite (1 par minute au plus) quand
  l'interrupteur bloque, **au moment du tir** comme **au moment de l'armement** (bouton
  Fourbe, bouton auto-bid, mot-clé, Hunter agressif). Le bandeau affiche en plus le nombre
  d'enchères armées qui ne miseront pas.
- `placeBid()` : point de passage unique des cinq chemins. Sur refus, il relit l'enchère,
  recalcule le minimum, **revérifie tous les plafonds**, et retente (3 essais, ~180 ms).
  Un refus définitif (terminée, solde) n'est pas retenté. Le log signale la mise rattrapée.
- Le Hunter passe désormais par `autoBidAllowed()` comme les quatre autres.
- La fenêtre de polling serré suit le réglage (`snipeSecondsBefore` + 10 s) et le temps
  restant se calcule sur l'horloge **serveur**.

`tests/snipe-race.test.mjs` : le snipe tire sous la fenêtre, la pause est expliquée, la
course est rattrapée à la hausse, et le rattrapage respecte le plafond. Mutations de
contrôle : sans la relance interne, la mise unique du Chasseur ne monte plus (39 → 39) ;
sans le log, le blocage redevient invisible.

### 38. « Compteur inconnu » lu comme « aucune vente en cours »
Logs du 27/09, répétés toutes les 8 minutes :

```
🔬 Aperçu brut : {"sellingCount":null,"maxConcurrentAuctions":5}
🔬 /mine : 0 vente active retenue.
```

Le site a cessé de renvoyer son compteur : `sellingCount` vaut **`null`**, pas un nombre.
`mineSellingState()` faisait alors `firstFinite(null, …)` → rien de fini → repli sur
`list.length`, une liste que /mine ne fournit plus non plus, donc **0**. Le bot en
concluait « 0 vente active, 5 créneaux libres » et repartait lister — dans un plafond déjà
plein. D'où les 50 minutes d'échecs en rafale du log, et le diagnostic de l'utilisateur,
exact : « il a du mal à détecter qu'on est déjà à 5 ventes et il essaye quand même ».

Deux aggravants dans la même boucle :

- **La barre de recherche était cherchée une seule fois.** Sur /collection elle n'est
  rendue qu'une fois les données chargées ; juste après un retour de navigation, elle
  n'existe pas encore. D'où les `no_search_input` en rafale — un défaut de patience, pas
  de page.
- **Une fenêtre bloquée ne disait rien.** `modal_still_open` était rendu tel quel alors que
  le site affiche presque toujours le motif du refus dans la fenêtre.

**✅ Corrigé (1.3.13-fork.22)**

- `mineSellingState()` distingue « compteur absent » de « zéro » (`countKnown`).
  Quand il est absent, `fetchSellingState()` **recompte avant tout calcul de créneaux** :
  d'abord la base (`auctions` filtrée `seller_id` + `status=active` + `end_at>now`, qui voit
  aussi les ventes créées à la main sur le site), sinon les identifiants d'enchères du bot.
- La barre de recherche est **attendue** (jusqu'à 6 s), avec un repli sur tout champ dont le
  placeholder parle de recherche.
- Une fenêtre bloquée est lue : le message du site part dans le log, la fenêtre est refermée,
  et s'il parle de limite/maximum/simultané, le lot s'arrête (pause ferme de 2 min existante).
- Coupe-circuit : **3 échecs d'affilée** interrompent le lot et déclenchent une pause d'1 min
  avant un nouveau décompte. Enchaîner n'aidait pas et nourrissait l'anti-bot du site.

`tests/selling-count-unknown.test.mjs` rejoue la réponse exacte du site : avec 5 ventes
actives en base et un plafond de 5, aucune mise ne doit partir ; avec 4, une mise doit
partir (témoin positif). Mutation de contrôle : en rétablissant l'ancienne lecture, le test
retrouve le symptôme mot pour mot — « Mise en vente de 2 carte(s) (0 actives) ».

### 39. Recherche serveur condamnée à tort, et définitivement
Capture du 27/09 : le bandeau du Market Watcher affichait `⏳ p.277/277 · 13105 ann…`.
Le bot ne cherchait plus — il **balayait le marché entier** à chaque scan, pour un seul
mot-clé. Trois défauts enchaînés.

**1. La sonde jugeait sur des champs que la réponse ne contient pas.** Elle comptait la
proportion d'annonces dont le titre, la catégorie ou le résumé contenaient le mot. Or le
site indexe aussi des champs que `/api/marketplace` ne renvoie pas. Une recherche qui
**fonctionnait** était donc déclarée cassée — « moins de la moitié des annonces contiennent
le mot » signifiait seulement « je ne reçois pas le champ où il est ».

**2. Le verdict était définitif.** `serverSearchBroken` était un verrou à sens unique :
une fois posé, plus aucune tentative jusqu'au rechargement de la page. D'où le balayage de
277 pages répété indéfiniment — « les recherches tournent à l'infini ».

**3. Les résultats trouvés étaient jetés.** Même quand `q=` ramenait les bonnes annonces,
le bot les re-testait localement avec ses propres champs, ne trouvait pas le mot, et les
écartait. La recherche marchait, l'affichage restait vide.

**✅ Corrigé (1.3.13-fork.23)**

- Nouvelle sonde, qui ne suppose rien de ce que le serveur indexe : elle compare la 1re page
  **filtrée** à la 1re page **non filtrée**. Si `q` est ignoré, les deux servent les mêmes
  annonces (≥ 80 % d'identifiants communs). Verdict mis en cache 10 min — 2 requêtes, pas
  une par scan.
- Le verdict « cassée » **expire au bout de 10 min** : le bot re-sonde et repasse sur `q=`
  dès que le site répond de nouveau correctement. Une ligne de log l'annonce.
- Une annonce ramenée par `q=<mot>` est **marquée** avec ce mot (`card.__wmServerKw`) et
  tous les matcheurs l'honorent : c'est le serveur qui sait quels champs il indexe.
- Une page refusée pour TOUS les mots-clés ne rend plus un scan « réussi » à 0 annonce :
  le scan est ignoré (sinon le pruning déclarait terminées des enchères vivantes). Un scan
  partiel est signalé dans le bandeau et **suspend tous les pruning**.

`tests/market-search-probe.test.mjs` rejoue le cas exact : le site filtre, mais le mot
n'apparaît dans aucun champ renvoyé. Trois mutations de contrôle échouent comme attendu —
verdict faussé (« déclarée cassée », 14 requêtes non filtrées), verrou définitif (« plus
aucune tentative »), et verdict serveur ignoré (« aucune annonce ne remonte »).

### 40. Le bouton de mode changeait l'état sans jamais le montrer
Logs du 27/09, en rafale sur la même carte :

```
17:44:40 🤖 Auto-bid activé : ?
17:44:39 ⚪ Mise manuelle : ?
17:44:38 🕵️ Fourbe activé : ?
```

Trois cycles complets Manuel → Auto-bid → Fourbe en quarante secondes : le mode avançait
bien d'un cran à chaque clic, mais **rien ne bougeait à l'écran**, alors l'utilisateur
recliquait. Deux causes.

**1. La mise à jour du bouton reposait sur un re-render qui est fait pour être sauté.**
`wmCycleBidMode()` se contentait de redemander un rendu complet de la liste. Or
`renderMarketHits()` s'interrompt volontairement tant qu'un champ du panneau a le focus —
sinon le champ « plafond », placé juste à côté du bouton, perdrait la frappe en cours.
Le bouton gardait donc son ancien libellé.

**2. Le titre ne venait que d'`activeHitsMap`.** Cette map est vidée à chaque (re)démarrage
du Market Watcher, alors que les cartes restent affichées : d'où les « ? ».

**3. Et la mise manuelle court-circuitait tout.** Le bouton « 🔨 Miser » exécutait un
`fetch` écrit à la main dans son attribut `onclick` — les trois vues en avaient chacune
une copie. Aucune ne bénéficiait du rattrapage de course ajouté en fork.21 : une mise
refusée parce qu'un autre joueur venait de miser affichait « ✗ Échec », point.

**✅ Corrigé (1.3.13-fork.24)**

- `paintBidModeButton()` repeint le bouton cliqué **sur place**, avant de demander le
  re-render complet. Ce qui s'affiche ne dépend plus d'un rendu qui peut être ignoré.
- `auctionTitleById()` interroge `activeHitsMap` **puis** le cache de rendu. Exposé en
  `window.wmAuctionTitle` pour les handlers des vues héritées, qui avaient le même défaut.
- `window.wmManualBid()` : point d'entrée unique des trois vues, qui passe par `placeBid`
  (relecture de l'enchère, nouveau minimum, relance). Une mise manuelle n'est soumise ni à
  l'interrupteur des mises auto ni à la limite horaire — l'utilisateur a cliqué — mais
  reste tenue par le plafond global (`manualBidAllowed`).

`tests/bid-mode-ui.test.mjs` clique les boutons **avec le focus dans le champ plafond** et
`activeHitsMap` vidée — les deux conditions réunies du bug. Trois mutations de contrôle
échouent : sans la repeinture, le bouton affiche « ⚪ Manuel » alors que le Fourbe est armé
(le symptôme exact) ; sans le repli de titre, le log dit « ? » ; sans `placeBid`, la mise
manuelle s'arrête au premier refus.

### 41. Collection : cartes sans cote ni bouton, et « ? » qui ne partaient jamais
Capture du 28/09 : sur la page Collection, une carte sur trois environ n'avait **ni cote
ni bouton 🗑️** — Pierre Berger, Rydge Conseil, Pouvoirs, Maquis des Vosges, John Fowles,
The Tunnel, DoTerra, Véra Belmont. Point commun : **toutes affichent le logo « WM »**, faute
d'illustration Wikipédia. Et ailleurs, des cotes bloquées sur « ? » alors que le site, lui,
connaissait le prix. Quatre causes.

**1. La détection partait de l'image.** Une tuile était « le plus petit ancêtre d'une
`<img>` dont l'`alt` égale le titre du `<h3>` ». Les cartes sans illustration n'ont pas
cette image : elles n'étaient jamais reconnues.

**2. Une cote manquée n'était plus jamais redemandée.** L'`IntersectionObserver` se
désabonnait d'une tuile dès sa première apparition. Si la demande échouait (refus du site)
ou était écartée pendant une pause globale de l'endpoint, **rien ne la relançait** tant que
la carte restait affichée : « ? » ou « ⋯ » jusqu'au rechargement de la page.

**3. Une carte jamais vendue n'était pas mémorisée.** `{"summary":{}}` faisait sortir
`storeSalesEntry()` sans rien écrire : « ⋯ » à vie, et la carte redemandée à chaque passage.

**4. Un titre non indexé laissait la tuile nue.** La liaison tuile → carte passe par le
titre ; une espace insécable dans le `<h3>`, ou une page de collection chargée sans passer
par l'intercepteur, et la tuile n'était jamais décorée.

**✅ Corrigé (1.3.13-fork.25)**

- Détection ancrée sur le **`<h3>`**, toujours présent : la tuile est son plus petit
  ancêtre portant le badge de rareté et ne contenant qu'un seul titre. Une tuile déjà
  décorée est écartée d'un simple `closest`, **avant** tout calcul de style.
- Visibilité suivie **en continu** ; `healCollectionQuotes()` remet en file, à chaque tic
  de 5 s, les cartes visibles encore sans cote dès que c'est permis (blocage par carte
  expiré, pause globale terminée). Aucune requête sinon.
- Résumé vide mémorisé comme « aucune vente » (« — »), avec une durée de vie d'1 h au lieu
  de 12 h : une première vente peut arriver à tout moment.
- `normTitle()` (NFC, espaces insécables, espaces multiples) des deux côtés de l'index ; et
  pour les titres toujours inconnus, **une** requête groupée à la table `cards`, au plus
  toutes les 30 s, sans redemander un titre avant 10 min. Deux cartes au même titre : on
  ne devine pas, la tuile reste sans décoration.
- Nouvel état « ⏸ » quand le site a mis les demandes de cote en pause, avec le délai de
  reprise — au lieu d'un « ⋯ » qui laisse croire que ça charge.
- Les badges ne sont réécrits que s'ils changent.

**Mesuré** sur une grille de 600 cartes dont 200 sans illustration, 30 re-rendus du site :
avant **400/600** cartes décorées et **146 ms** de JavaScript ; après **600/600** et **37 ms**.

`tests/collection-overlay-robust.test.mjs` couvre les quatre causes ; chacune a sa mutation
de contrôle, qui échoue sur sa propre assertion. `tests/collection-overlay.test.mjs`
(structure réelle du site, modale ignorée, seules les cartes visibles interrogées) reste vert.

### 42. Trash Seller : des cartes relancées en boucle au plancher
Logs du 28/09, une heure de fonctionnement : **26 mises en vente, 2 ventes**. La plupart des R
partaient au **plancher de 15 💰** pour une cote de **1 à 10 💰** (*The Tunnel* : cote 2,
*Pouvoirs* : cote 1), revenaient invendues et repartaient au même prix — 🔁2, 🔁3. L'ancienne
baisse (-15 % par tranche de 10 remises) ne se déclenchait jamais à ce rythme. À l'inverse,
*The First Slam Dunk*, listée à sa cote (47), est partie à **100 💰** sur surenchère.

Échecs dans le même log : `card_not_found` ×5 (dont des titres à apostrophe), `no_sell_button`
×2, « Impossible de créer l'enchère » ×3 (repris au 2e essai).

**✅ Nouvelles règles (1.3.13-fork.26)**, choisies par l'utilisateur :

- **% de la cote par rareté**, réglable dans le panneau Trash Seller (au-dessus de 100 :
  plus cher que le marché ; en dessous : pour vendre plus vite). Non réglé → le % global.
- **Plancher limité dans le temps** : le minimum du tableau ne protège que les **2 premières**
  mises en vente d'une carte (`sellFloorTries`, 0 = toujours) ; ensuite, le marché décide.
- **Baisse par invendu** : **-10 %** à chaque invendu (`sellDecayStepPct`), jamais sous
  **50 %** du prix de départ (`sellDecayMinPct`). Remplace -15 %/10 remises.
- **Mise de côté** : au-delà de **6 invendus** (`sellSetAsideAfter`, 0 = jamais), la carte
  sort de la file ; elle garde son tag et s'affiche dans « 🗃️ Mises de côté », d'où un clic la
  remet en vente avec un compteur remis à zéro. Filtre posé dans `selectTrashBatch()`, le
  point de passage commun (vente, aperçu, refresh).
- L'aperçu dit tout : `🛡️ marché 7 → min 15 (2×)`, `🔓 plancher levé`, `📉-20%`, et le nombre
  de cartes mises de côté.

**✅ Échecs corrigés**

- `normTitle()` replie la ponctuation typographique (’ – « ») sur l'ASCII. Utilisée par la
  recherche de la tuile, le contrôle de la tuile **et** le garde-fou de la fenêtre — qui,
  sinon, aurait refusé la bonne carte pour une apostrophe.
- La barre de recherche reçoit le plus long morceau du titre **sans ponctuation**
  (`searchTermFor`) : taper l'apostrophe ASCII ne trouvait rien si le site stocke l'autre.
- Attente de la tuile portée à 8 s ; le bouton « Mettre aux enchères » est **attendu**
  (3 s) au lieu d'être cherché une fois à 600 ms, et la fiche est refermée s'il n'apparaît pas.

`tests/trash-seller-pricing.test.mjs` vérifie les 7 prix d'un pool construit pour couvrir
chaque règle, la mise de côté et son retour. `tests/trash-seller-ui-robust.test.mjs` rejoue
l'apostrophe typographique et une fiche lente. Mutations de contrôle : % global à la place du
% par rareté, plancher permanent, baisse non bornée, mise de côté désactivée, bouton cherché
une seule fois — toutes échouent. La version précédente échoue sur l'apostrophe avec le
`card_not_found` exact des logs.

### 43. Un refus de recherche déclenchait un balayage de 7 minutes, qui masquait la suivante
Logs du 28/09 : à 19:59 la recherche « eiffage » est refusée (403) ; le bot bascule sur le
**balayage complet** du marché (8016 annonces). À 20:00 l'utilisateur remplace le mot-clé par
« Marcel Dassault » et relance le Market Watcher : le premier scan est **abandonné en silence**
(`if (marketScanInProgress) return;`, sans reprogrammation). À 20:07 c'est le vieux balayage qui
s'affiche — après même un STOP — et il rate les 2 « Marcel Dassault » UR que la recherche du site
trouve en une requête.

**✅ Corrigé (1.3.13-fork.27)**

- Une recherche **refusée** n'entraîne plus de balayage complet : l'affichage est conservé et la
  recherche est retentée 20 s plus tard. Le balayage complet reste réservé au cas où le site
  ignore réellement `q=`.
- **Génération de scan** (`marketScanGen`) : démarrage, arrêt et toute modification de la liste
  de mots-clés rendent le scan en cours périmé ; il s'arrête à la page suivante et n'affiche rien.
- Une seule boucle de scan vit à la fois (`marketLoopGen`) ; si un scan périmé finit sa page, la
  nouvelle boucle repasse 500 ms plus tard au lieu de mourir.
- Ajouter, retirer ou modifier un mot-clé relance la recherche **immédiatement**.
- Les deux compteurs sont déclarés en tête du script : `saveWatchlist()` peut être appelé dès le
  chargement (migration des anciennes listes), avant l'endroit où ils étaient d'abord définis.

Couvert par la suite existante du Market Watcher (recherche serveur, sonde, filtres, pagination,
modes, mises). Pas encore de test dédié au changement de mot-clé en cours de scan.

### 44. Le Trash Seller ne voyait que 2 cartes Trash sur une quinzaine
Retour du 29/09 : « il me détecte 2 cartes Trash, pourtant j'en ai une quinzaine ». Le scan de la
collection utilisait `!trashSellerRunning` comme signal d'arrêt : vendeur **non démarré** (aperçu,
« Refresh ventes »), il s'arrêtait après la **1re page**. Triée par rareté, cette page ne contient
que les cartes les plus rares ; les Trash étaient plus loin. Ce pool tronqué restait ensuite
**12 min en cache**, y compris pour le vendeur une fois lancé. Autre trou : poser ou retirer le
tag avec le 🗑️ de la page Collection ne prévenait pas le pool.

**✅ Corrigé (1.3.13-fork.28)**

- `fetchTrashCards(onProgress, shouldAbort)` : le signal d'arrêt est fourni par l'appelant. Le
  vendeur passe `() => !trashSellerRunning` ; l'aperçu et le refresh lisent tout.
- Un scan interrompu (`aborted`) n'écrase plus le cache.
- L'aperçu force une relecture complète (`getTrashPool(null, { force: true })`).
- Le 🗑️ de la Collection ajoute / retire la carte du pool immédiatement (avec sa rareté).

Rappel : une carte qui porte un **autre tag en plus** de Trash reste exclue par sécurité (règle
du tag unique), et les cartes mises de côté (#42) sont comptées à part.

`tests/trash-pool-scan.test.mjs` : collection de 4 pages, Trash réparties sur toutes. La version
précédente échoue avec « 2 carte(s) dans le pool — pages lues : [0] ».

### 45. Chasse Légendaire (nouveau mode)
Demande du 29/09 : « on scanne les Légendaires dont l'enchère finit bientôt, par exemple dans
20 s, et si elle est à 10 wikibidous, on mise ». Choix de l'utilisateur : **riposte jusqu'au prix
max**, Légendaires **déjà possédées comprises**, **L seulement**.

**✅ Ajouté (1.3.13-fork.28)** — case « 👑 Chasse Légendaire » sous « Mode fourbe », avec le prix
max (10 par défaut) et la fenêtre (20 s par défaut).

- Repérage toutes les 15 s tant que le Market Watcher tourne : `rarity=L` trié « fin proche »
  (vérifié : si le site ignore le filtre, repli sur les pages en cours du marché). Retient les L
  qui finissent dans les 3 min et dont la mise minimale est ≤ max ; journalise « 👑 Légendaire
  repérée ».
- La voie rapide (hot lane) suit ces enchères et passe à 150 ms à l'approche de la fenêtre.
- Dans la fenêtre, si on ne mène pas : mise **minimale** (`minNextBid`) si ≤ max, riposte à
  chaque surenchère tant que ça reste ≤ max. Rien sous 1,2 s de la fin.
- Tout passe par `autoBidAllowed()` / `placeBid()` : interrupteur « Mises auto ARMÉES »,
  plafond global, limite horaire, plafond par enchère (posé au max de la chasse). En pause, le
  journal le dit.

- Après un échec, 2 s de pause avant de retenter cette enchère (avant : une mise refusée
  repartait à chaque passage de la hot lane, ~5 fois par seconde).

**Mise minimale du site** (remarque de l'utilisateur : « si la carte est à 10, pas sûr qu'une
enchère à 11 passe, le site propose automatiquement la mise minimum »). Notre `minNextBid` (+10 %
arrondi au-dessus) n'est qu'une estimation. Désormais :

- si l'annonce porte un champ de minimum (`min_next_bid`, `minBid`, `minimum_bid`…), il l'emporte ;
- un refus « trop bas » / « mise minimale » est lu : le minimum annoncé (champ JSON ou chiffre
  après « minim… ») est retenu pour cette enchère tant que son prix ne bouge pas, et placeBid
  relance directement à ce montant ; sans chiffre, un cran au-dessus (+5 %, au moins +1) ;
- `BID_STALE_RE` reconnaît « minimale » (avant : seulement « minimum » → la relance repartait
  au même montant refusé) ;
- plafonds inchangés : si le minimum du site dépasse le max, on ne mise pas.

`tests/legend-hunt.test.mjs` : une L à 5 qui finit dans 30 s (un rival relance à 8 puis 12) et
une L à 500. Attendu : 1re mise à 5 dans les 20 dernières secondes, riposte à 9, arrêt à 12,
L chère ignorée, aucune mise en pause. Troisième passage avec une règle du site plus stricte
(+3 annoncé dans le refus ; +2 sans chiffre) : 6 ✗ → 8 ✓ et 5 ✗ → 6 ✓. Mutation « minimum
appris ignoré » : échoue (6 refusé en boucle).

### 46. Revente Légendaire (nouveau mode) et boutons de la Chasse
Demande du 29/09 : « les cartes Légendaires gagnées, on les remet sur le marché au prix moyen
réel du marché », en mode distinct du Trash Seller. Précision de l'utilisateur : trois modes —
**👑 Chasse** (achat seul), **👑 Chasse + Revente**, et le **Trash Seller** (inchangé).

Choix de l'utilisateur :
- **quelles L** : celles gagnées **après l'activation** de « Chasse + Revente », quelle que soit
  la façon de miser (Chasse, auto-bid, fourbe, à la main) ;
- **prix** : moyenne réelle de CETTE carte **en L** (cote `?scope=summary`, relue à chaque mise en
  vente), **jamais sous le prix payé + marge** — marge **50 %** par défaut, réglable ;
- **pas de moyenne en L** : pas de vente (liste « 📋 pas de cote », recontrôlée toutes les heures) ;
- **invendue** : remise en vente au même calcul, **sans tag Trash** ;
- **priorité** sur le Trash Seller pour les 5 places de vente.

**✅ Ajouté (1.3.13-fork.29)**

- Market Watcher : la case « Chasse Légendaire » devient deux boutons exclusifs, « 👑 Chasse » et
  « 👑 Chasse + Revente » ; re-clic = arrêt.
- Panneau Trash Seller : section « 👑 Revente Légendaire » (marge, état, file avec prix payé et
  plancher, ✕ pour garder une carte, bilan des reventes).
- Suivi : `syncWonAuctions()` alimente la file (`wm_legend_resell`) ; la boucle de revente relit
  les victoires elle-même (le Market Watcher n'a pas à tourner).
- Vente : même moteur que le Trash Seller (`sellBatch`), prix propre, pas d'undercut. Un verrou
  (`withSellLock`) empêche les deux modes de cliquer en même temps dans /collection ; le Trash
  Seller laisse libres les places attendues par la revente.
- Suivi des ventes : une vente de la revente (`legend` dans l'historique) n'est jamais re-taguée
  Trash ; « 🔄 Refresh ventes » ne l'annule pas. `checkSellHistoryResults` ne tourne plus qu'une
  passe à la fois (deux modes l'appellent).
- Rechargement de page : pas de reprise automatique (elle clique), sauf si c'est le bot qui a
  rechargé (retour sur /collection). Le bouton affiche alors ⏸ et un clic relance.

`tests/legend-resell.test.mjs` : six victoires en base (une ancienne, une SR, une L sans cote, une
L cotée seulement en SR, deux L cotées). Attendu : 400 (moyenne), 450 (payée 300 + 50 %), rien
pour les autres, rien avant le clic, l'invendue remise à 400 sans écriture de tag, boutons
exclusifs. Mutations « plancher ignoré » et « date d'activation ignorée » : échouent. La priorité
sur le Trash Seller n'a pas de test dédié.

### 47. Revente Légendaire : des cartes plus possédées ou plus en vente restaient listées
Retour du 30/09 (capture + logs) : « Catherine Ceylac — en vente · 203 » alors que l'utilisateur
l'avait retirée de la vente à la main (00:19:43), et « Hélène Mercier-Arnault — à vendre » alors
qu'il ne la possède plus. La file ne se fiait qu'à ses propres événements : un retrait manuel ou
une vente hors du bot ne la mettait jamais à jour.

**✅ Corrigé (1.3.13-fork.30)**

- Retrait manuel (✕ d'une vente active) d'une vente de la revente → la carte sort de la revente.
- `reconcileLegendResell()` (au chargement de la page, puis toutes les 2 min pendant la revente) :
  annonce disparue → sortie ; vendue → bilan ; terminée sans acheteur → à relister ; carte « à
  vendre » ou « sans cote » absente de `user_cards` (10 min après la victoire) → sortie.
- La liste n'affiche plus que les statuts vivants (à vendre, en vente, pas de cote).

Au passage, sur les mêmes logs :
- « Mise trop basse (minimum 97) » : si le site annonce comme minimum le montant qu'on vient
  d'envoyer, la relance part à +1 (il veut strictement plus) — toujours sous les plafonds ;
- l'arrêt au max de la Chasse n'est plus journalisé comme un « échec ».

`tests/legend-resell.test.mjs` rejoue les trois restes (vendue ailleurs, supprimée sur le site,
retirée à la main) ; la version précédente échoue sur les quatre contrôles ajoutés.

### 48. Solde insuffisant : rafales de mises refusées
Question du 30/09 : « que se passe-t-il quand je n'ai plus assez de wikibidous ? ». Les chemins
de mise automatique ne vérifiaient que « solde > 0 », jamais « solde ≥ montant ». La mise
partait, le site la refusait, et on recommençait : la Chasse toutes les 2 s, le Fourbe à chaque
tick de la hot lane (jusqu'à plusieurs fois par seconde en fin d'enchère), l'auto-bid à chaque
scan. Rejoué : 7 mises refusées sur une seule enchère en 14 s.

**✅ Corrigé (1.3.13-fork.31)**

- `autoBidAllowed()` (le passage obligé de toutes les mises auto) refuse une mise au-delà du
  solde lu, avec une ligne de journal par enchère toutes les 5 min. Le solde lu est bien ce qui
  reste à miser : le site retient le montant des mises en tête et le rend à la surenchère
  (« Solde -100 » puis « +100 » dans les logs).
- Un refus « solde insuffisant » du site (solde lu périmé) suspend les mises auto 30 s et relit
  le solde, au lieu de réessayer.
- Les mises manuelles ne sont pas bloquées (le site tranche).
- Rien ne change pour la vente (Trash Seller, Revente) : elle ne dépense pas de wikibidous.

`tests/low-balance.test.mjs` : solde 50 pour une mise de 60 → aucune requête ; solde lu 1000 mais
refus du site → une seule tentative. La version précédente envoie 7 mises refusées dans les deux cas.

### 49. Réserve de la Chasse et mode « Revente seule »
Demandes du 30/09 : une **réserve** (la Chasse ne fait jamais descendre le solde sous un montant),
et pouvoir **arrêter seulement la Chasse** en gardant la revente des L déjà gagnées.

**✅ Ajouté (1.3.13-fork.32)**

- Réserve `legendHuntReserve`, **500 💰** par défaut (0 = aucune), champ « réserve » de la ligne
  Chasse. Vérifiée dans `autoBidAllowed()` pour le contexte « Chasse Légendaire », donc aussi
  sur les relances de `placeBid` après une surenchère simultanée. Journal : « 💸 Réserve : … ».
- 3e bouton « 🏷️ Revente seule ». Les trois modes (Chasse, Chasse + Revente, Revente seule)
  sont exclusifs ; passer de « Chasse + Revente » à « Revente seule » arrête les achats mais
  garde la file et la date d'activation (les prochaines L gagnées, même à la main, y entrent
  toujours). La date n'est remise à « maintenant » que si la revente était arrêtée.
- Pas de tag à poser : la revente suit les victoires lues en base, pas un tag de collection.

Tests : `low-balance` (solde 540, mise 60, réserve 500 → pas de mise ; mutation « réserve
ignorée » : échoue) et `legend-resell` (Chasse + Revente → Revente seule : chasse coupée, revente
en marche, date d'activation inchangée).

### 50. 💎 Cartes les plus chères (nouveau panneau)
Demande du 30/09 : un menu dépliant, comme Statistiques ou Paramètres, avec un bouton qui charge
la cote de toutes les cartes et les classe de la plus chère à la moins chère. Choix de
l'utilisateur : **ma collection**, **top 50 + valeur totale**, **filtre par rareté**, cartes
**sans cote comptées à part**.

**✅ Ajouté (1.3.13-fork.33)**

- Panneau « 💎 Cartes les plus chères » au-dessus de Statistiques, bouton « 💎 Calculer »
  (re-clic pendant le calcul = arrêt, résultat partiel conservé).
- Lecture de toute la collection (`/api/my-collection`, 6 pages en parallèle, 2e essai des pages
  refusées), regroupée par carte ET par rareté : deux exemplaires de raretés différentes n'ont
  pas la même cote.
- Cote = moyenne `?scope=summary` du site pour la rareté de l'exemplaire (la même que la
  surcouche Collection ; pas de reconstruction de l'historique des ventes). Cache partagé : le
  2e calcul est quasi immédiat. 5 requêtes à la fois ; si le site freine (403/429), attente de
  la fin de sa pause avec compte à rebours, puis reprise ; les cotes refusées sont redemandées
  une fois à la fin.
- Résultat : valeur totale estimée (cote × exemplaires), top 50, filtre L / UR / SR / R / PC / C
  (avec le total de la rareté), nombre de cartes sans cote et de cotes illisibles.

`tests/top-cards.test.mjs` : collection de 2 pages ; mutations « cote sans tenir compte de la
rareté » et « pas de 2e essai » : échouent.

### 51. Revente Légendaire : baisse du prix sur invendus
Demande du 30/09 : « on vend au prix du marché, et toutes les X mises en vente pas concluantes
on baisse le prix de Y %, sans pouvoir descendre sous le prix payé + % minimum ». Avant, une L
invendue repartait au même calcul (cote L, plancher payé + marge) : si la cote était sous le
plancher, elle était relistée au plancher indéfiniment.

**✅ Ajouté (1.3.13-fork.34)**

- Compteur d'invendus par L (`unsold`), incrémenté à chaque vente terminée sans acheteur (suivi
  des ventes, réconciliation, vente sans identifiant).
- Prix = cote L × (1 − Y %)^⌊invendus / X⌋, jamais sous le plancher payé + marge.
  Défauts : **Y = 10 %, X = 2** (réglables dans la section Revente Légendaire ; Y = 0 = pas de
  baisse). La cote est toujours relue à chaque mise en vente.
- Journal : « 📉 -19 % après 4 invendu(s) », compteur 🔁 dans la liste.
- Indépendant de la baisse du Trash Seller (qui ne concerne que les cartes taguées Trash).

`tests/legend-resell.test.mjs` : 3 invendus → 1 palier → 900 (cote 1000) ; 20 invendus → borné au
plancher 285 (payé 190 + 50 %). Mutation « pas de baisse » : échoue.

### 52. 🎯 Chasse opti (achat-revente) et Revente limitée aux achats de la Chasse
Demande du 30/09 : « le but est de faire de l'argent » — scruter les enchères qui finissent
bientôt, comparer à la cote du marché, miser si elle est bien au-dessus ; boutons « Chasse opti »
et « Chasse opti + Revente », « Revente seule » valable pour tous les modes. Choix de
l'utilisateur : raretés à cocher, mise ≤ **60 %** de la cote, gain ≥ **20 💰**, et une **mise max**
pour ne jamais engager d'énormes sommes ; la Revente ne reprend que **les achats de la Chasse**.

**✅ Ajouté (1.3.13-fork.35)**

- Ligne « 🎯 Chasse opti » dans le Market Watcher : deux boutons, cases L / UR / SR / R / PC / C
  (L, UR, SR cochées par défaut), % de la cote, gain minimum, mise max (200 💰 par défaut).
- `discoverOpti()` (toutes les 15 s avec le Market Watcher) : `rarity=X` trié par fin proche,
  filtre de rareté refait côté bot, jamais mes propres ventes, cote de la rareté de l'annonce
  (au plus 12 nouvelles cotes par passage, rien pendant une pause imposée par le site).
  Plafond par enchère = min(cote × %, cote − gain, mise max) ; journal « 🎯 Opportunité ».
- Tir et riposte : même moteur que la Chasse L (hot lane, fenêtre et réserve communes), avec le
  plafond propre à l'enchère ; contrôles habituels (mises auto armées, solde, réserve, plafond
  global, limite horaire).
- Cinq modes exclusifs : Chasse, Chasse + Revente, Chasse opti, Chasse opti + Revente, Revente
  seule.
- Revente : ne reprend plus que les enchères où une Chasse a misé (`wm_chasse_bids`), toutes
  raretés, à la cote de la rareté de la carte. Un achat à la main n'est jamais revendu. Section
  renommée « 🏷️ Revente (achats de la Chasse) ».

Tests : `opti-hunt` (plafond 200 : 110 → 165 puis arrêt ; SR 22 ; gain trop faible, mise max,
ma propre vente, rareté décochée ignorés ; mutations « sans mise max », « sans filtre de
rareté », « sans exclusion de mes ventes » : échouent) et `legend-resell` (achat à la main
ignoré, UR de la Chasse opti revendue à sa cote UR).

### 53. Log déplacé sous le Pack Opener
Demande du 30/09 (capture) : le log, en bas du Trash Seller, était à l'étroit alors que la colonne
Pack Opener avait de la place. **1.3.13-fork.36** : le log (et « Export logs ») occupe désormais le
bas du Pack Opener, sur toute la hauteur libre ; le bloc « Matchs mots-clés » du Pack Opener est
retiré (`renderPackKwHits` ne fait plus rien sans son conteneur).

### 54. Chasse opti : les autres raretés étaient affamées par les Légendaires
Logs du 30/09 : « toutes les chasses opti se font sur des Légendaires ». Sur 20 minutes, 60
opportunités L pour 2 UR, aucune SR/R/PC malgré les cases cochées. Cause : les cotes à lire
(au plus 12 par passage) étaient prises dans l'ordre L, UR, SR… ; les nombreuses L qui finissent
dans les 3 minutes consommaient tout le budget, et les autres raretés n'étaient presque jamais
évaluées avant la fin de leur enchère. Le refus 403 des cotes (pause de 5 min) aggravait l'effet.

**✅ Corrigé (1.3.13-fork.37)** : les cotes sont lues **à tour de rôle par rareté** (une L, une
UR, une SR…, puis on recommence), sans doublon de carte. Rien ne change pour le seuil : avec un
gain minimum élevé (50 💰 chez l'utilisateur), les petites raretés restent rares à passer.

`tests/opti-hunt.test.mjs` ajoute 30 L sans intérêt mais à évaluer : la version précédente ne mise
plus ni sur l'UR ni sur la SR ; la nouvelle mise sur les deux.

### 55. Optimisation réseau (captures F12 du 01/10)
Deux captures réseau (147 requêtes en 110 s, puis 83 en 52 s) et les logs associés. Le site est
lent (médiane 4 à 6 s par requête), une page de marché sur quatre répond 500, et le bot en
rajoutait beaucoup. Analyse par trois agents (balayage, `/mine`+Supabase, hot lane/Chasses),
corrections, puis relecture adversariale par un quatrième agent.

**✅ Corrigé (1.3.13-fork.38, livré en fork.39 après relecture)** — sans retirer aucune fonctionnalité :

1. **Horloge serveur** : l'en-tête `Date` est posé à la FIN du traitement du site, pas au milieu.
   L'ancien calcul (milieu de la requête) donnait un décalage entre −6 et +12 s sur ces
   captures ; mesuré à l'arrivée des en-têtes (+0,5 s pour la troncature à la seconde), il tient
   entre +0,1 et +1,1 s. Toutes les décisions de fin d'enchère en dépendent.
2. **Mise refusée « trop basse »** : le site répond `409 {"code":"bid_too_low","min":79}`. Le bot
   relisait l'enchère (3 à 8 s) avant de remiser — et arrivait de nouveau trop bas (71 → 79 → 87).
   Il remise désormais **immédiatement** au minimum donné (6 ms au lieu de 3,2 s en test), sous
   les mêmes garde-fous ; au-delà du plafond, c'est un arrêt normal (« on s'arrête »), plus un
   « échec ». Le plafond propre à une Chasse est revérifié à chaque relance ; une chasse dont la
   mise suivante dépasse son plafond est abandonnée (elle gardait la hot lane à 150 ms).
3. **Aucun mot-clé** : chaque scan lisait tout le marché (~270 pages, 5 à 24 s chacune, 25 % de 500),
   en continu. Sans mot-clé, ce balayage ne sert qu'à repérer les enchères où je mène sans que le
   bot le sache. Désormais : relecture des seules enchères suivies toutes les 20 s (en
   réutilisant les lectures de la hot lane), balayage complet au démarrage puis toutes les
   15 min, et les mises faites à la main sur le site (même onglet) sont captées par
   l'intercepteur. Une relecture ratée sans fin connue rend le scan partiel : rien n'est purgé.
4. **État des ventes partagé** : `/mine` + recomptage en base (3 à 7 s) était demandé ~11 fois en
   93 s par trois modules. Requête en vol partagée, génération invalidée à chaque création /
   annulation de vente (bot ou site), cache de 25 s pour le seul affichage. `syncWonAuctions` ne
   rappelle plus `/mine` pour rien ; la Revente partage la porte « une fois par minute » (avec
   une lecture immédiate à son démarrage).
5. **Cotes : file unique** : surcouche Collection, Chasse opti, Revente et Trash Seller lisaient
   les cotes chacun de leur côté (jusqu'à 9 en vol → 403 → toutes les cotes en pause 5 min).
   Au plus 4 lectures en vol, Chasse/Revente d'abord ; pause progressive 1, 2, 4 puis 5 min ; les
   cotes du bot ne repassent plus par son propre intercepteur (stockage en double).
6. **Opportunités** sous 3 s restantes ignorées avant toute lecture de cote (logs « fin dans 0 s »).
7. **Lecture d'une enchère** limitée à 10 s (la hot lane attendait la plus lente).
8. **Purge** : une enchère suivie reste vivante jusqu'à 15 s après sa fin connue (heure serveur) —
   une relecture ratée près de la fin ne conclut plus « perdue / gagnée » sur un état incomplet.
9. **Boucles Trash Seller / Revente** : un Stop puis Start pendant une pause laissait deux boucles
   (mises en vente en double) ; l'ancienne boucle du Trash Seller, en finissant, arrêtait même la
   nouvelle. Jeton de génération.
10. **Moniteur des ventes** (notifications des ventes hors bot) : une passe à la fois, toutes les
    60 s, fenêtre de 5 min.

Tests : `network-efficiency` (horloge, sans mot-clé, mise manuelle, purge, Stop/Start — la version
précédente échoue sur le balayage continu, la mise manuelle et la double boucle),
`legend-hunt` (refus réel 409 `bid_too_low`, relecture lente : relance en 6 ms contre 3,2 s),
`top-cards` (4 lectures de cote simultanées au plus ; avant : 5).

**Relecture adversariale (agent relecteur) → corrigé dans 1.3.13-fork.39** — fork.38 n'a jamais
été livré :

1. **Plafond d'un autre réglage supprimé** : en lâchant une enchère hors de portée, la Chasse
   retirait « son » plafond… même s'il avait été remplacé entre-temps (Chasseur ciblé, Hunter,
   plafond tapé à la main) → auto-bid libéré jusqu'au plafond global (reproduit : riposte à 275
   au lieu de l'arrêt à 200). La chasse mémorise la valeur posée et ne retire que celle-là ; le
   changement du max de la Chasse L ne touche plus que ses propres plafonds.
2. **Pause des cotes jamais allongée** : une réponse 200 revenue d'une rafale en partie refusée
   remettait le palier à zéro. Remise à zéro seulement après 10 min sans refus.
3. **Relance immédiate sur ma propre mise** : si le minimum annoncé correspond à MA dernière
   mise + 10 % (autre onglet, mise à la main simultanée), pas de relance à l'aveugle — relecture
   de l'enchère (chemin qui vérifie « je mène déjà »). L'intercepteur retient aussi le montant
   des mises faites à la main sur le site.
4. **Lecture de cote sans limite de temps** : 4 lectures bloquées auraient gelé toute la file.
   Abandon au bout de 12 s.
5. **Trash Seller pendant une pause des cotes** : vendait au prix minimum du tableau ; la carte est
   désormais reportée tant que sa cote est illisible.
6. Sans mot-clé : cadence de 20 s tenue aussi quand aucune enchère n'est affichée ; une relecture
   ratée d'une enchère encore vivante la garde à l'écran ; chaque démarrage du Market Watcher
   refait le balayage complet. Moniteur des ventes : pas de « VENDU » renvoyé après un
   rechargement si la lecture de démarrage a échoué.

Test ajouté : `hunt-cap-safety` (Chasse L max 10, plafond utilisateur 200, rival à 250) — fork.38
riposte à 275 et efface le plafond de 200 ; fork.39 s'arrête et le conserve. `network-efficiency`
renforcé : l'enchère purgée passe désormais par le suivi ciblé, avec le bon gagnant au journal.

### #56 — Sans mot-clé, le Market Watcher parcourait encore tout le marché (fork.39)

**Constat (captures du 02/10, mode « Revente seule », aucun mot-clé)** : le compteur à gauche du
STOP défilait (p.210/210 · 9 930 annonces → p.228/228 · 10 784 annonces en 10 s). Le balayage
complet « au démarrage puis toutes les 15 min » de fork.38 repartait à **chaque rechargement de
page** (le minuteur n'était pas conservé), et la Revente recharge la page (retour sur
`/collection`). Sans mot-clé, la liste n'affiche pourtant que MES enchères : ce balayage de
~270 pages servait uniquement à repérer une mise faite depuis un autre appareil (les gains sont
de toute façon relevés par `syncWonAuctions`).

**✅ Corrigé (1.3.13-fork.40)** :

1. Sans mot-clé, **aucune page de marché n'est lue**, jamais : seules les enchères suivies sont
   relues toutes les 20 s (aucune suivie → aucune requête). Statut : « N enchère(s) suivie(s) ·
   aucun mot-clé, marché non parcouru ». Avec un mot-clé, rien ne change.
2. **Horloge serveur** : elle se recalait sur les pages de marché ; elle se recale aussi sur la
   lecture du solde (faite à chaque passage), pour ne jamais rester sans référence. Solde lu en
   `cache: no-store`, et une réponse servie par un cache (en-tête `Age` > 0) ne recale jamais
   l'horloge (son `Date` serait celui de la réponse d'origine).
3. **Bug masqué par le balayage** : une seule enchère suivie illisible (404 répété, aucune fin
   connue) rendait chaque scan « partiel » → plus AUCUNE purge, pour toutes les enchères, à vie.
   Désormais elle est seulement présumée vivante (gardée) sans bloquer la purge des autres, et
   abandonnée après 10 min d'échecs consécutifs (l'enchère n'existe plus).

Test : `network-efficiency` B — 0 page de marché sans mot-clé (fork.39 : 1 dès la 1re seconde,
puis tout le marché), horloge recalée via le solde (+3 s simulées, mesuré ≈ 3,2 s), enchère
terminée purgée malgré une voisine en 404 permanent (qui, elle, est conservée). Abandon après
10 min vérifié sur une copie dont le délai est réduit à 20 s.

### #57 — « Vérification anti-bot requise » : le bot insistait (fork.40)

**Constat (logs + capture F12 du 03/10)** : le site refuse des mises par
`403 {"error":"Vérification anti-bot requise.","code":"human_verification_required"}`. Sa
vérification s'affiche 1 à 2 s puis se fait seule. La Chasse opti renvoyait pourtant la même
mise toutes les 4 à 5 s pendant plus de 3 min (6 refus en 20 s sur la capture), chaque refus
journalisé « échouée ».

**✅ Corrigé (1.3.13-fork.41)** — le bot ne contourne PAS la vérification, il la laisse se faire :

- au premier refus de ce type : aucune nouvelle tentative, **toutes les mises automatiques en
  pause 10 s** (Chasses, Hunter, auto-bid, Fourbe) ; la Revente et les mises manuelles continuent ;
- refus de nouveau juste après la reprise : pause 30 s, puis 1, 2, 5 min ; retour à 10 s après une
  mise acceptée ou 15 min sans refus ;
- alertes au choix dans Paramètres (toutes cochées par défaut) : bandeau rouge avec compte à
  rebours dans le Market Watcher, son, notification Windows (permission demandée au clic sur
  START ou sur un mode de Chasse). Une ligne de journal au début et à la fin de chaque pause.

### #58 — Prix manuel dans la Revente (demande du 03/10)

Bouton ✏️ sur chaque carte de « Revente (achats de la Chasse) ». Choix de l'utilisateur : le prix
manuel est **libre, même à perte** (avertissement au journal), et **fixe** (pas de baisse sur
invendu) jusqu'à ce qu'il soit effacé (saisie vide = retour au prix automatique). Il permet aussi
de vendre une carte « pas de cote ». Carte déjà en vente à un autre prix : confirmation → la vente
est retirée (tant que personne n'a misé) et repart au nouveau prix ; sinon le prix s'applique à la
prochaine mise en vente.

Test : `antibot-manual-price` — fork.40 renvoie la mise 3 fois en 2,4 s pendant la vérification,
sans bandeau ; fork.41 : 1 refus, reprise 10,1 s après. Prix manuel : 150 sous un payé de 300
(et encore 150 après un invendu), 500 sans cote, vente à 1 754 retirée puis remise à 400, retour à
la cote (400) après effacement.

### #59 — Pendant la pause anti-bot, le bot continuait d'interroger le site (fork.41)

**Constat (question de l'utilisateur, 03/10)** : la pause de #57 ne bloquait que les MISES. Scan
du marché, Chasses (pages par rareté + cotes), voie rapide, solde, ventes, Revente… continuaient :
mesuré en test, **59 requêtes pendant une pause de 10 s**.

**✅ Corrigé (1.3.13-fork.42)** : pendant la pause, **aucune requête du bot**. Tout le code du bot
appelle `fetch(...)` ; une fonction `fetch` déclarée en tête du script (portée du script, donc
prioritaire sur `window.fetch`) retient chaque requête jusqu'à la fin de la pause. Les requêtes
du **site** (`window.fetch`, dont sa propre vérification) ne passent jamais par là. En plus, pour
qu'aucune rafale ne parte à la reprise : scan du marché, voie rapide, découverte des Chasses,
moniteur des ventes, rafraîchissement des ventes / de la collection, cotes de la collection se
mettent en veille ; la lecture des cotes (fetch d'origine) et les délais d'abandon
(`fetchWithTimeout`) attendent la fin de la pause avant de démarrer ; la mise en vente par
l'interface du site attend aussi. Statut du Market Watcher : « 🛡️ pause anti-bot ».

Test : `antibot-manual-price` A — fork.41 : 59 requêtes pendant la pause ; fork.42 : 0, puis
reprise (requêtes et mise acceptée 10,1 s après le refus).

### #60 — Trafic des Chasses : voie rapide globale, 0,15 s, 12 cotes par passage (fork.42)

**Constat (demande du 03/10 : « optimiser les trames, laisser mon navigateur respirer »)** :

- la voie rapide relisait **toutes** les enchères suivies au rythme de la plus urgente : une Chasse
  dans ses 30 dernières secondes faisait relire aussi celles qui finissent dans 4 min ;
- ce rythme était de 0,15 s, alors que le site met 1 à 6 s à répondre ;
- la Chasse opti lisait jusqu'à 12 cotes par passage, sur tout l'horizon de 3 min.

**✅ Corrigé (1.3.13-fork.43)**, sans retirer de fonctionnalité :

1. **Voie rapide par enchère** : chaque enchère est relue à SON rythme, d'après son temps restant
   (0,5 s dans sa fenêtre de Chasse / Fourbe ou ses 12 dernières secondes, puis 1 s, 2 s, 5 s ;
   au-delà de 5 min, le suivi ciblé de 20 s suffit).
2. **Rythme le plus serré : 0,5 s** au lieu de 0,15 s.
3. **Cotes de la Chasse opti** : au plus 6 par passage, seulement pour les enchères qui finissent
   dans les 90 s (les autres sont revues aux passages suivants ; une cote reste 12 h en cache).

Test : `hunt-traffic` — 1 Chasse en fin + 4 enchères à ~4 min, sur 10 s : fork.42 **315 lectures**
(63 par enchère), fork.43 **28** (20 pour la Chasse, 2 pour chacune des autres). Cotes en un
passage (10 UR bradées, 3 à ~60 s, 7 à ~150 s) : fork.42 10, fork.43 3.

### #61 — Enchères finies depuis des heures relues en boucle (fork.43)

**Constat (capture F12 du 03/10, 29 s)** : 123 lectures d'enchères, dont **119 sur 27 enchères
finies depuis 1 à 3 h** (anciennes mises, surtout de la Chasse) ; les 2 vraies opportunités, 2
lectures chacune. Trois causes :

1. avec un mot-clé actif, mes enchères absentes des résultats sont relues une par une ; l'API
   renvoie une enchère finie par son id → elle comptait comme « présente » → **jamais purgée**,
   suivie à vie (et `trackMyBid` la remettait même dans le suivi si j'étais le gagnant) ;
2. un mot-clé **refusé** par le site (fréquent) sautait toute purge ;
3. la voie rapide relisait toutes les 2 s une enchère dont la fin était passée, sans limite.

**✅ Corrigé (1.3.13-fork.44)** :

- une enchère finie depuis plus de 15 s (heure serveur) ne compte plus comme présente ; son
  dernier état est gardé pour le journal « gagnée / perdue » ; elle n'est plus remise dans le
  suivi ;
- recherche refusée : les enchères suivies dont l'état a plus d'1 min sont relues (25 max) et
  celles **prouvées** finies sont purgées (la purge reste interdite sur une simple absence) ;
  le code de purge est sorti dans `pruneTrackedAuctions` ;
- voie rapide : une enchère finie est relue 1 min au plus (état final), puis plus du tout ;
- recherche des Chasses toutes les 30 s au lieu de 15 s (demande de l'utilisateur).

Test : `tracked-prune` — 3 enchères finies il y a 2 h + 1 vivante, mot-clé qui répond puis mot-clé
refusé : fork.43 les garde toutes et les relit en boucle ; fork.44 les purge (« Enchère perdue …
rival » au journal), plus aucune relecture ensuite, la vivante est conservée.

**Ce que la capture montre aussi** : la toute première mise de la session (20 s après le
démarrage, 135 requêtes en tout) a été refusée « Vérification anti-bot requise ». Le volume de
requêtes n'est donc pas ce qui déclenche la vérification.

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
