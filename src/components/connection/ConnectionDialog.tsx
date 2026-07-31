import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, Link as LinkIcon, Check, X } from "lucide-react";
import { useStore } from "@/store";
import { inTauri } from "@/lib/ipc";
import { isRealProfile, pickSqliteFile, testProfileConnection } from "@/lib/backend";
import type { ConnectionProfile, Engine, Environment } from "@/lib/types";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const ENGINE_OPTIONS: { value: Engine; label: string; port: number }[] = [
  { value: "postgres", label: "Postgres", port: 5432 },
  { value: "mysql", label: "MySQL", port: 3306 },
  { value: "sqlite", label: "SQLite", port: 0 },
  { value: "mssql", label: "SQL Server", port: 1433 },
];

const SAVE_COLORS = [
  "#f26d6d", "#f2994a", "#f2c94c", "#3ac47d", "#4a9bf2", "#9b6df2", "#f26dbb",
];

const TEST_LATENCY_MS = 38;

export function ConnectionDialog() {
  const open = useStore((s) => s.connectionDialogOpen);
  const close = useStore((s) => s.closeConnectionDialog);
  const editingId = useStore((s) => s.editingProfileId);
  const profiles = useStore((s) => s.profiles);
  const editing = profiles.find((p) => p.id === editingId);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent
        hideClose
        className="max-w-[960px] gap-0 overflow-hidden border-border bg-background p-0"
      >
        <ConnectionForm key={editingId ?? "new"} editing={editing} onClose={close} />
      </DialogContent>
    </Dialog>
  );
}

function ConnectionForm({
  editing,
  onClose,
}: {
  editing?: ConnectionProfile;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const save = useStore((s) => s.saveProfile);
  const groupOrder = useStore((s) => s.groupOrder);

  const [engine, setEngine] = useState<Engine>(editing?.engine ?? "postgres");
  const [auth, setAuth] = useState("password");
  const [host, setHost] = useState(editing?.host ?? "localhost");
  const [port, setPort] = useState(String(editing?.port ?? 5432));
  const [ssl, setSsl] = useState(editing?.ssl ?? false);
  const [user, setUser] = useState(editing?.user ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [database, setDatabase] = useState(editing?.database ?? "");
  const [ssh, setSsh] = useState(editing?.sshTunnel ?? false);
  const [sshHost, setSshHost] = useState(editing?.sshHost ?? "");
  const [sshPort, setSshPort] = useState(String(editing?.sshPort || 22));
  const [sshUser, setSshUser] = useState(editing?.sshUser ?? "");
  const [sshKeyPath, setSshKeyPath] = useState(editing?.sshKeyPath ?? "");
  const [sshSecret, setSshSecret] = useState("");
  const [readOnly, setReadOnly] = useState(editing?.readOnly ?? false);
  const [name, setName] = useState(editing?.name ?? "");
  const [group, setGroup] = useState(editing?.group ?? groupOrder[0] ?? "");
  const [environment, setEnvironment] = useState<Environment>(
    editing?.environment ?? "local"
  );
  const [savePassword, setSavePassword] = useState(editing?.savePassword ?? true);
  const [color, setColor] = useState(editing?.color ?? "");
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "fail">(
    "idle"
  );
  const [testLatency, setTestLatency] = useState(TEST_LATENCY_MS);
  const [importOpen, setImportOpen] = useState(false);
  const [importValue, setImportValue] = useState("");
  const [importFailed, setImportFailed] = useState(false);

  const isSqlite = engine === "sqlite";
  const realSqlite = isSqlite && inTauri();

  function selectEngine(v: Engine) {
    setEngine(v);
    const opt = ENGINE_OPTIONS.find((o) => o.value === v);
    if (opt && opt.port) setPort(String(opt.port));
  }

  function buildProfile(id: string): ConnectionProfile {
    return {
      id,
      name: name || host || "New connection",
      engine,
      group: group || groupOrder[0] || "Ungrouped",
      color: color || SAVE_COLORS[3],
      host,
      port: Number(port) || 0,
      user,
      database: database || (isSqlite ? "database.db" : "postgres"),
      environment,
      ssl,
      sshTunnel: ssh && !isSqlite,
      sshHost,
      sshPort: Number(sshPort) || 22,
      sshUser,
      sshKeyPath,
      readOnly,
      agentAccess: editing?.agentAccess ?? false,
      readOnlyBadge: badge,
      state: "connected",
      savePassword,
    };
  }

  function runTest() {
    setTestState("testing");
    const candidate = buildProfile(editing?.id ?? "p_unsaved_test");
    if (isRealProfile(candidate)) {
      void testProfileConnection(
        candidate,
        password || undefined,
        sshSecret || undefined
      ).then((r) => {
        setTestLatency(r.latencyMs);
        setTestState(r.ok ? "ok" : "fail");
      });
      return;
    }
    setTimeout(() => {
      setTestLatency(TEST_LATENCY_MS);
      setTestState(host || isSqlite ? "ok" : "fail");
    }, 700);
  }

  function browseSqliteFile() {
    void pickSqliteFile().then((path) => {
      if (path) setDatabase(path);
    });
  }

  // NOTE: no window.prompt/alert here — native dialogs block the WKWebView
  // event loop in Tauri; the import is an inline row under the header instead.
  function applyImportUrl() {
    try {
      const u = new URL(importValue);
      const eng = u.protocol.replace(":", "");
      if (eng.startsWith("postgres")) selectEngine("postgres");
      else if (eng.startsWith("mysql")) selectEngine("mysql");
      setHost(u.hostname);
      if (u.port) setPort(u.port);
      if (u.username) setUser(decodeURIComponent(u.username));
      if (u.password) setPassword(decodeURIComponent(u.password));
      setDatabase(u.pathname.replace(/^\//, ""));
      setImportOpen(false);
      setImportValue("");
      setImportFailed(false);
    } catch {
      setImportFailed(true);
    }
  }

  function computeBadge(): ConnectionProfile["readOnlyBadge"] {
    if (engine === "sqlite") return "guaranteed";
    if (readOnly && engine === "mssql") return "unknown";
    return "best-effort";
  }
  const badge = computeBadge();

  function onSave() {
    save(
      buildProfile(editing?.id ?? `p_${Date.now()}`),
      password || undefined,
      sshSecret || undefined
    );
  }

  return (
    <div className="flex max-h-[88vh] flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <h2 className="text-[20px] font-bold tracking-tight text-foreground">
          {t("conn.newConnection")}
        </h2>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setImportOpen((v) => !v)}
            className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground hover:text-brand"
          >
            <LinkIcon className="h-3.5 w-3.5" />
            {t("conn.importUrl")}
          </button>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-panel-2 hover:text-foreground"
            aria-label={t("common.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {importOpen && (
        <div className="border-b border-border px-6 py-3">
          <div className="flex items-center gap-2">
            <input
              autoFocus
              autoCorrect="off"
              spellCheck={false}
              value={importValue}
              onChange={(e) => {
                setImportValue(e.target.value);
                setImportFailed(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyImportUrl();
              }}
              placeholder={t("conn.importPrompt")}
              className="h-9 flex-1 rounded-lg border border-input bg-input-bg px-3 text-[13px] outline-none focus:border-border-strong"
            />
            <Button variant="outline" size="sm" onClick={applyImportUrl}>
              {t("common.apply")}
            </Button>
          </div>
          {importFailed && (
            <p className="mt-1.5 text-[12px] text-destructive">
              {t("conn.importError")}
            </p>
          )}
        </div>
      )}

      {/* Two columns */}
      <div className="grid min-h-0 flex-1 grid-cols-2 overflow-y-auto">
        {/* Left — connection */}
        <div className="space-y-4 border-r border-border p-6">
          <SectionLabel>{t("conn.sectionConnection")}</SectionLabel>

          <div className={cn("grid gap-3", isSqlite ? "grid-cols-1" : "grid-cols-2")}>
            <Field label={t("conn.type")}>
              <Select value={engine} onValueChange={(v) => selectEngine(v as Engine)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENGINE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {!isSqlite && (
              <Field label={t("conn.authMethod")}>
                <Select value={auth} onValueChange={setAuth}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="password">{t("conn.authPassword")}</SelectItem>
                    <SelectItem value="iam">{t("conn.authIam")}</SelectItem>
                    <SelectItem value="none">{t("conn.authNone")}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}
          </div>

          {!isSqlite ? (
            <>
              <div className="grid grid-cols-[1fr_120px] gap-3">
                <Field label={t("conn.host")}>
                  <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="localhost" />
                </Field>
                <Field label={t("conn.port")}>
                  <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="5432" />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label={t("conn.user")}>
                  <Input value={user} onChange={(e) => setUser(e.target.value)} />
                </Field>
                <Field label={t("conn.password")}>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="pr-9"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </Field>
              </div>

              <Field label={t("conn.defaultDatabase")}>
                <Input value={database} onChange={(e) => setDatabase(e.target.value)} />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <ToggleBox label={t("conn.enableSsl")} checked={ssl} onChange={setSsl} />
                <ToggleBox label={t("conn.sshTunnel")} checked={ssh} onChange={setSsh} />
              </div>

              {ssh && (
                <div className="space-y-3 rounded-lg border border-border bg-panel px-4 py-3">
                  <div className="grid grid-cols-[1fr_120px] gap-3">
                    <Field label={t("conn.sshHost")}>
                      <Input
                        value={sshHost}
                        onChange={(e) => setSshHost(e.target.value)}
                        placeholder="bastion.example.com"
                      />
                    </Field>
                    <Field label={t("conn.sshPort")}>
                      <Input
                        value={sshPort}
                        onChange={(e) => setSshPort(e.target.value)}
                        placeholder="22"
                      />
                    </Field>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t("conn.sshUser")}>
                      <Input value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
                    </Field>
                    <Field label={t("conn.sshSecret")}>
                      <Input
                        type="password"
                        value={sshSecret}
                        onChange={(e) => setSshSecret(e.target.value)}
                        placeholder={t("conn.sshSecretHint")}
                      />
                    </Field>
                  </div>
                  <Field label={t("conn.sshKeyPath")}>
                    <Input
                      value={sshKeyPath}
                      onChange={(e) => setSshKeyPath(e.target.value)}
                      placeholder="~/.ssh/id_ed25519"
                    />
                  </Field>
                  <p className="text-[12px] text-muted-foreground">
                    {t("conn.sshAgentHint")}
                  </p>
                </div>
              )}
            </>
          ) : (
            <Field label={t("conn.dbFile")}>
              <div className="flex items-center gap-2">
                <Input
                  value={database}
                  onChange={(e) => setDatabase(e.target.value)}
                  placeholder="~/path/to/database.db"
                />
                {realSqlite && (
                  <Button variant="outline" onClick={browseSqliteFile}>
                    {t("conn.browse")}
                  </Button>
                )}
              </div>
            </Field>
          )}

          <label className="flex cursor-pointer items-center gap-2.5 pt-1">
            <Checkbox checked={readOnly} onCheckedChange={(v) => setReadOnly(!!v)} />
            <span className="text-[14px] text-foreground">{t("conn.readOnly")}</span>
          </label>
        </div>

        {/* Right — save */}
        <div className="flex flex-col p-6">
          <SectionLabel>{t("conn.sectionSave")}</SectionLabel>

          <div className="space-y-4">
            <Field label={t("conn.profileName")}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("conn.connectionName")}
              />
            </Field>

            <Field label={t("conn.groupProject")}>
              <GroupCombobox
                value={group}
                onChange={setGroup}
                options={groupOrder}
                placeholder={t("conn.groupPlaceholder")}
              />
            </Field>

            <Field label={t("conn.environment")}>
              <Select value={environment} onValueChange={(v) => setEnvironment(v as Environment)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">{t("conn.envLocal")}</SelectItem>
                  <SelectItem value="staging">{t("conn.envStaging")}</SelectItem>
                  <SelectItem value="production">{t("conn.envProduction")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <div>
              <label className="mb-1.5 block text-[13px] text-muted-foreground">
                {t("conn.color")}
              </label>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setColor("")}
                  className={cn(
                    "h-5 w-5 rounded-full border border-border-strong",
                    !color && "ring-2 ring-brand ring-offset-2 ring-offset-background"
                  )}
                />
                {SAVE_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={cn(
                      "h-5 w-5 rounded-full transition-transform hover:scale-110",
                      color === c && "ring-2 ring-foreground ring-offset-2 ring-offset-background"
                    )}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>

            <label className="flex cursor-pointer items-center gap-2.5">
              <Checkbox checked={savePassword} onCheckedChange={(v) => setSavePassword(!!v)} />
              <span className="text-[14px] text-foreground">{t("conn.savePasswords")}</span>
            </label>
          </div>

          <div className="mt-auto flex justify-end pt-6">
            <Button variant="outline" onClick={onSave} className="min-w-[110px]">
              {t("common.save")}
            </Button>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border px-6 py-3">
        <div className="text-[12.5px] text-muted-foreground">
          {testState === "ok" && (
            <span className="flex items-center gap-1.5 text-success">
              <span className="h-2 w-2 rounded-full bg-success" />
              {t("conn.testOk")} · {testLatency} ms
            </span>
          )}
          {testState === "fail" && (
            <span className="text-destructive">{t("conn.testFail")}</span>
          )}
          {testState === "testing" && <span>{t("conn.testing")}</span>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={runTest} className="min-w-[90px]">
            {testState === "ok" ? <Check className="h-4 w-4 text-success" /> : null}
            {t("common.test")}
          </Button>
          <Button variant="brand" onClick={onSave} className="min-w-[110px]">
            {t("common.connect")}
          </Button>
        </div>
      </div>
    </div>
  );
}

// NOTE: the native <datalist> popup follows the system theme in WKWebView and
// can render white-on-white — hand-rolled suggestions instead.
function GroupCombobox({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const query = value.trim().toLowerCase();
  const matches = query
    ? options.filter((g) => g.toLowerCase().includes(query))
    : options;
  const shown = matches.length === 1 && matches[0] === value ? [] : matches;

  return (
    <div className="relative">
      <Input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        placeholder={placeholder}
      />
      {open && shown.length > 0 && (
        <div className="absolute inset-x-0 top-full z-50 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-2xl">
          {shown.map((g) => (
            <button
              key={g}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(g);
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-[13px] hover:bg-accent hover:text-accent-foreground"
            >
              {g}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-[13px] text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function ToggleBox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-input-bg px-4 py-2.5">
      <span className="text-[13.5px] font-medium text-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
