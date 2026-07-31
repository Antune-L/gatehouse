# Écarts visuels vs maquette

Journal des changements d'UI par rapport à la maquette « SQL Studio - Maquettes v1 ».
Réf. maquettes : [New connection modal](new-connection.png).

## Session retours `Feedbacks.md` (2026-07-17)

Changements décidés à partir des retours utilisateur, qui s'écartent volontairement
de la maquette d'origine ou la complètent.

### Grille de données (`DataGrid`)
- Largeur de colonne dérivée du type SQL (`timestamp` ~190px, `uuid` ~290px, etc.)
  au lieu d'une largeur fixe → les valeurs longues ne sont plus tronquées par défaut.
- `+ Ligne` : la ligne insérée s'affiche en haut, sous l'en-tête (surlignée vert),
  au lieu d'être ajoutée en bas de la grille.
- Un filtre incomplet (sans valeur) n'est plus appliqué ni affiché en chip tant qu'il
  n'a pas de valeur (sauf `is null` / `is not null`).

### Vue Relations (`RelationsView`, `@xyflow/react`)
- Création de liens désactivée (`nodesConnectable={false}`) — lecture seule.
- Arêtes en bézier courbé (`type: "default"`) au lieu de `smoothstep`.
- Bouton `+N colonnes` cliquable pour afficher toutes les colonnes d'une table.
- Tables déplaçables (passage en `defaultNodes`/`defaultEdges` non contrôlés).
- Handles (points gris) rendus uniquement sur les colonnes réellement reliées par une
  arête, pas sur toutes les colonnes.

### Éditeur SQL (`SqlEditor`)
- Panneau latéral Historique/Sauvegardées replié par défaut (rail vertical + bouton).
- Séparateur horizontal redimensionnable entre l'éditeur et la zone de résultats.
- Résultat réinitialisé au changement/fermeture d'onglet (remount via `key`).

### Connexions (`ConnectionsManager`)
- Suppression d'un profil (corbeille au survol) et d'un groupe (corbeille en-tête).
- Réordonnancement drag & drop des groupes et des profils (intra/inter-groupe).
- `+ Groupe` crée un vrai groupe vide inline (placeholder « Déposez un profil ici »)
  au lieu d'ouvrir la modale de connexion.
- Phrase d'aide « glisser un profil dans un cadre… » retirée.

### Modale Nouvelle connexion (`ConnectionDialog`)
- Reconstruite selon la maquette [new-connection.png](new-connection.png) : mise en
  page 2 colonnes (CONNEXION | ENREGISTRER), fond clair thème-aware (au lieu du fond
  sombre codé en dur), toggles SSL/Tunnel SSH côte à côte, statut de test en pied.

### Barre de titre (`TitleBar`)
- Pastille « RO · GARANTI / BEST-EFFORT » retirée.
- « Connecté » conservé (porte les états reconnexion / déconnecté).
- Espace à gauche conservé : réservé aux boutons natifs macOS (`titleBarStyle: Overlay`).

## Session câblage IPC (2026-07-17)

Ajouts d'UI absents de la maquette, nécessaires au branchement sur le backend réel.

### Panneau connexions (`ContextPanel`)
- Bouton « Ouvrir un fichier SQLite… » (pointillés, sous la recherche) — visible
  uniquement dans l'app desktop ; crée/sélectionne un profil sqlite via le dialog natif.
- Bandeau d'avertissement discret si le schéma de la base ne peut pas être chargé.

### Modale Nouvelle connexion (`ConnectionDialog`)
- Bouton « Parcourir… » à côté du champ fichier (SQLite, desktop uniquement).

### File de validation (`ValidationQueue`)
- Statut « failed » possible dans « Recently resolved » avec le message d'erreur
  d'exécution (une écriture approuvée mais échouée n'est plus silencieuse).

### Shell
- Sélection de texte désactivée globalement (comportement app native) sauf champs
  éditables, `pre` et `code`.

## Session moteur Postgres (2026-07-17, nuit)

### Mode desktop = données réelles uniquement
- L'app desktop n'injecte plus les profils/onglets/file d'attente de démo :
  seuls les profils persistés côté backend apparaissent (le mode navigateur
  `npm run dev` garde la démo complète). Premier lancement : profils seedés
  « Cache » (SQLite) et « PG local (test) » (Postgres).

### Modale Nouvelle connexion
- Le bouton Tester fait un vrai test de connexion pour SQLite **et** Postgres
  (latence réelle ; échec réel si serveur injoignable ou SSL demandé).

## Session feedbacks UI (2026-07-17, nuit — 2e passe)

### Gestionnaire de connexions
- Suppression d'un profil (ou d'un groupe non vide) : modale de confirmation
  au lieu d'une suppression immédiate.
- Double-clic sur un profil = connexion directe (+ fermeture du gestionnaire).
- Bouton « Tester » du panneau de détail câblé sur le vrai test de connexion
  (résultat + latence affichés dans le pied de page).
- Drag & drop des profils/groupes réparé (Tauri interceptait le drag HTML5 ;
  `dragDropEnabled: false`).

### Modale Nouvelle connexion
- Champ « Groupe (projet) » : input avec suggestions (datalist) — permet de
  créer un nouveau groupe à la volée, au lieu d'un Select fermé.

### Shell macOS
- Icône d'app conforme au gabarit Apple (carré arrondi avec marges, coins
  transparents) — `icon-source.html` reste la source, rendue via Playwright
  puis `npx tauri icon`.
- Traffic lights centrés verticalement sur la barre de titre de 44 px
  (`trafficLightPosition` 14×16).
- Menu natif custom : « Gatehouse / Edit / View / Window », sans « Close
  Window » ; ⌘W ferme l'onglet actif, ⌘Q et la fermeture de fenêtre passent
  par une modale de confirmation (désactivable : Réglages → Général).

### Grille de données
- ⌘Z / ⇧⌘Z : undo/redo des modifications en attente (édits de cellules,
  + Row, suppressions marquées, discard).
- Booléens Postgres affichés `true`/`false` (au lieu de `t`/`f`).

### Éditeur SQL
- Taper `"` ouvre l'autocomplete sur les tables uniquement (insertion quotée).
- Panneau History/Saved : replié par défaut (session précédente, rappel).

### Navigation FK
- Cliquer sur une valeur FK ouvre la table référencée **filtrée sur la ligne
  liée** (filtre `=` posé sur la colonne cible) au lieu de la table entière.

## Session feedbacks UI (2026-07-17, nuit — 3e passe)

### Modale Nouvelle connexion
- Champ « Groupe (projet) » : le `<datalist>` natif (popup thème système,
  illisible en clair) est remplacé par un dropdown de suggestions custom aux
  couleurs de l'app (filtrage en tapant, clic pour choisir).

### Panneau connexions
- « Ouvrir un fichier SQLite… » n'apparaît plus que si le profil actif est
  SQLite (l'ouverture reste possible via Nouvelle connexion → Parcourir).

## Chantiers 7-10 (2026-07-18)

### Réglages → Agents (MCP)
- L'en-tête indique « serveur MCP actif · socket Unix locale » au lieu du
  faux « port 52110 » (le transport réel est une socket Unix, pas un port).
- Nouveau bloc d'appairage sous la liste des clients : champ nom + bouton
  « Appairer un client », puis encart affichant le token une seule fois avec
  bouton Copier (absent de la maquette — nécessaire au flux de pairing réel).
- Clients : pastille verte seulement si activité < 5 min ; badge « Révoqué »
  (ligne grisée) au lieu de la disparition immédiate.
- « Accès par profil » liste tous les profils (`groupe · nom`), plus
  seulement le groupe ACME ; sous-libellé unifié « lecture + écritures via
  file » hors production.
- Journal d'audit : statuts supplémentaires « en attente » / « échouée » ;
  bannière destructive si l'intégrité de la chaîne d'audit est compromise.

### File de validation
- Le champ de confirmation renforcée (retaper le nom du profil) apparaît et
  est exigé aussi pour les DELETE/DDL hors production (la maquette ne le
  montrait qu'en production).

### Panneau connexions
- Le sélecteur de database devient un libellé statique quand le profil ne
  connaît qu'une database (cas desktop réel).

### Barre de statut
- Le ticker d'activité agent affiche les vrais appels MCP (client, tool,
  durée, lignes) en desktop ; la version démo reste en mode navigateur.

- Réglages > Raccourcis (2026-07-18) : la maquette montre une table statique ;
  l'écran est désormais interactif — bindings cliquables (enregistrement au
  clavier, erreurs inline conflit/réservé/sans-⌘), bouton « Réinitialiser les
  défauts » à côté du filtre, rangée ⌘Z/⇧⌘Z grisée (menu natif). Sous-vues et
  navigation d'onglets éclatées en lignes individuelles (5 lignes au lieu de 2).

### Dialog de connexion (2026-07-20)
- Le toggle « Tunnel SSH » déplie désormais une sous-section absente de la
  maquette : Hôte SSH / Port SSH, Utilisateur SSH, Secret SSH (passphrase ou
  mot de passe), Chemin de la clé privée, plus une ligne d'aide ssh-agent —
  encadrée `border bg-panel` sous la rangée SSL/SSH.
- Gestionnaire de connexions : la carte « SSL / SSH » affiche aussi
  `SSH user@host` quand le tunnel est actif.

### Activité agents (2026-07-28)
- Nouvelle section du rail « Activité agents » (icône Bot, sous Historique),
  absente de la maquette. Panneau latéral : liste des clients MCP (nombre
  d'appels, dernier appel, badge révoqué). Écran principal : journal d'audit
  pleine page (date+heure, client, profil, requête, issue) avec chips de
  filtre par client, bannière d'intégrité de chaîne et état vide. Réutilise
  les libellés/couleurs d'issue du journal d'audit des Réglages (extraits
  dans `src/lib/auditOutcome.ts`).

### Grille de données — copie de ligne (2026-07-31)
- Gouttière (numéro de ligne) : cliquer le numéro sélectionne la ligne
  (⌘C copie alors la ligne entière, valeurs séparées par tab, `NULL` pour
  null). Le numéro reste visible au survol ; le bouton de suppression « − »
  s'affiche désormais à droite du numéro au lieu de le remplacer.
- Clic droit sur le numéro : menu contextuel « Copier la ligne » (nouveau
  composant `ui/context-menu.tsx`, Radix). L'animation de copie (liseré
  arc-en-ciel) s'applique à la ligne entière.

### Barre d'onglets de projets (2026-07-31)
- Nouvelle colonne d'avatars (48px) entre la barre d'icônes (Rail) et le
  panneau de contexte, absente de la maquette, style Slack/Discord. Elle
  est visible dès qu'un profil est ouvert, avec en tête une carte « + »
  (bordure pointillée) qui ouvre l'écran Connexions.
- Chaque projet est un carré arrondi de 32px rempli de la couleur du profil,
  avec ses initiales (2 caractères, couleur du texte calculée selon la
  luminance du fond) ; le nom complet apparaît au survol (title). Le profil
  actif est en pleine opacité avec un anneau ; les autres sont estompés.
  Badge « × » de fermeture en haut à droite, visible au survol.

### Détail de connexion — aperçu + activité (2026-07-31)
- Le panneau détail d'un profil (écran Connexions) abandonne les 4 cartes
  flottantes de la maquette pour un layout dense : en-tête (pastille couleur,
  nom, badge env, alerte « SSL désactivé » si hôte distant sans SSL) suivi
  d'une chaîne de connexion copiable en mono, sans mot de passe
  (`moteur://user@hôte:port/base`, chemin du fichier pour SQLite).
- Dessous, split deux colonnes : à gauche deux panneaux Connexion (hôte:port,
  utilisateur, base, moteur, groupe, mot de passe « Keychain ✓ ») et Sécurité
  (SSL, tunnel SSH, lecture seule « garanti » pour SQLite / « best-effort »
  sinon avec note explicative, toggle Accès agent MCP déplacé ici) ; à droite
  l'activité du profil : écritures en attente (fond ambré si > 0), dernières
  requêtes, requêtes sauvegardées — filtrées par profil, compteurs cliquables
  qui ouvrent la section correspondante (file, historique, sauvegardées).
