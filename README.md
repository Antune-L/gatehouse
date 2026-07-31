# Gatehouse

> **Where agents meet your data**

Gatehouse is a macOS SQL editor and database manager built as a **control point**
between you, your AI agents, and your databases. Agents interact with named
connection profiles **without ever seeing credentials**, their reads run
read-only, and **every write — from you, the UI, or an agent — passes through a
human validation queue**.

Supported engines: **PostgreSQL, MySQL, SQLite, MS SQL Server**.

## Install

Download the `.dmg` for your Mac from the
[latest release](../../releases/latest) — `aarch64` for Apple Silicon, `x64`
for Intel — and drag Gatehouse into `/Applications`.

### First launch

Releases are not signed with an Apple Developer ID, so Gatekeeper blocks the
app the first time you open it. This is a one-time step — pick either path:

**Without the Terminal.** Open Gatehouse once and dismiss the warning dialog,
then go to **System Settings → Privacy & Security**, scroll down to the
Security section, and click **Open Anyway** next to Gatehouse. Confirm and
authenticate with your admin password. (Since macOS 15, the old
right-click → Open shortcut no longer works — System Settings is the only
GUI path.)

**With the Terminal.** Clear the quarantine flag once after dragging the app
into `/Applications`:

```bash
xattr -dr com.apple.quarantine /Applications/Gatehouse.app
```

Prefer building from source? `npm run app:build` produces the same
`Gatehouse.app` locally, with no Gatekeeper prompt at all.

Maintainers: see [docs/Releasing.md](docs/Releasing.md) for how releases are
cut and published.

## Quick start

```bash
npm install            # install frontend deps
npm run dev            # run the UI in a browser at http://localhost:1420
npm run app:dev        # run the full desktop app (Tauri, native window)
npm run app:build      # build a standalone Gatehouse.app bundle
```

`npm run dev` runs the frontend standalone with a seeded sample database, so you
can explore every screen without connecting to a real server. `npm run app:dev`
runs the same UI inside the Tauri shell backed by the Rust engine.

## What's inside

- **Frontend** — React + Vite + TypeScript, Tailwind CSS v4, shadcn/ui,
  TanStack Table/Virtual (virtualized grid), React Flow (relations), i18next
  (French + English).
- **Backend** — Rust (Tauri v2): SQL read/write classifier (`sqlparser`),
  SQLite engine with a read-only authorizer, AES-256-GCM encrypted profile
  store with a Keychain master key, in-memory validation queue, and the
  embedded MCP tool surface.

## Core guarantees

- Credentials never leave the Rust backend.
- An agent never executes a write directly — it files a `request_write` that a
  human approves.
- Read-only is enforced by the engine where possible, with an honest
  three-state badge: **guaranteed · best-effort · unknown**.
- Any ambiguity about scope, privilege, identity or integrity fails closed.

## Connect an AI agent (MCP)

Gatehouse embeds an [MCP](https://modelcontextprotocol.io) server. Agents talk
to it through `gatehouse-mcp`, a small stdio proxy that forwards to a local
Unix socket owned by the running app — no TCP port, and the agent never sees
credentials: it addresses profiles by name, reads run read-only, and every
write lands in the validation queue for human approval.

**1. Pair the client.** Launch Gatehouse, open **Settings → Agents**, create a
client (e.g. `claude-code`) and copy the pairing token — it is shown only
once; Gatehouse stores only its hash. Revoking the client from the same screen
cuts access immediately.

**2. Enable agent access per profile.** In the same screen, toggle the
connection profiles the agent may use. Production profiles can never be
enabled.

**3. Register the proxy in your MCP client.** The proxy ships inside the app
bundle at `Gatehouse.app/Contents/MacOS/gatehouse-mcp`; from a source
checkout, build it with `npm run mcp:proxy` (output:
`src-tauri/target/release/gatehouse-mcp`). The Gatehouse app must be running
when the agent connects.

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add gatehouse \
  -e GATEHOUSE_TOKEN=<paste-your-token> \
  -- /Applications/Gatehouse.app/Contents/MacOS/gatehouse-mcp
```

Add `--scope user` to make the server available in every project, then check
the connection with `/mcp` inside Claude Code.

</details>

<details>
<summary><strong>Codex</strong></summary>

```bash
codex mcp add gatehouse \
  --env GATEHOUSE_TOKEN=<paste-your-token> \
  -- /Applications/Gatehouse.app/Contents/MacOS/gatehouse-mcp
```

Or declare it directly in `~/.codex/config.toml`:

```toml
[mcp_servers.gatehouse]
command = "/Applications/Gatehouse.app/Contents/MacOS/gatehouse-mcp"
env = { GATEHOUSE_TOKEN = "<paste-your-token>" }
```

</details>

The agent gets four tools: `list_profiles`, `get_schema`, `query` (read-only,
capped at 1000 rows / 5 MiB) and `request_write` (files a request in the
validation queue and returns its id — never a result before approval). Set
`GATEHOUSE_SOCKET` to override the socket path (default:
`~/Library/Application Support/Gatehouse/gatehouse.sock`).

## Learn more

See `docs/` for the full design (`Decisions.md`, `DesignPrompt.md`, `Draft.md`)
and `AGENTS.md` for the architecture map.
