import { useTranslation } from "react-i18next";
import { Database } from "lucide-react";
import type {
  ConnectionState,
  Engine,
  Environment,
  SqlType,
} from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <GateMark className="h-6 w-6" />
      <span className="text-[15px] font-semibold tracking-tight text-foreground">
        Gatehouse
      </span>
    </div>
  );
}

export function GateMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--brand-muted)" />
      <rect
        x="1"
        y="1"
        width="30"
        height="30"
        rx="8"
        stroke="var(--brand)"
        strokeWidth="1.5"
        strokeOpacity="0.5"
      />
      <path
        d="M10 22V13a6 6 0 0 1 12 0v9"
        stroke="var(--brand)"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path d="M8 22h16" stroke="var(--brand)" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="16" cy="15" r="1.8" fill="var(--brand)" />
    </svg>
  );
}

const ENGINE_META: Record<Engine, { label: string; color: string }> = {
  postgres: { label: "PostgreSQL", color: "#5a9bd8" },
  mysql: { label: "MySQL", color: "#e0a04a" },
  sqlite: { label: "SQLite", color: "#46b17b" },
  mssql: { label: "SQL Server", color: "#e5484d" },
};

export function engineLabel(engine: Engine) {
  return ENGINE_META[engine].label;
}

export function EngineIcon({
  engine,
  className,
}: {
  engine: Engine;
  className?: string;
}) {
  return (
    <Database
      className={cn("h-4 w-4", className)}
      style={{ color: ENGINE_META[engine].color }}
    />
  );
}

export function EnvBadge({ env }: { env: Environment }) {
  if (env === "production")
    return <Badge variant="destructive">production</Badge>;
  if (env === "staging") return <Badge variant="info">staging</Badge>;
  return <Badge variant="outline">local</Badge>;
}

export function StateDot({ state }: { state: ConnectionState }) {
  const { t } = useTranslation();
  const color =
    state === "connected"
      ? "bg-success"
      : state === "reconnecting"
        ? "bg-warning animate-pulse"
        : "bg-muted-foreground/50";
  return (
    <span
      className={cn("inline-block h-2 w-2 rounded-full", color)}
      title={t(`badge.${state}`)}
    />
  );
}

const TYPE_COLORS: Record<string, string> = {
  integer: "#5a9bd8",
  bigint: "#5a9bd8",
  numeric: "#5a9bd8",
  boolean: "#9b6df2",
  text: "#46b17b",
  varchar: "#46b17b",
  timestamp: "#e0a04a",
  date: "#e0a04a",
  json: "#f26dbb",
  uuid: "#f2994a",
};

export function typeColor(type: SqlType): string {
  return TYPE_COLORS[type] ?? "#8b8b92";
}

export function ColorDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      className={cn("inline-block h-2.5 w-2.5 rounded-full", className)}
      style={{ backgroundColor: color }}
    />
  );
}
