# Audit du code importé — v1.3.13

Relevé à l'import (commit upstream `3ef2719`), avant toute correction.
Les numéros de ligne renvoient à `src/open_cards.js`.

## 🔴 Bugs

### 1. Toute erreur d'ouverture = attente du cooldown complet, en silence
`src/open_cards.js:11333` — `if (data.packs_remaining === 0 || data.error)` traite
de la même façon « plus de packs » et **n'importe quelle** erreur serveur : session
expirée, 401, maintenance, rate-limit. Le bot attend alors le cooldown entier
(jusqu'à 10 min) et reboucle indéfiniment sans rien signaler. Une session expirée
la nuit = bot qui tourne dans le vide jusqu'au matin.

**Correctif** : distinguer les cas. `packs_remaining === 0` → cooldown. Erreur
d'auth → arrêt du module + alerte visible (+ Discord). Erreur inconnue → backoff.

### 2. Cooldown jamais lu depuis le serveur
Même bloc : la durée vient uniquement du réglage utilisateur (`getSetting('packCooldown')`),
avec une marge fixe de 2 s. Aucune lecture d'un temps restant renvoyé par l'API.
Si le site change ses cooldowns, ou si l'utilisateur se trompe de type de compte,
on perd des slots (trop lent) ou on tape trop tôt en boucle (trop rapide).

**Correctif** : lire le temps restant renvoyé par l'API quand il existe, garder le
réglage utilisateur en repli, et borner par un plancher de sécurité.

### 3. Pas de gestion du 429, pas de backoff exponentiel
`src/open_cards.js:11374-11380` — seul le `403` est traité (pause 60 s) ; tout le
reste tombe sur `await sleep(5000)`. Un `502`/page HTML de Cloudflare fait échouer
`res.json()` dans `openPack()` (`src/open_cards.js:10656`) → retry toutes les 5 s
en boucle. C'est le comportement qui fait repérer un bot par la modération.

**Correctif** : vérifier `res.ok` et `content-type` avant `res.json()`, respecter
`Retry-After`, backoff exponentiel plafonné, arrêt au bout de N échecs consécutifs.

### 4. Aucun échappement HTML
Les titres de cartes et leurs URL partent bruts dans `innerHTML`
(ex. `src/open_cards.js:10820-10835` : `href="${url}"`, `title="${title}"`).
Un seul échappement dans tout le fichier (`src/open_cards.js:7551`, et il ne traite
que le guillemet double). Un titre Wikipédia contenant `"` casse l'attribut et
l'affichage ; un `<` dans un titre injecte du HTML dans la page.

**Correctif** : un helper `esc()` unique, appliqué à toute donnée serveur injectée.

### 5. Stats de session comptées avant vérification
`handlePackOpened()` (`src/open_cards.js:10758`) sort tôt si `cards` est vide, mais
n'inspecte jamais `data.error`. Une réponse partielle ou inattendue qui porterait
quand même un tableau `cards` serait comptée comme un pack réussi.

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
