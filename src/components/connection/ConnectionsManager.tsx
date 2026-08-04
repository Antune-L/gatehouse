import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  Copy,
  Folder,
  Plus,
  ShieldAlert,
  X,
  Trash2,
  GripVertical,
} from "lucide-react";
import { useStore } from "@/store";
import { isRealProfile, testProfileConnection } from "@/lib/backend";
import type { ConnectionProfile, Engine, QueueEntry } from "@/lib/types";
import { ColorDot, engineLabel } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, formatRelativeTime } from "@/lib/utils";

const COPY_FEEDBACK_MS = 1600;
const DEMO_TEST_DELAY_MS = 700;
const DEMO_TEST_LATENCY_MS = 38;
const MAX_PENDING_WRITES = 6;
const MAX_RECENT_QUERIES = 5;
const MAX_SAVED_QUERIES = 5;
const EMPTY_VALUE = "—";
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];
const PENDING_STATUSES: QueueEntry["status"][] = ["pending", "approved"];
const ENGINE_SCHEMES: Record<Engine, string> = {
  postgres: "postgres",
  mysql: "mysql",
  mssql: "mssql",
  sqlite: "sqlite",
};

const PANEL_TONE_CLASS = {
  default: "border-border bg-card",
  warning: "border-warning/40 bg-warning/5",
};

const INFO_TONE_CLASS = {
  default: "text-foreground",
  success: "text-success",
  danger: "text-destructive",
};

type PanelTone = keyof typeof PANEL_TONE_CLASS;
type InfoTone = keyof typeof INFO_TONE_CLASS;
type ActivityItem = { id: string; label: string; meta: string };

type Drag =
  | { kind: "profile"; id: string }
  | { kind: "group"; group: string }
  | null;

type PendingDelete =
  | { kind: "profile"; profile: ConnectionProfile }
  | { kind: "group"; group: string; count: number };

export function ConnectionsManager() {
  const { t } = useTranslation();
  const profiles = useStore((s) => s.profiles);
  const groupOrder = useStore((s) => s.groupOrder);
  const managerProfileId = useStore((s) => s.managerProfileId);
  const setManagerProfile = useStore((s) => s.setManagerProfile);
  const openConnectionDialog = useStore((s) => s.openConnectionDialog);
  const addGroup = useStore((s) => s.addGroup);
  const deleteGroup = useStore((s) => s.deleteGroup);
  const deleteProfile = useStore((s) => s.deleteProfile);
  const moveProfile = useStore((s) => s.moveProfile);
  const moveGroup = useStore((s) => s.moveGroup);
  const setActiveProfile = useStore((s) => s.setActiveProfile);
  const close = useStore((s) => s.closeConnectionsManager);

  const [drag, setDrag] = useState<Drag>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  function confirmPendingDelete() {
    if (!pendingDelete) return;
    if (pendingDelete.kind === "profile") deleteProfile(pendingDelete.profile.id);
    else deleteGroup(pendingDelete.group);
    setPendingDelete(null);
  }

  function connectTo(id: string) {
    setActiveProfile(id);
    close();
  }

  const selected =
    profiles.find((p) => p.id === managerProfileId) ?? profiles[0] ?? null;

  function dropInGroup(group: string, index: number) {
    if (!drag) return;
    if (drag.kind === "profile") moveProfile(drag.id, group, index);
    setDrag(null);
  }

  function dropOnGroupFrame(group: string, groupIndex: number, count: number) {
    if (!drag) return;
    if (drag.kind === "profile") moveProfile(drag.id, group, count);
    else if (drag.kind === "group" && drag.group !== group)
      moveGroup(drag.group, groupIndex);
    setDrag(null);
  }

  return (
    <div className="flex h-full">
      {/* Left: profile list */}
      <aside className="flex w-[360px] shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="flex items-center gap-2 px-4 py-3">
          <h1 className="text-[17px] font-bold tracking-tight text-foreground">
            {t("connScreen.title")}
          </h1>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={addGroup}>
              <Plus className="h-3.5 w-3.5" /> {t("connScreen.newGroup")}
            </Button>
            <Button variant="brand" size="sm" onClick={() => openConnectionDialog()}>
              <Plus className="h-3.5 w-3.5" /> {t("connScreen.newProfile")}
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
          {groupOrder.map((group, groupIndex) => {
            const ps = profiles.filter((p) => p.group === group);
            return (
              <div
                key={group}
                onDragOver={(e) => {
                  if (drag) e.preventDefault();
                }}
                onDrop={() => dropOnGroupFrame(group, groupIndex, ps.length)}
                className={cn(
                  "rounded-xl border border-dashed p-2.5 transition-colors",
                  drag ? "border-brand/50" : "border-border-strong"
                )}
              >
                <div
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", group);
                    e.dataTransfer.effectAllowed = "move";
                    setDrag({ kind: "group", group });
                  }}
                  onDragEnd={() => setDrag(null)}
                  className="mb-2 flex cursor-grab items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground active:cursor-grabbing"
                >
                  <GripVertical className="h-3.5 w-3.5 opacity-50" />
                  <Folder className="h-3.5 w-3.5" />
                  {group}
                  <span className="ml-auto flex items-center gap-2 normal-case tracking-normal">
                    <span>
                      {ps.length}{" "}
                      {ps.length > 1 ? t("connScreen.profiles") : t("connScreen.profile")}
                    </span>
                    <button
                      onClick={() => {
                        if (ps.length === 0) deleteGroup(group);
                        else setPendingDelete({ kind: "group", group, count: ps.length });
                      }}
                      title={t("connScreen.deleteGroup")}
                      className="rounded p-0.5 text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
                <div className="space-y-2">
                  {ps.length === 0 && (
                    <div className="rounded-lg border border-dashed border-border py-3 text-center text-[11px] text-muted-foreground/60">
                      {t("connScreen.emptyGroup")}
                    </div>
                  )}
                  {ps.map((p, index) => {
                    const active = p.id === selected?.id;
                    return (
                      <div
                        key={p.id}
                        draggable
                        onDragStart={(e) => {
                          e.stopPropagation();
                          e.dataTransfer.setData("text/plain", p.id);
                          e.dataTransfer.effectAllowed = "move";
                          setDrag({ kind: "profile", id: p.id });
                        }}
                        onDragEnd={() => setDrag(null)}
                        onDragOver={(e) => {
                          if (drag?.kind === "profile") e.preventDefault();
                        }}
                        onDrop={(e) => {
                          e.stopPropagation();
                          dropInGroup(group, index);
                        }}
                        onClick={() => setManagerProfile(p.id)}
                        onDoubleClick={() => connectTo(p.id)}
                        className={cn(
                          "group flex w-full cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                          active
                            ? "border-brand bg-card ring-1 ring-brand/30"
                            : "border-border bg-panel-2/50 hover:border-border-strong"
                        )}
                      >
                        <ColorDot color={p.color} className="h-2.5 w-2.5" />
                        <div className="min-w-0 flex-1">
                          <div className="text-[13.5px] font-semibold text-foreground">
                            {p.name}
                          </div>
                          <div className="truncate text-[11.5px] text-muted-foreground">
                            {engineLabel(p.engine)} · {p.host || p.database}
                          </div>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingDelete({ kind: "profile", profile: p });
                          }}
                          title={t("connScreen.deleteProfile")}
                          className="rounded p-0.5 text-muted-foreground/50 opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                        {p.state === "reconnecting" ? (
                          <span className="flex items-center gap-1 text-[11px] text-warning">
                            <span className="h-3 w-3 animate-spin rounded-full border-2 border-warning border-t-transparent" />
                            {t("connScreen.reconnecting")}
                          </span>
                        ) : (
                          <span
                            className={cn(
                              "h-2 w-2 rounded-full",
                              p.state === "connected"
                                ? "bg-success"
                                : "bg-muted-foreground/40"
                            )}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      {/* Right: profile detail */}
      {selected && (
        <ProfileDetail
          key={selected.id}
          profile={selected}
          onConnect={() => connectTo(selected.id)}
          onClose={close}
        />
      )}

      <Dialog
        open={!!pendingDelete}
        onOpenChange={(o) => !o && setPendingDelete(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pendingDelete?.kind === "group"
                ? t("connScreen.confirmDeleteGroupTitle")
                : t("connScreen.confirmDeleteTitle")}
            </DialogTitle>
          </DialogHeader>
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            {pendingDelete?.kind === "profile" &&
              t("connScreen.confirmDeleteProfile", {
                name: pendingDelete.profile.name,
              })}
            {pendingDelete?.kind === "group" &&
              t("connScreen.confirmDeleteGroup", {
                name: pendingDelete.group,
                count: pendingDelete.count,
              })}
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={confirmPendingDelete}>
              {t("common.delete")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProfileDetail({
  profile,
  onConnect,
  onClose,
}: {
  profile: ConnectionProfile;
  onConnect: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toggleAgentAccess = useStore((s) => s.toggleAgentAccess);
  const openConnectionDialog = useStore((s) => s.openConnectionDialog);
  const setSection = useStore((s) => s.setSection);
  const queue = useStore((s) => s.queue);
  const history = useStore((s) => s.history);
  const saved = useStore((s) => s.saved);
  const prod = profile.environment === "production";
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "fail">(
    "idle"
  );
  const [testLatency, setTestLatency] = useState(0);
  const [testError, setTestError] = useState("");
  const [copied, setCopied] = useState(false);

  const isSqlite = profile.engine === "sqlite";
  const isRemoteHost =
    profile.host.length > 0 && !LOCAL_HOSTS.includes(profile.host.toLowerCase());
  const sslWarning = !isSqlite && !profile.ssl && isRemoteHost;
  const dsn = isSqlite
    ? profile.database
    : `${ENGINE_SCHEMES[profile.engine]}://${profile.user}@${profile.host}:${profile.port}/${profile.database}`;

  const pendingWrites: ActivityItem[] = queue
    .filter((q) => q.profileId === profile.id && PENDING_STATUSES.includes(q.status))
    .slice(0, MAX_PENDING_WRITES)
    .map((entry) => ({
      id: entry.id,
      label: entry.sql,
      meta: `${entry.originLabel} · ${formatRelativeTime(entry.createdAt)}`,
    }));
  const recentQueries: ActivityItem[] = history
    .filter((h) => h.profileId === profile.id)
    .sort((a, b) => b.ranAt.localeCompare(a.ranAt))
    .slice(0, MAX_RECENT_QUERIES)
    .map((entry) => ({
      id: entry.id,
      label: entry.sql,
      meta: `${formatRelativeTime(entry.ranAt)} · ${entry.rowCount} ${t("common.rows")}`,
    }));
  const savedQueries: ActivityItem[] = saved
    .filter((q) => q.profileId === profile.id)
    .slice(0, MAX_SAVED_QUERIES)
    .map((entry) => ({
      id: entry.id,
      label: entry.name,
      meta: formatRelativeTime(entry.updatedAt),
    }));

  function copyDsn() {
    void navigator.clipboard.writeText(dsn).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    });
  }

  function runTest() {
    setTestState("testing");
    setTestError("");
    if (!isRealProfile(profile)) {
      setTimeout(() => {
        setTestLatency(DEMO_TEST_LATENCY_MS);
        setTestState("ok");
      }, DEMO_TEST_DELAY_MS);
      return;
    }
    void testProfileConnection(profile).then((r) => {
      setTestLatency(r.latencyMs);
      setTestError(r.error ?? "");
      setTestState(r.ok ? "ok" : "fail");
    });
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
      <div className="flex items-center gap-3 px-6 pb-2 pt-4">
        <ColorDot color={profile.color} className="h-3 w-3" />
        <span className="text-[18px] font-bold tracking-tight text-foreground">
          {profile.name}
        </span>
        <span
          className={cn(
            "rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase",
            prod
              ? "bg-destructive/10 text-destructive"
              : "bg-panel-2 text-muted-foreground"
          )}
        >
          {t("connScreen.env")} : {profile.environment}
        </span>
        {sslWarning && (
          <Badge variant="warning">
            <ShieldAlert className="h-3 w-3" />
            {t("connScreen.sslWarning")}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              profile.state === "connected" ? "bg-success" : "bg-muted-foreground/40"
            )}
          />
          {profile.state === "connected"
            ? t("topbar.connected")
            : t("topbar.disconnected")}
        </div>
        <button
          onClick={onClose}
          className="ml-2 rounded p-1 text-muted-foreground hover:bg-panel-2 hover:text-foreground"
          aria-label={t("common.close")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex items-center gap-2 px-6 pb-4">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-panel-2 px-3 py-1.5 font-mono text-[12.5px] text-muted-foreground">
          {dsn}
        </code>
        <Button variant="outline" size="sm" onClick={copyDsn} className="min-w-[92px]">
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? t("connScreen.copied") : t("connScreen.copy")}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 gap-4 px-6 pb-6">
        <div className="flex w-[46%] shrink-0 flex-col gap-4 overflow-y-auto">
          <PanelBox title={t("connScreen.sectionConnection")}>
            <InfoRow label={t("connScreen.host")} mono>
              {profile.host || EMPTY_VALUE}
              {profile.port ? `:${profile.port}` : ""}
            </InfoRow>
            <InfoRow label={t("connScreen.user")} mono>
              {profile.user || EMPTY_VALUE}
            </InfoRow>
            <InfoRow label={t("connScreen.defaultDb")} mono>
              {profile.database || EMPTY_VALUE}
            </InfoRow>
            <InfoRow label={t("connScreen.engine")}>{engineLabel(profile.engine)}</InfoRow>
            <InfoRow label={t("connScreen.group")}>{profile.group || EMPTY_VALUE}</InfoRow>
            <InfoRow label={t("connScreen.password")}>
              {isRealProfile(profile) && profile.savePassword
                ? t("connScreen.passwordKeychain")
                : EMPTY_VALUE}
            </InfoRow>
          </PanelBox>

          <PanelBox title={t("connScreen.sectionSecurity")}>
            <InfoRow
              label={t("connScreen.ssl")}
              note={sslWarning ? t("connScreen.sslWarningNote") : undefined}
              tone={sslWarning ? "danger" : "default"}
            >
              {profile.ssl ? t("connScreen.sslEnabled") : t("connScreen.sslDisabled")}
            </InfoRow>
            <InfoRow label={t("connScreen.sshTunnelLabel")} mono={profile.sshTunnel}>
              {profile.sshTunnel
                ? `${profile.sshUser ? `${profile.sshUser}@` : ""}${profile.sshHost}:${profile.sshPort}`
                : EMPTY_VALUE}
            </InfoRow>
            <InfoRow
              label={t("connScreen.readOnlyLabel")}
              note={
                isSqlite
                  ? t("connScreen.readOnlyGuaranteedNote")
                  : t("connScreen.readOnlyBestEffortNote")
              }
              tone={isSqlite ? "success" : "default"}
            >
              {isSqlite
                ? t("connScreen.readOnlyGuaranteed")
                : t("connScreen.readOnlyBestEffort")}
            </InfoRow>
            <div className="flex items-start gap-3 border-t border-border pt-3">
              <Switch
                checked={!prod && profile.agentAccess}
                disabled={prod}
                onCheckedChange={() => toggleAgentAccess(profile.id)}
              />
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-foreground">
                  {t("connScreen.agentAccessTitle")}
                </div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                  {profile.agentAccess && !prod
                    ? t("connScreen.agentAccessOn")
                    : t("connScreen.agentAccessOff")}
                </div>
              </div>
            </div>
          </PanelBox>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
          <ActivityPanel
            title={t("connScreen.pendingWrites")}
            items={pendingWrites}
            emptyLabel={t("connScreen.pendingWritesEmpty")}
            onCountClick={() => setSection("queue")}
            tone={pendingWrites.length > 0 ? "warning" : "default"}
          />

          <ActivityPanel
            title={t("connScreen.recentQueries")}
            items={recentQueries}
            emptyLabel={t("connScreen.recentQueriesEmpty")}
            onCountClick={() => setSection("history")}
          />

          <ActivityPanel
            title={t("connScreen.savedQueries")}
            items={savedQueries}
            emptyLabel={t("connScreen.savedQueriesEmpty")}
            onCountClick={() => setSection("saved")}
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
        <div className="mr-auto min-w-0 flex-1 pr-4 text-[12.5px] text-muted-foreground">
          {testState === "testing" && <span>{t("conn.testing")}</span>}
          {testState === "ok" && (
            <span className="flex items-center gap-1.5 text-success">
              <span className="h-2 w-2 rounded-full bg-success" />
              {t("conn.testOk")} · {testLatency} ms
            </span>
          )}
          {testState === "fail" && (
            <span className="line-clamp-2 text-destructive" title={testError || undefined}>
              {t("conn.testFail")}
              {testError ? ` — ${testError}` : ""}
            </span>
          )}
        </div>
        <Button variant="outline" onClick={() => openConnectionDialog(profile.id)}>
          {t("connScreen.edit")}
        </Button>
        <Button variant="outline" onClick={runTest} className="min-w-[90px]">
          {testState === "ok" ? <Check className="h-4 w-4 text-success" /> : null}
          {t("common.test")}
        </Button>
        <Button variant="brand" onClick={onConnect}>
          {t("common.connect")}
        </Button>
      </div>
    </div>
  );
}

function PanelBox({
  title,
  count,
  onCountClick,
  tone = "default",
  children,
}: {
  title: string;
  count?: number;
  onCountClick?: () => void;
  tone?: PanelTone;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-md border p-4", PANEL_TONE_CLASS[tone])}>
      <div className="mb-2.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>{title}</span>
        {count !== undefined && onCountClick && (
          <button
            onClick={onCountClick}
            className="rounded px-1 tabular-nums text-foreground/70 hover:bg-panel-2 hover:text-foreground"
          >
            {count}
          </button>
        )}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function InfoRow({
  label,
  note,
  mono = false,
  tone = "default",
  children,
}: {
  label: string;
  note?: string;
  mono?: boolean;
  tone?: InfoTone;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-[130px] shrink-0 text-[12.5px] text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "text-[13px]",
            mono && "font-mono text-[12.5px]",
            INFO_TONE_CLASS[tone]
          )}
        >
          {children}
        </span>
        {note && (
          <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground">
            {note}
          </span>
        )}
      </span>
    </div>
  );
}

function ActivityPanel({
  title,
  items,
  emptyLabel,
  onCountClick,
  tone = "default",
}: {
  title: string;
  items: ActivityItem[];
  emptyLabel: string;
  onCountClick: () => void;
  tone?: PanelTone;
}) {
  return (
    <PanelBox
      title={title}
      count={items.length}
      onCountClick={onCountClick}
      tone={tone}
    >
      {items.length === 0 && (
        <p className="text-[12px] text-muted-foreground/70">{emptyLabel}</p>
      )}
      {items.map((item) => (
        <div key={item.id} className="min-w-0">
          <div className="truncate font-mono text-[12px] text-foreground/85">
            {item.label}
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {item.meta}
          </div>
        </div>
      ))}
    </PanelBox>
  );
}
