---
title: Décisions techniques
date: 2026-07-16
tags:
  - decisions
  - architecture
status: living-document
---

# Décisions techniques

Décisions actées lors de la phase de conception, en complément de [[Draft]]. Document vivant : chaque nouvelle décision structurante s'ajoute ici avec sa date et sa justification.

## 0. Identité produit — Gatehouse

**Décision (2026-07-16)** : le produit s'appelle **Gatehouse** et utilise la signature **« Where agents meet your data »**.

**Pourquoi** : le nom matérialise la promesse centrale du produit — un point de contrôle entre les utilisateurs, les agents IA et les bases de données. Les agents peuvent explorer les profils autorisés sans accéder aux credentials, tandis que les écritures générées passent par une validation humaine explicite.

Cette décision concerne l'identité produit. Les identifiants techniques existants, notamment le nom provisoire du proxy `sql-reader-mcp`, seront renommés séparément lors de l'initialisation du projet afin d'éviter une migration partielle.

## 1. Stack — Tauri (backend Rust + frontend web)

**Décision (2026-07-16)** : Tauri plutôt qu'Electron ou du full-Rust (egui/iced).

**Pourquoi** : toute la logique sensible (connexions DB, credentials, serveur MCP) vit dans le process Rust ; l'UI (grille de données, resize de colonnes, infinite scroll) se fait en React, là où les toolkits UI natifs Rust obligeraient à tout réécrire à la main.

**Crates identifiées** (vérifiées sur crates.io le 2026-07-16) :

| Besoin | Crate |
| ------ | ----- |
| Postgres | `tokio-postgres` (ou `sqlx`) |
| MySQL | `mysql_async` |
| SQLite | `rusqlite` (feature `hooks` pour l'authorizer) |
| MS SQL | `tiberius` |
| Tunnel SSH | `russh` |
| Parsing SQL | `sqlparser` |
| Serveur MCP | `rmcp` (SDK Rust officiel) |
| Keychain | `keyring` |

**Frontend (décision 2026-07-16)** : Tailwind CSS + **shadcn/ui** le plus possible — privilégier un composant shadcn existant avant d'écrire un composant custom. Pour l'aperçu des relations (§8) : `@xyflow/react` (React Flow) + `elkjs`.

**Maquette UI (2026-07-16)** : ébauche des écrans principaux générée depuis [[DesignPrompt]] — https://claude.ai/code/artifact/f701e999-9f5a-4031-ac05-32de47b1ee69

**Grille de données (décision 2026-07-16)** : **TanStack Table** (`@tanstack/react-table`) + **TanStack Virtual** (`@tanstack/react-virtual`) pour la grille (tri, resize de colonnes, infinite scroll virtualisé) — shadcn/ui ne fournit pas de grille virtualisée. Les deux sont headless (logique sans rendu imposé), donc le rendu reste en Tailwind/shadcn ; c'est d'ailleurs la base du pattern data-table officiel de shadcn. Vérifiés context7 2026-07-16.

## 2. CI de release — ad hoc pour l'instant

**Décision (2026-07-16)** : pas de pipeline signé/notarisé pour le moment, builds ad hoc.

> [!warning] Conséquences à garder en tête
> - Un binaire non signé est bloqué par Gatekeeper sur toute autre machine (contournable par clic droit > Ouvrir).
> - Le Keychain identifie une app par sa signature de code : un binaire re-signé ad hoc à chaque build peut perdre l'accès à ses entrées Keychain. C'est une des raisons du choix de stockage ci-dessous (une seule entrée Keychain exposée au problème, pas une par connexion).

**Décision (2026-07-16)** : pas d'auto-update in-app en v1. L'updater Tauri exige des builds signés, incompatible avec les builds ad hoc ci-dessus. À réévaluer quand la CI signera/notarisera les builds.

## 3. Stockage des profils et credentials — tout dans une SQLite locale

**Décision (2026-07-16)** : une seule base SQLite locale dans le dossier de l'app contient tout — profils de connexion (host, port, user, moteur, groupe, couleur), settings, flags "accès agent" — et les mots de passe dans une colonne chiffrée (AES-GCM). La clé maîtresse de chiffrement, générée aléatoirement, est la seule chose stockée dans le Keychain macOS.

**Pourquoi** : pattern "Safe Storage" de Chrome. Un seul fichier à gérer/exporter, rien en clair sur le disque, une seule entrée Keychain (cf. piège de la signature ad hoc ci-dessus). Pas de `.env` : le backend Rust est dans le process de l'app, ce pattern n'a pas lieu d'être.

**Règle absolue** : les credentials n'existent en clair qu'en mémoire du process. Le serveur MCP reçoit des noms de profils et ne doit jamais inclure un credential dans une réponse ni dans un log.

## 4. Exposition aux agents — serveur MCP embarqué

**Décision (2026-07-16)** : l'app embarque un serveur MCP (via `rmcp`) exposant des tools du type `list_profiles`, `query(profile, database?, sql)`, `request_write(profile, database?, sql)`. L'agent ne manipule que des noms de profils, jamais de credentials. La `database` optionnelle (défaut : database par défaut du profil) doit appartenir à l'allowlist du scope agent (§10).

**Ajouts (2026-07-16, gap analysis DBeaver/pgAdmin — voir [[Draft]])** :
- Tool `get_schema(profile, database?)` : tables, colonnes, types, FK en format compact — évite que chaque agent brûle des tokens à requêter `information_schema`.
- Les réponses de `query` sont plafonnées en lignes (ex. 1000), avec mention explicite « résultat tronqué à N lignes ». Le total exact n'est annoncé que s'il est déjà connu — jamais de `COUNT(*)` automatique lancé pour l'obtenir.
- Format de résultat économe en tokens : colonnes déclarées une fois, lignes en tableaux.

- Lecture : exécution directe dans un contexte read-only (voir §5).
- Écriture : entrée dans une file de validation dans l'UI, exécution seulement après approbation humaine. Le dialogue montre le SQL complet + paramètres, le type de statement, les objets ciblés (AST) et « nombre de lignes inconnu » — **aucun EXPLAIN ni dry-run automatique sur ce chemin** (la planification peut évaluer des fonctions ; [[SecurityFeedback]] V4-3). L'EXPLAIN estimé reste une action humaine distincte dans l'éditeur.
- Chaque profil sauvegardé a un flag "accès agent" (défaut : **désactivé**, voir décision ci-dessous), configurable dans le menu Settings ; le serveur MCP filtre les profils exposés selon ce flag.

**Décisions (2026-07-16, revue sécurité — [[SecurityFeedback]] SEC-01)** :
- **Transport MCP : socket Unix + proxy stdio.** Le serveur écoute sur une socket Unix (fichier dans le dossier de données de l'app, permissions `0600`, UID du pair vérifié) ; l'app distribue un binaire proxy `sql-reader-mcp` que les clients MCP lancent en stdio. Aucun port TCP : supprime le DNS rebinding et la validation d'`Origin`. Appairage à la première connexion (approbation dans l'UI), token par client passé au proxy via variable d'environnement, clients listés et révocables dans Settings. Support vérifié (2026-07-16) : `rmcp` accepte un transport `AsyncRead`/`AsyncWrite` via la feature `transport-async-rw`, compatible `UnixStream`.
- **Flag « accès agent » désactivé par défaut**, y compris pour les profils importés. Une connexion n'est jamais exposée aux agents sans activation manuelle, profil par profil — le coût est un clic par profil, le gain est qu'aucune base fraîchement ajoutée ne devient lisible par un agent par oubli.
- Scope agent (profil, database), appairage, threat model et le reste des décisions sécurité : voir §10.

**Pourquoi pas juste une consigne dans le prompt de l'agent** : les agents désobéissent par erreur (incident Replit de juillet 2025 : base de production supprimée malgré un code freeze explicite), l'injection de prompt via les données lues est un vecteur réel, et un agent peut croire de bonne foi qu'une requête est read-only alors qu'elle écrit. Le classifier est aussi l'aiguillage vers la file de validation : sans lui, on bloque tout ou on autorise tout.

## 5. Classifier lecture vs écriture — architecture en couches

**Décision (2026-07-16)** : validée par une recherche croisée (2 agents indépendants, sources officielles + prior art). Constat central : **seules deux familles garantissent le read-only** — les permissions côté moteur et le handle physiquement read-only. Le parsing et les transactions READ ONLY seuls sont contournables.

### Règle transverse non négociable

**Un seul statement SQL par appel driver, toujours.** Le serveur MCP Postgres officiel d'Anthropic s'est fait exploiter exactement là-dessus : il wrappait le SQL agent dans `BEGIN TRANSACTION READ ONLY`, et un `COMMIT; DROP SCHEMA public CASCADE;` injecté sortait de la transaction (serveur déprécié en juillet 2025, étude de cas Datadog). C'est le contrôle le moins cher et le plus rentable de l'architecture.

### Les couches

1. **Pré-filtre UX** : `sqlparser` (dialecte par connexion) classifie et aiguille — lecture → exécution, écriture → file de validation. Fail-closed : si le SQL ne parse pas, on le traite comme une écriture. Doit parcourir l'AST en entier (les CTE `WITH x AS (DELETE ... RETURNING) SELECT ...` parsent comme des SELECT). Jamais utilisé comme barrière de sécurité.
2. **Enforcement moteur** (la vraie barrière) : voir tableau.
3. **Filet secondaire** : wrapper transaction + rollback là où c'est possible — mitigation d'accident, jamais une garantie (séquences non rollbackées, DDL MySQL à commit implicite, effets externes irréversibles).

### Enforcement par moteur

| Moteur | Mécanisme | Niveau |
| ------ | --------- | ------ |
| SQLite | Flag d'ouverture read-only **+ authorizer** (`sqlite3_set_authorizer` via `rusqlite`) qui refuse tout sauf lecture, y compris `ATTACH` | ==Garanti== |
| Postgres | Transaction `READ ONLY` + rollback, envoyée uniquement via le **protocole étendu** (le serveur refuse plus d'un statement par requête — `tokio-postgres` `query()`/`prepare()`) | Quasi-garanti |
| MySQL | `START TRANSACTION READ ONLY` + multi-statements désactivés (défaut drivers Rust) + parseur bloque `SET`/`COMMIT` (le read-only de session se désactive sans privilège) | Best-effort solide |
| MS SQL | **Mode garanti (opt-in)** : `EXECUTE AS USER = '<user_readonly>' WITH COOKIE` — le `REVERT` exige un cookie que seul notre process détient ; nécessite un user read-only + droit `IMPERSONATE`, testé à la connexion. Alternative : login dédié `db_datareader` + `db_denydatawriter`. **Fallback** : parseur + wrapper rollback | Garanti (opt-in) / best-effort |

### MS SQL — cascade sondée à la connexion

**Règle actée (2026-07-16)** : l'app n'exécute jamais de DDL sur la base cible pour ses propres besoins (pas de création d'utilisateur, de rôle ou de quoi que ce soit — cohérent avec la promesse du produit et zéro résidu).

1. **Compte déjà read-only** : l'app sonde les permissions effectives du compte via `fn_my_permissions(NULL, 'DATABASE')` (appelable par tout membre de `public`, vérifié doc Microsoft 2026-07-16). **Correction (2026-07-16, [[SecurityFeedback]] SEC-03)** : cette sonde est nécessaire mais pas suffisante — elle ne couvre ni toutes les permissions objet, ni les linked servers, ni l'ownership chaining, ni le CLR. Un compte sondé read-only reçoit donc le badge **best-effort renforcé**, pas ==garanti== ; seul le mode `EXECUTE AS` (annexe ci-dessous), validé par la matrice de tests d'attaque de SEC-03, donne ==garanti==. Cas fréquent en entreprise (compte fourni par un DBA).
2. **Compte writable** : allowlist SELECT-only + wrapper rollback → badge "best-effort". Ce best-effort est structurellement plus solide que sur Postgres (vérifié doc `CREATE FUNCTION` 2026-07-16) : les UDF T-SQL « can't be used to perform actions that modify the database state » (pas d'écriture cachée dans un `SELECT fonction()`) et T-SQL n'a pas de CTE modifiantes (l'écriture est toujours un statement de premier niveau, visible du parseur). Allowlist : un seul statement, `SELECT` de premier niveau uniquement ; rejet de `EXEC`, `SELECT ... INTO`, `NEXT VALUE FOR`, contrôle de transaction, `SET`. Trou résiduel : une UDF peut appeler une extended stored procedure (`xp_...`) — nécessite des permissions élevées qu'un tel compte n'a précisément pas.

> [!note]- Annexe : mode garanti sur compte writable (opt-in DBA, jamais exécuté par l'app)
> Pour les équipes qui veulent la garantie moteur sur un compte writable, un DBA peut créer un user à impersonner `WITHOUT LOGIN` (coquille de permissions, ni mot de passe ni connexion directe, réversible par `DROP USER agent_readonly`) :
>
> ```sql
> CREATE USER agent_readonly WITHOUT LOGIN;
> ALTER ROLE db_datareader ADD MEMBER agent_readonly;
> ALTER ROLE db_denydatawriter ADD MEMBER agent_readonly;
> GRANT IMPERSONATE ON USER::agent_readonly TO [compte_du_user];
> ```
>
> L'app sonde `IMPERSONATE` à la connexion : si le droit existe, elle bascule les lectures agent en `EXECUTE AS USER = 'agent_readonly' WITH COOKIE` et le badge passe à "garanti" (une fois la matrice de tests d'attaque SEC-03 validée).

> [!danger] Pièges documentés
> - SQLite : le flag read-only ne couvre que la base principale — sans authorizer, `ATTACH 'file:x.db?mode=rwc'` permet d'écrire dans une base attachée.
> - MS SQL : ne jamais impersonner `dbo` (désactive l'évaluation des DENY). `ApplicationIntent=ReadOnly` est un hint de routage vers des replicas, aucun effet sur un serveur standalone.
> - Postgres : une transaction READ ONLY n'empêche pas tous les effets de bord des fonctions privilégiées — seul un rôle restreint les couvre.

### Règles complémentaires par moteur (2026-07-16, revue sécurité — [[SecurityFeedback]] SEC-03)

- **EXPLAIN n'est pas toujours une lecture** : `EXPLAIN ANALYZE` (Postgres, MySQL ≥ 8.0.18) exécute réellement la requête analysée. Il est classifié comme la requête qu'il contient (une écriture analysée passe par la file de validation) et soumis aux mêmes protections read-only sur le chemin agent. Le bouton EXPLAIN de l'UI utilise la forme estimée non exécutante ; sur MS SQL, le plan estimé passe par le mécanisme `SHOWPLAN` dédié (statement seul dans son batch), pas par un simple préfixe.
- **MySQL** : rejet des commentaires exécutables `/*! ... */` avant classification — le serveur exécute leur contenu alors qu'un parseur les traite comme des commentaires — en plus de `INTO OUTFILE`/`DUMPFILE` et des fonctions de fichiers.
- **Postgres, chemin agent** : rejet de `SET`/`RESET` (permis dans une transaction READ ONLY, un `RESET statement_timeout` annulerait les limites de session) et de `COPY` (accès fichiers ou programme côté serveur selon les privilèges du rôle).

### Rejeté explicitement

- Savepoint + rollback systématique comme garantie (effets non transactionnels).
- Classification par EXPLAIN/dry-run (peut évaluer des fonctions à effets de bord, double les round-trips).
- Proxy SQL externe (absurde pour une app desktop).

### UI

Afficher par connexion un badge honnête à trois états (§10) : read-only ==garanti== (enforced moteur — SQLite, et MS SQL `EXECUTE AS` après la matrice de tests SEC-03), **best-effort** (classifié — Postgres, MySQL, MS SQL sondé) et **inconnu** (sonde échouée ou ambiguë → accès agent refusé, fail-closed). Aucun outil existant ne le fait — différenciateur.

## 6. Scope v1 (complément au [[Draft]])

**Décisions (2026-07-16)** :
- Tunnel SSH : **dans le scope v1**. Le tunnel est géré par l'app (via `russh`), jamais par l'agent.
- Édition inline des lignes : **dans le scope v1**.
- MariaDB : **écarté pour l'instant** (réévaluable, le driver MySQL le couvrirait à moindre coût).

**Décisions (2026-07-16, suite au gap analysis Beekeeper — voir [[Draft]])** :
- **Dans le scope v1** : historique des requêtes, SSL/TLS, onglets multiples avec persistance de session, navigation par clés étrangères, édition stagée (§7), édition de schéma via UI (create/alter table).
- **Post-v1** : le reste des fonctionnalités complémentaires du [[Draft]], dont l'ERD.

**Décisions (2026-07-16, suite au gap analysis DBeaver/pgAdmin/TablePlus — voir [[Draft]])** :
- **Dans le scope v1** : test de connexion, reconnexion automatique + indicateur d'état, mode lecture seule par connexion côté humain (réutilise §5), annulation de requête en cours (remontée de post-v1 à v1), `LIMIT` implicite configurable, statement timeout par connexion, EXPLAIN en un clic, distinction NULL vs chaîne vide, et les trois ajouts MCP du §4 (`get_schema`, plafond de lignes, format compact).
- L'annulation de requête et le `LIMIT` implicite forment le garde-fou minimal contre les requêtes accidentellement lourdes (produit cartésien, `SELECT *` sur une grosse table) — d'autant plus nécessaires que des agents exécutent des requêtes.

## 7. Écritures humaines et agent — file de validation unifiée (édition stagée)

**Décision (2026-07-16)** : les modifications faites dans l'UI (édition inline, insertion/suppression/duplication de lignes) ne partent jamais directement en base. Elles sont stagées, affichées avec le SQL généré et le nombre exact de lignes concernées (connu par construction — N lignes stagées, contrôle `affected_rows` à l'exécution), puis appliquées explicitement — c'est la même file de validation que celle des écritures agent (§4). L'édition de schéma via UI (§6) suit la même règle : le DDL généré (CREATE/ALTER) est affiché et passe par cette file avant exécution.

**Pourquoi** : un seul chemin de code pour toutes les écritures (une seule surface à sécuriser et à tester), une seule UX de revue, et la promesse produit — rien n'écrit sans validation explicite — vaut pour l'humain comme pour l'agent. C'est aussi le pattern éprouvé de Beekeeper Studio (modifications accumulées avec code couleur + « Copy to SQL » avant application).

**Précision (2026-07-16)** : les requêtes SQL tapées par l'humain dans l'éditeur s'exécutent directement, **sans** passer par la file de validation. Taper soi-même un `UPDATE` et l'exécuter est déjà une intention explicite ; la file couvre les écritures générées (éditions UI) et les écritures agent.

## 8. Aperçu des relations — vue locale centrée, pas d'ERD global

**Décision (2026-07-16)** : la visualisation du schéma est une **vue locale centrée sur une table** : la table courante au centre, ses voisines directes par clé étrangère autour (1 saut), avec les cardinalités sur les liens. Pas de diagramme global du schéma en v1.

**Pourquoi** : le problème des ERD classiques (pgAdmin, DBeaver, Beekeeper payant) est connu — dès quelques dizaines de tables, le diagramme global devient un plat de spaghettis illisible qu'on ne consulte jamais. La question réelle de l'utilisateur est presque toujours locale : « à quoi cette table est-elle reliée, et dans quel sens ? ». Une vue centrée y répond sans jamais atteindre la taille où un diagramme devient illisible.

**Règles de lisibilité** :
- **1 saut par défaut**, expansion progressive : cliquer une voisine la recentre ou déplie ses propres liens. Le graphe ne montre jamais que ce que l'utilisateur a demandé.
- **Nœuds compacts** : nom de table + PK + FK seulement (avec un compteur « +N colonnes », dépliable). Jamais toutes les colonnes par défaut — c'est ça qui transforme un diagramme en mur de texte.
- **Cardinalités explicites** sur chaque lien : 1-n déduit des FK (sens de la flèche = sens de la référence) ; n-n détecté par heuristique de table de jointure (table dont les colonnes sont essentiellement deux FK, PK composite incluse) et affiché comme un lien direct n-n, la table de jointure restant visible sur demande.
- **Auto-layout déterministe**, aucun placement manuel à sauvegarder : la vue est jetable et régénérée, ce n'est pas un document à entretenir.
- Accessible depuis la table (onglet Structure ou raccourci) et cohérent avec la navigation FK du [[Draft]] : le clic sur un lien mène aux données.

**Implémentation (décision 2026-07-16)** : `@xyflow/react` (React Flow, MIT) pour le rendu et l'interaction + `elkjs` (port officiel de l'Eclipse Layout Kernel, EPL-2.0) pour l'auto-layout — vérifiés docs officielles 2026-07-16.
- L'anti-ambiguïté des liens vient de l'**ancrage par colonne** : un `Handle` React Flow par colonne PK/FK (`sourceHandle`/`targetHandle`), le lien part de la ligne `orders.user_id` et arrive sur la ligne `users.id` — jamais de lien centre-à-centre. Cardinalités posées via `EdgeLabelRenderer`.
- elkjs en algorithme `layered`, routage orthogonal, `portConstraints: FIXED_ORDER` (respecte l'ordre des colonnes sur les bords) — layout déterministe, contrairement aux layouts à forces. Bibliothèque lourde (transpilée depuis Java) : chargement lazy/worker.
- Homemade uniquement pour la couche sémantique (schéma → graphe FK, heuristique table de jointure, cardinalités) et le composant nœud.
- Écartés : dagre (pas de ports → liens centre-à-centre ambigus), Cytoscape.js (canvas, nœuds non-React), mermaid (statique), GoJS/JointJS+ (commerciaux), full homemade (rien de plus contre l'ambiguïté).

**Hors scope v1** : ERD global exportable (backlog post-v1) ; s'il arrive un jour, il sera filtré (par schéma ou sélection de tables), jamais « tout le schéma d'un coup ».

## 9. Navigation — double sidebar

**Décision (2026-07-16)** : navigation en deux sidebars accolées, pattern Beekeeper/TablePlus/VS Code (activity bar + panneau contextuel).

**Sidebar 1 — rail fin d'icônes, global à l'app** :
- Connexions / profils, groupés par projet, avec la couleur du profil (§3)
- Historique des requêtes
- Requêtes sauvegardées
- File de validation (§7), avec badge compteur — une écriture agent en attente doit être visible depuis n'importe quel écran
- Settings (en bas)

**Sidebar 2 — panneau contextuel de la connexion active** :
- En haut : sélecteur de database (dropdown), puis arborescence schéma > tables / vues / vues matérialisées
- Recherche de table — le Cmd+P du [[Draft]] ouvre la même recherche en palette

**Sélecteur de database, comportement par moteur** :

| Moteur | Comportement |
| ------ | ------------ |
| Postgres | Le protocole ne permet pas de changer de database sur une connexion ouverte : le dropdown ouvre une nouvelle connexion en réutilisant les credentials du profil (pattern Beekeeper/TablePlus) |
| MySQL / MS SQL | Une même connexion voit toutes les databases accessibles : changement de contexte simple, l'arborescence peut en lister plusieurs |
| SQLite | Un fichier = une base, pas de dropdown |

**Conséquence sur le modèle de données** : un profil = un serveur + une database par défaut (pas une liste). La database courante est un état de session, persisté avec les onglets (§6), pas une propriété du profil.

## 10. Sécurité — décisions issues de la revue (2026-07-16)

Propositions v2 de [[SecurityFeedback]] validées le 2026-07-16 (R2 et R3 arbitrées explicitement, le reste en bloc). Cette section fige les choix structurants ; le détail des mécanismes et les checklists d'implémentation restent dans [[SecurityFeedback]].

**Threat model** : un process malveillant s'exécutant sous le même utilisateur macOS est **hors scope pour la confidentialité** — il peut de toute façon lire la config MCP des clients, où vit leur token. L'appairage sert à distinguer, tracer et révoquer les clients légitimes, pas à authentifier un binaire.

**Appairage MCP** : token de 32 octets aléatoires par client, seul son hash SHA-256 stocké côté app ; le dialogue d'appairage affiche le nom déclaré, le PID et le chemin de l'exécutable du pair ; une seule demande à la fois, backoff après refus, journalisation.

**Scope agent** : accordé par couple **(profil, database)** — allowlist par cases à cocher dans l'UI, défaut = uniquement la database par défaut du profil. Les tools prennent `profile` + `database` optionnelle ; database hors allowlist → erreur générique sans révéler les autres ; la cible n'est jamais déduite de l'onglet actif. `USE` et identifiants cross-database hors scope rejetés par le parseur (aiguillage UX) ; la barrière réelle reste le moteur. Après `request_write`, l'agent ne voit qu'un identifiant de demande et un statut, jamais le résultat avant approbation.

**Badge read-only** : trois états — ==garanti==, best-effort, inconnu. « Garanti » signifie exactement « le moteur refuse toute modification des données persistantes de la base cible » (ni système de fichiers serveur, ni réseau, ni disponibilité). Réservé à SQLite et au mode MS SQL `EXECUTE AS` **après** la matrice de tests d'attaque (SEC-03) ; Postgres/MySQL restent best-effort ; sonde échouée ou ambiguë → « inconnu » + accès agent refusé (fail-closed).

**Profils production** : champ « environnement » sur le profil ; le passage en production désactive automatiquement l'accès agent, invalide les approbations en attente et exige une réactivation explicite, signalée en permanence dans l'UI.

**TLS/SSH** : vérification complète (chaîne + hostname) par défaut, TLS ≥ 1.2, CA custom par profil ; **accès agent ⇒ vérification TLS active** (ou connexion locale). Store de clés hôtes SSH propre à l'app avec import lecture seule de `~/.ssh/known_hosts`, fingerprint affichée au premier contact, échec dur si la clé change, agent forwarding non implémenté. Clés privées référencées par chemin (permissions `0600` exigées), passphrase stockée comme secret ou demandée à l'usage.

**Chiffrement local** : secrets (passwords, passphrases) en AES-GCM avec AAD liée à la cible (host, port, user, mode TLS) — altérer la cible dans la SQLite casse le déchiffrement au lieu d'envoyer le secret ailleurs. Les tokens d'appairage MCP ne sont **jamais** chiffrés-récupérables : seul leur hash est stocké (voir « Appairage MCP » ci-dessus), un token perdu se remplace par un ré-appairage. Historique, requêtes sauvegardées et onglets persistés chiffrés avec la clé maîtresse. **Résultats de requêtes jamais persistés sur disque.** Rétention : 90 jours (historique) / 180 jours (audit agent), configurables ; purge au démarrage puis quotidienne.

**Approbations** : demandes d'écriture en mémoire du process Rust uniquement (un redémarrage les invalide par construction), structure immuable, hash SHA-256 sur sérialisation canonique (SQL + paramètres + fingerprint complète de la cible + client d'origine), usage unique, expiration 5 minutes.

**Édition de lignes** : requiert une clé primaire ou une contrainte unique dont toutes les colonnes sont NOT NULL ; sinon table en lecture seule avec la raison affichée. **Concurrence optimiste au niveau colonne** (validée 2026-07-16, [[SecurityFeedback]] V5-1/V5-C2/V6-2/V6-4) : requêtes exclusivement paramétrées, `WHERE` = identité de ligne + valeurs originales des colonnes modifiées en égalité NULL-safe par dialecte (`IS NOT DISTINCT FROM` Postgres et SQLite ; `<=>` MySQL ; MS SQL `IS NOT DISTINCT FROM` en 2022+ sinon l'expansion officielle Microsoft, choisie selon la version détectée) ; colonne `rowversion` utilisée en priorité quand elle existe ; types sans égalité fiable refusés à l'édition inline avec raison. `affected_rows == 1` par ligne en filet, rollback de la transaction entière en cas d'écart, jamais de réessai silencieux. Garantie exacte : l'app empêche l'écrasement silencieux d'une modification concurrente portant sur une colonne qu'elle s'apprête elle-même à modifier. Sur MySQL, `CLIENT_FOUND_ROWS` + filtrage des colonnes no-op évitent les faux conflits. Pour DELETE : `rowversion` en priorité, sinon snapshot complet des valeurs comparables ; colonne non chargée → rafraîchissement complet + nouvelle confirmation ; type non comparable ou snapshot complet impossible dans les plafonds → refus fail-closed.

**Distribution** : v1 strictement locale ; la CI signée/notarisée est le prérequis de toute première distribution externe (reporté dans [[Draft]]).

### Compléments validés (2026-07-16, propositions v3/v4 de [[SecurityFeedback]])

Validés lors des passes v3 à v6 ; le détail des mécanismes reste dans [[SecurityFeedback]] (V3-x à V6-x).

- **Scope de namespace strict** (terminologie officielle — jamais « scope strict » seul) : la garantie est « l'agent ne peut *adresser* que les databases de l'allowlist », pas la provenance des données — une vue ou routine `SQL SECURITY DEFINER` d'une database autorisée peut exposer des données d'ailleurs (comportement par défaut des vues MySQL). Limite affichée à l'activation et visible sur le profil ; sonde informative des objets `DEFINER`. Sur MySQL : sonde `SHOW GRANTS FOR CURRENT_USER()` + rôles actifs (`CURRENT_ROLE()`, `SHOW GRANTS ... USING`) à l'activation et à chaque connexion agent ; privilège global ou hors allowlist, ou analyse ambiguë → refus fail-closed, avec repli opt-in étiqueté en permanence « allowlist non garantie ». Mode « provenance stricte » : post-v1. **Pools agent indexés par (profil, database)**, jamais par profil seul.
- **Tunnel SSH + TLS** : chemin agent, TLS DB requis même à travers un tunnel — exception uniquement pour une destination distante *littéralement* loopback (`127.0.0.0/8`, `::1`, jamais un hostname à résoudre) ou une socket Unix du serveur SSH. Chemin humain : toléré sans TLS avec l'indicateur « segment SSH → DB non chiffré ». L'adresse locale du tunnel et le hostname de vérification TLS sont deux champs distincts ; SNI et validation de certificat utilisent toujours le hostname DB final. AAD des secrets étendue à la cible SSH + cible DB + mode TLS (pas la fingerprint TOFU).
- **Cryptographie locale** : la clé maîtresse Keychain ne chiffre jamais directement — sous-clés HKDF-SHA-256 à labels distincts : `k_secrets`, `k_content`, `k_audit` (MAC), `k_audit_enc` (contenu des records d'audit). Blob versionné `[version:1][key_id:4][nonce:12][ciphertext‖tag]`, `key_id` = génération monotone, une entrée Keychain par génération, AAD incluant version + type + identifiant (+ cible pour les secrets). Rotation manuelle transactionnelle avec état `active_key_id`/`rotation_target_key_id` et reprise déterministe ; suppression de l'ancienne clé seulement après vérification complète des blobs **et** de la chaîne d'audit rechiffrée (validé — [[SecurityFeedback]] V5-2). Perte de clé détectée par blob canari → réinitialisation documentée (profils conservés, secrets à ressaisir), pas d'escrow. Paramètres approuvés sérialisés avec index, tag de type (enum interne versionné), marqueur NULL, longueur, octets.
- **Frontière Tauri** : **le WebView bundlé est trusted** (threat model explicite) — compromettre le frontend bundlé équivaut à compromettre le binaire signé, même classe que le same-user hors scope ; CSP et rendu texte protègent contre les *données* DB devenant du code, pas contre un frontend compromis. Un WebView compromis obtient au plus les pouvoirs de l'humain : jamais les credentials (ne traversent pas l'IPC), ni le contournement du read-only par profil ou des règles agent (enforcement Rust). CSP sans host distant : `default-src 'self'; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-src 'none'; worker-src 'self'` (worker elkjs à tester sous CSP). Commandes IPC typées, pas de commande « execute raw », `dangerouslySetInnerHTML` interdit par lint, valeurs DB rendues en texte uniquement.
- **Imports/exports** : neutralisation CSV des déclencheurs (`=`, `+`, `-`, `@`, TAB, CR, LF et variantes pleine largeur) appliquée **sur la valeur brute, avant quoting/escaping CSV** (validé — l'ordre inverse masquerait le déclencheur derrière la quote), export brut derrière avertissement explicite ; fichiers `0600`, écriture atomique, pas de symlink ; XLSX/ZIP plafonnés en taille **décompressée** (2 Gio), ratio (100:1), entrées (10 000), cellule (1 Mio) ; formules Excel jamais évaluées (valeur en cache seulement) ; JSON profondeur ≤ 64 ; URL de connexion importée parsée côté Rust, password extrait immédiatement vers le stockage chiffré, jamais persisté ni loggé ; presse-papiers avec seuil lignes + octets.
- **Audit tamper-evident** : records chiffrés (`k_audit_enc`, seuls `seq` et l'horodatage en clair), chaîne HMAC (`k_audit`) détectant modification/suppression/réordonnancement, ancre `(key_id, last_seq, last_mac)` dans le Keychain **mise à jour avant tout acquittement** — aucun record acquitté au client ne peut être tronqué sans détection (group-commit toléré sous cette même règle) ; rotation = rechiffrement complet de la chaîne + recalcul des MAC dans la transaction de rotation, nouvelle ancre avant suppression de l'ancienne clé ; checkpoint authentifié à la purge ; export JSON Lines après vérification de chaîne. Reprise au démarrage quand la chaîne SQLite est en avance sur l'ancre : queue valide et monotone sous `k_audit` → avancer l'ancre avant de servir ; queue invalide → fail-closed et alerte. Limite documentée : disque + Keychain déverrouillé = hors scope (R2).
- **Ressources agent** : plafond 1 000 lignes **et** 5 Mio par réponse, lecture en streaming avec **annulation protocolaire réelle** de la requête à la troncature — `CancelRequest` Postgres, signal Attention MS SQL, `sqlite3_interrupt` SQLite, `KILL QUERY` MySQL (support des crates à confirmer à l'implémentation) ; timeouts posés par session (`statement_timeout`/`lock_timeout` PG, `innodb_lock_wait_timeout`/`max_execution_time` MySQL, `SET LOCK_TIMEOUT` MS SQL, `busy_timeout` SQLite — vérifiés doc officielle), **bornes non désactivables sur le chemin agent** : statement [1 s, 300 s] défaut 30 s, lock [1 s, 30 s] défaut 5 s (le chemin humain reste libre) ; pool par (profil, database) : 2 connexions worker = 2 requêtes simultanées, file 15 s ; MySQL reçoit en plus 1 connexion de contrôle dédiée pour `KILL QUERY`, hors SQL utilisateur. Une annulation MySQL n'est confirmée qu'après terminaison effective du worker cible ; sinon connexion détruite et résultat déclaré inconnu. Jamais de reconnexion silencieuse — connexion à l'état incertain détruite, recréation avec rituel complet (sonde de grants, SET de session).
- **Matrice d'attaque MS SQL** : liste de cas figée ([[SecurityFeedback]] V4-8, + `NEXT VALUE FOR`/séquences), implémentée en tests d'intégration automatisés contre un MS SQL conteneurisé au début du chantier driver ; le badge ==garanti== MS SQL est **conditionné à leur passage en CI**.
- **Threat model formalisé** : en scope — client MCP malveillant, données DB malveillantes (injection de prompt, contenu piégé), serveur DB compromis, MITM réseau, données au repos (disque/backup volé). Hors scope — process same-user à l'exécution (R2), root/kernel, session déverrouillée, **frontend bundlé compromis** ; chaîne de build traitée par SEC-10. Télémétrie/crash reports désactivés par défaut et jamais porteurs de SQL, résultats ou credentials.

## 11. Raccourcis clavier — TanStack Hotkeys + personnalisation dans Settings

**Décision (2026-07-16)** : **TanStack Hotkeys** (`@tanstack/react-hotkeys`) pour tous les raccourcis clavier — vérifié docs officielles + npm 2026-07-16 (v0.10.0).

**Pourquoi** : l'app est pensée keyboard-first ([[Draft]] : Cmd+P recherche de table/palette, Cmd+F recherche dans une table). TanStack Hotkeys est la seule des options classiques à fournir nativement l'enregistrement de raccourcis (`useHotkeyRecorder` + `formatForDisplay`), exactement ce qu'il faut pour un écran de personnalisation ; il gère `Mod` (Cmd/Ctrl selon la plateforme), les séquences et le scoping, et reste cohérent avec la stack TanStack déjà actée (§1 : Table, Virtual).

- **Personnalisation dans Settings** : section « Raccourcis clavier » dans le menu Settings (§9) — liste des actions avec leur binding courant, ré-enregistrement via `useHotkeyRecorder`, reset par action et global. Les bindings personnalisés sont persistés dans la SQLite locale des settings (§3) ; seuls les écarts aux défauts sont stockés.
- Les raccourcis sont déclarés via un registre central action → binding (source unique pour l'exécution, l'écran Settings et les hints affichés dans l'UI — [[DesignPrompt]]), jamais de `useHotkey` avec une combinaison en dur dans un composant.
- **Réserve** : bibliothèque pré-1.0 (v0.10.0), API susceptible de bouger — le registre central limite la surface à adapter en cas de breaking change.
- Écartés : react-hotkeys-hook et hotkeys-js (pas de recorder natif pour la personnalisation), implémentation maison (rien de plus que la gestion `keydown`, tout à réécrire : normalisation des touches, plateformes, séquences).

## 12. Internationalisation — i18next, français + anglais

**Décision (2026-07-16)** : l'app est traduite en **français et anglais** dès la v1, via **i18next + react-i18next** — vérifiés npm 2026-07-16 (i18next 26.x, react-i18next 17.x). Traduction 100 % locale : fichiers de ressources embarqués dans le bundle, aucun service de traduction distant.

**Pourquoi** : standard de facto de l'i18n React — mature, documenté, gère pluriels et interpolation, et n'impose aucune étape de compilation dédiée (contrairement à Lingui), ce qui reste dans la philosophie « privilégier l'existant » du §1.

- **Règle dès le premier composant** : aucune chaîne UI en dur, tout passe par les clés de traduction — rétrofitter l'i18n sur une app existante coûte bien plus cher que de l'imposer au départ.
- Langue choisie dans Settings (§9), persistée dans la SQLite locale (§3) ; défaut : langue système si fr/en, sinon anglais.
- Ce qui n'est **pas** traduit : le SQL, les identifiants de schéma, les messages d'erreur bruts renvoyés par les moteurs. Les réponses du serveur MCP restent en anglais (lues par des agents, pas par l'humain).
- Fichiers de ressources JSON par langue, organisés par namespace (un par grande zone : grille, éditeur, settings, file de validation).

## 13. Synthèse des garanties de sécurité

Résumé exécutable de la revue [[SecurityFeedback]]. Cette partie sert de référence rapide pendant l'implémentation ; en cas d'ambiguïté, les mécanismes détaillés et leurs tests dans [[SecurityFeedback]] font foi.

> [!danger] Règles non négociables
> Les credentials ne quittent jamais le backend Rust. Un agent n'exécute jamais directement une écriture. Toute ambiguïté sur le scope, les privilèges, l'intégrité ou l'identité d'une ligne se résout en fail-closed. Les résultats de requêtes ne sont jamais persistés sur disque.

### Garanties retenues

| Zone | Garantie |
|---|---|
| **Transport MCP** | Socket Unix locale + appairage explicite par client, token aléatoire révocable stocké uniquement sous forme de hash, demandes limitées et journalisées. |
| **Scope agent** | Allowlist par `(profil, database)`, pools séparés par cible, aucune cible déduite de l'onglet actif. La garantie porte sur le **namespace adressable**, pas sur la provenance interne des vues et routines. |
| **Lecture seule** | Badge à trois états : ==garanti==, best-effort, inconnu. Échec ou ambiguïté de la sonde → accès agent refusé. Le badge ==garanti== signifie uniquement que le moteur bloque les modifications persistantes dans la database cible. |
| **Écritures agent** | `request_write` crée une demande immuable en mémoire, liée au SQL, aux paramètres, à la cible et au client. Approbation humaine obligatoire, usage unique, expiration 5 minutes, aucun résultat avant validation. |
| **Écritures humaines stagées** | SQL paramétré, identité de ligne obligatoire, transaction atomique et concurrence optimiste. UPDATE protège les colonnes écrites ; DELETE exige un snapshot complet comparable ou est refusé. Aucun réessai silencieux. |
| **Réseau** | TLS ≥ 1.2 avec validation de chaîne et hostname sur le chemin agent, y compris dans un tunnel SSH sauf destination distante littéralement loopback ou socket Unix. Changement de clé SSH = échec dur. |
| **Secrets locaux** | AES-GCM avec AAD liée à la cible, sous-clés HKDF séparées par usage, blobs versionnés avec `key_id`, clé maîtresse dans le Keychain et rotation reprenable. Les tokens MCP ne sont jamais récupérables depuis le stockage. |
| **Frontend Tauri** | Aucun credential dans le WebView, commandes IPC typées, CSP sans contenu distant, valeurs DB rendues comme texte, aucune commande IPC générique permettant d'exécuter du SQL brut. |
| **Ressources agent** | 1 000 lignes et 5 Mio maximum par réponse, streaming, timeouts non désactivables, file d'attente bornée et annulation protocolaire réelle. État de session incertain → connexion détruite et recréée. |
| **Imports/exports** | Neutralisation CSV avant quoting, ZIP/XLSX limités en taille décompressée, ratio, entrées et taille de cellule ; formules Excel jamais évaluées ; JSON et presse-papiers bornés ; fichiers privés, atomiques et sans symlink. |
| **Audit** | Records chiffrés et chaînés par HMAC, ancre Keychain mise à jour avant acquittement, troncature détectable, purge avec checkpoint authentifié, rotation par rechiffrement complet et reprise fail-closed. |
| **Distribution** | Aucune distribution externe avant CI de release, signature et notarisation. Télémétrie et crash reports désactivés par défaut et exclus des données sensibles. |

### Limites explicitement assumées

- **Scope de namespace, pas de provenance** : une vue ou routine `DEFINER` autorisée peut lire ailleurs. La limite est affichée lors de l'activation ; le mode provenance stricte est post-v1.
- **Postgres et MySQL read-only restent best-effort** : seul un mécanisme réellement imposé par le moteur peut obtenir le badge ==garanti==.
- **Process same-user hors scope pour la confidentialité** : il peut lire les configurations MCP de l'utilisateur. L'appairage identifie et révoque les clients légitimes, il n'atteste pas leur binaire.
- **Frontend bundlé compromis hors scope** : assimilé à un binaire signé compromis. Même dans ce cas, l'architecture ne doit pas exposer les credentials ni permettre de contourner les règles agent appliquées en Rust.
- **Éditeur SQL humain = échappatoire explicite** : l'humain peut exécuter directement un SQL qu'il écrit lui-même, sous réserve du mode read-only du profil. Cette liberté n'est jamais transmise à l'agent.
- **Serveur DB compromis** : la sécurité locale protège les secrets, l'interface et le transport ; elle ne peut garantir la véracité des données ou la disponibilité d'un serveur malveillant.

### Conditions fail-closed principales

- database hors allowlist, privilège MySQL global/hors scope ou analyse de grants ambiguë ;
- sonde read-only échouée ou état moteur inconnu ;
- TLS, hostname ou clé hôte SSH non vérifiable ;
- table sans identité unique sûre, type non comparable ou snapshot DELETE incomplet ;
- chaîne d'audit invalide, discontinue ou indéchiffrable ;
- clé de chiffrement manquante, blob canari invalide ou rotation incohérente ;
- annulation non confirmée ou connexion dont l'état de session est incertain ;
- import dépassant un plafond de sécurité ou contenant une structure non traitable.

### Gates obligatoires avant de revendiquer les garanties

- [ ] Matrice d'attaque MS SQL complète en CI avant d'afficher le badge ==garanti==.
- [ ] Tests d'intégration des annulations `tokio-postgres`, `tiberius`, `rusqlite` et `mysql_async`.
- [ ] Test MySQL du canal de contrôle dédié et de la confirmation effective de `KILL QUERY`.
- [ ] Tests `CLIENT_FOUND_ROWS` : no-op, trigger neutralisant, conflit concurrent et cardinalité anormale.
- [ ] Tests de concurrence UPDATE/DELETE pour chaque dialecte et chaque opérateur NULL-safe.
- [ ] Tests de crash à chaque étape de rotation des clés et entre commit d'audit et ancrage Keychain.
- [ ] Tests de falsification, réordonnancement, suppression, troncature et purge de la chaîne d'audit.
- [ ] Tests CSP Tauri, worker elkjs et absence de credentials dans les payloads IPC.
- [ ] Tests CSV Excel/LibreOffice et bombes ZIP/XLSX, profondeurs JSON, cellules et presse-papiers.
- [ ] Validation de la release packagée, signée et notarisée avant toute distribution externe.

> [!success] État de la conception
> Les décisions de sécurité SEC-01 à SEC-12 sont validées au niveau architecture. Les cases ci-dessus sont des preuves d'implémentation obligatoires : une fonctionnalité ou un badge dépendant ne doit pas être livré tant que son gate ne passe pas.
