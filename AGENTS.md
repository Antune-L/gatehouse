# Gatehouse — architecture map for agents

Gatehouse is a Tauri (Rust + React) macOS SQL editor / database manager. The
product promise is a **control point** between humans, AI agents and databases:
agents use named profiles without credentials, reads are read-only, and every
write passes through a human validation queue. Full design lives in `docs/`
(`Decisions.md` is the source of truth; `Draft.md` scope; `DesignPrompt.md` UI).

## Stack

- Frontend: React 18 + Vite 6 + TypeScript, Tailwind v4, shadcn/ui, TanStack
  Table + Virtual, `@xyflow/react`, i18next (fr/en), zustand.
- Backend: Rust, Tauri v2, `sqlparser`, `rusqlite`, `aes-gcm`, `keyring`.

## Frontend layout (`src/`)

- `main.tsx` / `App.tsx` — entry + shell (Rail + ContextPanel + TopBar + main).
- `store.ts` — the single zustand store: profiles, workspace tabs, validation
  queue, history, saved queries, MCP clients, audit, settings. All UI state and
  actions live here. `classifyIntoQueue` builds queue entries from SQL.
- `lib/types.ts` — domain model. `lib/seed.ts` — deterministic sample database
  (a small e-commerce schema) so the app is fully functional without a server.
- `lib/sql.ts` — client-side `classify()` (mirrors the Rust classifier),
  `queryTable()` (sort/filter/paginate seed data) and `runSelect()` (a minimal
  SELECT executor for the editor demo runtime).
- `lib/i18n.ts` — all UI strings (no hardcoded strings in components).
- `components/ui/` — shadcn-style primitives.
- `components/layout/` — `Rail` (icon rail), `ContextPanel` (sidebar 2:
  connections tree, history, saved, queue summary, settings nav), `TopBar`.
- `components/workspace/Workspace.tsx` — tabbed main area (table tabs with
  Data/Structure/Relations sub-views, and SQL query tabs).
- `components/data/` — `DataGrid` (virtualized grid: sort, resize, GUI filters,
  staged inline edits, FK navigation, NULL handling, export/copy),
  `StructureView`, `RelationsView`.
- `components/editor/SqlEditor.tsx` — autocomplete, Run/EXPLAIN/Cancel, results.
- `components/queue/ValidationQueue.tsx` — the central differentiator screen.
- `components/settings/SettingsScreen.tsx` — MCP clients, per-profile agent
  access, audit log, shortcuts, language.
- `components/connection/ConnectionDialog.tsx` — the New Connection form.
- `components/CommandPalette.tsx` — Cmd+P table search / commands.

## Backend (`src-tauri/src/`)

- `lib.rs` — Tauri commands + `AppState` (store + queue). Registered commands:
  `classify_sql`, `list_profiles`, `save_profile`, `delete_profile`,
  `sqlite_list_tables`, `get_schema`, `test_connection`, `run_query`,
  `explain_query`, `request_write`, `queue_list`, `queue_resolve`,
  `queue_approve_execute`,
  `mcp_tool_schemas`. Data commands take a `profile_id`; credentials are
  resolved backend-side and never cross IPC.
- `classifier.rs` — read/write classifier via `sqlparser`; fail-closed; one
  statement per call; EXPLAIN ANALYZE and MySQL executable comments handled.
- `crypto.rs` — Keychain master key + AES-256-GCM with target-bound AAD.
- `store.rs` — SQLite profile/settings store; passwords encrypted at rest.
- `engine.rs` — SQLite read path (read-only open + authorizer = guaranteed
  read-only) + Postgres (reads on a `default_transaction_read_only=on`
  session, best-effort; no TLS yet). MySQL/MS SQL are scaffolded.
- `queue.rs` — in-memory validation queue (5-minute single-use approvals).
- `mcp.rs` — embedded MCP tool contract (Unix-socket transport is the target).

## Conventions

- No hardcoded UI strings — use i18next keys.
- Security invariants are non-negotiable (see `Decisions.md` §5/§10 and §13):
  credentials never cross the IPC boundary; agents never write directly; any
  ambiguity fails closed.

## Design

- Monitor any visual changes (vs maquette) in `DesignChanges.md`

## Commands

```bash
npm run dev            # frontend only (browser)
npm run app:dev        # full desktop app
npm run build          # typecheck + build frontend
npm run app:build      # standalone .app + .dmg bundle
npm run bump -- patch  # bump version everywhere (patch|minor|major|x.y.z)
cd src-tauri && cargo test   # backend unit tests (classifier)
```
