
# Gatehouse

> **Where agents meet your data**

Gatehouse est un SQL Editor et Database Manager (ie Beekeeper Studio) conçu comme un point de contrôle entre les utilisateurs, les agents IA et leurs bases de données.
Décisions techniques actées : [[Decisions]]
Dans un premier temps, on va l'utiliser que sur Mac.
L'application doit pouvoir se lancer en standalone.
Chaque release créer un nouveau build (faire une CI).
Précision (2026-07-16, revue sécurité) : la v1 reste sur la machine du développeur — la CI signée/notarisée est le prérequis de la première distribution externe, pas de la v1 locale ([[Decisions]] §2 et §10, [[SecurityFeedback]] SEC-10).
Au démarrage de l'implémentation, lancer le skill `prometheus-setup` (README user-first, AGENTS.md/CLAUDE.md, graphe graphify) pour que les agents IA puissent pleinement travailler sur le projet.

On doit pouvoir voir toutes les tables.
On doit pouvoir enregistrer des base de données, exemple sur Beekeeper Studio avec Postgres :
![[Pasted image 20260716200423.png|376]]

On veut pouvoir prendre en charge Postgres, MySQL, SQLite et MS SQL.

## Fonctionnalités principales
- Pouvoir voir le contenu des tables, chercher des tables, filtrer, faire des query à part (sans être au niveau d'une table, ie pour lancer `select * from ...` ) 
	- Toutes les colonnes doivent être resizeable, mettre le type etc..
	- Pouvoir trier par colonne 
- Pouvoir sauvegarder les connexions à chaque DB, pouvoir les grouper (ie, j'ai un projet mais avec plusieurs DB locales, un staging, une production etc..)
- **Être friendly avec les agents (Claude, Codex...), c'est à dire qu'ils peuvent interagir avec l'un des profils proposés sans lire les credentials** -> si l'agent doit faire des requêtes qui modifie des données (tout ce qui n'est pas du query), l'utilisateur doit valider avant
- Avoir une interface moderne
- Faire une infinite scroll sur les données affichées
- Pouvoir exporter les données facilement
- Mettre des raccourcis clavier, ie CMD P pour chercher une table, CMD F pour chercher un élément au sein d'une table etc...
- Avoir un autocomplete lorsqu'on écrit des requêtes SQL (nom de colonne existante, table...)

## Fonctionnalités complémentaires (gap analysis Beekeeper Studio, 2026-07-16)

Retenues après comparaison avec l'édition communautaire (gratuite) de Beekeeper Studio. Les items marqués *(v1)* sont dans le scope v1 ([[Decisions]] §6) ; le reste est post-v1.

### Éditeur SQL
- Historique des requêtes, scopé par connexion — inclut les requêtes exécutées par les agents *(v1)*
- Requêtes sauvegardées, stockées dans la SQLite locale existante ([[Decisions]] §3)
- Onglets multiples avec persistance de session au relancement *(v1)*
- Exécution de la sélection / de la requête sous le curseur
- Formateur SQL (prettify)

### Données
- Navigation par clés étrangères : clic sur une valeur FK ouvre l'enregistrement lié *(v1)*
- Édition stagée : les modifications UI passent par la même file de validation que les écritures agent ([[Decisions]] §7) *(v1)*
- Insertion, suppression et duplication de lignes
- Visionneuse pour grandes valeurs (JSON, texte long) en modal ou sidebar, avec coloration
- Filtres GUI par colonne (colonne + opérateur + valeur), cumulables sans limite (Beekeeper limite à 2 en gratuit), en plus du filtre SQL libre
- Copie presse-papiers des résultats : CSV, JSON, Markdown, INSERT

### Connexions & schéma
- SSL/TLS — indispensable pour les bases managées (RDS, Azure, Supabase...) *(v1)*
- Import de connexion depuis une URL (`postgres://...`)
- Onglet Structure par table : colonnes, types, index, contraintes, triggers, DDL
- Édition de schéma via UI : create/alter table, colonnes, index, clés étrangères *(v1)*
- Vues et vues matérialisées listées dans la sidebar et requêtables

### Import / export
- Import de fichiers (CSV, Excel, JSON) vers une table — payant chez Beekeeper
- Export multi-tables — payant chez Beekeeper

## Fonctionnalités complémentaires (gap analysis DBeaver / pgAdmin / TablePlus, 2026-07-16)

Seconde passe de comparaison, cette fois avec DBeaver, pgAdmin et TablePlus. Tout est retenu en scope v1 ([[Decisions]] §6).

### Connexions
- Bouton « Tester la connexion » avant de sauvegarder un profil *(v1)*
- Reconnexion automatique (timeout idle, VPN, sortie de veille) et indicateur d'état de connexion *(v1)*
- Mode lecture seule par connexion, côté humain : toggle sur le profil (typiquement la production), qui réutilise l'enforcement moteur de [[Decisions]] §5 *(v1)*

### Garde-fous d'exécution
- Annulation d'une requête en cours *(v1)* — remonté depuis le gap analysis Beekeeper
- `LIMIT` implicite configurable sur l'affichage du contenu des tables *(v1)*
- Statement timeout configurable par connexion *(v1)*

### Éditeur & données
- EXPLAIN en un clic à côté de Run (sortie brute, plan **estimé** non exécutant — pas de plan graphique) *(v1)*. Précision (2026-07-16, revue sécurité) : pas un simple préfixe — MS SQL passe par le mécanisme `SHOWPLAN` dédié, et `EXPLAIN ANALYZE` (qui exécute réellement la requête) est une action distincte soumise au classifier ([[Decisions]] §5)
- Distinction NULL vs chaîne vide dans la grille et l'édition inline : affichage distinct + action « Set NULL » *(v1)*

### Agents (MCP)
- Tool `get_schema(profile, database?)` : tables, colonnes, types et clés étrangères dans un format compact, pour éviter que chaque agent requête `information_schema` à sa façon *(v1)*
- Plafond de lignes sur les réponses agent (ex. 1000), avec mention « résultat tronqué à N lignes » dans la réponse MCP — le total exact seulement s'il est déjà connu, jamais de `COUNT(*)` automatique *(v1)*
- Format de résultat économe en tokens : colonnes déclarées une fois, lignes en tableaux (pas un objet JSON par ligne) *(v1)*

### Écarté
- MariaDB : écarté pour l'instant
- Diagramme entité-relation **global** (payant chez Beekeeper) : backlog post-v1 — remplacé en v1 par l'aperçu local des relations ci-dessous

## Navigation (2026-07-16)

Double sidebar : un rail fin d'icônes global (profils, historique, requêtes sauvegardées, file de validation avec badge, settings) accolé à un panneau contextuel de la connexion active (sélecteur de database, arborescence schéma > tables/vues, recherche). Détails et comportement du sélecteur par moteur : [[Decisions]] §9. *(v1)*

## Aperçu des relations et des tables (2026-07-16)

Preview visuelle d'une table et de ses liens (1-n, n-n...), pensée lisible — voir [[Decisions]] §8 pour les règles (vue centrée 1 saut, nœuds compacts PK/FK, cardinalités sur les liens, expansion progressive, auto-layout). *(v1)*
