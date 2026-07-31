import { useTranslation } from "react-i18next";
import { activeProfile, useStore } from "@/store";
import { GateMark } from "@/components/shared";
import type { ConnectionProfile, Engine } from "@/lib/types";
import { cn } from "@/lib/utils";

const ENGINE_VERSION: Record<Engine, string> = {
  postgres: "Postgres 16",
  mysql: "MySQL 8",
  sqlite: "SQLite",
  mssql: "SQL Server",
};

function projectLabel(group: string) {
  return group.replace(/^projet\s+/i, "").toLowerCase();
}

export function TitleBar() {
  const profile = useStore(activeProfile);

  return (
    <header
      data-tauri-drag-region
      className="drag-region flex h-11 shrink-0 items-center gap-3 border-b border-border bg-sidebar-rail pl-[80px] pr-4"
    >
      {/* Left padding reserves space for the native macOS window controls
          (close / minimise / zoom), which the OS draws over the title bar.
          NOTE: data-tauri-drag-region only fires on the element itself, not
          its children — the flex spacer needs it too. */}
      <div className="no-drag flex items-center gap-2">
        <GateMark className="h-[18px] w-[18px]" />
        <span className="text-[13.5px] font-semibold tracking-tight text-foreground">
          Gatehouse
        </span>
      </div>

      <div data-tauri-drag-region className="flex-1 self-stretch" />

      {profile && (
        <div className="no-drag flex items-center gap-2">
          <EnvPill profile={profile} project={projectLabel(profile.group)} />
          <StatePill state={profile.state} />
        </div>
      )}
    </header>
  );
}

function EnvPill({
  profile,
  project,
}: {
  profile: ConnectionProfile;
  project: string;
}) {
  const prod = profile.environment === "production";
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-full border px-3 py-1 text-[12px]",
        prod
          ? "border-destructive/40 bg-destructive/10"
          : "border-border bg-panel-2"
      )}
    >
      <span
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: profile.color }}
      />
      <span
        className={cn(
          "font-semibold",
          prod ? "text-destructive" : "text-foreground"
        )}
      >
        {project} · {profile.name}
      </span>
      <span className="text-muted-foreground">
        {ENGINE_VERSION[profile.engine]}
      </span>
    </div>
  );
}

function StatePill({
  state,
}: {
  state: "connected" | "reconnecting" | "disconnected";
}) {
  const { t } = useTranslation();
  const color =
    state === "connected"
      ? "bg-success"
      : state === "reconnecting"
        ? "bg-warning animate-pulse"
        : "bg-muted-foreground/50";
  const label =
    state === "connected"
      ? t("topbar.connected")
      : state === "reconnecting"
        ? t("topbar.reconnecting")
        : t("topbar.disconnected");
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-border bg-panel-2 px-3 py-1 text-[12px] text-foreground">
      <span className={cn("h-2 w-2 rounded-full", color)} />
      {label}
    </div>
  );
}
