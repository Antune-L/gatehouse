---
title: Feedback sécurité
date: 2026-07-16
tags:
  - security
  - architecture
  - feedback
status: revision-v6-reviewed
updated: 2026-07-16
---

# Feedback sécurité

Revue de [[Draft]] et [[Decisions]] avant le début de l'implémentation de **Gatehouse — Where agents meet your data**.

> [!danger] Verdict
> Les fondations sont bonnes, particulièrement le fail-closed, le statement unique et l'enforcement côté moteur. Cependant, le serveur MCP et les badges read-only ne devraient pas être implémentés avant la résolution des éléments P0 ci-dessous.

> [!info] Synchronisation du 2026-07-16
> Cette version prend en compte les ajouts sur `get_schema`, le plafond de lignes MCP, l'annulation, le statement timeout, le mode read-only humain, la reconnexion automatique, EXPLAIN, le changement de database, React Flow/ELK et l'absence d'auto-update en v1.

> [!info] Revue complémentaire du 2026-07-16 (seconde passe)
> Ajouts de cette passe : proposition de transport MCP (socket Unix + proxy stdio), piège `EXPLAIN ANALYZE` (exécute réellement la requête), commentaires exécutables MySQL, `SET`/`RESET` et `COPY` sur le chemin agent Postgres, liaison des credentials chiffrés à la cible de connexion (AAD), durcissement de l'affichage des approbations (caractères bidi/invisibles), format d'export de profils, et une section « Propositions de résolution » qui répond à chaque question ouverte.

## Principes à conserver

- Un seul statement SQL par appel driver.
- Le parseur sert à l'aiguillage UX, jamais comme unique barrière de sécurité.
- Les écritures générées par l'UI et les écritures agent passent par une validation humaine explicite.
- Le SQL écrit manuellement par l'humain s'exécute directement, sous réserve du mode read-only de la connexion.
- Les credentials ne sont jamais transmis au frontend ou à un agent.
- Les garanties affichées dans l'UI doivent correspondre à une barrière réellement imposée par le moteur.

## P0 — Bloquants

### SEC-01 — Définir le transport et l'authentification MCP

**Risque**

Le plan définit les tools MCP, mais pas le transport, l'authentification des clients, leur appairage, la révocation ou la durée des sessions. Un serveur HTTP local non protégé pourrait être appelé par un autre processus ou par un site malveillant via DNS rebinding.

Le flag « accès agent » est actuellement activé par défaut. La lecture seule protège partiellement l'intégrité, mais pas la confidentialité des données.

**Actions**

- [x] Choisir explicitement le transport MCP : socket Unix + proxy stdio (décidé 2026-07-16, reporté dans [[Decisions]] §4).
- [ ] Si HTTP :
  - [ ] écouter uniquement sur loopback ;
  - [ ] valider strictement l'en-tête `Origin` ;
  - [ ] authentifier chaque client ;
  - [ ] utiliser des tokens courts, non présents dans les logs ;
  - [ ] refuser les connexions sans appairage préalable.
- [ ] Afficher les clients MCP connectés dans l'UI.
- [ ] Permettre leur révocation immédiate.
- [ ] Arrêter ou verrouiller le serveur lorsque l'application est fermée ou verrouillée.
- [x] Passer le flag « accès agent » à **désactivé par défaut**, y compris pour les profils importés (décidé 2026-07-16, reporté dans [[Decisions]] §4).
- [ ] Ne pas exposer les noms de profils non autorisés dans `list_profiles`.
- [ ] Définir une limite de requêtes et de connexions par client.

**Proposition (2026-07-16)**

Éviter TCP entièrement : le serveur MCP écoute sur une **socket Unix** (fichier dans le dossier de données de l'app, permissions `0600`), et l'app distribue un petit binaire proxy `sql-reader-mcp`. Les clients MCP (Claude Code, Codex...) le lancent en **stdio** — le transport que tous supportent nativement — et le proxy relaie octet pour octet vers la socket.

Bénéfices : aucun port réseau ouvert, donc pas de DNS rebinding ni d'en-tête `Origin` à valider ; les permissions du système de fichiers restreignent l'accès à l'utilisateur courant ; le backend peut vérifier l'UID du pair (`getpeereid` sur macOS). L'appairage reste nécessaire pour distinguer les clients entre eux : token généré à l'appairage, passé au proxy via variable d'environnement (jamais en argument de ligne de commande, visible dans `ps`).

- [x] Vérifier que `rmcp` accepte un transport custom sur socket Unix → oui, transport `AsyncRead`/`AsyncWrite` via la feature `transport-async-rw` (validé 2026-07-16).
- [ ] Garder le proxy sans aucune logique métier : relais 1:1, il se termine quand l'app ferme la socket.
- [ ] Vérifier l'UID du pair à chaque connexion sur la socket.
- [ ] Créer la socket dans un dossier parent en permissions `0700`.
- [ ] Créer la socket sans suivre de symlink ; à la suppression, ne supprimer qu'une socket appartenant à l'utilisateur courant.

**Critère de clôture**

Un client non appairé ne peut ni lister les profils, ni lancer une requête. Un profil nouvellement créé ou importé n'est jamais exposé automatiquement.

**Référence**

- [MCP — Transports et sécurité](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP — Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)

### SEC-02 — Définir la portée réelle de l'accès agent

**Risque**

« L'agent ne lit pas les credentials » ne signifie pas qu'il ne peut pas exfiltrer les données. Un accès `query(profile, sql)` sans autre limite peut lire toutes les tables accessibles au compte, y compris une base de production.

Une injection de prompt contenue dans une ligne de la base peut également pousser l'agent à lire d'autres tables ou à transmettre des données sensibles.

**Actions**

- [ ] Définir les scopes possibles :
  - [ ] profil ;
  - [ ] base ;
  - [ ] schéma ;
  - [ ] tables ou vues autorisées.
- [x] Décider si la v1 autorise seulement le scope par profil ou un scope plus fin → scope (profil, database) avec allowlist (R3, validé 2026-07-16, [[Decisions]] §10).
- [ ] Afficher clairement les données auxquelles chaque client MCP peut accéder.
- [ ] Ajouter une confirmation au premier accès d'un client à un profil.
- [ ] Ajouter une option « lecture agent interdite sur production ».
- [x] Prévoir un plafond de lignes sur les résultats MCP.
- [ ] Définir une valeur maximale non désactivable pour le chemin agent.
- [ ] Limiter également le nombre d'octets retournés : une seule ligne peut contenir plusieurs gigaoctets.
- [ ] Ne pas exécuter automatiquement un `COUNT(*)` coûteux uniquement pour annoncer le nombre total de lignes ; répondre « résultat tronqué à N lignes » si le total n'est pas déjà connu.
- [ ] Interdire aux tools MCP l'export direct vers un fichier.
- [ ] Définir si les résultats MCP peuvent contenir des colonnes marquées sensibles ou si une redaction est nécessaire.
- [ ] Appliquer les mêmes scopes à `get_schema` qu'à `query`.
- [ ] Ne pas exposer via `get_schema` les databases, schémas ou tables non autorisés.
- [x] Définir la cible exacte des tools MCP après un changement de database dans l'UI → aucune influence de l'UI, la cible est toujours le paramètre explicite du tool (R3, validé 2026-07-16).
- [x] Ne jamais déduire la database MCP depuis « l'onglet actuellement actif » (acté avec R3).
- [x] Décider si les tools utilisent `profile + database`, un identifiant de connexion immuable ou uniquement la database par défaut du profil → `profile` + `database` optionnelle, défaut = database par défaut du profil (R3, validé 2026-07-16).
- [ ] Bloquer les références cross-database lorsque le scope agent ne les autorise pas.
- [ ] Plafonner aussi la taille de la réponse `get_schema` (un schéma de plusieurs milliers de tables peut dépasser le contexte d'un agent et coûter cher à sérialiser).
- [x] Définir ce que voit l'agent après `request_write` : un identifiant de demande et un statut (en attente, approuvée, rejetée, exécutée), jamais le résultat avant approbation (validé 2026-07-16, [[Decisions]] §10).
- [ ] Limiter le nombre de `request_write` en attente par client : une file saturée pousse l'humain à approuver en masse sans lire (fatigue d'approbation).

**Critère de clôture**

L'utilisateur peut répondre précisément à : « quel client peut lire quelles données ? », et modifier ou révoquer ce droit sans supprimer le profil.

### SEC-03 — Corriger les garanties read-only par moteur

> [!warning]
> Le terme « garanti » doit préciser sa portée. Une protection peut garantir l'absence de modification des tables persistantes ciblées sans garantir l'absence d'effets sur le système de fichiers, le réseau, une autre base ou la disponibilité du serveur.

#### Transverse — tous moteurs

**Risque**

`EXPLAIN` n'est pas toujours une lecture : `EXPLAIN ANALYZE` (Postgres, MySQL ≥ 8.0.18) **exécute réellement** la requête analysée, y compris ses écritures — la doc Postgres recommande explicitement de l'entourer d'un `BEGIN`/`ROLLBACK` pour les writes. Le bouton EXPLAIN « simple préfixe par dialecte » du [[Draft]] ne doit donc pas court-circuiter le classifier, et un agent peut soumettre lui-même un `EXPLAIN ANALYZE <écriture>`.

**Actions**

- [ ] Classifier `EXPLAIN ANALYZE <écriture>` comme une écriture (file de validation), jamais comme une lecture.
- [ ] Sur le chemin agent, appliquer à `EXPLAIN ANALYZE` la même protection read-only que la requête analysée.
- [ ] Pour le bouton EXPLAIN de l'UI, utiliser par défaut la forme sans exécution (`EXPLAIN` simple, plan estimé sur MS SQL) et réserver la variante « analyze » à une action distincte et étiquetée comme exécutante.

**Références**

- [PostgreSQL — EXPLAIN (« the statement is actually executed when the ANALYZE option is used »)](https://www.postgresql.org/docs/current/sql-explain.html)
- [MySQL — EXPLAIN ANALYZE](https://dev.mysql.com/doc/refman/8.4/en/explain.html)

#### MS SQL

**Risque**

`fn_my_permissions(NULL, 'DATABASE')` ne suffit pas pour déclarer un compte read-only :

- il ne recense pas toutes les permissions objet ;
- il ne vérifie pas les linked servers ;
- un compte peut exécuter une procédure qui écrit via ownership chaining ;
- une fonction CLR peut accéder aux fichiers, au réseau, aux web services ou à d'autres bases.

Le trou résiduel ne se limite donc pas aux extended stored procedures `xp_...`.

**Actions**

- [ ] Retirer le badge « garanti » fondé uniquement sur `fn_my_permissions(NULL, 'DATABASE')`.
- [ ] Vérifier les permissions `SERVER`, `DATABASE`, `SCHEMA` et `OBJECT` pertinentes.
- [ ] Détecter les droits `EXECUTE`, `CONTROL`, `IMPERSONATE` et les accès externes.
- [ ] Détecter la présence de CLR ou d'objets externes utilisables par le compte.
- [ ] Tester les permissions héritées du rôle `public`.
- [ ] Vérifier le comportement avec ownership chaining.
- [ ] Définir une matrice de tests d'attaque avant d'autoriser le badge « garanti ».
- [ ] Fermer la connexion après toute erreur ou annulation pendant `EXECUTE AS` ; ne jamais la remettre dans le pool.

**Critère de clôture**

Le badge affiché est dérivé d'une politique documentée et d'une suite de tests, pas seulement de l'absence de quatre permissions.

**Références**

- [Microsoft — fn_my_permissions](https://learn.microsoft.com/en-us/sql/relational-databases/system-functions/sys-fn-my-permissions-transact-sql?view=sql-server-ver17)
- [Microsoft — EXECUTE AS et ownership chaining](https://learn.microsoft.com/en-us/sql/t-sql/statements/execute-as-clause-transact-sql?view=sql-server-ver17)
- [Microsoft — CLR functions et accès externes](https://learn.microsoft.com/en-us/sql/relational-databases/user-defined-functions/create-clr-functions?view=sql-server-ver17)

#### MySQL

**Risque**

Une transaction `READ ONLY` empêche les modifications des tables persistantes, mais un `SELECT` peut avoir d'autres effets. Par exemple, `SELECT ... INTO OUTFILE` écrit sur le système de fichiers du serveur si le compte possède le privilège `FILE`.

**Actions**

- [ ] Rejeter `INTO OUTFILE` et `INTO DUMPFILE`.
- [ ] Rejeter les commentaires exécutables MySQL (`/*!50000 ... */`) avant classification : le serveur exécute leur contenu alors qu'un parseur générique peut les traiter comme des commentaires — un `SELECT /*! ... INTO OUTFILE */` contournerait sinon le pré-filtre.
- [ ] Rejeter les opérations de lecture ou écriture de fichiers serveur.
- [ ] Rejeter les fonctions de verrouillage ou d'attente non nécessaires.
- [ ] Vérifier l'absence du privilège `FILE` pour un profil déclaré sûr.
- [ ] Interdire les tables temporaires dans le chemin agent, même si elles sont permises par une transaction read-only.
- [ ] Conserver le badge « best-effort » tant que la sécurité dépend du compte original.

**Références**

- [MySQL — SELECT INTO OUTFILE](https://dev.mysql.com/doc/refman/8.0/en/select-into.html)
- [MySQL — Transactions READ ONLY](https://dev.mysql.com/doc/refman/8.4/en/commit.html)

#### PostgreSQL

**Actions**

- [ ] Garder la mention « quasi-garanti » ou « best-effort renforcé », jamais « garanti », avec un compte writable.
- [ ] Définir le traitement des fonctions `SECURITY DEFINER`, fonctions C et extensions.
- [ ] Utiliser un rôle réellement restreint lorsque l'utilisateur veut une garantie moteur.
- [ ] Interdire les accès externes et fonctions privilégiées connues dans le chemin agent.
- [ ] Appliquer des timeouts de statement et de lock au niveau de la session agent.
- [ ] Rejeter `SET`/`RESET` sur le chemin agent : ces statements restent permis dans une transaction READ ONLY, et un `RESET statement_timeout` seul suffirait à annuler les limites de session.
- [ ] Rejeter `COPY` sur le chemin agent : `COPY ... TO/FROM` peut lire ou écrire des fichiers côté serveur (ou exécuter un programme) si le rôle a les privilèges `pg_read_server_files`/`pg_write_server_files`/`pg_execute_server_program`.

**Référence**

- [PostgreSQL — SET TRANSACTION](https://www.postgresql.org/docs/current/sql-set-transaction.html)

#### SQLite

**Actions**

- [ ] Ouvrir la base cible avec `SQLITE_OPEN_READONLY`.
- [ ] Installer l'authorizer avant toute préparation de statement.
- [ ] Refuser `ATTACH`, `DETACH`, les écritures, les PRAGMA dangereux et les fonctions non autorisées.
- [ ] Désactiver le chargement d'extensions.
- [ ] Désactiver l'ouverture en écriture des bases attachées au niveau de la configuration SQLite.
- [ ] Ne jamais utiliser la connexion de la SQLite interne de l'application pour exécuter du SQL utilisateur.
- [ ] Définir le badge comme « base cible non modifiable », sans promettre l'absence d'effets de fonctions natives ou custom.

**Références**

- [SQLite — Authorizer](https://www.sqlite.org/c3ref/set_authorizer.html)
- [SQLite — Configuration ATTACH](https://www.sqlite.org/c3ref/c_dbconfig_defensive.html)

### SEC-04 — Définir la sécurité TLS et SSH

**Risque**

La présence de TLS ou d'un tunnel SSH ne protège pas contre un MITM si les certificats et clés hôtes ne sont pas vérifiés correctement.

**Actions TLS**

- [ ] Vérifier le hostname du serveur.
- [ ] Vérifier la chaîne de certificats par défaut.
- [ ] Permettre l'ajout explicite d'une CA custom.
- [ ] Refuser le mode `trust all` par défaut.
- [ ] Afficher un avertissement persistant si la vérification est désactivée.
- [ ] Stocker les certificats et clés client sensibles comme des secrets.
- [ ] Définir les versions minimales de TLS acceptées.

**Actions SSH**

- [ ] Utiliser `known_hosts` ou un stockage équivalent.
- [ ] Présenter la fingerprint lors de la première connexion.
- [ ] Échouer si la clé hôte change.
- [ ] Ne jamais accepter silencieusement une nouvelle clé.
- [ ] Désactiver l'agent forwarding par défaut.
- [ ] Ne pas envoyer les clés privées au frontend.
- [ ] Définir les permissions de fichiers acceptées pour une clé privée.

**Critère de clôture**

Une interception TLS ou un changement de clé SSH provoque un échec visible, jamais une connexion silencieuse.

## P1 — Risques élevés

### SEC-05 — Rendre les approbations immuables

**Risque**

Une approbation peut devenir invalide si le SQL, les paramètres ou la connexion changent entre l'affichage et l'exécution. L'estimation des lignes affectées est également indéfinie pour certains DDL et requêtes complexes.

**Actions**

- [ ] Créer un identifiant immuable pour chaque demande.
- [ ] Lier l'approbation au hash du SQL et des paramètres.
- [ ] Lier l'approbation à :
  - [ ] l'identifiant du profil ;
  - [ ] hostname et port ;
  - [ ] base et schéma ;
  - [ ] utilisateur DB ;
  - [ ] configuration TLS/SSH ;
  - [ ] client MCP d'origine.
- [ ] Rendre l'approbation à usage unique et avec expiration.
- [ ] Invalider l'approbation si le profil ou le SQL change.
- [ ] Invalider l'approbation après une reconnexion ou un changement de database.
- [ ] Afficher l'origine : humain, UI générée ou client MCP identifié.
- [ ] Afficher l'environnement sans dépendre uniquement d'une couleur.
- [ ] Afficher le SQL exactement tel qu'il sera exécuté (les mêmes octets que ceux couverts par le hash), sans troncature silencieuse — une requête très longue doit scroller, pas être coupée.
- [ ] Signaler visuellement les caractères invisibles ou trompeurs dans le SQL affiché : contrôles bidirectionnels (U+202E et famille, attaque type « Trojan Source »), zero-width, homoglyphes non-ASCII dans les identifiants.
- [ ] Ajouter une confirmation renforcée pour la production et les opérations destructrices.
- [ ] Définir ce que signifie « estimation des lignes » pour chaque moteur.
- [ ] Ne pas exécuter de requête à effets de bord pour produire cette estimation.
- [ ] Pour le DDL, afficher les objets affectés et le niveau de risque plutôt qu'une estimation artificielle.
- [ ] Vérifier que les écritures tapées manuellement ne peuvent pas contourner le mode read-only activé sur le profil.

**Critère de clôture**

Le backend peut démontrer que le statement exécuté est exactement celui qui a été approuvé, sur exactement la même cible.

### SEC-06 — Isoler les sessions et limiter les ressources

**Risque**

Une requête de lecture peut provoquer un déni de service, conserver un verrou, allouer trop de mémoire ou laisser un état de session réutilisé par une autre requête.

**Actions**

- [ ] Utiliser un pool ou des connexions distinctes pour les agents.
- [x] Mettre le statement timeout configurable dans le scope v1.
- [ ] Définir un timeout maximal non désactivable pour les clients MCP.
- [ ] Appliquer un lock timeout.
- [x] Mettre le plafond de lignes MCP dans le scope v1.
- [ ] Appliquer le plafond dans le backend avant sérialisation complète du résultat.
- [ ] Limiter le nombre maximal d'octets retournés.
- [ ] Limiter le nombre de requêtes concurrentes par profil et client.
- [ ] Streamer les résultats avec une mémoire bornée.
- [x] Mettre l'annulation de requête dans le scope v1.
- [ ] Annuler réellement la requête côté driver lors d'une annulation UI ou MCP.
- [ ] Fermer les connexions dont l'état de transaction ou d'impersonation est incertain.
- [ ] Nettoyer l'état de session avant réutilisation.
- [ ] Définir le comportement pour les requêtes contenant attente, verrou explicite ou récursion excessive.
- [ ] Distinguer le `LIMIT` implicite de navigation de table des requêtes libres et MCP : il ne protège pas automatiquement un agrégat, un produit cartésien ou une fonction coûteuse.
- [ ] Lors d'une reconnexion automatique :
  - [ ] revérifier TLS et la clé hôte SSH ;
  - [ ] revérifier le mode read-only effectif ;
  - [ ] recréer les timeouts et paramètres de session ;
  - [ ] invalider les requêtes ou approbations liées à l'ancienne session ;
  - [ ] ne jamais fallback silencieusement vers une connexion moins sécurisée.

**Critère de clôture**

Une requête volontairement lente ou produisant un résultat massif ne peut pas bloquer durablement l'application ou épuiser sa mémoire.

### SEC-07 — Durcir la frontière Tauri WebView/Rust

**Risque**

Les données affichées depuis une base sont non fiables. Une valeur contenant du HTML, du Markdown, une URL ou un message d'erreur peut devenir un vecteur XSS. Une XSS dans un WebView Tauri est critique si elle donne accès à des commandes IPC puissantes.

**Actions**

- [ ] Configurer une CSP stricte.
- [ ] Ne charger aucun script distant.
- [ ] Définir des capabilities Tauri minimales par fenêtre.
- [ ] Ne jamais activer l'accès IPC pour du contenu distant.
- [ ] Valider chaque argument de commande dans le backend Rust.
- [ ] Ne pas exposer de commande générique permettant de contourner le classifier et la file de validation.
- [ ] Ne jamais envoyer un credential ou une clé au frontend.
- [ ] Éviter tout rendu HTML brut.
- [ ] Sanitiser le Markdown et les liens éventuels.
- [ ] Ouvrir les liens externes via une allowlist explicite.
- [ ] Traiter les erreurs driver comme du texte, pas comme du contenu HTML.

**Références**

- [Tauri — Security](https://v2.tauri.app/security/)
- [Tauri — Content Security Policy](https://v2.tauri.app/security/csp/)
- [Tauri — Capabilities](https://v2.tauri.app/security/capabilities/)

### SEC-08 — Compléter le stockage des secrets

**Risque**

Le chiffrement des passwords ne couvre pas automatiquement les requêtes sauvegardées, l'historique, les onglets persistés, les URLs de connexion, les exports ou les logs. Une requête SQL peut elle-même contenir un secret.

Les détails nécessaires à une utilisation sûre d'AES-GCM ne sont pas encore définis.

**Actions**

- [ ] Définir un format versionné pour les données chiffrées.
- [ ] Générer un nonce unique pour chaque chiffrement.
- [ ] Utiliser l'identifiant du profil et le type du secret comme données authentifiées.
- [ ] Étendre les données authentifiées aux champs de cible du profil (host, port, user, mode TLS) : les champs non chiffrés de la SQLite locale sont modifiables par tout process du même utilisateur, et sans cette liaison un attaquant local pourrait rediriger le host vers son propre serveur pour récolter le password au prochain connect. Avec l'AAD, toute altération de la cible fait échouer le déchiffrement au lieu d'envoyer le secret ailleurs.
- [ ] Effacer les buffers contenant des secrets après usage (crate `zeroize`).
- [ ] Définir le format d'export de profils : jamais de secrets par défaut ; si l'utilisateur demande un export avec secrets, chiffrement par passphrase dédiée — jamais la clé maîtresse, qui ne quitte pas le Keychain.
- [ ] Définir la rotation et la migration de la clé maîtresse.
- [ ] Définir le comportement si la clé Keychain est perdue.
- [ ] Créer le fichier SQLite avec des permissions restrictives.
- [ ] Ne jamais persister une URL de connexion brute contenant un password.
- [ ] Redacter les connection strings et credentials dans tous les logs.
- [ ] Vérifier les logs produits par les drivers Rust.
- [ ] Définir une politique pour l'historique SQL :
  - [ ] chiffrement ;
  - [ ] durée de rétention ;
  - [ ] suppression manuelle ;
  - [ ] désactivation par profil ;
  - [ ] mode privé pour la production.
- [ ] Définir si les crash reports ou la télémétrie sont autorisés à contenir du SQL ou des résultats.
- [ ] Garder les secrets exclusivement dans le process Rust et réduire leur durée de vie en mémoire.

**Critère de clôture**

Une inspection de la SQLite locale, des logs et des crash reports ne révèle ni credential, ni URL secrète, ni SQL sensible lorsque la politique du profil l'interdit.

### SEC-09 — Sécuriser l'édition de données

**Risque**

Un UPDATE ou DELETE généré depuis une ligne sans identité stable peut modifier plus de lignes que prévu. Une modification concurrente peut aussi rendre le SQL affiché obsolète.

**Actions**

- [ ] Exiger une clé primaire ou une contrainte unique stable pour l'édition et la suppression.
- [ ] Désactiver ces opérations lorsqu'aucune identité sûre n'existe.
- [ ] Utiliser des paramètres pour toutes les valeurs.
- [ ] Échapper les identifiants avec les règles du dialecte.
- [ ] Utiliser de l'optimistic concurrency avec les valeurs originales ou une colonne de version.
- [ ] Définir le nombre exact de lignes attendu.
- [ ] Rollback et erreur si le nombre de lignes affectées diffère.
- [ ] Afficher les anciennes et nouvelles valeurs lors de la validation.
- [ ] Ajouter une confirmation renforcée pour suppression, changement de type ou suppression de colonne.

**Critère de clôture**

Une édition de ligne ne peut pas se transformer silencieusement en modification de plusieurs lignes.

### SEC-10 — Définir la stratégie de release

**Risque**

Une distribution non signée habitue l'utilisateur à contourner Gatekeeper et ne garantit pas la provenance du binaire. Le [[Draft]] demande une CI par release, alors que [[Decisions]] parle de builds ad hoc.

**Actions**

- [x] Décider si la v1 est strictement réservée à la machine du développeur → oui (P12, validé 2026-07-16).
- [x] Réconcilier la décision « CI par release » avec « builds ad hoc » → la CI signée/notarisée est le prérequis de la première distribution externe, pas de la v1 locale (reporté dans [[Draft]]).
- [ ] Interdire la distribution publique avant signature et notarisation.
- [ ] Utiliser les signatures d'artefacts de l'updater Tauri.
- [ ] Stocker les clés de signature hors du dépôt.
- [ ] Épingler les GitHub Actions par SHA.
- [ ] Commiter les lockfiles Rust et frontend.
- [ ] Ajouter les audits de dépendances à la CI.
- [ ] Définir une procédure de rotation ou compromission des clés de signature.

**Références**

- [Tauri — Distribution](https://v2.tauri.app/distribute/)
- [Tauri — Updater et signatures](https://v2.tauri.app/fr/plugin/updater/)

## P2 — Durcissements complémentaires

### SEC-11 — Sécuriser les imports, exports et le presse-papiers

**Actions**

- [ ] Neutraliser les cellules CSV commençant par `=`, `+`, `-` ou `@` pour les exports destinés à un tableur.
- [ ] Définir si l'utilisateur peut demander un export CSV brut non neutralisé.
- [ ] Créer les exports avec des permissions restrictives.
- [ ] Nettoyer les fichiers temporaires.
- [ ] Ne pas suivre silencieusement un symlink lors d'un export.
- [ ] Limiter la taille des imports et exports.
- [ ] Parser une URL de connexion sans la conserver ou la logger en entier.
- [ ] Masquer le password lors de la prévisualisation d'une URL.
- [ ] Afficher un avertissement avant copie de données sensibles dans le presse-papiers.
- [ ] Réserver les exports locaux à l'UI humaine, pas aux tools MCP en v1.

### SEC-12 — Formaliser le threat model et l'audit

**Actions**

- [ ] Définir les attaquants considérés :
  - [ ] client MCP malveillant ;
  - [ ] données DB malveillantes ;
  - [ ] serveur DB malveillant ou compromis ;
  - [ ] attaquant réseau ;
  - [ ] processus local du même utilisateur ;
  - [ ] dépendance ou build compromis.
- [ ] Définir explicitement ce qui est hors scope.
- [ ] Journaliser les accès agent sans enregistrer les secrets ou résultats complets.
- [ ] Inclure dans l'audit :
  - [ ] client MCP ;
  - [ ] profil et fingerprint de connexion ;
  - [ ] type de requête ;
  - [ ] heure, durée et volume retourné ;
  - [ ] approbation ou rejet ;
  - [ ] utilisateur ayant approuvé.
- [ ] Ajouter une fonction de purge et d'export de l'audit.
- [ ] Définir la durée de rétention.

## Ordre de traitement recommandé

1. [ ] Écrire le threat model et définir précisément la portée du mot « garanti ».
2. [ ] Décider du transport MCP, de l'appairage et des scopes.
3. [ ] Corriger la matrice read-only des quatre moteurs.
4. [ ] Définir les invariants de la file d'approbation.
5. [ ] Définir TLS, SSH et le stockage des secrets.
6. [ ] Définir l'isolation des connexions et les limites de ressources.
7. [ ] Définir la frontière IPC Tauri.
8. [ ] Définir l'édition sûre des lignes et du schéma.
9. [ ] Définir la stratégie de release.
10. [ ] Traiter les imports, exports, logs et l'audit.

## Questions à trancher

Toutes tranchées le 2026-07-16 — décisions consolidées dans [[Decisions]] §10.

- [x] Quel transport MCP sera utilisé ? → socket Unix + proxy stdio.
- [x] Quels clients pourront se connecter et comment seront-ils appairés ? → appairage par token (hash stocké côté app) avec approbation UI ; process same-user hors threat model confidentialité (R2).
- [x] L'accès agent sera-t-il limité par profil, schéma ou table ? → par couple (profil, database) avec allowlist ; scopes plus fins prévus dans le modèle de config, post-v1 (R3).
- [x] Les profils production pourront-ils être exposés aux agents ? → opt-in explicite uniquement ; passage en production = désactivation auto + invalidation des approbations (P4).
- [x] Le badge « garanti » couvre-t-il uniquement la modification de la base cible ? → oui, formulation actée ; affichage réservé à SQLite et MS SQL `EXECUTE AS` après matrice de tests (P5 + R5).
- [x] Les agents utiliseront-ils des connexions et pools dédiés ? → oui, pool dédié par profil, 2 connexions max (P6).
- [x] Quelles règles exactes seront appliquées pour TLS et SSH ? → vérification complète par défaut, accès agent ⇒ TLS vérifié, TOFU SSH avec échec dur, agent forwarding non implémenté (P7 + R7).
- [x] L'historique SQL sera-t-il chiffré, redacted ou désactivable ? → chiffré (clé maîtresse), désactivable par profil, désactivé par défaut en production ; résultats jamais persistés (P8 + R8).
- [x] Quelle est la durée de rétention des historiques et audits ? → 90 jours / 180 jours, configurables, purge au démarrage + quotidienne (P9).
- [x] Comment l'approbation sera-t-elle liée à la requête et à la cible exactes ? → hash SHA-256 sur sérialisation canonique, demandes en mémoire uniquement, usage unique, 5 min (P10 + R10).
- [x] Quel comportement pour les tables sans clé primaire ou contrainte unique ? → lecture seule avec raison affichée ; une contrainte unique nullable ne qualifie pas (P11 + R11).
- [x] La v1 sera-t-elle distribuée à d'autres machines avant signature ? → non, machine du développeur uniquement (P12).

## Propositions de résolution (2026-07-16)

Réponses recommandées aux questions ci-dessus, à valider avant report dans [[Decisions]]. Chaque proposition privilégie le défaut le plus sûr, avec opt-in explicite pour assouplir.

1. **Transport MCP** : socket Unix + binaire proxy stdio (voir proposition SEC-01). Aucun port TCP en v1.
2. **Appairage** : à la première connexion d'un proxy, dialogue d'approbation dans l'app (nom déclaré du client, UID vérifié) ; token persistant par client, listé et révocable dans Settings.
3. **Scope agent v1** : par profil uniquement, flag « accès agent » **désactivé par défaut** (inverse la décision actuelle de [[Decisions]] §4). Le modèle de config doit prévoir dès la v1 les scopes plus fins (schéma, table) même s'ils ne sont pas implémentés.
4. **Profils production** : jamais exposés aux agents par défaut. Champ « environnement » sur le profil ; exposer un profil production exige une confirmation dédiée et reste signalé en permanence dans l'UI.
5. **Portée du badge « garanti »** : « le moteur refuse toute modification des données persistantes de la base cible ». Il ne couvre ni le système de fichiers du serveur, ni le réseau, ni une autre base, ni la disponibilité — formulation reprise telle quelle dans le tooltip du badge.
6. **Connexions agent** : pool dédié par profil (2 connexions max), jamais partagé avec l'UI ; toute connexion dont l'état est incertain (annulation, erreur pendant impersonation) est fermée, pas réutilisée.
7. **TLS/SSH** : TLS avec vérification complète (chaîne + hostname) par défaut, minimum TLS 1.2, CA custom possible par profil ; désactiver la vérification est un toggle par profil avec avertissement persistant. SSH : trust-on-first-use avec affichage de la fingerprint, échec dur si la clé hôte change.
8. **Historique SQL** : chiffré dans la SQLite locale avec la clé maîtresse existante, désactivable par profil, purge manuelle globale ; désactivé par défaut sur les profils marqués production.
9. **Rétention** : 90 jours pour l'historique, 180 jours pour l'audit agent, tous deux configurables.
10. **Approbations** : identifiant unique + hash SHA-256 couvrant SQL, paramètres et fingerprint complète de la cible (profil, host, port, database, user DB, config TLS/SSH, client d'origine) ; usage unique, expiration 5 minutes, invalidées par reconnexion, changement de database ou édition du profil (détail en SEC-05).
11. **Tables sans clé primaire ni contrainte unique** : édition et suppression désactivées en v1, sans fallback `ctid`/`rowid` (comportements subtils et non portables).
12. **Distribution v1** : machine du développeur uniquement. Toute distribution externe attend la CI qui signe et notarise (SEC-10) ; cela résout aussi la contradiction Draft/Decisions — la « CI par release » devient le prérequis de la première distribution, pas de la v1 locale.

## Validation des propositions v1 (historique)

L'évaluation ci-dessous distingue la validité de la **réponse proposée** de la clôture complète du constat de sécurité associé.

| # | Proposition | Verdict | Ajustements nécessaires |
| --- | --- | --- | --- |
| 1 | Socket Unix + proxy stdio | ✅ Validée | `rmcp` accepte un transport basé sur `AsyncRead`/`AsyncWrite` avec la feature `transport-async-rw`, donc une `UnixStream` est compatible. Ajouter un dossier parent `0700`, créer la socket sans suivre de symlink et supprimer uniquement une socket appartenant à l'utilisateur courant. |
| 2 | Appairage par client | 🟠 Validable après ajustements | L'UID authentifie l'utilisateur macOS, pas le client : tous les process du même utilisateur partagent cet UID. Stocker le token côté app dans le Keychain ou la SQLite chiffrée, limiter les demandes d'appairage et expliciter si un process malveillant du même utilisateur est hors threat model. |
| 3 | Scope agent par profil | ❌ Non validée en l'état | Un profil ne délimite pas forcément une database : MySQL/MS SQL voient plusieurs databases et les requêtes cross-database restent possibles. En v1, utiliser au minimum `profile + database`, ou limiter formellement les tools à la database par défaut et rejeter les références cross-database. |
| 4 | Protection des profils production | ✅ Validée comme garde-fou UX | Ce champ ne constitue pas une barrière moteur. Quand un profil passe en production, désactiver automatiquement son accès agent, invalider les approbations en attente et exiger une nouvelle activation explicite. |
| 5 | Portée du badge « garanti » | 🟠 Formulation validée, mécanisme non validé | Le tooltip proposé est honnête. Il ne corrige toutefois pas la sonde MS SQL fondée sur `fn_my_permissions`, ni les protections MySQL/Postgres encore incomplètes. Ne pas afficher le badge avant correction de SEC-03. |
| 6 | Pool agent dédié | ✅ Validée pour l'isolation | Deux connexions maximum est un défaut raisonnable. Il reste à imposer les timeouts, plafonds d'octets, nettoyage de session et réinitialisation complète après reconnexion. |
| 7 | TLS complet + SSH TOFU | 🟠 Validable après ajustements | Ajouter import/usage de `known_hosts`, désactiver l'agent forwarding, définir le stockage des clés privées et décider si un profil production ou exposé aux agents peut désactiver la vérification TLS. |
| 8 | Historique SQL chiffré | 🟠 Partiellement validée | Bonne solution pour l'historique. Étendre la politique aux requêtes sauvegardées, onglets persistés et éventuels résultats mis en cache. Conserver nonce unique, AAD, format versionné et stratégie de perte/rotation de clé. |
| 9 | Rétention 90/180 jours | ✅ Validée comme politique par défaut | Préciser le job de purge, le comportement lors d'une modification de durée et les données exactes contenues dans l'audit. Ne jamais auditer les résultats complets ou credentials. |
| 10 | Approbation liée par SHA-256 | 🟠 Validable après ajustements | Sérialiser canoniquement les champs avant hash, conserver la demande immuable en mémoire ou utiliser un HMAC si elle est persistée, et invalider toutes les demandes au redémarrage de l'app. L'exécution doit relire les mêmes octets et paramètres. |
| 11 | Pas d'édition sans clé stable | 🟠 Règle validée, SEC-09 encore ouvert | Refuser aussi une contrainte unique contenant une valeur `NULL` si elle ne garantit pas l'unicité sur le moteur concerné. Les lignes éditables doivent encore utiliser paramètres, optimistic concurrency et `affected_rows == 1`. |
| 12 | V1 locale uniquement | ✅ Validée | Reporter explicitement la décision dans [[Draft]] : la CI signée/notarisée devient un prérequis de toute première distribution externe, pas une exigence de la v1 locale. |

**Références complémentaires**

- [rmcp — transports `AsyncRead`/`AsyncWrite`](https://docs.rs/rmcp/latest/rmcp/transport/index.html)
- [PostgreSQL — `EXPLAIN ANALYZE` exécute la requête](https://www.postgresql.org/docs/current/sql-explain.html)
- [SQL Server — `SET SHOWPLAN_XML` doit être seul dans son batch](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-showplan-xml-transact-sql?view=sql-server-ver17)
- [SQLite — limites de stabilité du format EXPLAIN](https://sqlite.org/lang_explain.html)

## État global avant retours v2 (historique)

| Constat | État | Avis |
| --- | --- | --- |
| SEC-01 — Transport et authentification MCP | 🟠 Partiellement validé | Le transport est bon et techniquement faisable. L'identité réelle du client, le stockage du token, le rate limit d'appairage et le threat model same-user restent à fixer. |
| SEC-02 — Portée de l'accès agent | 🟠 Partiellement validé | Default-off, production opt-in et plafond de lignes sont bons. La cible database, les accès cross-database, le plafond d'octets et les scopes de `get_schema` restent ouverts. |
| SEC-03 — Garanties read-only | ❌ Non validé | La portée du badge est mieux formulée, mais les mécanismes MS SQL, MySQL, Postgres et EXPLAIN ne sont pas encore corrigés dans [[Decisions]]. |
| SEC-04 — TLS et SSH | 🟠 Partiellement validé | Les defaults proposés sont bons. Clés privées, `known_hosts`, agent forwarding et profils autorisés à désactiver TLS restent à décider. |
| SEC-05 — Approbations immuables | 🟠 Presque validé | La proposition couvre correctement la cible et l'expiration. Ajouter canonicalisation, HMAC ou stockage mémoire, invalidation au redémarrage et affichage exact des octets. |
| SEC-06 — Sessions et ressources | 🟠 Partiellement validé | Pool dédié, limite de connexions, timeout, plafond de lignes et annulation sont de bonnes réponses. Les limites d'octets, lock timeout, streaming borné et garanties de reconnexion restent ouvertes. |
| SEC-07 — Frontière Tauri | ❌ Non validé | Aucun choix sur CSP, capabilities, contenu distant, rendu de données DB ou validation IPC n'est encore reporté dans les plans. |
| SEC-08 — Stockage des secrets | 🟠 Partiellement validé | Historique chiffré et production opt-out sont bons. Le format AES-GCM, les autres contenus persistés, les logs, exports et la perte de clé restent ouverts. |
| SEC-09 — Édition de données | 🟠 Partiellement validé | Le refus sans clé stable est validé. La concurrence, la paramétrisation, les clés nullable et le contrôle du nombre de lignes restent ouverts. |
| SEC-10 — Releases | ✅ Validable après report | La stratégie « v1 locale, distribution seulement après signature » est cohérente. Il faut encore mettre [[Draft]] en accord avec [[Decisions]]. |
| SEC-11 — Imports et exports | ❌ Non validé | Aucune proposition ne couvre encore CSV injection, fichiers temporaires, permissions, symlinks ou secrets dans les URLs importées. |
| SEC-12 — Threat model et audit | 🟠 Partiellement validé | La rétention est définie, mais pas les attaquants inclus/hors scope, le contenu exact de l'audit, sa purge ni son export. |

> [!summary] Conclusion
> Je valide complètement les propositions **1, 4, 6, 9 et 12** dans leur périmètre. Les propositions **2, 5, 7, 8, 10 et 11** sont bonnes mais nécessitent les ajustements listés. La proposition **3** doit être revue avant validation, car le scope « profil » ne correspond pas au nouveau modèle multi-database.

## Propositions révisées (2026-07-16, v2)

Réponses aux ajustements demandés dans « Validation des propositions ». Les propositions validées (1, 4, 6, 9, 12) ne sont pas répétées ; leurs compléments sont regroupés en fin de section.

> [!success] Validation du 2026-07-16
> R2 (threat model same-user) et R3 (scope profil + database) arbitrés explicitement et validés ; le reste de la v2 validé en bloc. Décisions structurantes reportées dans [[Decisions]] §10, précision distribution reportée dans [[Draft]].

### R2 — Appairage : identité du client et threat model same-user

Position de threat model à acter : **un process malveillant s'exécutant sous le même utilisateur macOS est hors scope pour la confidentialité**. Un tel process peut de toute façon lire la config MCP du client (où le token doit vivre) et l'espace utilisateur entier. L'appairage ne prétend donc pas authentifier cryptographiquement un binaire ; il sert à distinguer les clients légitimes entre eux, à tracer leurs accès par client et à les révoquer individuellement.

Mécanisme :

- Token de 32 octets aléatoires généré à l'appairage ; l'app n'en stocke que le **hash SHA-256** dans la SQLite locale — le vol du fichier ne donne pas le token utilisable.
- Côté client, le token vit dans la config MCP (variable d'environnement du proxy), en clair — assumé par le threat model ci-dessus.
- Le dialogue d'appairage affiche le nom déclaré du client, le PID et le **chemin de l'exécutable** du pair (via `LOCAL_PEERPID` sur la socket puis `proc_pidpath`) — identification utile même si non infalsifiable.
- Une seule demande d'appairage affichée à la fois, backoff après refus, toutes les demandes journalisées.

### R3 — Scope agent : « profil + database » (remplace la proposition 3)

Un accès agent est accordé par couple **(profil, database)**, jamais par profil entier.

- L'UI d'activation liste les databases visibles de la connexion avec cases à cocher ; défaut = uniquement la database par défaut du profil.
- Les tools MCP prennent `profile` + `database` optionnelle (défaut : la database par défaut du profil). Database hors allowlist → erreur générique, sans révéler l'existence des autres. Jamais de déduction depuis l'onglet actif de l'UI.
- `get_schema` et `list_profiles` ne montrent que les databases autorisées.
- Chemin agent : `USE` / changement de contexte rejeté par le parseur ; identifiants qualifiés `db.table` visant une database non autorisée rejetés (aiguillage UX, pas barrière).
- La barrière réelle reste le moteur : en mode garanti MS SQL, le user impersonné `WITHOUT LOGIN` est scopé à sa database. Sur MySQL, le blocage cross-database reste best-effort si le compte a des droits ailleurs — cohérent avec le badge affiché.
- Postgres : cross-database impossible sur une connexion ; SQLite : sans objet (`ATTACH` déjà refusé par l'authorizer).

### R5 — Badge : règle d'affichage en attendant SEC-03

Trois états : ==garanti==, best-effort, inconnu.

- « Garanti » est réservé en v1 à SQLite (flag read-only + authorizer) et au mode MS SQL `EXECUTE AS`, ce dernier **seulement après** la matrice de tests d'attaque de SEC-03.
- Postgres et MySQL restent best-effort quel que soit le résultat des sondes de permissions.
- Une sonde qui échoue ou renvoie un résultat ambigu → état « inconnu » et accès agent refusé (fail-closed).

### R7 — TLS/SSH : décisions restantes

- Store de clés hôtes SSH propre à l'app (SQLite locale), avec bouton « importer depuis `~/.ssh/known_hosts` » en lecture seule — l'app n'écrit jamais dans les fichiers SSH de l'utilisateur.
- Clés privées SSH référencées par chemin (jamais copiées), permissions `0600` exigées ; la passphrase est soit stockée comme secret AES-GCM, soit demandée à l'usage, au choix de l'utilisateur.
- Agent forwarding : **non implémenté** en v1 — pas une option désactivée, le code n'existe pas.
- Règle : **accès agent ⇒ vérification TLS active** (ou connexion locale : SQLite, tunnel SSH à clé hôte vérifiée). Un profil dont la vérification TLS est désactivée ne peut pas être exposé aux agents.
- Profil production avec TLS non vérifié : autorisé pour l'humain mais confirmation bloquante à chaque connexion, en plus de l'avertissement persistant.

### R8 — Périmètre du chiffrement local

Trois catégories de données persistées, chacune avec sa règle :

1. **Secrets** (passwords, passphrases, tokens d'appairage) : AES-GCM, AAD liée à la cible de connexion (voir SEC-08).
2. **Contenus sensibles** (historique, requêtes sauvegardées, contenu des onglets persistés) : chiffrés avec la clé maîtresse, AAD = type d'enregistrement + identifiant, même format versionné.
3. **Résultats de requêtes : jamais persistés sur disque en v1.** L'infinite scroll garde les données en mémoire uniquement — la question du cache de résultats disparaît par construction.

### R10 — Approbations : cycle de vie concret

- Les demandes d'écriture vivent **uniquement en mémoire du process Rust**, dans une structure immuable, jamais persistées → un redémarrage de l'app les invalide par construction (l'agent reçoit « demande expirée : application redémarrée »).
- Sérialisation canonique avant hash : champs dans un ordre fixe, chacun préfixé par sa longueur — version du format, profil, host, port, database, user DB, fingerprint TLS/SSH, client d'origine, octets SQL, puis paramètres en séquence préfixée — SHA-256 du tout.
- À l'exécution : relecture de la structure immuable, recalcul du hash, comparaison avec le hash approuvé ; ce sont ces octets-là qui partent au driver.
- Pas de HMAC nécessaire tant que rien n'est persisté ; si la file devait un jour survivre au redémarrage, passer à un HMAC avec clé dérivée de la clé maîtresse.

### R11 — Identité de ligne : règle resserrée

Une ligne est éditable si la table a une clé primaire, ou à défaut une contrainte unique dont **toutes les colonnes sont NOT NULL**. Une contrainte unique nullable ne qualifie pas — la sémantique des NULL diverge selon les moteurs (Postgres accepte plusieurs NULL, MS SQL un seul par index unique). Sinon : table en lecture seule, avec la raison affichée dans l'UI.

### Compléments aux propositions validées

- **P1** : dossier parent de la socket en `0700`, création sans suivre de symlink, suppression restreinte à une socket appartenant à l'utilisateur courant — ajoutés aux actions SEC-01.
- **P4** : le passage d'un profil en « production » désactive automatiquement son accès agent, invalide ses approbations en attente et exige une réactivation explicite.
- **P9** : purge au démarrage puis quotidienne pendant l'exécution ; raccourcir la rétention déclenche une purge immédiate après confirmation. L'audit ne contient jamais résultats ni credentials ; pour un profil dont l'historique est désactivé, l'audit ne stocke que le hash du SQL et les métadonnées (client, cible, durée, volume, décision).

## Validation des retours v2

### Verdict par retour

| Retour | Verdict | Avis |
| --- | --- | --- |
| R2 — Appairage et threat model same-user | ✅ Validé | Le périmètre est maintenant honnête : l'UID et le chemin servent à l'identification UX et à l'audit, pas à promettre une identité cryptographique. Un token aléatoire de 32 octets peut être stocké sous forme de hash SHA-256 côté app. |
| R3 — Scope `(profil, database)` | 🟠 Validé sauf MySQL | La cible explicite et l'absence de dépendance à l'onglet actif sont bonnes. Sur MySQL, l'allowlist applicative n'est pas une barrière de confidentialité si le compte possède des droits globaux ou sur d'autres databases : le serveur applique les privilèges réels du compte, indépendamment de la database par défaut. |
| R5 — Badge et état `inconnu` | ✅ Validé comme règle d'affichage | Réserver `garanti` à SQLite et au mode MS SQL testé, garder Postgres/MySQL en best-effort et refuser l'accès agent sur une sonde ambiguë est cohérent. Les anciens paragraphes contradictoires de [[Decisions]] §5 doivent toutefois être supprimés. |
| R7 — TLS/SSH | 🟠 Non validé pour tous les tunnels | Les décisions TLS, `known_hosts`, clés privées et absence d'agent forwarding sont bonnes. Un `LocalForward` SSH chiffre jusqu'au serveur SSH, puis la connexion vers la destination DB est créée depuis ce serveur. Si la DB est sur une autre machine, ce dernier segment peut rester en clair. |
| R8 — Chiffrement local | 🟠 Validable après harmonisation | Historique, requêtes sauvegardées, onglets et absence de cache résultat ferment l'essentiel du point. Il faut retirer les tokens MCP de la catégorie AES-GCM puisque seul leur hash est stocké, puis acter nonce unique, format versionné, rotation et perte de clé. |
| R10 — Cycle de vie des approbations | ✅ Validé avec précision mineure | Le stockage mémoire, l'expiration, la structure immuable et la sérialisation canonique répondent au TOCTOU. Ajouter un tag de type et un marqueur `NULL` à chaque paramètre, pas seulement sa longueur. |
| R11 — Identité de ligne | ✅ Validé | PK ou contrainte unique entièrement `NOT NULL`, optimistic concurrency et rollback si le nombre de lignes diffère constituent une règle sûre pour la v1. |
| P1 — Durcissement socket | ✅ Validé | Parent `0700`, socket `0600`, contrôle du propriétaire et protection contre les symlinks ferment le risque local dans le threat model choisi. |
| P4 — Transition vers production | ✅ Validé | La désactivation automatique de l'accès agent et l'invalidation des approbations empêchent un simple changement d'étiquette de conserver des droits dangereux. |
| P9 — Purge et audit minimal | 🟠 Validable après ajustement | Utiliser un **HMAC** dérivé de la clé maîtresse plutôt qu'un hash simple du SQL. Les requêtes courantes ont une faible entropie et peuvent être retrouvées par dictionnaire depuis un SHA-256 brut. |

### Ajustements demandés

#### A1 — Scope MySQL

Choisir explicitement une des politiques suivantes :

1. **Scope réel** : l'accès agent est autorisé seulement si les privilèges du compte MySQL sont limités aux databases cochées. L'app sonde `SHOW GRANTS` et refuse le scope strict en présence de privilèges globaux ou d'autres databases.
2. **Scope UX best-effort** : l'UI annonce clairement que la database allowlist n'est pas une frontière de confidentialité sur ce profil.
3. **Scope profil entier en v1** : pour MySQL, exposer toutes les databases accessibles au compte et ne pas promettre une restriction que le moteur n'impose pas.

La première option est recommandée. `SHOW GRANTS` doit tenir compte des rôles actifs et des privilèges globaux ; une analyse ambiguë doit échouer fermée.

Le pool agent doit également être indexé par **(profil, database)**, pas seulement par profil, pour éviter qu'un état de session ou un changement de contexte fuite entre deux scopes.

#### A2 — Tunnel SSH et chiffrement de bout en bout

Pour l'accès agent :

- exiger TLS côté DB même à travers un tunnel SSH ;
- exception seulement si la destination DB est explicitement le loopback ou une socket Unix du serveur SSH ;
- sinon afficher que le segment serveur SSH → serveur DB n'est pas couvert par le tunnel ;
- lier à l'AAD la cible SSH, la cible DB finale et le mode TLS.

#### A3 — Données cryptographiques

- tokens MCP : hash seulement, jamais déchiffrables côté app ;
- secrets DB/SSH : AES-GCM avec nonce aléatoire unique ;
- contenu sensible : format chiffré versionné distinct ;
- audit SQL sans historique : HMAC dérivé de la clé maîtresse ;
- documenter rotation, perte de clé et migration du format.

#### A4 — Paramètres approuvés

La sérialisation canonique doit inclure pour chaque paramètre :

- index ;
- type driver/dialecte ;
- marqueur `NULL` explicite ;
- longueur ;
- octets exacts.

### Contradictions à corriger dans les plans

Toutes corrigées le 2026-07-16 : signatures `(profile, database?)` et règle « pas de `COUNT(*)` automatique » dans [[Decisions]] §4 et [[Draft]], mention `rmcp` vérifiée dans §4, cascade MS SQL alignée sur §10 (best-effort renforcé, ==garanti== réservé à `EXECUTE AS` post-matrice), badge à trois états dans §5, tokens hash-only dans §10, EXPLAIN corrigé dans [[Draft]] et règles par moteur reportées dans §5.

- [[Decisions]] §4 conserve les anciennes signatures `query(profile, sql)` et `get_schema(profile)` alors que §10 impose `(profile, database)`.
- [[Decisions]] §4 promet « N lignes au total » sans définir comment obtenir le total ; ne pas lancer automatiquement un second `COUNT(*)`.
- [[Decisions]] §4 indique encore que le support socket Unix de `rmcp` reste à vérifier, alors que `transport-async-rw` accepte un flux `AsyncRead`/`AsyncWrite`.
- [[Decisions]] §5 dit encore qu'un compte MS SQL sondé par `fn_my_permissions` reçoit le badge `garanti`, contrairement à §10.
- [[Decisions]] §5 ne présente que `garanti` et `best-effort`, alors que §10 ajoute l'état `inconnu`.
- [[Decisions]] §10 classe les tokens parmi les secrets AES-GCM, alors que R2 prévoit de n'en stocker que le hash.
- [[Draft]] décrit toujours EXPLAIN comme un « simple préfixe par dialecte » : SQL Server exige un mécanisme `SHOWPLAN` spécifique, et `EXPLAIN ANALYZE` doit rester une action distincte qui exécute réellement la requête.

### État global après retours v2

| Constat | Nouvel état | Reste à faire |
| --- | --- | --- |
| SEC-01 — Transport et authentification MCP | ✅ Validé au niveau conception | Reporter P1 partout et retirer la mention `rmcp` non vérifiée. |
| SEC-02 — Portée de l'accès agent | 🟠 Partiel | Arbitrer le scope MySQL, passer les pools à `(profil, database)`, ajouter plafonds d'octets et `get_schema`. |
| SEC-03 — Garanties read-only | ❌ Toujours ouvert | Corriger les contradictions MS SQL et reporter les règles MySQL/Postgres/EXPLAIN dans [[Decisions]]. |
| SEC-04 — TLS et SSH | 🟠 Presque validé | Ajouter la règle de chiffrement DB après le serveur SSH. |
| SEC-05 — Approbations immuables | 🟠 Presque validé | Ajouter les types de paramètres et définir la politique d'estimation des lignes. |
| SEC-06 — Sessions et ressources | 🟠 Partiel | Limites d'octets, lock timeout, streaming borné, pool par database et reconnexion complète. |
| SEC-07 — Frontière Tauri | ❌ Toujours ouvert | CSP, capabilities, validation IPC et rendu des données DB restent absents des décisions. |
| SEC-08 — Stockage des secrets | 🟠 Presque validé | Harmoniser token/hash, nonce/version, rotation/perte et HMAC d'audit. |
| SEC-09 — Édition de données | 🟠 Presque validé | Reporter explicitement paramétrisation et échappement des identifiants dans [[Decisions]]. |
| SEC-10 — Releases | ✅ Validé | Décisions et Draft sont maintenant cohérents sur la distribution locale. |
| SEC-11 — Imports et exports | ❌ Toujours ouvert | CSV injection, fichiers temporaires, permissions, symlinks et URLs avec secrets. |
| SEC-12 — Threat model et audit | 🟠 Partiel | Compléter les autres attaquants du threat model, utiliser HMAC et définir export/purge de l'audit. |

**Références complémentaires**

- [MySQL — les privilèges globaux s'appliquent quelle que soit la database par défaut](https://dev.mysql.com/doc/refman/8.4/en/request-access.html)
- [MySQL — `SHOW GRANTS` et rôles actifs](https://dev.mysql.com/doc/refman/8.0/en/show-grants.html)
- [OpenSSH — `LocalForward` crée la connexion vers la destination depuis la machine distante](https://man.openbsd.org/ssh)

> [!summary] Conclusion v2
> Je valide R2, R5, R10, R11, P1 et P4. R8 et P9 demandent seulement une harmonisation cryptographique. R7 doit couvrir le dernier segment du tunnel. R3 reste le principal désaccord : sur MySQL, une allowlist applicative ne doit pas être présentée comme une frontière de confidentialité si le compte possède des droits au-delà.

## Propositions révisées (2026-07-16, v3)

Réponses aux ajustements A1–A4 et aux questions restées ouvertes (SEC-05 estimation, SEC-07, SEC-11, SEC-12). Les contradictions listées plus haut sont déjà corrigées dans [[Decisions]] et [[Draft]] — elles découlaient de décisions validées. Le reste de cette section est à valider.

### V3-1 — Scope MySQL : sonde des grants, fail-closed (répond à A1)

Politique retenue : **scope réel (option 1) par défaut, repli best-effort explicitement étiqueté (option 2) en opt-in**. Le repli est nécessaire en pratique : un compte dev typique (`root@localhost`) a tous les privilèges et rendrait sinon l'accès agent inutilisable sur MySQL local.

- À l'activation de l'accès agent sur un profil MySQL, puis à chaque (re)connexion agent : sonde `SHOW GRANTS FOR CURRENT_USER()`, complétée par les rôles actifs (`SELECT CURRENT_ROLE()` puis `SHOW GRANTS ... USING <rôles>`).
- Analyse des grants : tout privilège global (`ON *.*` au-delà de `USAGE`) ou tout privilège sur une database hors allowlist → **scope strict refusé**.
- Analyse impossible ou ambiguë (grant non parsé, proxy user, version exotique) → scope strict refusé, fail-closed.
- Refus du scope strict : l'UI explique quels grants posent problème et propose le repli — activation avec la mention permanente « allowlist non garantie sur ce profil » à côté du badge. Sans cette acceptation explicite, pas d'accès agent.
- Le même mécanisme vaut pour MS SQL en mode best-effort (sans `EXECUTE AS`) : le user impersonné du mode garanti est, lui, déjà scopé par le moteur.
- **Pools agent indexés par (profil, database)** — jamais par profil seul : aucun état de session ne peut fuiter entre deux scopes, et un changement de contexte résiduel ne survit pas à la frontière du pool. Vaut pour les trois moteurs multi-database.

### V3-2 — Tunnel SSH : chiffrement de bout en bout (répond à A2)

- Chemin agent : **TLS DB requis même à travers un tunnel SSH**. Exception uniquement si la destination configurée du tunnel est le loopback du serveur SSH (`127.0.0.0/8`, `::1`, `localhost`) ou une socket Unix de ce serveur.
- Chemin humain : autorisé sans TLS derrière un tunnel, mais l'UI affiche « segment serveur SSH → serveur DB non chiffré » tant que la destination n'est pas locale au serveur SSH.
- AAD des secrets étendue à : cible SSH (host, port, user SSH), cible DB finale (host, port) et mode TLS — la fingerprint de clé hôte n'y entre pas (c'est un état TOFU, sa rotation légitime ne doit pas casser le déchiffrement ; le changement de clé est déjà un échec dur de connexion).

### V3-3 — Architecture cryptographique (répond à A3, R8, P9)

- **Dérivation** : la clé maîtresse Keychain ne chiffre jamais directement. Trois sous-clés dérivées par HKDF-SHA-256 avec des labels distincts : `k_secrets` (AES-GCM des secrets), `k_content` (AES-GCM des contenus sensibles), `k_audit` (HMAC de l'audit).
- **Format de blob versionné** : `[version:1 octet][nonce:12 octets][ciphertext‖tag]`. AAD = version + type d'enregistrement + identifiant (+ champs de cible pour les secrets). Version inconnue → erreur claire, jamais de tentative de déchiffrement.
- **Nonce** : 96 bits aléatoires (CSPRNG de l'OS) à chaque chiffrement, y compris à chaque réécriture. Volume attendu très faible (< 10⁴ blobs) : risque de collision négligeable.
- **Tokens MCP** : hash SHA-256 simple, sans clé — 256 bits d'entropie aléatoire, un dictionnaire n'a pas de prise. Jamais chiffrés-récupérables ; token perdu = ré-appairage.
- **Audit SQL** : HMAC-SHA-256 avec `k_audit` — le SQL a une faible entropie, un hash nu se retrouve par dictionnaire.
- **Rotation** : commande manuelle dans Settings. Nouvelle clé maîtresse générée, tous les blobs rechiffrés dans une transaction SQLite, nouvelle entrée Keychain écrite avant suppression de l'ancienne ; toute interruption laisse l'ancienne clé valide. Pas de rotation automatique en v1.
- **Perte de clé** : détectée au démarrage par un blob canari. Proposition de réinitialisation : profils conservés (leurs champs sont en clair), secrets à ressaisir, historique/onglets purgés, audit conservé mais HMAC non vérifiables. Aucun escrow en v1 — documenté tel quel.

### V3-4 — Sérialisation des paramètres approuvés (répond à A4)

Chaque paramètre est sérialisé, dans l'ordre : index (u32 big-endian), tag de type driver/dialecte (chaîne préfixée par sa longueur), marqueur NULL (1 octet), longueur des octets (u64 big-endian), octets exacts de la valeur. Un paramètre NULL a le marqueur à 1 et une longueur nulle — impossible de confondre NULL, chaîne vide et absence.

### V3-5 — Estimation des lignes affectées (SEC-05)

- Jamais d'exécution ni d'effet de bord pour produire une estimation.
- Éditions stagées UI : le nombre exact est connu par construction (N lignes stagées) — affiché tel quel, et `affected_rows == N` imposé à l'exécution (rollback sinon, cf. SEC-09).
- `request_write` agent (SQL libre) : Postgres et MySQL affichent l'estimation du plan (`EXPLAIN` simple, non exécutant), étiquetée « estimation du planificateur » ; MS SQL et SQLite en v1 affichent « estimation indisponible » plus le type de statement et les objets touchés (extraits de l'AST).
- DDL : objets affectés + niveau de risque, jamais de nombre artificiel (déjà acté).

### V3-6 — Frontière Tauri (SEC-07)

- **CSP** : `default-src 'self'; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-src 'none'` — aucun host distant. `ipc:` **et** `http://ipc.localhost` sont requis dans `connect-src` pour l'IPC Tauri v2 (vérifié doc officielle 2026-07-16) ; Tauri ajoute lui-même les nonces/hashes des scripts bundlés à la compilation. `unsafe-inline` toléré uniquement pour les styles (Tailwind/shadcn), jamais pour les scripts.
- **Fenêtres** : une seule fenêtre principale, aucune URL distante jamais chargée dans une WebView. Capabilities Tauri minimales : uniquement les commandes de l'app ; pas de plugin shell ni fs génériques ; liens externes via l'opener avec allowlist de schémas (`https:` uniquement) et confirmation.
- **IPC** : commandes typées (structs serde) validées côté Rust. La classification et l'enforcement read-only s'exécutent côté Rust quel que soit l'appelant — aucune commande « execute raw » ne contourne la file, et le frontend n'envoie jamais de flag de confiance (« ceci est une lecture ») que le backend croirait.
- **Rendu** : aucune valeur DB rendue en HTML — texte React uniquement, `dangerouslySetInnerHTML` interdit par règle lint ; visionneuse JSON avec son propre renderer ; URLs des cellules non cliquables par défaut (copie), ouverture via confirmation ; erreurs driver affichées comme texte brut.

### V3-7 — Imports, exports, presse-papiers (SEC-11)

- Export CSV : neutralisation des cellules commençant par `=`, `+`, `-`, `@` (préfixe `'`) par défaut ; export brut possible via une option explicite par export, avec avertissement.
- Écriture des exports : fichier créé en `0600`, écriture atomique (fichier temporaire dans le dossier cible + rename), refus de suivre un symlink sur la destination.
- Fichiers temporaires dans le dossier de l'app, purgés au démarrage.
- Imports : taille plafonnée (défaut 1 Gio, configurable), parsing en streaming à mémoire bornée.
- URL de connexion importée : parsée côté Rust, password extrait immédiatement vers le stockage chiffré ; l'URL brute n'est jamais persistée ni loggée, la préview masque le password.
- Presse-papiers : avertissement au-delà d'un seuil de lignes (défaut 10 000).
- Tools MCP : aucun accès fichier en v1 (déjà acté en SEC-02).

### V3-8 — Threat model et audit (SEC-12)

**Attaquants en scope** : client MCP malveillant (appairé ou non) ; données DB malveillantes (injection de prompt vers l'agent, contenu piégé vers l'UI) ; serveur DB compromis (réponses protocolaires hostiles — les drivers doivent traiter les réponses comme non fiables) ; attaquant réseau (MITM sur TLS/SSH) ; accès local aux données au repos (disque volé, backup Time Machine).

**Hors scope** : process malveillant du même utilisateur pendant l'exécution (acté en R2) ; root/kernel compromis ; session déverrouillée physiquement accessible. La chaîne de build est traitée séparément par SEC-10 (lockfiles, audits de dépendances, actions épinglées par SHA).

**Audit** : table SQLite locale en append-only applicatif (aucune commande d'update/delete hors purge). Champs : client MCP, profil + database, fingerprint de cible, type de requête, HMAC du SQL (`k_audit`) + référence vers l'entrée d'historique si l'historique du profil est activé, horodatage, durée, lignes et octets retournés, décision (approbation/rejet) et son origine. Export JSON Lines depuis l'UI, avec les mêmes règles d'écriture sûre que les exports (V3-7). Purge selon la rétention actée (180 jours). Télémétrie et crash reports : désactivés par défaut, et ne peuvent jamais contenir SQL, résultats ou credentials.

### V3-9 — Sources et statut des affirmations

**Faits vérifiés sur source officielle (2026-07-16)** :

- `SHOW GRANTS [FOR user [USING role, ...]]` et les formes `FOR CURRENT_USER()` : [MySQL — SHOW GRANTS](https://dev.mysql.com/doc/refman/8.4/en/show-grants.html). `CURRENT_ROLE()` retourne les rôles actifs de la session : [MySQL — Information Functions](https://dev.mysql.com/doc/refman/8.4/en/information-functions.html).
- CSP Tauri v2 : `connect-src` doit inclure `ipc:` et `http://ipc.localhost` ; Tauri ajoute nonces/hashes des scripts bundlés à la compilation : [Tauri — CSP](https://v2.tauri.app/security/csp/).
- `EXPLAIN` sans `ANALYZE` n'exécute pas la requête, `EXPLAIN ANALYZE` l'exécute : [PostgreSQL — EXPLAIN](https://www.postgresql.org/docs/current/sql-explain.html), [MySQL — EXPLAIN](https://dev.mysql.com/doc/refman/8.4/en/explain.html). Plan estimé MS SQL via `SET SHOWPLAN_XML`, seul dans son batch : [SQL Server — SET SHOWPLAN_XML](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-showplan-xml-transact-sql?view=sql-server-ver17).
- HKDF : [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869). Nonce AES-GCM de 96 bits recommandé : [NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final). Neutralisation CSV `=`, `+`, `-`, `@` : [OWASP — CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection).
- Comportement `LocalForward` (dernier segment depuis le serveur SSH) : déjà sourcé dans la validation v2 ([OpenSSH — ssh(1)](https://man.openbsd.org/ssh)).

**À confirmer par un test à l'implémentation** (APIs macOS citées en R2, plausibles mais non testées ici) : `LOCAL_PEERPID` (sockopt `SOL_LOCAL`, `man 4 unix`) et `proc_pidpath` (libproc) pour identifier le pair de la socket.

**Choix de conception sans source externe** (défauts proposés, pas des faits) : indexation des pools par (profil, database) ; token de 32 octets ; format de blob `[version][nonce][ciphertext‖tag]` et labels HKDF ; sérialisation des paramètres (V3-4) ; blob canari ; procédure de rotation ; seuils (1 Gio d'import, 10 000 lignes presse-papiers, 90/180 jours, 5 minutes d'expiration) ; règle « TLS requis sauf loopback du serveur SSH ».

## Validation de la v3

### Verdict par proposition

| Proposition | Verdict | Avis |
| --- | --- | --- |
| V3-1 — Scope MySQL | 🟠 Validable après précision | La sonde des grants, le fail-closed et le pool `(profil, database)` sont bons. `SHOW GRANTS` ne suffit toutefois pas à garantir la provenance des données : une vue ou fonction `SQL SECURITY DEFINER` située dans une database autorisée peut lire une autre database avec les droits de son definer. |
| V3-2 — Tunnel SSH | ✅ Validée avec détails d'implémentation | La règle TLS de bout en bout ferme le risque. Pour l'exception loopback, vérifier l'adresse réellement résolue sur le serveur SSH, pas seulement la chaîne `localhost`. Lors d'un tunnel local, le driver TLS doit vérifier le hostname de la DB finale, pas `127.0.0.1`. |
| V3-3 — Architecture cryptographique | 🟠 Validable après ajustement de rotation | HKDF, séparation des sous-clés, AES-GCM versionné, HMAC et perte de clé sont cohérents. La rotation doit identifier explicitement la clé active : ajouter un `key_id` au blob ou un état transactionnel permettant de choisir sans ambiguïté entre ancienne et nouvelle clé après interruption. |
| V3-4 — Paramètres approuvés | ✅ Validée | Index, type canonique, marqueur NULL, longueur et octets exacts suppriment les ambiguïtés. Le tag de type doit être un enum interne versionné, pas une chaîne libre renvoyée par le driver. |
| V3-5 — Estimation des écritures agent | ❌ Non validée | Le plan rejetait déjà EXPLAIN/dry-run comme garantie car la planification peut évaluer des expressions ou fonctions. PostgreSQL autorise notamment la pré-évaluation de fonctions `IMMUTABLE` pendant le planning. Pour le SQL agent libre, afficher seulement type de statement, objets et « estimation indisponible » sur tous les moteurs en v1. |
| V3-6 — Frontière Tauri | 🟠 Validable après clarification du trust model | CSP, capabilities, validation Rust et rendu texte sont bons. Il reste une contradiction : le SQL humain tapé dans l'éditeur peut écrire directement, donc une commande IPC capable de l'exécuter existe nécessairement. Un WebView compromis pourrait appeler cette même commande. |
| V3-7 — Imports/exports | 🟠 Partiellement validée | Les fichiers `0600`, l'écriture atomique, le streaming et l'absence d'accès fichier MCP sont bons. Compléter la protection CSV et les limites spécifiques aux formats compressés comme XLSX. |
| V3-8 — Threat model et audit | 🟠 Partiellement validée | Le threat model est désormais suffisamment précis. L'audit n'est cependant qu'append-only au niveau applicatif : il n'est ni confidentiel ni détectablement intègre face au scénario « disque ou backup volé » pourtant déclaré en scope. |
| V3-9 — Sources et statut | ✅ Validée | La distinction faits vérifiés, tests d'implémentation et choix de conception est excellente et doit être conservée. |

### Ajustements demandés

#### V3-A1 — Définir la sémantique du scope MySQL

Choisir ce que signifie « database autorisée » :

- **scope de namespace** : l'agent peut lire tout ce qu'exposent les objets de la database autorisée, y compris les données provenant d'ailleurs via une vue ou routine `SQL SECURITY DEFINER` ;
- **scope de provenance** : aucune donnée d'une database non autorisée ne doit être accessible.

Le scope de provenance nécessite au minimum :

- refuser les vues/routines `SQL SECURITY DEFINER` en mode strict ;
- ou n'autoriser que les vues `SQL SECURITY INVOKER` dont toutes les dépendances restent dans l'allowlist ;
- traiter toute dépendance ou chemin dynamique impossible à analyser comme ambigu et échouer fermé.

Si cette analyse n'est pas souhaitée en v1, adopter explicitement le scope de namespace et le dire dans l'UI. Les vues MySQL utilisent `SQL SECURITY DEFINER` par défaut.

#### V3-A2 — Rendre la rotation récupérable

Le format doit inclure :

- un identifiant de clé ou génération ;
- un identifiant d'algorithme implicite dans la version ou explicite ;
- un état `active_key_id` dans la SQLite ;
- deux entrées Keychain distinctes pendant la rotation ;
- une procédure de reprise déterministe après chaque point d'interruption.

Séquence recommandée :

1. écrire la nouvelle clé dans le Keychain ;
2. marquer une rotation en cours ;
3. rechiffrer les blobs dans une transaction avec le nouveau `key_id` ;
4. basculer atomiquement `active_key_id` ;
5. valider la transaction ;
6. supprimer l'ancienne clé seulement après vérification complète.

#### V3-A3 — Supprimer EXPLAIN du chemin `request_write`

Pour une écriture agent libre :

- parser le statement ;
- afficher son type et les objets ciblés ;
- afficher « nombre de lignes inconnu » ;
- ne lancer ni EXPLAIN, ni dry-run, ni requête supplémentaire.

L'EXPLAIN estimé reste disponible comme action humaine distincte dans l'éditeur. Il n'est pas utilisé automatiquement lors d'une demande d'écriture agent.

#### V3-A4 — Clarifier la confiance accordée au WebView

Deux choix cohérents :

1. **WebView considéré comme trusted UI** : une compromission du code frontend bundlé est hors scope ; les protections CSP/rendu texte empêchent les données DB de devenir du code, mais le backend accepte qu'un frontend compromis puisse agir comme l'humain.
2. **WebView non fiable jusque dans l'intention humaine** : toute écriture, même tapée dans l'éditeur, nécessite une confirmation native ou passe par la file de validation.

La v3 mélange actuellement les deux modèles. Le premier est pragmatique pour une app desktop, mais doit être écrit explicitement dans le threat model.

#### V3-A5 — Compléter imports et exports

CSV :

- couvrir aussi tabulation, retour chariot, saut de ligne et variantes Unicode pleine largeur ;
- appliquer la neutralisation par champ après parsing/escaping CSV ;
- tester Excel et LibreOffice ;
- conserver l'export brut uniquement derrière l'avertissement explicite.

Imports :

- limiter la taille **décompressée** des XLSX/ZIP, pas seulement le fichier source ;
- limiter nombre d'entrées ZIP, ratio de compression, lignes, colonnes et taille d'une cellule ;
- limiter la profondeur JSON ;
- ne jamais évaluer les formules Excel.

Presse-papiers :

- appliquer un seuil en octets en plus du nombre de lignes.

#### V3-A6 — Protéger l'audit

Le scénario disque/backup volé exige :

- chiffrement des métadonnées sensibles de l'audit avec `k_content` ou une sous-clé dédiée ;
- HMAC du **record complet**, pas seulement du SQL ;
- chaînage des records ou compteur monotone authentifié pour détecter suppression, réordonnancement et modification ;
- checkpoint authentifié lors d'une purge légitime ;
- export JSONL seulement après déchiffrement explicite dans l'UI.

Un simple `append-only applicatif` ne rend pas un fichier SQLite inviolable ou tamper-evident.

### État global après v3

| Constat | État v3 | Reste à faire |
| --- | --- | --- |
| SEC-01 — Transport et authentification MCP | ✅ Validé | Tests macOS de `LOCAL_PEERPID`/`proc_pidpath` à l'implémentation. |
| SEC-02 — Portée de l'accès agent | 🟠 Presque validé | Choisir namespace/provenance MySQL, plafonner les octets et la taille de `get_schema`. |
| SEC-03 — Garanties read-only | 🟠 Presque validé | Retirer EXPLAIN automatique de `request_write` et exécuter la matrice de tests MS SQL. |
| SEC-04 — TLS et SSH | ✅ Validable | Ajouter résolution loopback distante et hostname TLS final. |
| SEC-05 — Approbations immuables | ✅ Validé hors estimation | V3-4 est correcte ; remplacer la politique d'estimation V3-5. |
| SEC-06 — Sessions et ressources | 🟠 Partiel | Plafond d'octets, lock timeout, streaming borné et reconnexion restent à figer. |
| SEC-07 — Frontière Tauri | 🟠 Presque validé | Choisir explicitement le trust model du WebView et vérifier le worker ELK sous CSP. |
| SEC-08 — Stockage des secrets | 🟠 Presque validé | Ajouter `key_id`, reprise de rotation et corriger la phrase « rien en clair » pour les métadonnées de profil. |
| SEC-09 — Édition de données | ✅ Validable | Reporter paramétrisation/quoting et préciser la concurrence utilisée. |
| SEC-10 — Releases | ✅ Validé | Aucun changement. |
| SEC-11 — Imports et exports | 🟠 Partiel | CSV complet, zip bombs, limites décompressées et seuil presse-papiers en octets. |
| SEC-12 — Threat model et audit | 🟠 Presque validé | Chiffrer et authentifier l'audit complet, puis le rendre tamper-evident. |

**Références complémentaires**

- [MySQL — vues cross-database et `SQL SECURITY`](https://dev.mysql.com/doc/refman/8.4/en/create-view.html)
- [MySQL — objets `SQL SECURITY DEFINER`](https://dev.mysql.com/doc/refman/8.0/en/stored-objects-security.html)
- [PostgreSQL — fonctions `IMMUTABLE` pré-évaluables pendant le planning](https://www.postgresql.org/docs/current/xfunc-volatility.html)
- [OWASP — caractères et séparateurs concernés par CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection)

> [!summary] Conclusion v3
> Je valide V3-2, V3-4 et V3-9. V3-1, V3-3, V3-6, V3-7 et V3-8 sont proches mais nécessitent les précisions ci-dessus. Je ne valide pas V3-5 : l'estimation automatique par EXPLAIN d'une écriture agent doit être retirée.

## Propositions révisées (2026-07-16, v4)

Réponses aux ajustements V3-A1 à V3-A6 et aux points restants (SEC-06, matrice MS SQL). V3-5 est remplacée par V4-3.

### V4-1 — Scope MySQL : sémantique de namespace, assumée (répond à V3-A1)

Décision proposée : **la v1 adopte le scope de namespace, explicitement**. Le scope de provenance est indécidable dans le cas général (routines avec SQL dynamique) et un fail-closed sur provenance refuserait la plupart des bases réelles — les vues MySQL sont `SQL SECURITY DEFINER` par défaut.

- La garantie du scope strict est reformulée partout : « l'agent ne peut **adresser** que les databases autorisées » — pas « ne peut voir aucune donnée d'ailleurs ». L'UI le dit au moment de l'activation : les vues/routines `DEFINER` d'une database autorisée peuvent exposer des données d'autres databases.
- Les objets `DEFINER` ne sont donc **pas interdits** en mode strict v1. La sonde d'activation compte les objets `DEFINER` présents dans l'allowlist (`information_schema.VIEWS`/`ROUTINES`, colonne `SECURITY_TYPE` — à confirmer à l'implémentation) et l'affiche à titre informatif, sans bloquer.
- Post-v1, un mode « provenance stricte » opt-in : refus des objets `DEFINER`, vues `INVOKER` acceptées seulement si toutes leurs dépendances (`information_schema.VIEW_TABLE_USAGE` et `VIEW_ROUTINE_USAGE`, vérifiées existantes) restent dans l'allowlist, toute dépendance non analysable = fail-closed.
- Même sémantique de namespace, même mention UI, pour MS SQL en mode best-effort (l'ownership chaining cross-database y crée le même vecteur) ; le mode garanti `EXECUTE AS` reste couvert par la matrice V4-8.

### V4-2 — `key_id` et reprise de rotation (répond à V3-A2)

- Format de blob v2 : `[version:1][key_id:4, u32 BE][nonce:12][ciphertext‖tag]`. L'algorithme est impliqué par la version ; le `key_id` entre aussi dans l'AAD.
- `key_id` = compteur de génération monotone démarrant à 1. Une entrée Keychain par génération (`…-master-k<key_id>`).
- État SQLite `crypto_state` : `active_key_id`, `rotation_target_key_id` (NULL hors rotation).
- Séquence : 1) écrire la nouvelle clé dans le Keychain ; 2) poser `rotation_target_key_id` ; 3) rechiffrer tous les blobs avec le nouveau `key_id` dans une transaction ; 4) dans la même transaction, basculer `active_key_id` et remettre `rotation_target_key_id` à NULL ; 5) commit ; 6) supprimer l'ancienne entrée Keychain seulement après un scan confirmant qu'aucun blob ne porte l'ancien `key_id`.
- Reprise déterministe : chaque blob porte son `key_id`, il n'y a jamais d'ambiguïté sur la clé à utiliser. Au démarrage, `rotation_target_key_id` non NULL + clé cible présente → reprendre le rechiffrement (idempotent) ; clé cible absente (interruption avant l'étape 1 terminée) → annuler la rotation et nettoyer l'état. Le blob canari suit le même format et la même rotation.

### V4-3 — `request_write` sans estimation automatique (remplace V3-5, répond à V3-A3)

Adopté tel que demandé : pour une écriture agent libre, le dialogue d'approbation montre le SQL complet + paramètres, le type de statement et les objets ciblés (AST), et « nombre de lignes inconnu ». **Aucun EXPLAIN, dry-run ni requête supplémentaire n'est lancé sur ce chemin, sur aucun moteur.** L'EXPLAIN estimé reste une action humaine distincte de l'éditeur ; `EXPLAIN ANALYZE` reste classifié comme exécutant (déjà acté). Les éditions stagées UI conservent leur comptage exact par construction et le contrôle `affected_rows == N` (SEC-09).

### V4-4 — Trust model du WebView : trusted UI, explicite (répond à V3-A4)

Choix 1 adopté et inscrit au threat model : **le code frontend bundlé est trusted**. Le compromettre équivaut à compromettre le binaire signé — même classe d'attaquant que le process same-user déjà hors scope (R2), la chaîne de build étant traitée par SEC-10.

- Ce que CSP + rendu texte protègent : les **données** DB ne deviennent jamais du code (attaquant en scope « données malveillantes ») — pas une défense contre un frontend compromis.
- Conséquence assumée, écrite noir sur blanc : la commande IPC exécutant le SQL de l'éditeur humain existe ; un WebView compromis obtient au plus les pouvoirs de l'humain sur les profils déverrouillés. Il n'obtient jamais : les credentials (ils ne traversent pas l'IPC), le contournement du toggle lecture seule par profil, ni les règles du chemin agent (enforcement Rust).
- Ajout CSP : `worker-src 'self'` pour le worker d'auto-layout du diagramme de relations (elkjs) — comportement sous CSP à vérifier à l'implémentation (point remonté par la revue).

### V4-5 — Limites d'imports/exports complétées (répond à V3-A5)

CSV export :

- neutralisation **par champ, appliquée après l'échappement CSV**, pour les champs commençant par `=`, `+`, `-`, `@`, tabulation (0x09), CR (0x0D), LF (0x0A), et les variantes Unicode pleine largeur des quatre déclencheurs (U+FF1D, U+FF0B, U+FF0D, U+FF20) ;
- matrice de test Excel + LibreOffice à l'implémentation ; export brut uniquement derrière l'avertissement explicite (déjà acté).

Imports (défauts configurables — choix de conception) :

- XLSX/ZIP : taille **décompressée** totale ≤ 2 Gio, ratio de compression ≤ 100:1, ≤ 10 000 entrées ZIP, ≤ 1 Mio par cellule, colonnes ≤ 16 384 (plafond du format) ; tout dépassement = refus avant traitement ;
- formules Excel **jamais évaluées** : seule la valeur en cache du fichier est importée ; absente → champ vide + avertissement ;
- JSON : profondeur ≤ 64, parsing en streaming, cap fichier 1 Gio inchangé.

Presse-papiers : seuil en octets (défaut 50 Mio) en plus des 10 000 lignes.

### V4-6 — Audit chiffré et tamper-evident (répond à V3-A6)

- Quatrième sous-clé HKDF : `k_audit_enc` (AES-GCM du contenu des records) ; `k_audit` reste dédiée aux MAC.
- Record : en clair, seulement `seq` (compteur u64 strictement monotone) et l'horodatage (indexation/purge) ; tout le reste (client, profil + database, fingerprint de cible, type, HMAC du SQL, réf historique, décision, durées et volumes) chiffré en un blob AES-GCM avec AAD = version + `seq`.
- Chaînage : `mac_n = HMAC(k_audit, seq ‖ mac_(n-1) ‖ horodatage ‖ ciphertext)`, genesis fixe — détecte modification, suppression et réordonnancement.
- Anti-troncature : ancre `(last_seq, last_mac)` écrite dans le Keychain à la fermeture de l'app et toutes les 256 écritures — le scénario « disque/backup volé » n'emporte pas le Keychain, une troncature du fichier se voit à la comparaison avec l'ancre.
- Purge légitime : record checkpoint authentifié dans la chaîne (`purged_through_seq` + MAC du dernier record purgé).
- Export JSON Lines : après déchiffrement explicite dans l'UI, précédé d'une vérification de chaîne dont le verdict figure dans l'export ; règles d'écriture de V3-7.
- Limite honnête, documentée : un attaquant disposant du disque **et** du Keychain déverrouillé peut réécrire la chaîne — c'est le scénario same-user/session déverrouillée, déjà hors scope (R2).

### V4-7 — Plafonds de ressources et reconnexion (SEC-06)

- Réponses agent : plafond de **5 Mio par réponse** en plus des 1 000 lignes ; lecture en streaming, le driver cesse de consommer dès qu'un des deux plafonds est atteint, la mention « tronqué » l'indique.
- Timeouts posés par session à l'initialisation de chaque connexion des pools agent (paramètres vérifiés doc officielle 2026-07-16) : Postgres `SET statement_timeout` + `SET lock_timeout` ; MySQL `SET SESSION innodb_lock_wait_timeout` (secondes) et `max_execution_time` pour les SELECT (ms — portée SELECT-only à confirmer à l'implémentation) ; MS SQL `SET LOCK_TIMEOUT <ms>` + timeout de statement côté driver ; SQLite `PRAGMA busy_timeout` (ms) + interruption via l'API du driver.
- Défauts (choix de conception) : statement timeout agent 30 s, lock timeout 5 s, configurables par profil. Le chemin humain garde le timeout du profil déjà prévu au Draft.
- Concurrence : 4 requêtes agent simultanées max par pool (profil, database), file d'attente bornée à 15 s puis erreur MCP explicite.
- Reconnexion : chemin humain, auto-reconnexion avec backoff exponentiel (1 s → 30 s, jitter) et indicateur d'état (déjà au Draft). Chemin agent : **jamais de reconnexion silencieuse au milieu d'une requête** — connexion cassée = erreur de la requête et destruction de la connexion ; la suivante est recréée en repassant tout le rituel d'initialisation (sonde de grants V3-1/V4-1, SET de session, timeouts). Une connexion dont l'état de session est incertain est détruite, jamais réutilisée.

### V4-8 — Matrice d'attaque MS SQL : contenu et calendrier (SEC-03)

- **Quand** : la liste des cas est figée maintenant (ci-dessous) ; elle est implémentée en **tests d'intégration automatisés contre un MS SQL conteneurisé au début du chantier driver MS SQL**, et le badge ==garanti== est conditionné à leur passage en CI — pas de validation manuelle.
- Cas (chacun doit échouer **côté moteur** sous l'identité impersonnée, pas seulement au parseur) : INSERT/UPDATE/DELETE/MERGE/TRUNCATE ; SELECT INTO ; DDL ; BULK INSERT et OPENROWSET(BULK) ; `REVERT` sans cookie et empilement d'`EXECUTE AS` ; procédures signées ; xp_cmdshell et procédures étendues ; linked servers/OPENQUERY ; écritures cross-database et ownership chaining ; TRUSTWORTHY ; `sp_executesql`/EXEC dynamique ; jobs SQL Agent (msdb) ; CLR. Écritures tempdb : tolérées — hors de la définition du badge (« données persistantes de la DB cible »). Liste à affiner à l'implémentation, jamais à raccourcir sans décision.

### V4-9 — Détails d'implémentation actés depuis la validation v3

- V3-2 : l'exception loopback du tunnel SSH n'accepte que des destinations littérales (`127.0.0.0/8`, `::1`, socket Unix) — jamais un hostname à résoudre, `localhost` compris. Sur un tunnel local, le driver vérifie le certificat TLS contre le **hostname DB configuré** (SNI + vérification), pas contre `127.0.0.1`.
- V3-4 : le tag de type des paramètres est un **enum interne versionné**, jamais une chaîne renvoyée par le driver.
- SEC-08 : la formulation « rien en clair » est corrigée — les métadonnées de profil (nom, host, port, user) sont en clair par conception ; seuls secrets, contenus sensibles et audit sont chiffrés.
- SEC-09 : à reporter dans [[Decisions]] — les éditions stagées passent exclusivement par des requêtes paramétrées (valeurs en paramètres, identifiants quotés par dialecte, jamais de valeurs concaténées) ; concurrence optimiste = WHERE sur l'identité de ligne actée en R11 + contrôle `affected_rows == N` avec rollback sinon.

### V4-10 — Sources et statut (complément de V3-9)

**Faits vérifiés sur source officielle (2026-07-16)** : `information_schema.VIEW_TABLE_USAGE` et `VIEW_ROUTINE_USAGE` ([MySQL 8.4](https://dev.mysql.com/doc/refman/8.4/en/information-schema-view-table-usage-table.html) — lignes visibles seulement sur les objets où l'on a un privilège) ; `lock_timeout`/`statement_timeout` réglables par `SET` de session ([PostgreSQL](https://www.postgresql.org/docs/current/runtime-config-client.html)) ; `SET LOCK_TIMEOUT` en millisecondes, portée connexion ([SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-lock-timeout-transact-sql)) ; `innodb_lock_wait_timeout` en secondes, portée session ([MySQL 8.4](https://dev.mysql.com/doc/refman/8.4/en/innodb-parameters.html)) ; `PRAGMA busy_timeout` en millisecondes, par connexion ([SQLite](https://www.sqlite.org/pragma.html)) ; vues MySQL `DEFINER` par défaut (sourcé par la revue v3).

**À confirmer par un test à l'implémentation** : colonne `SECURITY_TYPE` de `information_schema.VIEWS`/`ROUTINES` ; `max_execution_time` MySQL (ms, portée SELECT-only) ; worker elkjs sous `worker-src 'self'` ; lecture des valeurs en cache XLSX sans évaluation de formule.

**Choix de conception sans source externe** : format de blob v2 et `key_id` u32 ; ancre d'audit Keychain (fermeture + toutes les 256 écritures) ; checkpoint de purge ; tous les seuils (2 Gio décompressé, ratio 100:1, 10 000 entrées, 1 Mio/cellule, profondeur JSON 64, 5 Mio/réponse agent, 50 Mio presse-papiers, 30 s/5 s timeouts, 4 requêtes et 15 s de file).

## Validation de la v4

### Décision sur l'arbitrage V4-1

> [!success] Scope de namespace validé pour la v1
> La v1 garantit que l'agent ne peut **adresser directement** que les databases autorisées. Elle ne garantit pas la provenance physique des données retournées par une vue ou routine `DEFINER`. Cette limite est acceptable si elle est affichée à l'activation et reste visible sur le profil.

Le choix est cohérent avec les bases MySQL réelles et évite de présenter une analyse de provenance nécessairement incomplète comme une garantie. Le terme « scope strict » doit toujours être qualifié en **scope de namespace strict**. Le mode post-v1 de provenance stricte reste pertinent.

### Verdict par proposition

| Proposition | Verdict | Avis |
| --- | --- | --- |
| V4-1 — Scope de namespace | ✅ Validée | L'arbitrage est accepté. Les objets `DEFINER` font partie de la surface logique de la database autorisée ; leur présence est affichée mais ne bloque pas. |
| V4-2 — Rotation avec `key_id` | 🟠 Validable après intégration de l'audit | La reprise des blobs AES-GCM est déterministe. La procédure doit aussi traiter les records d'audit, leur chaîne HMAC et l'ancre Keychain, tous dérivés de l'ancienne clé maîtresse. |
| V4-3 — `request_write` sans EXPLAIN | ✅ Validée | Type, objets, SQL complet et « nombre de lignes inconnu » constituent la bonne UX sûre. |
| V4-4 — WebView trusted | ✅ Validée | Le trust model est désormais cohérent : le frontend bundlé est trusted, tandis que les données DB restent hostiles et ne deviennent jamais du code. |
| V4-5 — Imports/exports | 🟠 Validable après correction d'ordre | La couverture fonctionnelle est bonne. La neutralisation d'une cellule doit précéder la sérialisation CSV finale ; si elle est appliquée après ajout des quotes CSV, le premier caractère observé peut être `"` et masquer le déclencheur. |
| V4-6 — Audit tamper-evident | 🟠 Validable après deux ajustements | Le chiffrement et la chaîne HMAC sont solides. L'ancre toutes les 256 écritures laisse une queue pouvant être tronquée sans détection, et la rotation de clé n'est pas encore reliée à la chaîne historique. |
| V4-7 — Ressources/reconnexion | 🟠 Validable après cohérence des limites | Les timeouts et la reconnexion sont bons. Quatre requêtes simultanées sont incompatibles avec la décision précédente de deux connexions maximum si les drivers ne multiplexent pas — comportement à éviter. |
| V4-8 — Matrice MS SQL | ✅ Validée comme gate de livraison | La garantie est conditionnée à des tests moteur automatisés. Ajouter `NEXT VALUE FOR`/séquences à la matrice, car leur état est persistant dans la database cible. |
| V4-9 — Détails validés | ❌ Optimistic concurrency à corriger | `WHERE` sur l'identité de ligne + `affected_rows == N` empêche une modification multi-lignes, mais ne détecte pas qu'un autre utilisateur a modifié la ligne entre lecture et écriture. Ce n'est pas encore de l'optimistic concurrency. |
| V4-10 — Sources/statut | ✅ Validée | La séparation faits, tests futurs et choix de conception est claire et exploitable. |

### Corrections nécessaires

#### V4-C1 — Rotation de la chaîne d'audit

La rotation de clé maîtresse doit inclure explicitement :

- déchiffrement/rechiffrement de tous les records d'audit avec le nouveau `key_id` ;
- recalcul de la chaîne HMAC complète avec le nouveau `k_audit` ;
- création d'une nouvelle ancre Keychain correspondant à la chaîne recalculée ;
- état de rotation permettant de distinguer une interruption avant ou après la mise à jour de l'ancre ;
- suppression de l'ancienne clé seulement après vérification des blobs **et** de la chaîne d'audit.

Une alternative serait de créer des segments de chaîne par génération de clé, reliés par un checkpoint authentifié avec ancienne et nouvelle clés. Le rechiffrement complet est plus simple en v1.

#### V4-C2 — Anti-troncature de l'audit

Avec une ancre toutes les 256 écritures, un attaquant peut tronquer la queue jusqu'à la dernière ancre sans détection.

Choisir :

- mise à jour de l'ancre à chaque transaction d'audit ; ou
- ancrage par petit batch avec une fenêtre de perte explicitement documentée.

Pour pouvoir annoncer « tamper-evident », l'option recommandée est une ancre à chaque commit de batch. Le batch peut regrouper plusieurs événements simultanés, mais aucun record confirmé à l'utilisateur ne doit rester durablement hors ancre.

#### V4-C3 — CSV : ordre de neutralisation

Ordre correct :

1. recevoir la valeur brute de la cellule ;
2. détecter les déclencheurs dangereux ;
3. préfixer/transformer la valeur ;
4. seulement ensuite appliquer quoting et escaping CSV.

Conserver les tests Excel/LibreOffice, car les outils peuvent retraiter différemment quotes et caractères de protection.

#### V4-C4 — Concurrence et pool agent

Aligner les décisions :

- soit pool de 2 connexions et maximum 2 requêtes simultanées ;
- soit pool de 4 connexions et maximum 4 requêtes.

La première option est recommandée en v1. Ne pas compter sur le multiplexing ou plusieurs result sets actifs sur une même connexion.

Lorsqu'un plafond de lignes ou d'octets est atteint :

- annuler explicitement la requête côté moteur ;
- fermer la connexion si l'état après annulation n'est pas garanti ;
- ne pas se contenter d'arrêter de lire le stream pendant que le serveur continue le travail.

Les timeouts agent peuvent être configurables, mais doivent conserver un plafond supérieur non désactivable.

#### V4-C5 — Véritable optimistic concurrency

La clause d'écriture doit contenir :

- l'identité stable de la ligne ;
- **et** une version originale : colonne `rowversion`/version lorsqu'elle existe, ou valeurs originales nécessaires avec comparaisons null-safe.

Exemple conceptuel :

```sql
UPDATE table
SET value = ?
WHERE id = ?
  AND original_value IS NOT DISTINCT FROM ?;
```

L'équivalent doit être généré par dialecte. `affected_rows == 0` signifie alors conflit concurrent ou ligne supprimée ; aucune écriture ne doit être réessayée silencieusement.

#### V4-C6 — Précisions TLS du tunnel

Les décisions V4-9 sont validées avec ces invariants :

- l'adresse de connexion locale au tunnel et le hostname de vérification TLS sont deux champs distincts ;
- SNI et validation du certificat utilisent le hostname DB final ;
- l'exception sans TLS agent ne vaut que pour une destination distante littéralement loopback ou une socket Unix.

### État final après revue v4

| Constat | État | Reste à fermer |
| --- | --- | --- |
| SEC-01 — Transport/auth MCP | ✅ Validé | Tests macOS à l'implémentation. |
| SEC-02 — Scope agent | ✅ Validé pour la v1 | Employer partout « scope de namespace ». |
| SEC-03 — Read-only | 🟠 Conception validée | Passage effectif de la matrice MS SQL, avec séquences ajoutées. |
| SEC-04 — TLS/SSH | ✅ Validé | Appliquer V4-C6. |
| SEC-05 — Approbations | ✅ Validé | Aucun EXPLAIN automatique. |
| SEC-06 — Ressources | 🟠 Presque validé | Corriger 2 connexions/4 requêtes, cancellation et plafond maximal. |
| SEC-07 — Tauri | ✅ Validé au niveau conception | Tester CSP/worker pendant l'implémentation. |
| SEC-08 — Crypto/secrets | 🟠 Presque validé | Intégrer audit et ancre dans la rotation. |
| SEC-09 — Édition | ❌ À corriger | Ajouter une version/valeurs originales au `WHERE`. |
| SEC-10 — Release | ✅ Validé | Aucun changement. |
| SEC-11 — Imports/exports | 🟠 Presque validé | Corriger l'ordre de neutralisation CSV. |
| SEC-12 — Threat model/audit | 🟠 Presque validé | Fermer la fenêtre anti-troncature et la rotation de chaîne. |

> [!summary] Conclusion v4
> L'arbitrage V4-1 est validé. La v4 est globalement acceptée, sous réserve de cinq corrections avant report définitif : rotation/ancrage de l'audit, ordre CSV, cohérence pool/concurrence, cancellation après troncature et vraie optimistic concurrency. V4-9 ne peut pas être validée telle quelle sur ce dernier point.

## Propositions révisées (2026-07-16, v5)

Réponses aux corrections V4-C1 à V4-C6 et aux cinq questions restées ouvertes. Les décisions v4 validées sont reportées dans [[Decisions]] §10. Terminologie adoptée partout : **« scope de namespace strict »** (jamais « scope strict » seul).

### V5-1 — Concurrence optimiste réelle (répond à V4-C5, remplace le point SEC-09 de V4-9)

Stratégie retenue (question 4) : **comparaison des valeurs originales** comme mécanisme portable — les versions moteur ne sont pas généralisables (`xmin` est propre à Postgres ; `rowversion` MS SQL exige une colonne dédiée, donc du DDL que l'app s'interdit sur les tables qui n'en ont pas ; MySQL et SQLite n'ont rien d'équivalent). Conformément à V4-C5 : si la table possède **déjà** une colonne `rowversion` (MS SQL), elle est utilisée en priorité comme version dans le `WHERE` ; `xmin` reste une optimisation post-v1 possible pour Postgres.

- **UPDATE stagé** : `WHERE` = identité de ligne (R11) + valeurs originales de **toutes les colonnes modifiées**, en égalité NULL-safe. C'est exactement suffisant contre le lost update : l'UPDATE ne posant (`SET`) que les colonnes modifiées, une modification concurrente d'une *autre* colonne n'est pas écrasée par construction ; une modification concurrente d'une colonne qu'on écrit fait échouer le `WHERE`.
- **DELETE stagé** : identité + valeurs originales des colonnes affichées au moment du stage (celles sur lesquelles l'humain a fondé sa décision).
- **Égalité NULL-safe par dialecte** (vérifiée doc officielle 2026-07-16) : Postgres `IS NOT DISTINCT FROM` ; MySQL `<=>` (documenté équivalent à `IS NOT DISTINCT FROM`) ; SQLite `IS` (et accepte `IS NOT DISTINCT FROM` comme alias) ; MS SQL `IS NOT DISTINCT FROM` **depuis SQL Server 2022 (16.x) seulement** — pour les versions antérieures, le prédicat étendu documenté par Microsoft : `(NOT (A <> B OR A IS NULL OR B IS NULL) OR (A IS NULL AND B IS NULL))`, sélectionné d'après la version détectée à la connexion.
- **Fail-closed sur les types sans égalité fiable** (ex. `xml` Postgres, qui n'a pas d'opérateur d'égalité) : la colonne est refusée à l'édition inline avec la raison affichée — même logique que « table sans PK = lecture seule ». Liste des types concernés par moteur à établir à l'implémentation.
- `affected_rows == 1` par ligne conservé en filet : 0 ligne = conflit concurrent ou ligne supprimée → rollback de la transaction entière + rafraîchissement des lignes en conflit dans l'UI. **Jamais de réessai silencieux** (V4-C5).

### V5-2 — Ancre d'audit sans fenêtre, intégrée à la rotation (répond à V4-C1 et V4-C2, questions 1 et 5)

- **Ancre à chaque record** (question 1 : record, pas batch) : l'écriture du record + la mise à jour de l'ancre Keychain `(key_id, last_seq, last_mac)` précèdent la délivrance de la réponse au client MCP ou à l'UI. Optimisation autorisée : group-commit — des records d'une même rafale peuvent partager une écriture d'ancre **à condition qu'aucun effet ne soit acquitté avant que l'ancre couvrant son record soit écrite**. Garantie équivalente : aucun record acquitté n'est tronquable sans détection ; la fenêtre des 256 records disparaît.
- **Rotation** (question 5) : **rechiffrement complet de la chaîne**, pas de segments — l'option que V4-C1 juge elle-même plus simple en v1. À l'étape 3 de V4-2, les records d'audit sont rechiffrés avec la `k_audit_enc` de la nouvelle génération et la chaîne de MAC est recalculée avec la nouvelle `k_audit`, dans la même transaction que les autres blobs. Pourquoi pas le segment authentifié : il faudrait soit conserver les anciennes clés (contraire à l'objectif d'une rotation post-suspicion de compromission), soit sceller chaque segment sous la nouvelle clé — deux régimes de vérification pour un gain nul aux volumes considérés (app locale, rétention 180 jours). Une seule clé vivante, une seule procédure de vérification.
- **Ancre et état de rotation** (V4-C1) : l'état `rotation_target_key_id` de V4-2 est étendu d'un drapeau `anchor_updated`. Séquence : rechiffrement + recalcul de chaîne (transaction) → bascule `active_key_id` (même transaction) → écriture de la nouvelle ancre Keychain `(nouveau key_id, last_seq, last_mac)` → `anchor_updated` posé → suppression de l'ancienne clé **seulement après** une passe de vérification complète des blobs **et** de la chaîne d'audit sous la nouvelle clé. À la reprise après interruption : ancre portant l'ancien `key_id` + `anchor_updated` absent = réécrire l'ancre depuis la chaîne recalculée (l'ancre est toujours reconstructible car la chaîne est déjà commitée) ; toute autre incohérence = rotation reprise depuis l'étape de rechiffrement, idempotente.

### V5-3 — Neutralisation CSV avant sérialisation (répond à V4-C3)

Pipeline corrigé, dans l'ordre de V4-C3 : valeur brute → détection du caractère déclencheur **sur la valeur brute** → préfixe `'` → puis seulement quoting et escaping CSV (RFC 4180). L'ordre proposé en V4-5 était faux : après quoting, le premier caractère observé peut être `"` et masquer le déclencheur — et un tableur interprète la formule même dans un champ quoté. Les tests Excel/LibreOffice restent au plan (les outils retraitent différemment quotes et caractères de protection).

### V5-4 — Pool agent : 2 connexions, 2 requêtes, annulation réelle (répond à V4-C4, question 2)

- **2 connexions et 2 requêtes simultanées max** par pool (profil, database) — les deux nombres alignés (question 2 : 2 retenu, l'option recommandée par V4-C4). Aucun recours au multiplexing ni à plusieurs result sets actifs sur une même connexion. Les clients MCP sérialisent l'essentiel de leurs appels ; 2 couvre le recouvrement requête + `get_schema` sans multiplier la charge sur des serveurs partagés. File d'attente 15 s puis erreur MCP explicite.
- **Annulation réelle après troncature** : cesser de consommer ne suffit pas, le serveur continue d'exécuter. Annulation protocolaire : Postgres `CancelRequest` (clé de cancel de la connexion), MS SQL signal Attention (cancel driver), SQLite `sqlite3_interrupt`, MySQL `KILL QUERY <id>` émis depuis l'autre connexion du pool. Si l'annulation échoue ou laisse l'état de session incertain → connexion détruite (règle V4-7). Même mécanique pour le bouton d'annulation humain déjà au scope. Support exact dans `tokio-postgres`/`tiberius`/`rusqlite`/`mysql_async` à confirmer à l'implémentation.

### V5-5 — Plafonds durs des timeouts agent (question 3)

Oui, bornés et non désactivables **sur le chemin agent** (exigence finale de V4-C4) : statement timeout dans [1 s, 300 s] (défaut 30 s), lock timeout dans [1 s, 30 s] (défaut 5 s) ; une valeur nulle/illimitée est refusée à la configuration. Le chemin humain reste libre (timeout désactivable) : l'humain a le bouton d'annulation et agit en connaissance de cause sur son poste.

### V5-6 — Points actés sans contre-proposition

- **V4-C6 (TLS du tunnel)** : les trois invariants sont adoptés tels quels — l'adresse de connexion locale au tunnel et le hostname de vérification TLS sont deux champs distincts du modèle de connexion ; SNI et validation du certificat utilisent toujours le hostname DB final ; l'exception sans TLS agent ne vaut que pour une destination distante littéralement loopback ou une socket Unix.
- **Matrice MS SQL (V4-8)** : ajout de `NEXT VALUE FOR` et des séquences aux cas de la matrice — leur état est persistant dans la database cible, donc couvert par la définition du badge ==garanti==.
- **Terminologie** : « scope de namespace strict » remplace « scope strict » dans [[Decisions]] et les futurs documents.

### V5-7 — Sources et statut (complément)

**Faits vérifiés sur source officielle (2026-07-16)** : [PostgreSQL — `IS NOT DISTINCT FROM`](https://www.postgresql.org/docs/current/functions-comparison.html) ; [MySQL — `<=>`](https://dev.mysql.com/doc/refman/8.4/en/comparison-operators.html) (équivalent documenté de `IS NOT DISTINCT FROM`) ; [SQLite — `IS`/`IS NOT DISTINCT FROM`](https://www.sqlite.org/lang_expr.html) ; [SQL Server — `IS [NOT] DISTINCT FROM`](https://learn.microsoft.com/en-us/sql/t-sql/queries/is-distinct-from-transact-sql) (2022+, avec l'expansion officielle pour les versions antérieures).

**À confirmer à l'implémentation** : mécanismes d'annulation dans les quatre crates ; liste des types sans égalité fiable par moteur.

**Choix de conception sans source externe** : bornes des timeouts (300 s / 30 s), 2 connexions et 15 s de file, group-commit d'ancre, comparaison limitée aux colonnes modifiées (UPDATE) / affichées (DELETE).

## Validation de la v5

### Verdict point par point

| Proposition | Verdict | Avis |
|---|---|---|
| V5-1 — Concurrence optimiste | 🟠 Validable avec réserve | L'UPDATE protège bien contre le lost update sur les colonnes écrites, à condition de nommer explicitement cette garantie **concurrence optimiste au niveau colonne**. La règle DELETE reste trop faible si elle ne compare que les colonnes affichées. |
| V5-2 — Ancre et rotation de l'audit | ✅ Validé avec précision de reprise | L'acquittement après ancrage supprime la fenêtre des 256 records. Le rechiffrement complet garde un seul régime de vérification et convient aux volumes annoncés. Il faut seulement définir la reprise lorsque SQLite est en avance sur l'ancre Keychain. |
| V5-3 — Neutralisation CSV | ✅ Validé | La détection sur la valeur brute avant quoting corrige bien le contournement identifié en v4. |
| V5-4 — Pool et annulation | ❌ Non validé en l'état pour MySQL | Deux requêtes peuvent occuper les deux connexions. Il ne reste alors aucune connexion pour envoyer `KILL QUERY` à l'une d'elles. Les trois autres mécanismes sont cohérents, sous réserve du support réel des crates. |
| V5-5 — Timeouts agent | ✅ Validé | Les bornes sont simples, imposables côté backend et non désactivables par l'agent. |
| V5-6 — TLS, MS SQL et terminologie | ✅ Validé | Les invariants correspondent aux garanties revendiquées. La matrice MS SQL reste un gate d'intégration avant le badge ==garanti==. |
| V5-7 — Sourcing | ✅ Validé | Les syntaxes NULL-safe et leurs limites de version sont correctement documentées. |

### V5-C1 — Réserver un canal de contrôle MySQL

La proposition `2 connexions = 2 requêtes simultanées` est incompatible avec la garantie d'annulation par une autre connexion : au moment où les deux workers exécutent une requête, aucun worker n'est disponible pour envoyer `KILL QUERY`.

Correction recommandée :

- conserver **2 connexions worker** et **2 requêtes simultanées** ;
- ajouter **1 connexion de contrôle MySQL dédiée**, hors capacité d'exécution du pool ;
- cette connexion n'exécute aucun SQL utilisateur : uniquement récupération/usage des identifiants de session, `KILL QUERY` et éventuellement les contrôles de santé ;
- mémoriser le `CONNECTION_ID()` lors de la prise en charge de chaque worker ;
- la connexion de contrôle utilise le même compte : MySQL autorise un utilisateur à interrompre ses propres threads sans privilège d'administration supplémentaire ;
- si le canal de contrôle est indisponible, fermer la connexion cible, la considérer incertaine et la recréer avec le rituel complet ; ne jamais annoncer une annulation réussie avant confirmation.

Alternative plus restrictive : garder seulement deux connexions MySQL mais limiter ce moteur à une requête active, la seconde étant réservée au contrôle. Cette option contredit toutefois le choix de deux requêtes simultanées.

Source officielle : [MySQL 8.4 — KILL Statement](https://dev.mysql.com/doc/refman/8.4/en/kill.html) et [accès aux threads du compte courant](https://dev.mysql.com/doc/refman/8.4/en/processlist-access.html).

### V5-C2 — Distinguer UPDATE au niveau colonne et DELETE au niveau ligne

La proposition UPDATE est valide avec cette formulation exacte :

> L'application empêche l'écrasement silencieux d'une modification concurrente portant sur une colonne qu'elle s'apprête elle-même à modifier.

Elle ne détecte volontairement pas la modification concurrente d'une autre colonne. Ce n'est pas une faille si l'UPDATE généré ne pose réellement que les colonnes modifiées, mais ce n'est pas une protection de version de ligne complète.

Pour DELETE, les seules colonnes affichées ne suffisent pas : une colonne masquée ou non chargée peut avoir changé depuis le stage sans invalider le `WHERE`. Politique recommandée :

1. utiliser `rowversion` lorsqu'elle existe ;
2. sinon comparer toutes les valeurs originales comparables récupérées pour la ligne, y compris celles qui ne sont pas affichées ;
3. si un snapshot complet et comparable n'est pas disponible, refuser le DELETE stagé ou imposer un rafraîchissement suivi d'une nouvelle confirmation humaine.

Le prédicat MS SQL pré-2022 proposé est bien l'expansion officielle de `IS NOT DISTINCT FROM`. Source : [Microsoft — IS [NOT] DISTINCT FROM](https://learn.microsoft.com/en-us/sql/t-sql/queries/is-distinct-from-transact-sql).

### V5-C3 — Définir la reprise lorsque la chaîne est en avance sur l'ancre

SQLite et le Keychain ne partagent pas de transaction atomique. Un crash peut donc survenir après le commit du record et de sa MAC, mais avant l'écriture de l'ancre. Le record n'a pas été acquitté, donc la garantie client reste vraie, mais le démarrage suivant doit traiter ce cas sans conclure automatiquement à une falsification.

Règle recommandée :

- si la chaîne SQLite contient une queue après l'ancre, vérifier intégralement cette queue depuis le dernier MAC ancré ;
- si elle est valide et monotone, avancer l'ancre jusqu'à la tête de chaîne avant de servir une nouvelle requête ;
- si elle est invalide, discontinue ou indéchiffrable, passer en fail-closed et signaler une intégrité d'audit non vérifiable ;
- rendre aussi idempotent le cas inverse de rotation : nouvelle ancre déjà écrite mais drapeau `anchor_updated` non encore persisté.

### V5-C4 — Éviter les faux conflits MySQL sur un UPDATE sans changement

Selon la configuration du client MySQL, le nombre retourné peut représenter les lignes réellement modifiées plutôt que les lignes trouvées. Un UPDATE qui réécrit la même valeur peut alors retourner 0 et être pris à tort pour un conflit concurrent.

Il faut adopter au moins une des deux protections :

- ne jamais stager de colonne dont la valeur normalisée est identique à la valeur originale ;
- ou activer une sémantique « matched rows » telle que `CLIENT_FOUND_ROWS`, puis vérifier le comportement exact de `mysql_async`.

Cette réserve ne permet pas un écrasement : elle crée seulement un faux positif et un rollback inutile.

### État des points de sécurité après v5

| Point | État après revue v5 |
|---|---|
| SEC-01 — Transport/auth MCP | ✅ Validé |
| SEC-02 — Scope agent | ✅ Validé pour la v1, scope de namespace assumé |
| SEC-03 — Read-only | 🟠 Conception validée, badge conditionné par la matrice MS SQL en CI |
| SEC-04 — TLS/SSH | ✅ Validé |
| SEC-05 — Approbations | ✅ Validé |
| SEC-06 — Ressources | 🟠 Bloqué uniquement par le canal d'annulation MySQL |
| SEC-07 — Tauri/WebView | ✅ Validé au niveau conception |
| SEC-08 — Crypto/secrets | ✅ Validé au niveau conception |
| SEC-09 — Édition | 🟠 UPDATE validé ; DELETE à renforcer selon V5-C2 |
| SEC-10 — Release | ✅ Validé |
| SEC-11 — Imports/exports | ✅ Validé au niveau conception |
| SEC-12 — Threat model/audit | ✅ Validé sous réserve d'inscrire la reprise V5-C3 |

> [!summary] Conclusion v5
> La v5 est validée sur le fond, sauf **V5-4 dans sa forme MySQL actuelle**. Pour conserver deux requêtes simultanées et une annulation garantie, MySQL exige un troisième canal de contrôle qui ne sert pas aux requêtes utilisateur. Deux précisions doivent également entrer dans le plan : DELETE doit protéger la ligne entière ou refuser l'opération, et la reprise d'audit doit savoir authentifier une chaîne SQLite en avance sur l'ancre Keychain.

## Propositions révisées (2026-07-16, v6)

Réponses aux trois ajustements V5-C1 à V5-C4 et aux trois questions du retour v5. Les points v5 validés sont reportés dans [[Decisions]] §10.

### V6-1 — Pool MySQL : 2 workers + 1 connexion de contrôle (répond à V5-C1, question 1)

**Accepté tel que recommandé** : sur MySQL, chaque pool (profil, database) a 2 connexions worker (= 2 requêtes simultanées) plus **1 connexion de contrôle dédiée**, hors capacité d'exécution, qui ne porte jamais de SQL utilisateur — uniquement `KILL QUERY`, la lecture des identifiants de session et les contrôles de santé. Le `CONNECTION_ID()` de chaque worker est mémorisé à la prise en charge de la requête ; même compte que les workers (MySQL autorise l'interruption de ses propres threads sans privilège supplémentaire — sourcé en V5-C1). Canal de contrôle indisponible → fermeture de la connexion cible, état incertain, recréation avec le rituel complet ; jamais d'annulation annoncée réussie avant confirmation. Les autres moteurs restent à 2 connexions (leur annulation est hors-bande : `CancelRequest`, Attention, `sqlite3_interrupt`).

### V6-2 — DELETE stagé : politique par cause d'incomplétude (répond à V5-C2, question 2)

La politique V5-C2 est adoptée (1. `rowversion` si elle existe ; 2. sinon comparaison de **toutes** les valeurs originales comparables de la ligne, affichées ou non). Pour le cas 3 (snapshot complet non comparable), la réponse dépend de la cause :

- **Colonnes non chargées** (ex. BLOB non récupéré par la grille) → **rafraîchissement** : la ligne est relue intégralement, affichée, et la suppression re-confirmée ; le DELETE re-confirmé utilise le snapshot frais dans son `WHERE`, donc une modification survenue après le rafraîchissement refait échouer le `WHERE` (convergent, pas de fenêtre silencieuse).
- **Types sans égalité fiable** (ex. `xml` Postgres) → **refus fail-closed** avec la raison affichée : le rafraîchissement n'y change rien, la colonne ne sera jamais comparable dans un `WHERE`. L'échappatoire reste l'éditeur SQL (chemin humain direct, intention explicite — [[Decisions]] §7).

Terminologie actée : la garantie UPDATE s'appelle **« concurrence optimiste au niveau colonne »**, avec la formulation exacte de V5-C2 (« l'application empêche l'écrasement silencieux d'une modification concurrente portant sur une colonne qu'elle s'apprête elle-même à modifier »).

### V6-3 — Reprise d'audit : chaîne en avance sur l'ancre (répond à V5-C3)

Règle V5-C3 adoptée telle quelle, inscrite au plan :

- au démarrage, si la chaîne SQLite contient une queue au-delà de l'ancre Keychain : vérification intégrale de la queue depuis le dernier MAC ancré ; valide et monotone → avancer l'ancre jusqu'à la tête de chaîne **avant de servir la moindre requête** (cas normal de crash post-commit/pré-ancre — le record n'avait pas été acquitté, la garantie client reste vraie) ;
- queue invalide, discontinue ou indéchiffrable → fail-closed : accès agent suspendu, alerte « intégrité d'audit non vérifiable » dans l'UI ;
- cette authentification est sûre parce qu'une queue valide exige `k_audit`, que l'attaquant du scénario en scope (disque/backup volé) ne possède pas ;
- cas miroir de la rotation rendu idempotent : nouvelle ancre déjà écrite mais `anchor_updated` non persisté → re-vérifier la chaîne sous la clé active et reposer le drapeau.

### V6-4 — UPDATE sans changement : les deux protections (répond à V5-C4, question 3)

Les deux, à des rôles différents :

- **`CLIENT_FOUND_ROWS` activé** sur les connexions MySQL qui exécutent des éditions stagées — c'est la correction de fond : `affected_rows` compte alors les lignes *trouvées* par le `WHERE`, la sémantique des trois autres moteurs. Robuste aussi face aux cas que le filtrage client ne voit pas (trigger `BEFORE UPDATE` qui neutralise le changement). Vérifié (2026-07-16) : comportement documenté côté serveur ([MySQL C API — `mysql_affected_rows`](https://dev.mysql.com/doc/c-api/8.4/en/mysql-affected-rows.html)) et exposé par `mysql_async` (`OptsBuilder::client_found_rows`, [docs.rs](https://docs.rs/mysql_async/latest/mysql_async/struct.OptsBuilder.html)) ; comportement effectif à confirmer par un test à l'implémentation.
- **Filtrage des no-op** en hygiène d'UX, tous moteurs : une colonne dont la valeur normalisée est identique à l'originale n'est jamais stagée ; une ligne sans aucune colonne réellement modifiée ne produit aucun statement.

## Validation de la v6

### Verdict point par point

| Proposition | Verdict | Avis |
|---|---|---|
| V6-1 — Canal de contrôle MySQL | ✅ Validé | `2 workers + 1 contrôle` ferme l'impossibilité structurelle de V5-4 sans réduire la concurrence. Le canal de contrôle reste hors du chemin SQL utilisateur. |
| V6-2 — DELETE selon la cause d'incomplétude | ✅ Validé | La distinction est correcte : un snapshot manquant peut être complété, un type non comparable ne peut pas l'être. Le nouveau `WHERE` referme bien toute course postérieure au rafraîchissement. |
| V6-3 — Reprise de l'audit | ✅ Validé | Une queue authentifiée sous `k_audit` peut être ré-ancrée dans le threat model retenu. Une queue invalide reste fail-closed. |
| V6-4 — UPDATE sans changement | ✅ Validé | `CLIENT_FOUND_ROWS` fournit la sémantique nécessaire ; le filtrage no-op reste utile pour l'UX et la réduction des écritures inutiles. |

### Précisions d'implémentation obligatoires

#### Confirmation d'une annulation MySQL

Le succès de `KILL QUERY` signifie que le serveur a accepté de poser le signal d'interruption, pas nécessairement que la requête cible est déjà terminée. Une annulation n'est donc annoncée comme réussie qu'après résolution de l'opération du worker cible avec l'erreur d'interruption attendue. Si cette confirmation n'arrive pas dans le délai prévu :

- détruire la connexion worker ;
- retourner un état « session interrompue, résultat inconnu », pas « annulation réussie » ;
- recréer la connexion avec la sonde et les paramètres de session complets.

Source : [MySQL 8.4 — KILL Statement](https://dev.mysql.com/doc/refman/8.4/en/kill.html), qui précise que `KILL` pose un drapeau vérifié ensuite par le thread cible.

#### Plafonds applicables au snapshot DELETE

Le rafraîchissement de V6-2 doit obtenir la valeur complète de toutes les colonnes comparables utilisées dans le `WHERE`, même si l'UI n'en montre qu'un aperçu. Si une valeur ne peut pas être récupérée ou paramétrée dans les plafonds de ressources et de protocole — BLOB trop grand, paquet maximal, allocation refusée — le DELETE stagé est refusé fail-closed avec la raison affichée. Un aperçu tronqué ou un hash local non garanti par le moteur ne remplace jamais la valeur originale dans le prédicat.

#### Tests d'intégration minimaux pour `CLIENT_FOUND_ROWS`

Le chantier MySQL doit prouver au minimum :

- UPDATE qui pose une valeur identique → 1 ligne trouvée ;
- trigger `BEFORE UPDATE` qui neutralise la nouvelle valeur → 1 ligne trouvée ;
- valeur originale devenue obsolète → 0 ligne trouvée et rollback ;
- identité unique incorrectement construite et correspondant à plusieurs lignes → échec dur, jamais validation partielle.

Les deux maillons documentaires sont confirmés : [MySQL 8.4 — `mysql_affected_rows`](https://dev.mysql.com/doc/c-api/8.4/en/mysql-affected-rows.html) et [`mysql_async::OptsBuilder::client_found_rows`](https://docs.rs/mysql_async/latest/mysql_async/struct.OptsBuilder.html#method.client_found_rows).

### État final de la revue de conception

| Point | État après revue v6 |
|---|---|
| SEC-01 — Transport/auth MCP | ✅ Validé |
| SEC-02 — Scope agent | ✅ Validé pour la v1, scope de namespace assumé |
| SEC-03 — Read-only | ✅ Conception validée ; badge MS SQL toujours conditionné au passage de la matrice en CI |
| SEC-04 — TLS/SSH | ✅ Validé |
| SEC-05 — Approbations | ✅ Validé |
| SEC-06 — Ressources | ✅ Validé |
| SEC-07 — Tauri/WebView | ✅ Validé au niveau conception |
| SEC-08 — Crypto/secrets | ✅ Validé au niveau conception |
| SEC-09 — Édition | ✅ Validé |
| SEC-10 — Release | ✅ Validé |
| SEC-11 — Imports/exports | ✅ Validé au niveau conception |
| SEC-12 — Threat model/audit | ✅ Validé |

> [!success] Conclusion v6
> Les quatre décisions v6 sont validées. Elles ferment les dernières réserves de conception de la revue sécurité. Les confirmations restantes concernent l'implémentation et les tests — support réel des annulations par les crates, matrice d'attaque MS SQL, comportement `CLIENT_FOUND_ROWS`, CSP/worker et types comparables — elles ne nécessitent plus d'arbitrage d'architecture.

## Décisions à reporter dans les plans

Une fois les choix validés :

- mettre les décisions structurantes dans [[Decisions]] ;
- ajuster le scope et les fonctionnalités dans [[Draft]] ;
- conserver cette note comme checklist de suivi ;
- transformer les contrôles critiques en tests automatisés lors de l'implémentation.
