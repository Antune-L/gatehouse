---
title: Go-live — état et reste à faire
date: 2026-07-17
tags:
  - golive
  - state
status: living-document
---

# Go-live — état et reste à faire

Fichier d'état multi-sessions issu de l'audit exhaustif du 2026-07-17 (4 passes :
backend/packaging, stubs frontend, conformité docs v1, [[SecurityFeedback]]).
À mettre à jour à chaque étape : cocher, dater, noter les découvertes en bas
(section Journal). Référence de scope : [[Draft]] (v1 = machine du développeur ;
signature/notarization/CI = prérequis de la première distribution externe
uniquement). Source de vérité des décisions : [[Decisions]].

**État global** : le frontend est complet mais tourne à 100 % sur les données
seed (`src/lib/seed.ts`) ; le backend Rust est réel (classifieur, moteur SQLite
read-only, crypto, queue) mais **aucun `invoke()` dans les 41 fichiers TS/TSX**
— aucune fonctionnalité v1 n'est réelle de bout en bout.

---

## Chantier 1 — Câblage IPC (bloquant, tout en dépend)

- [x] Passer `@tauri-apps/api` en dependency (actuellement devDependency)
- [x] Couche d'accès frontend (`src/lib/ipc.ts` ou équivalent) avec fallback
      seed en mode navigateur (`npm run dev`)
- [x] Brancher les 9 commandes existantes : `classify_sql`, `list_profiles`,
      `save_profile`, `sqlite_list_tables`, `sqlite_run_query`, `request_write`,
      `queue_list`, `queue_resolve`, `mcp_tool_schemas`
- [x] Remplacer le classifieur client (`src/lib/sql.ts`) par `classify_sql`
      comme autorité (le miroir client peut rester pour l'UX hors ligne)

## Chantier 2 — Ouvrir un vrai fichier SQLite (bloquant, découvert à l'audit)

- [x] Ajouter le plugin `dialog` de Tauri + permission dans
      `src-tauri/capabilities/default.json` (aujourd'hui seulement
      `core:default`, `core:window:default`, `core:app:default` : **aucun moyen
      de choisir un fichier .db depuis l'UI**)
- [x] Parcours UI : bouton « Ouvrir un fichier SQLite » → dialog → profil sqlite
- [x] Étendre `sqlite_list_tables` en vrai `get_schema` (colonnes, types, PK,
      FK) — aujourd'hui il ne renvoie que des noms (`engine.rs:58`)

## Chantier 3 — Exécution des écritures (le différenciateur produit)

Aujourd'hui : approuver ne déclenche **rien** (`queue_resolve` change juste le
statut) ; pas de `run_write` dans `engine.rs` ; pas d'état `Used` dans
`queue.rs` (l'approbation « single-use » n'est jamais consommée) ; côté seed,
un édit approuvé disparaît en rouvrant la table.

- [x] `engine.rs` : chemin d'écriture SQLite (connexion séparée, non read-only,
      une seule instruction)
- [x] `queue.rs` : état `Used`/`Consumed`, consommation à l'exécution
- [x] Lier approbation → exécution → résultat (lignes affectées réelles)
- [x] SEC-05 : lier l'approbation à un hash du SQL + empreinte de la cible
      (profil, base) — re-vérifier le hash à l'exécution (SHA-256 dans
      `queue.rs`, + refus si le profil a été repointé vers une autre base
      entre staging et approbation ; couvert par tests unitaires + IPC)
- [x] Frontend : décompte d'expiration qui tique réellement (tick 1 s),
      statut « utilisé/exécutée » distinct, approbation désactivée une fois
      la demande expirée

## Chantier 4 — Corrections sécurité v1 (issues de [[SecurityFeedback]])

- [x] `lib.rs:156` : le profil seed a `agent_access: true` — viole la décision
      « accès agent désactivé par défaut »
- [x] `lib.rs:63` : `request_write` ne vérifie ni le flag `agent_access` du
      profil, ni l'allowlist (profil, base), ni l'environnement production
- [x] `engine.rs` : authorizer SQLite passé d'un allow-all fonctions à une
      allowlist de built-ins sûrs (SEC-03) — `load_extension` & co refusés,
      couvert par test
- [x] `classifier.rs` : `query_has_modifying_cte` inspecte réellement les corps
      de CTE (`SetExpr::Insert/Update`, imbrications, set-operations) ; DELETE
      en CTE non représentable par le parseur → fail-closed. Tests : 3 formes
      modifiantes + garde anti-faux-positif (`updated_at` dans une CTE lecture)
- [x] `classifier.rs` : le scan COPY attrape désormais un COPY en début de
      requête (`starts_with`), plus l'occurrence interne
- [x] Cap en octets (5 MiB, aligné sur le contrat `mcp.rs`) + timeout par
      instruction (progress handler SQLite / `statement_timeout` PG) +
      annulation (`sqlite3_interrupt` / cancel token PG) sur le chemin de
      lecture — `run_query` est passé async (spawn_blocking, il bloquait le
      thread principal), `cancel_query(query_id)` côté IPC, bouton Cancel réel
      et réglage `statementTimeout` câblés côté frontend. Tests : cap,
      timeout, interruption. Au passage l'authorizer autorise
      `SQLITE_RECURSIVE` (CTE récursives = lecture pure, refusées avant)
- [x] Neutralisation CSV à l'export (préfixes `=`, `+`, `-`, `@`, tab/CR →
      quote initiale ; en-têtes inclus ; nombres non touchés)
- [x] Crypto ([[Decisions]] §13) : blob versionné
      `[version][key_id][nonce][ct‖tag]`, sous-clés HKDF-SHA256 (la clé
      maîtresse ne chiffre plus directement), `zeroize` sur les clés
      intermédiaires, blob canari (posé au 1er chiffrement, vérifié à l'échec
      de déchiffrement → erreur claire `KeyMismatch` au lieu d'un échec
      opaque), chmod 0600 sur `gatehouse.db`. Rétro-compat : les blobs
      pré-versioning (`nonce||ct`) se déchiffrent toujours (fallback après
      échec authentifié). 4 tests crypto à clé injectée (pas de Keychain)
- [ ] Piège documenté ([[Decisions]] ligne 53) : la signature ad hoc à chaque
      rebuild peut invalider l'accès Keychain → tester la survie de la clé
      maîtresse entre deux `npm run app:build` (test manuel, à faire au
      moment de fixer l'identité de signature — cf. [[Feedbacks]] trousseau)

## Chantier 5 — Persistance (v1 : « persistance de session »)

Aujourd'hui seuls le thème et la langue survivent à un relancement
(localStorage). Le store zustand n'a pas de middleware `persist` ; la table
`settings` de `store.rs` existe mais rien n'y écrit.

- [x] Profils : lire/écrire via `list_profiles`/`save_profile` (le mot de passe
      saisi dans `ConnectionDialog` est actuellement **jeté** à la sauvegarde)
- [x] Onglets ouverts, historique, requêtes sauvegardées, réglages — commandes
      `ui_state_get`/`ui_state_set` (JSON dans la table `settings` de
      store.rs), hydratation dans `initBackend` (onglets restaurés seulement si
      `restoreTabs`, historique purgé selon `historyRetentionDays`, langue/
      thème réappliqués, ordre des groupes et profil actif restaurés),
      persistance debouncée 500 ms par subscriber zustand (gardée par un flag
      post-hydratation pour ne jamais écraser l'état stocké au boot). Test IPC
      `ui_state_roundtrips`
- [x] Action réelle « sauvegarder la requête courante » — bouton Sauvegarder
      dans la barre de l'éditeur, nommage inline (Entrée/Échap), visible dans
      le panneau Sauvegardées (vérifié par test navigateur)

## Chantier 6 — Commandes backend manquantes

- [x] `test_connection` (le bouton actuel est un `setTimeout(700)` avec
      latence codée en dur, `ConnectionDialog.tsx:31`)
- [x] `get_schema` complet (cf. chantier 2)
- [x] EXPLAIN réel (le plan affiché est inventé, `SqlEditor.tsx:209`)
- [x] Annulation de requête (cf. chantier 4 : `cancel_query` + bouton Cancel
      réel dans l'éditeur, résultat tardif ignoré si annulé)
- [x] Timeout par instruction (`statementTimeout` passé en `timeout_ms` par
      l'éditeur et la grille de données)

## Chantier 7 — Moteurs réseau (Postgres, MySQL, MS SQL, SSH)

Postgres est câblé depuis le 2026-07-17 (crate `postgres` 0.19 synchrone).
MySQL/MS SQL restent scaffoldés ; SSL et tunnel SSH restent des booléens
stockés sans code derrière (SSL coché → erreur explicite « TLS is not
supported yet », fail closed).

- [x] Postgres : session lecture ouverte avec `default_transaction_read_only=on`
      (best-effort, vérifié par test : un DELETE sur la session lecture est
      refusé par le serveur) ; schéma via `information_schema`/`pg_catalog`
      (PK, FK, index, vues, estimation `reltuples`) ; lectures via
      `simple_query` (valeurs en texte, types par `prepare()` best-effort) ;
      écritures via la queue uniquement (`pg_execute`, session sans read-only)
- [x] MySQL (crate `mysql` 28, sync) : lectures sur session
      `SET SESSION TRANSACTION READ ONLY` (best-effort), schéma via
      `information_schema` (colonnes, PK, FK, index, estimation TABLE_ROWS),
      timeout `max_execution_time` (SELECT-only), TLS via `SslOpts` (vérif
      complète par défaut), écritures via la queue. Tests live `#[ignore]`
      paramétrés `GATEHOUSE_MYSQL_USER/PASSWORD/DB` (le MySQL 8.2 local a un
      mot de passe root inconnu de l'agent — à lancer manuellement).
- [x] MS SQL (tiberius 0.12, rustls, runtime tokio local) : connexion
      `EncryptionLevel::Required` si SSL, schéma via `sys.*` +
      `INFORMATION_SCHEMA`, lectures avec conversion typée (chrono pour les
      temporels), `SET LOCK_TIMEOUT`. **Compilé mais jamais exécuté contre un
      vrai serveur** (aucun disponible localement) — à valider avec le
      conteneur de la matrice d'attaque SEC-03. Pas de mode session
      read-only → badge « unknown » côté UI (Decisions §5).
- [x] SSL/TLS réel : Postgres via `postgres-native-tls` (vérification chaîne
      + hostname par défaut, `SslMode::Require`), MySQL via `SslOpts`,
      MS SQL via rustls. L'annulation PG utilise le même connecteur TLS.
- [x] Tunnel SSH (russh 0.62, `tunnel.rs`) : un tunnel par profil (listener
      `127.0.0.1:0` → canal direct-tcpip), auth clé (permissions 0600 exigées,
      passphrase = secret SSH chiffré, AAD liée à la cible SSH), ssh-agent,
      ou mot de passe. Clés hôtes : store applicatif (`ssh_known_hosts` dans
      gatehouse.db), import lecture seule de `~/.ssh/known_hosts`,
      accept-new au premier contact, **échec dur si la clé change**
      (fingerprints SHA256 dans l'erreur). TLS à travers le tunnel : PG via
      `hostaddr` (SNI/vérif sur l'hôte logique), MS SQL via l'hôte de config ;
      MySQL+SSL+tunnel refusé fail-closed (le crate vérifie le cert contre
      127.0.0.1). Champs profil `ssh_host/port/user/key_path` + secret,
      formulaire de connexion complété (fr/en). Non testé contre un vrai
      sshd (aucun disponible sur cette machine) — test live `#[ignore]`
      paramétré `GATEHOUSE_SSH_*` prêt à lancer.
- [x] Pools de connexions (`pool.rs`) : par cible `(profil, database,
      empreinte host/port/user/ssl/tunnel)`, cap 2 connexions, file d'attente
      15 s (`PoolTimeout` sinon), probe au checkout (`is_valid`/`ping`/
      `SELECT 1`), destruction sur toute erreur (jamais de réutilisation d'un
      état incertain, Decisions §10), purge des clés périmées d'un profil
      édité/re-tunnelé. Chemin de lecture + schéma PG/MySQL/MSSQL ; les
      écritures restent hors pool sur connexion dédiée. Rituel par requête :
      `statement_timeout`/`max_execution_time`/`LOCK_TIMEOUT` re-posés à
      chaque appel (les réglages de session persistent sur une connexion
      poolée). 6 tests unitaires pool.
- [x] Annulation MySQL : `KILL QUERY <connection_id>` via connexion de
      contrôle ouverte à la demande (jamais de SQL utilisateur) ;
      ER_QUERY_INTERRUPTED (1317) et ER_QUERY_TIMEOUT (3024) → statut
      « interrompue » (l'annulation n'est confirmée que quand le worker
      termine). Annulation MS SQL : tiberius n'expose pas le signal
      Attention → future abandonnée via oneshot + select, connexion
      détruite (le serveur avorte la requête à la coupure), résultat déclaré
      interrompu — le repli prévu par Decisions §10 ; au passage MS SQL gagne
      un vrai statement timeout (côté client). L'annulation PG mappe
      désormais 57014 (QUERY_CANCELED) → « interrompue ».
- [x] LIMIT poussé côté serveur (`classifier::with_server_limit`, sqlparser) :
      un SELECT/CTE sans LIMIT/FETCH reçoit `LIMIT n+1` avant envoi — plus de
      bufferisation de tables entières par `simple_query` ; appliqué aussi à
      MySQL/MS SQL ; EXPLAIN/SHOW/multi-statements inchangés (caps aval).
      3 tests unitaires + tests live PG verts.

## Chantier 8 — Serveur MCP embarqué

`mcp.rs` ne contient que le contrat JSON statique. Pas de crate `rmcp`, pas de
socket, pas de pairing. Le « port 52110 » affiché dans les réglages est une
chaîne en dur (`SettingsScreen.tsx:428`).

- [x] Serveur `rmcp` 2.2 embarqué (`mcp.rs`) : socket Unix
      `…/Gatehouse/gatehouse.sock` en 0600, vérification peer-UID
      (`getpeereid` = euid de l'app), démarré au setup Tauri. Préambule
      d'appairage (1 ligne JSON avec le token) avant le protocole MCP ;
      token inconnu/révoqué → fermeture silencieuse (pas d'oracle).
- [x] Proxy stdio `gatehouse-mcp` (`src/bin/gatehouse-mcp.rs`) : pipe
      stdio ↔ socket, token via `GATEHOUSE_TOKEN` (+ `GATEHOUSE_SOCKET`
      optionnel), sortie dès qu'un côté ferme. Livré avec l'app :
      `externalBin` + script `npm run mcp:proxy` (appelé par
      `beforeBuildCommand`) qui stage `binaries/gatehouse-mcp-<triple>`.
      NOTE fresh clone : lancer `npm run mcp:proxy` une fois avant
      `app:dev` (tauri-build valide l'existence du fichier).
- [x] Pairing par client : 32 octets aléatoires, seul le hash SHA-256
      stocké (table `mcp_clients`), id indépendant du token ; révocation
      re-vérifiée à chaque connexion. Réglages → Agents : appairage réel
      (token affiché une seule fois + bouton copier), liste réelle
      (pastille verte si activité < 5 min, badge « Révoqué »), révocation
      branchée sur le backend.
- [x] Les 4 tools branchés sur les vrais chemins : `list_profiles` (profils
      agent_access uniquement), `get_schema` (compact), `query` (classifieur
      fail-closed, cap 1000 lignes / 5 MiB, timeout 30 s), `request_write`
      (queue réelle + événement `queue-changed` → la demande apparaît dans
      la file de validation UI). Chaque appel audité (SEC-12, fail-closed).
      Vérifié bout-en-bout par un client MCP Python à travers le proxy :
      handshake, lecture réelle, écriture refusée, enqueue, profil non
      autorisé → erreur générique, tokens inconnu/révoqué refusés.
- [x] Ticker d'activité agent réel : événement `agent-activity` émis à
      chaque tool call → `AgentActivity.tsx` affiche client/tool/durée/
      lignes réels en desktop (démo seed conservée en navigateur). Libellé
      « port 52110 » remplacé par « socket Unix locale ».

## Chantier 9 — Audit backend (promesse produit, SEC-12)

- [x] **`audit.rs` créé** : records AES-GCM sous sous-clé HKDF dédiée
      (`k_audit_enc`, seuls `seq` + horodatage en clair), chaîne HMAC-SHA256
      (`k_audit`) détectant modification/suppression/réordonnancement, ancre
      `(key_id, last_seq, last_mac)` dans le Keychain mise à jour **avant**
      acquittement, purge 180 j avec checkpoint authentifié, reprise au
      démarrage (chaîne en avance sur l'ancre + valide → avance ; sinon
      fail-closed observable). Simplification v1 documentée : une seule
      génération de clé (key_id 0, comme crypto.rs) — la rotation
      (rechiffrement + re-MAC transactionnels) reste à faire. Ouverture
      paresseuse (`AuditHandle`) pour ne pas déclencher le prompt Keychain
      au lancement des builds dev ad hoc. 7 tests unitaires (falsification,
      suppression, troncature post-acquittement, purge, ancre perdue).
- [x] Alimenté sur le cycle de vie de la queue : `request_write` (pending),
      `queue_resolve` (approved/rejected, audité **avant** le changement de
      statut), `queue_approve_execute` (executed/failed). Chemin agent
      fail-closed : audit indisponible ou chaîne invalide → demande/exécution
      agent refusée (le chemin humain continue avec warning stderr). Les
      lectures agent seront auditées par le serveur MCP (chantier 8).
- [x] Réglages : `audit_list` (vérifie la chaîne, 200 dernières entrées
      déchiffrées) remplace le seed en desktop ; bannière d'alerte si chaîne
      invalide ; fetch au moment d'ouvrir Réglages → Agents (pas au démarrage).

## Chantier 10 — Frontend : recâbler ou retirer les simulations

- [x] Runtime SQL de démo limité à `SELECT … FROM <une table>` : les requêtes
      sauvegardées du seed (JOIN, GROUP BY) **échouent au Run**, les vues de
      l'arbre ne sont pas requêtables — disparaît avec le chantier 1
- [x] Confirmation renforcée : le champ « retaper le nom du profil » est
      maintenant affiché **et exigé** pour toute écriture production ET pour
      les DELETE/DDL quel que soit l'environnement (avant : affiché pour
      delete/DDL mais exigé seulement en prod, et le champ n'existait qu'en
      prod → l'exigence élargie aurait rendu ces demandes inapprouvables).
      Vérifié par test navigateur (bouton désactivé → activé après saisie).
- [x] Sélecteur de base : remplacé par un libellé statique quand une seule
      database est connue (cas desktop réel — un profil = une database) ; le
      Select ne reste que s'il y a un vrai choix.
- [x] Liste « Accès par profil » : tous les profils, libellé `groupe · nom`
      (le filtre en dur « Projet ACME » est retiré).
- [x] Révocation client MCP réelle (chantier 8) : `mcp_client_revoke` côté
      backend, re-vérifiée à chaque connexion/appel.

## Chantier 11 — Réglages fantômes et raccourcis

4 réglages changent l'état mais n'ont aucun effet : `autoReconnect`,
`exportFormat`, `runSelectionOnly`, `keywordCase`. (Fonctionnent : `rowLimit`,
`autocomplete`, `editorFontSize`, thème, langue, `confirmQuit`, et depuis les
chantiers 4-6 : `statementTimeout`, `restoreTabs`, `historyRetentionDays`.)

- [x] Câbler ou retirer chacun des 4 restants
- [x] Raccourcis : table statique non personnalisable ; ⌘F, ⌘1-2-3, ⌘. affichés
      mais **non branchés** (seuls ⌘P, ⌘T, ⌘⇧V le sont). [[Decisions]] §
      raccourcis impose TanStack Hotkeys (`@tanstack/react-hotkeys`, absent de
      `package.json`)

## Chantier 12 — Finitions

- [x] i18n : ~10 fichiers avec de l'anglais en dur — `StructureView`
      entièrement non traduit, ExportMenu, CommandPalette, queue
      (« Recently resolved »), DataGrid
- [x] `elkjs` promis pour l'auto-layout des relations ([[Decisions]] §8),
      absent de `package.json`
- [x] `RelationsView` force `colorMode="dark"` (ne suivra pas les thèmes
      vert/bleu de la maquette)
- [x] Import d'URL via `window.prompt`/`alert` ; copie presse-papier qui
      échoue silencieusement
- [x] `.gitignore` exclut `docs/` : la source de vérité ne voyage pas avec le
      repo — décision à prendre (sortir Decisions/Draft du ignore ?)

---

## Hors scope v1 (confirmé par [[Draft]] — ne pas s'en inquiéter)

Signature/notarization + updater (distribution externe uniquement — mais une
CI de release non signée existe depuis le 2026-07-20, cf. Journal),
MariaDB, ERD global exportable, import CSV/Excel, formateur SQL, mode
strict-provenance, run-selection.

## Ordre recommandé

1. Chantiers 1 + 2 (IPC + dialog) — tout le reste en dépend
2. Chantiers 3 + 4 (écritures + sécurité) — le cœur de la promesse produit
3. Chantiers 5 + 6 (persistance + commandes manquantes) — l'app devient un
   vrai outil quotidien sur SQLite
4. Chantier 9 (audit) puis 8 (MCP) — la promesse « agents » devient réelle
5. Chantier 7 (moteurs réseau) — le plus gros volume, découplable
6. Chantiers 10-12 en continu

## Journal

- 2026-07-17 — Création du fichier après audit exhaustif (4 passes). Toutes les
  références fichier:ligne vérifiées par grep à l'écriture. Rien d'implémenté.
- 2026-07-17 (soir) — **Chantiers 1, 2 et cœur du 3 terminés** : IPC câblé
  (`src/lib/ipc.ts` + `src/lib/backend.ts`, fallback seed en navigateur),
  plugin dialog + `get_schema` complet (colonnes/PK/FK/index/rowCount),
  chemin d'écriture réel (`sqlite_execute`), statuts `Used`/`Failed` dans la
  queue, `queue_approve_execute` (approbation single-use → exécution → lignes
  affectées réelles), `test_connection` et EXPLAIN QUERY PLAN réels, profils
  sqlite persistés dans le store Rust, seed `agent_access=false` et gate agent
  dans `request_write` (chantier 4 partiel). Vérifié : 17 tests cargo dont
  2 tests d'intégration passant par la vraie couche IPC (`tauri::test`),
  typecheck + lint + build OK, démo navigateur intacte (Playwright), app
  desktop lancée avec une vraie base `~/gatehouse/cache.db`.
  Corrigé au passage : drag de la fenêtre (`data-tauri-drag-region` +
  permission `core:window:allow-start-dragging` — `-webkit-app-region` ne
  fonctionne pas sous Tauri et `core:window:default` n'inclut PAS
  start-dragging) et sélection de texte désactivée hors zones éditables.
  Reste notamment : SEC-05 (hash SQL lié à l'approbation), comptes à rebours
  qui tiquent, timeout/annulation, cap octets, persistance onglets/historique,
  moteurs réseau, MCP, audit backend.
- 2026-07-17 (nuit) — **Chantier 7 : Postgres câblé end-to-end** (déclencheur :
  l'utilisateur a branché une base PSQL et ne voyait pas ses tables — seul
  SQLite était réel). Backend : crate `postgres` 0.19, `PgTarget` +
  `pg_test`/`pg_schema`/`pg_query`/`pg_execute` dans `engine.rs`, lecture sur
  session `default_transaction_read_only=on`. Commandes IPC refactorées par
  profil : `get_schema(profileId)`, `run_query(profileId, …)` (ex
  `sqlite_run_query`), `test_connection(profile, password?)`,
  `queue_approve_execute` dispatch sqlite/postgres — les credentials sont
  résolus côté Rust (store chiffré) et ne traversent jamais l'IPC.
  `TableSchema` porte désormais `schema` (multi-schémas Postgres ; `main` en
  SQLite), frontend aplati via `allTables()` et noms qualifiés
  `"schema"."table"` dans le SQL généré (grille + writes). En mode desktop,
  les profils/onglets/démo ne sont plus injectés : tout ce qui est visible
  est réel (le navigateur garde la démo). Vérifié : 22 tests cargo (17 + 5
  Postgres `--ignored` exécutés sur le PG 14 local, dont refus d'un DELETE
  par la session lecture), typecheck/lint/build OK, démo navigateur intacte
  (Playwright). Base de test : `gatehouse_pg_test` + profil seedé
  « PG local (test) ». Limites notées dans le chantier 7 : TLS refusé
  explicitement, LIMIT tronqué côté client, row counts = estimations.
- 2026-07-17 (nuit, 2e passe) — **Batch feedbacks UI** (les 11 points restants
  de [[Feedbacks]] cochés, détail là-bas). Notables côté architecture :
  `dragDropEnabled: false` dans tauri.conf.json (Tauri interceptait le drag &
  drop HTML5 — cause des drags de profils/groupes cassés) ;
  `trafficLightPosition` 14×16 (alignement barre de titre 44 px) ; icône
  régénérée au gabarit Apple (rounded-rect 824/1024, `npx tauri icon`) ;
  **menu natif custom dans `lib.rs`** (le menu Tauri par défaut liait ⌘W à
  Close Window et ⌘Z au responder chain natif — items custom quit/undo/redo/
  close-tab émis vers le frontend via l'événement `gatehouse://menu`, routés
  dans `App.tsx` : fermeture d'onglet, modale de confirmation avant de quitter
  (réglage `confirmQuit`, `onCloseRequested`), undo/redo de la grille) ;
  booléens Postgres normalisés `t`/`f` → booléens dans `toQueryResult` ;
  autocomplete `"` → tables quotées. Vérifié : cargo 17 passed + 5 ignored,
  typecheck/lint/build OK, démo navigateur Playwright OK (arbre, autocomplete
  quotée, modale de suppression), app desktop relancée (traffic lights centrés,
  menu custom visible, nouvelle icône dans le Dock). Non vérifié à la main :
  frappe réelle ⌘W/⌘Q/⌘Z (osascript sans permission Accessibilité).
  Dans la foulée : **chantier 3 terminé** — SEC-05 (empreinte SHA-256
  sql+profil+base vérifiée à la consommation de l'approbation, + refus si le
  profil a été repointé ; tests `tampered_sql_is_refused`,
  `retargeted_profile_refuses_approval`), countdown qui tique + statut
  « exécutée » + approbation bloquée si expirée côté frontend. Et fix du
  feedback trousseau : clé maîtresse Keychain mise en cache par process
  (`OnceLock` dans `crypto.rs`) — une demande par lancement au lieu d'une par
  action ; la demande par rebuild restera tant que la signature dev est ad hoc.
  Puis **chantier 4 (partiel)** : allowlist de fonctions SQLite dans
  l'authorizer (SEC-03), détection AST des CTE modifiantes + scan COPY corrigé
  dans le classifieur, le tout testé. Vérifié : cargo 24 passed + 5 ignored,
  typecheck/lint/build OK. Reste au chantier 4 : cap octets/timeout/annulation,
  neutralisation CSV, crypto blob versionné, survie de la clé Keychain entre
  rebuilds (lié à la signature ad hoc, cf. [[Feedbacks]]).
- 2026-07-17 (nuit, 3e passe) — **Chantiers 4 (code) et 5 terminés, chantier 6
  quasi**. Chantier 4 : cap 5 MiB + timeout + annulation sur le chemin de
  lecture (`run_query` async + `cancel_query`, `sqlite3_interrupt` via
  progress handler/handle, `statement_timeout` PG), neutralisation CSV,
  crypto blob versionné `[version][key_id][nonce][ct‖tag]` + HKDF + zeroize +
  canari + chmod 0600 (rétro-compat blobs existants) — il ne reste que le test
  manuel de survie Keychain entre deux `app:build`. Chantier 5 : persistance de
  session complète (`ui_state_get/set` + hydratation/subscriber zustand ;
  onglets si `restoreTabs`, historique purgé par `historyRetentionDays`,
  requêtes sauvegardées, réglages, ordre des groupes, profil actif) + bouton
  réel « Sauvegarder la requête ». Chantier 6 : terminé — annulation et
  timeout cochés (les autres items l'étaient déjà). Aussi : 3 retours
  UI traités (bouton Quitter → permission `core:window:allow-destroy`
  manquante ; datalist illisible → combobox custom ; bouton « Ouvrir un
  fichier SQLite » limité aux profils SQLite). Vérifié : cargo 32 passed +
  5 ignored (8 nouveaux tests), typecheck/lint/build OK, flux « sauvegarder
  une requête » vérifié par test navigateur, app dev relancée (23:41). Reste
  chantiers : 7 (MySQL/MSSQL/TLS/SSH), 8 (MCP), 9 (audit), 10-12 (finitions).
- 2026-07-18 — **Chantiers 9, 8, 7 (partiel) et 10 terminés.**
  Chantier 9 : `audit.rs` (records chiffrés `k_audit_enc`, chaîne HMAC
  `k_audit`, ancre Keychain avant acquittement, purge 180 j avec checkpoint,
  reprise fail-closed), événements queue audités, `audit_list` + bannière
  chaîne invalide dans les réglages. Chantier 8 : serveur `rmcp` 2.2 sur
  socket Unix 0600 + peer-UID, pairing par hash SHA-256 (UI réelle
  d'appairage/révocation), proxy `gatehouse-mcp` bundlé (`externalBin`),
  4 tools branchés + audités, ticker d'activité réel — vérifié bout-en-bout
  par un client MCP Python via le proxy (handshake, lecture réelle, écriture
  refusée, enqueue visible dans la file UI, tokens inconnu/révoqué refusés).
  Chantier 7 : MySQL complet (best-effort read-only, TLS, timeouts), MS SQL
  tiberius (compilé, jamais exécuté contre un vrai serveur), TLS Postgres
  natif (vérif complète), LIMIT poussé côté serveur via sqlparser, garde
  SSH fail-closed ; restent tunnel SSH, pools, annulation MySQL/MS SQL.
  Chantier 10 : confirmation renforcée exigée pour delete/DDL partout,
  sélecteur de base honnête, « Accès par profil » sans filtre en dur,
  révocation MCP réelle. Vérifié : cargo 46 passed + 7 ignored (dont 5 live
  PG verts), typecheck/lint/build OK, parcours navigateur (file de
  validation, écran Agents) par Playwright.

- 2026-07-18 (suite) : correctif de deux régressions bloquantes au lancement.
  (1) `default-run = "gatehouse"` dans Cargo.toml — l'ajout du binaire
  `gatehouse-mcp` cassait le `cargo run` de `tauri dev`. (2) Fenêtre vide +
  curseur occupé au démarrage : interblocage dans `Store::password` (le
  chemin d'échec de déchiffrement rappelait `setting()` alors que le Mutex
  du store était encore tenu), déclenché sur le thread principal car
  `get_schema`/`test_connection` étaient des commandes synchrones.
  Correctifs : verrou relâché avant le contrôle canari, `get_schema` et
  `test_connection` passés en async + spawn_blocking, test de régression
  `password_decrypt_failure_reports_key_mismatch_without_deadlock` (clé
  maître injectée via `crypto::preset_master_key_for_tests`). Vérifié :
  cargo 47 passed, app relancée avec UI complète (95 tables FFTir chargées),
  thread principal sain au `sample`. TODO(ali) restant :
  `queue_approve_execute` encore synchrone (écriture réseau sur le thread
  principal).

- 2026-07-18 (suite) : ⌘S dans la grille de données = « Réviser » (la cellule
  en cours d'édition est validée puis tout part en file) — vérifié Playwright.
  `toggleAgentAccess` persiste maintenant le profil via `save_profile`
  (`Store::upsert` conserve le mot de passe stocké quand password est absent,
  via COALESCE). README : nouvelle section « Connect an AI agent (MCP) » avec
  instructions dépliables Claude Code / Codex (syntaxes vérifiées :
  `claude mcp add -e`, `codex mcp add --env` + `[mcp_servers]` dans
  config.toml).

- 2026-07-18 (suite) : lot chantiers 1/3/11/12. (1) `queue_approve_execute`
  async + spawn_blocking (l'écriture réseau quittait le thread principal —
  même famille que le gel du matin). (2) `classify_sql` Rust = autorité de
  routage : `classifyStatement()` dans backend.ts (fail-closed si IPC en
  erreur), utilisé par `SqlEditor.run()` ; le TS reste miroir pour le
  navigateur et l'affichage (badge live, chips de file). (3) Réglages :
  `exportFormat` câblé (ExportMenu, format par défaut en tête + download
  md/sql), `keywordCase` câblé (casse des mots-clés d'autocomplétion) ;
  `autoReconnect`/`reconnectAttempts` et `runSelectionOnly` retirés (pas de
  connexion persistante ; run-selection hors scope v1). Raccourcis : ⌘1-2-3
  (sous-vues) et ⌘. (annuler la requête) branchés, ⌘F retiré, lignes ⌘S et
  ⌘Z/⇧⌘Z ajoutées — TanStack Hotkeys ([[Decisions]]) non adopté, keydown
  custom conservé. (4) i18n : StructureView complet, palette, file
  (« Résolues récemment »), DataGrid, ExportMenu ; les `reason` du
  classifieur restent en anglais (générées côté Rust — à traiter avec le
  backend si besoin). (5) RelationsView : elkjs (layered, RIGHT) remplace
  les positions manuelles, `colorMode` suit le thème, couleurs en variables
  CSS. (6) Import URL = rangée inline dans le dialog (plus de
  window.prompt/alert qui bloquent la WKWebView) ; copie presse-papier avec
  retour ✓/✗ (ExportMenu, token MCP). (7) `docs/` sorti du .gitignore.
  Vérifié : cargo 47 passed, tsc/eslint verts, `npm run build` OK,
  Playwright (⌘1-3, i18n fr, elk multi-nœuds sur `orders`, thème clair).

- 2026-07-18 (suite) : ⌥⌘←/→ navigue entre les onglets ouverts (cycle avec
  retour au début, ligne ajoutée à la table des raccourcis). ⌘1/⌘2/⌘3
  rebasculés sur `e.code` (Digit1/2/3 = touche physique) pour fonctionner
  tels quels sur AZERTY (où `e.key` donne &/é/") comme sur QWERTY. Vérifié
  Playwright : cycle aller-retour entre 2 onglets + les 3 sous-vues.

- 2026-07-18 (soir) : raccourcis personnalisables. Nouveau `src/lib/shortcuts.ts`
  (bindings "Mod+Alt+Shift+<token>" ; token = `e.code` pour la rangée de
  chiffres — indépendant du layout AZERTY — sinon `e.key` normalisé). Les
  handlers (App, SqlEditor run/cancel, DataGrid ⌘S, palette) et les
  affichages (badge Run, hints palette) lisent `settings.shortcuts` ;
  hydratation assainie via `sanitizeShortcuts` (défauts + entrées valides).
  Écran Réglages > Raccourcis : clic = enregistrement (Échap annule),
  refus des combos sans ⌘, des touches du menu natif (⌘W/⌘Q/⌘Z) et des
  conflits (message avec l'action en cause), bouton « Réinitialiser les
  défauts » ; ⌘Z/⇧⌘Z affiché en ligne fixe (menu natif). Vérifié Playwright :
  réassignation ⌘P→⌘K effective immédiatement, conflit, réservé, sans-mod,
  reset. Feux macOS : `trafficLightPosition` passé à y=24 — mesure pixel
  (probe Swift + screencapture sur l'app réelle) : centre boutons 21.8pt
  pour un centre de barre à 22pt (y:16 donnait ~17.8pt, d'où le décalage
  visuel signalé).

- 2026-07-18 (soir, 2) : erreur trousseau bloquante. Deux vrais bugs corrigés
  au passage : (1) `load_or_create_master_key` régénérait une nouvelle clé
  maîtresse sur N'IMPORTE QUELLE erreur de lecture — un refus d'accès aurait
  écrasé la clé et rendu tous les mots de passe indéchiffrables ; seul
  `keyring::Error::NoEntry` crée désormais une clé. (2) `password_for` (et
  `test_connection`) avalaient l'erreur (`unwrap_or(None)`) → connexion
  tentée sans mot de passe et erreur d'auth trompeuse ; l'erreur est
  propagée partout (get_schema, run_query, approve, MCP get_schema/query).
  Le canary ne classe plus un refus Keychain en KeyMismatch. Marqueur stable
  `keychain:` (crypto.rs KEYCHAIN_ERROR_PREFIX) détecté centralement dans
  ipc.ts (`inv()` wrapper) → événement `gatehouse:keychain-error` → overlay
  bloquant dans App.tsx (Réessayer relance initBackend et re-déclenche la
  demande macOS ; Quitter en desktop). Vérifié : cargo 47 passed, tsc/eslint
  verts, Playwright (overlay fr, couche bloquante, retry efface). Le refus
  réel se teste manuellement : cliquer « Refuser » à l'invite trousseau
  après un rebuild (signature ad hoc → nouvelle invite).

- 2026-07-20 — **Chantier 7 : tunnel SSH + pools + annulation MySQL/MS SQL.**
  Nouveaux modules `tunnel.rs` (russh 0.62 : un tunnel par profil, listener
  local → direct-tcpip, TOFU accept-new + échec dur sur changement de clé,
  auth clé/agent/mot de passe, clé privée 0600 exigée) et `pool.rs` (cap 2
  par cible, attente 15 s, probe au checkout, destruction sur erreur, purge
  des clés périmées). `Store` : colonnes `ssh_host/port/user/key_path` +
  `ssh_secret_enc` (migration ALTER TABLE en place), table `ssh_known_hosts`,
  `crypto::ssh_aad`. `AppState.store` passé en `Arc<Store>` pour que la
  résolution profil→cible (mot de passe + tunnel) vive dans les closures
  spawn_blocking (`resolve_net_target`), partagée avec le chemin MCP.
  `NetTarget.tcp` = endpoint TCP réel (tunnel) distinct de l'hôte logique
  TLS. Annulation : `ActiveQuery::MySql` (KILL QUERY via connexion de
  contrôle) et `::MsSql` (oneshot + select + destruction), `cancel_query`
  passé async ; erreurs 1317/3024 MySQL et 57014 PG mappées « interrompue ».
  Frontend : champs SSH dans ConnectionDialog (fr/en), secret SSH transmis à
  save/test, SSL/SSH affiché dans le gestionnaire. Garde `SshNotSupported`
  remplacée par la validation des champs SSH. Vérifié : cargo 55 passed +
  9 ignored (6 tests pool, 2 store SSH, live tunnel/kill prêts), tsc/eslint
  verts, `npm run build` OK, section SSH du dialog vérifiée par Playwright.
  **Restes chantier 7** : tester le tunnel contre un vrai sshd
  (`GATEHOUSE_SSH_*`, aucun sshd local dispo), MS SQL toujours jamais exécuté
  contre un vrai serveur, TLS MySQL à travers un tunnel (refus fail-closed en
  attendant un override de hostname dans le crate).

- 2026-07-20 (suite) — **CI de release non signée** (décision : pas de compte
  Apple Developer pour l'instant, distribution par `.dmg` téléchargé depuis
  les releases GitHub ; Homebrew écarté — le flag `--no-quarantine` a été
  supprimé en Homebrew 5.1, un tap n'apporterait plus que la distribution).
  Nouveau `.github/workflows/release.yml` : déclenché sur tag `v*`,
  `tauri-apps/tauri-action@v1`, matrice `macos-latest` (ARM) +
  `macos-15-intel` (Intel, label dispo jusqu'à août 2027 ; `macos-13` retiré
  depuis déc. 2025), release GitHub en draft. Runners natifs obligatoires
  (pas de `--target`) : le sidecar `mcp:proxy` est nommé d'après le triple
  hôte. `tauri.conf.json` : `targets` passé de `"app"` à `["app", "dmg"]`.
  README : section Install (dmg + commande `xattr -dr com.apple.quarantine`,
  reprise dans le corps de chaque release). Non testé en CI (repo jamais
  poussé sur GitHub — aucun remote). Pièges connus : le tag poussé doit
  correspondre à la version de `tauri.conf.json`/`package.json` (l'action
  nomme la release `v__VERSION__` d'après la conf, pas d'après le tag) ; la
  signature ad hoc change à chaque build → invite Keychain à chaque mise à
  jour installée. `npm run bump -- <patch|minor|major|x.y.z>` synchronise la
  version dans package.json, package-lock.json, tauri.conf.json, Cargo.toml
  et Cargo.lock (échec si elles divergent déjà) et affiche les commandes
  commit + tag ; testé sur copie scratchpad, zéro churn de formatage.
  Procédure complète documentée dans `docs/Releasing.md`, lié depuis le
  README (section Install).

- 2026-07-18 (soir, 3) : badge « lecture seule » retiré du panneau latéral
  (info toujours dans le gestionnaire de connexions) ; composant
  ReadOnlyBadge et clés i18n morts supprimés. Diagnostic du « impossible
  d'ouvrir cette base » après retry trousseau : la clé maîtresse Keychain a
  été RÉÉCRITE le 17/07 à 21:34Z par l'ancien bug de régénération (mdat de
  l'entrée `security find-generic-password`) ; le mot de passe FFTir
  (profil créé 20:33Z) est chiffré sous la clé perdue. Ça « marchait » avant
  parce que l'erreur était avalée + PG local en auth trust. Correctifs :
  tout échec de déchiffrement non-Keychain → KeyMismatch (« re-save the
  password »), sans dépendre du canary (absent pour les profils d'avant le
  18/07) ; le bandeau d'erreur du panneau affiche désormais le détail réel
  de l'erreur + bouton Réessayer (refreshSchema). Action utilisateur : ré-
  enregistrer le mot de passe du profil FFTir.
