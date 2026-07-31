# Alignement app ↔ maquette « SQL Studio - Maquettes v1 »

State file for a multi-session task (per CLAUDE.md). Maquette source: claude.ai/design
project `df0623b6-bfa2-4da4-8ef1-8cc5e66e78b7`, file `SQL Studio - Maquettes v1.dc.html`,
readable via the `DesignSync` tool (get_project/list_files/get_file by projectId).
Rendered screenshots live in the session scratchpad as `maq_*.png`.

## Décisions actées
- **Nom produit = Gatehouse** (maquette dit « SQL Studio » = titre de travail ; on
  aligne le wordmark de la maquette sur « Gatehouse », pas l'inverse).
- **2 thèmes uniquement** : Vert clair (défaut) + Bleu sombre. **Pas d'ambre.**

## Palettes (extraites de la maquette)
### Vert clair (light, défaut)
bg `#fbfcef` · card `#f6f7e8` · shell/rail `#e8edd4`/`#dde7c7` · panel `#f2f4dd` ·
panel-2 `#e2e8cd` · elevated `#edeec9` · foreground `#2b3d33` · muted-fg `#5a6e60`/`#7a8d7c` ·
brand `#3d7a62` · brand-muted `#dcefe4` · border `#d4dec2` / strong `#c8d4b8` ·
destructive `#c96f5f` · warning `#d9a441` · info `#5899e2` · dots `#fe5f57`/`#febb2e`/`#28c840`

### Bleu sombre (dark)
bg `#152036` · card `#1b2845` · shell/rail `#0e1a30` · panel `#1b2845` · panel-2 `#223250` ·
elevated `#274060` · foreground `#eaf3ff` · muted-fg `#7fa0c6`/`#8fb3d9` · brand `#5899e2` ·
brand-muted `#22406b` · border `#2c4569` / strong `#3f6ea8` · destructive `#e07a6f` ·
warning `#febb2e` · info `#65afff` · success `#6fd3a0`

## Écarts + ordre d'alignement (statut) — TOUS FAITS
- [x] **A** — Système de thème : 2 palettes complètes (vert clair défaut + bleu sombre).
- [x] **Seed/branding** — profils acme locale/staging/production + Perso notes.sqlite,
      base acme_prod, tables customers/invoices ajoutées, agents claude-code/codex,
      langue par défaut fr. Timestamps queue/agents ancrés à l'horloge réelle.
- [x] **C+B** — Settings : sections **Apparence** (cartes-radio aperçu + swatches) +
      **Éditeur** ajoutées, Général restructuré (LIMIT/reconnexion/restore/export/langue),
      Agents refait (serveur actif/clients/accès par profil/journal fr), Raccourcis + filtre.
      `SettingsScreen.tsx` réécrit ; nav `ContextPanel` étendue.
- [x] **D** — Settings › Éditeur : autocomplétion, casse, taille police, exécuter sélection,
      rétention (tous branchés au store `AppSettings`).
- [x] **G+H** — `TitleBar` plein largeur (wordmark + pills acme·production/RO·GARANTI/Connecté,
      espace réservé boutons macOS natifs). Barre de statut basse dans `DataGrid`
      (stagées→Réviser, LIMIT appliqué·modifier, `AgentActivity`). Toolbar grille :
      `ViewTabs` + chips filtre inline + Exporter + Ligne + gutter n° de ligne + insert/delete stagés.
- [x] **E** — `SqlEditor` : panneau Historique/Sauvegardées à droite + autocomplete riche
      (badges col/tbl/kw, type, table source), toolbar Run/EXPLAIN/Annuler, taille police liée.
- [x] **F** — `ConnectionsManager` plein 2-panneaux (cadres pointillés + Groupe/Nouvelle,
      détail Hôte/Base/SSL/Reconnexion + Accès agent + Modifier/Tester/Connecter). Ouvert
      depuis l'en-tête connexion du ContextPanel ; le modal `ConnectionDialog` reste pour le form.
- [x] **I** — `TitleBar` : wordmark Gatehouse + padding gauche pour les vrais boutons macOS
      (pas de pastilles décorées — ce sont les contrôles natifs de la fenêtre).
- [x] **Queue** — libellés traduits fr (risque, instruction, colonne, confirmation renforcée,
      origines), countdown d'expiration corrigé (`formatCountdown`).

## Vérif finale
`tsc --noEmit` OK · `eslint src` 0 error (6 warnings préexistants) · `npm run build` OK.
Vérifié visuellement (Playwright) : main, settings×5, éditeur+autocomplete, manager, queue, thème bleu.

## Déjà conformes (recolor seulement)
File de validation (2b), Relations (2d), Structure, coloration SQL (mots-clés violets OK).

## Fait avant l'audit (ok, à garder)
Export résultats éditeur, TopBar hauteurs égales, suppression « Filter tables », ESLint
flat-config fonctionnel, palette ⌘P sans useEffect.
