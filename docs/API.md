# Surface réseau utilisée par le bot

Relevé depuis `src/open_cards.js`. Tous les appels partent du navigateur avec
`credentials: "include"` : c'est la session cookie de l'utilisateur connecté qui
authentifie, aucun token n'est stocké par le bot.

## API applicative — `https://www.wiki-masters.com/api`

| Méthode | Endpoint | Usage dans le bot |
|---|---|---|
| POST | `/packs/open` | Ouverture d'un pack. Réponse : `{ cards: [...], packs_remaining, error? }` |
| GET | `/wikibidous` | Solde de l'utilisateur |
| GET | `/my-collection?page=&limit=&sort=obtained_at\|rarity[&pending=1]` | Collection paginée ; `pending=1` inclut les cartes engagées dans un échange |
| GET | `/marketplace?card_id=&limit=&sort=ending_soon` | Annonces actives (aussi utilisé pour l'undercut) |
| POST | `/marketplace` | Création d'une mise en vente |
| GET | `/marketplace/{id}` | Détail d'une enchère (hot lane, snipe) |
| DELETE | `/marketplace/{id}` | Annulation d'une vente |
| POST | `/marketplace/{id}/bid` | Miser — corps `{ amount }` |
| GET | `/marketplace/cards/{cardId}/sales` | Historique des ventes d'une carte (cote, médiane) |
| GET | `/trades/{id}` | Détail d'un échange |
| PATCH | `/trades/{id}` | Accepter / refuser un échange — corps `{ action }` |

Cartes : `wikipedia_title`, `rarity` (`L`, `UR`, `SR`, `R`, `PC`, `C`), `atk`, `def`,
`wikipedia_url`, `card_id`. Les objets de collection encapsulent parfois la carte
dans `item.card` — le code teste systématiquement les deux formes.

## Backend Supabase — `https://cyrxjeppjqsxxjayfrur.supabase.co/rest/v1`

Le bot tape **directement** la base PostgREST du site, avec la clé `anon` publique
du projet codée en dur (`src/open_cards.js:6009-6011`). Tables touchées :

| Table | Usage |
|---|---|
| `tags` | Découverte / création / suppression du tag de vente (« Trash ») |
| `user_card_tags` | Étiquetage en masse ; rejeu des lots que le site rate en 500 |
| `wishlist_items` | Détection des ajouts wishlist faits depuis le site |

⚠️ Fragilité : une rotation de clé ou un durcissement des règles RLS côté
WikiMasters casse d'un coup l'étiquetage et le Trash Seller. À isoler derrière une
seule couche d'accès quand on refactorera.

## Externe

| Hôte | Usage |
|---|---|
| `wikimedia.org/api/rest_v1/metrics/pageviews/...` | Vues réelles du dernier mois → anticipation d'un changement de rareté |
| `discord.com/api/webhooks/...` | Notifications, si l'utilisateur renseigne un webhook |
| `fonts.googleapis.com` | Police Rajdhani de l'UI |

## Interception

`src/open_cards.js:11164` remplace `window.fetch` par un wrapper qui :
1. compte les ouvertures de pack **manuelles** (faites depuis le site) ;
2. rejoue les `POST /rest/v1/user_card_tags` que le site échoue en 5xx ;
3. capte les ajouts wishlist pour les verser dans les mots-clés ;
4. rejoue un `PATCH /api/trades/{id}` `action=accept` échoué en 500 ;
5. récupère l'`auction_id` d'un `POST /api/marketplace` pour l'associer à `sellHistory`.

C'est le point le plus fragile du projet, et un blocage net pour un passage en
extension MV3 (voir `docs/AUDIT.md`).
