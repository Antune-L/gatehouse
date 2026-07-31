---
title: Prompt Claude Design — ébauche UI v1
date: 2026-07-16
tags:
  - design
  - prompt
status: draft
---

# Prompt global pour Claude Design

Prompt autonome (aucun accès aux docs du repo requis) reprenant tous les éléments v1 de [[Draft]], [[Decisions]] et [[SecurityFeedback]].

**Maquette générée (2026-07-16)** : https://claude.ai/code/artifact/f701e999-9f5a-4031-ac05-32de47b1ee69

---

Je veux une première ébauche d'interface (maquettes des écrans principaux) pour **Gatehouse**, une application desktop macOS de type **SQL Editor + Database Manager**, concurrente de Beekeeper Studio et TablePlus.

La signature du produit est **« Where agents meet your data »**. L'identité visuelle doit évoquer un point de passage moderne et rassurant entre les utilisateurs, les agents IA et leurs bases de données, sans tomber dans les codes visuels génériques de la cybersécurité.

## Contexte produit

- App desktop macOS standalone (Tauri : backend Rust + frontend React). UI en **Tailwind CSS + shadcn/ui** — privilégier les composants shadcn existants.
- Moteurs supportés : **Postgres, MySQL, SQLite, MS SQL**.
- Interface moderne, thème sombre en priorité, densité adaptée à un outil de données (beaucoup d'informations à l'écran, mais lisible).
- **Différenciateur clé** : l'app est pensée pour cohabiter avec des agents IA (Claude, Codex...) via un serveur MCP embarqué. Les agents interagissent avec des profils de connexion nommés **sans jamais voir les credentials**, leurs lectures s'exécutent en read-only, et **toute écriture (agent ou générée par l'UI) passe par une file de validation humaine**. Aucun outil du marché ne fait ça : l'UI doit rendre cette promesse visible et rassurante.

## Navigation globale — double sidebar

Pattern VS Code / Beekeeper : deux sidebars accolées.

**Sidebar 1 — rail fin d'icônes, global à l'app :**
- Connexions / profils, groupés par projet (ex. un projet = DB locale + staging + production), chaque profil a une couleur
- Historique des requêtes
- Requêtes sauvegardées
- **File de validation, avec badge compteur** — une écriture agent en attente doit être visible depuis n'importe quel écran
- Settings (en bas)

**Sidebar 2 — panneau contextuel de la connexion active :**
- En haut : sélecteur de database (dropdown ; absent pour SQLite où un fichier = une base)
- Arborescence : schéma > tables / vues / vues matérialisées
- Recherche de table — **Cmd+P** ouvre la même recherche en palette de commandes

## Écrans à maquetter

### 1. Gestion des connexions
- Formulaire "New Connection" inspiré de Beekeeper : type de connexion, méthode d'auth, host/port, toggle **Enable SSL**, user/password, default database, toggle **SSH Tunnel**, checkbox **Read Only Mode** (côté humain, typiquement pour la production), bouton **Test** avant Connect/Save, import depuis une URL `postgres://...`, nom + groupe + pastille couleur à la sauvegarde.
- Par profil : un flag "accès agent" (désactivé par défaut).
- Indicateur d'état de connexion (connecté / reconnexion / déconnecté) avec reconnexion automatique.
- **Badge read-only honnête par connexion** : "garanti" (enforcement moteur) vs "best-effort" (classification) — deux styles visuellement distincts, l'environnement (prod/staging) signalé autrement que par la seule couleur.

### 2. Grille de données (contenu d'une table)
- Infinite scroll, colonnes redimensionnables avec le **type affiché** dans l'en-tête, tri par colonne.
- Filtres GUI par colonne (colonne + opérateur + valeur, cumulables sans limite) + filtre SQL libre.
- Édition inline **stagée** : les modifications ne partent pas en base, elles s'accumulent avec un code couleur (modifié / inséré / supprimé) puis rejoignent la file de validation. Insertion, suppression, duplication de lignes.
- Distinction visuelle **NULL vs chaîne vide** + action "Set NULL".
- **Navigation par clé étrangère** : clic sur une valeur FK ouvre l'enregistrement lié.
- Visionneuse pour grandes valeurs (JSON, texte long) en modal ou sidebar, avec coloration syntaxique.
- Export facile + copie presse-papiers (CSV, JSON, Markdown, INSERT).
- Mention du `LIMIT` implicite appliqué à l'affichage (configurable).
- **Cmd+F** pour chercher dans la table.

### 3. Éditeur SQL
- Onglets multiples (persistés entre sessions), autocomplete (tables, colonnes), historique par connexion (incluant les requêtes des agents, identifiées comme telles), requêtes sauvegardées.
- Boutons : **Run**, **EXPLAIN** (sortie brute), **annuler la requête en cours**.
- Les requêtes tapées par l'humain s'exécutent directement (pas de file de validation) — c'est une intention explicite.

### 4. File de validation (écran central du produit)
- Liste unifiée des écritures en attente : éditions UI stagées, écritures demandées par un agent, DDL généré par l'éditeur de schéma.
- Pour chaque entrée : le **SQL exact**, l'estimation des lignes affectées (ou les objets affectés + niveau de risque pour du DDL), **l'origine** (humain / UI générée / client MCP identifié), la cible (profil, base, environnement).
- Actions : approuver / rejeter, avec **confirmation renforcée** pour la production et les opérations destructrices.
- Anciennes vs nouvelles valeurs affichées pour les éditions de lignes.

### 5. Aperçu des relations (pas d'ERD global)
- Vue **locale centrée sur une table** : la table au centre, ses voisines directes par FK autour (1 saut), expansion progressive au clic.
- Nœuds compacts : nom de table + PK + FK seulement, compteur "+N colonnes" dépliable.
- **Cardinalités sur les liens** (1-n, n-n), liens ancrés colonne-à-colonne (de `orders.user_id` vers `users.id`), auto-layout propre.
- Accessible depuis l'onglet Structure d'une table ; clic sur un lien mène aux données.

### 6. Structure d'une table
- Onglet Structure : colonnes, types, index, contraintes, triggers, DDL.
- Édition de schéma via UI (create/alter table, colonnes, index, FK) — le DDL généré passe par la file de validation.

### 7. Settings — section Agents (MCP)
- Liste des **clients MCP connectés** (nom, dernière activité) avec révocation immédiate.
- Par profil : accès agent on/off (off par défaut), scope d'accès, option "lecture agent interdite sur production".
- Journal d'audit des accès agents (client, profil, type de requête, heure, approuvé/rejeté).

## Raccourcis clavier à faire sentir dans l'UI
Cmd+P (chercher une table / palette), Cmd+F (chercher dans une table) ; l'app est pensée keyboard-first, montrer les hints là où c'est pertinent.

## Attendu
Une première ébauche des écrans ci-dessus, en commençant par : la vue principale (double sidebar + grille de données + onglets SQL), la file de validation, et le formulaire de connexion. Thème sombre d'abord. Cohérence shadcn/ui.
