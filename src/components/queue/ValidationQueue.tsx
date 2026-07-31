import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  User,
  Layers,
  Check,
  X,
  ShieldCheck,
  AlertTriangle,
  ArrowRight,
  Clock,
} from "lucide-react";
import { useStore } from "@/store";
import type { QueueEntry, QueueOrigin, RiskLevel } from "@/lib/types";
import { EnvBadge } from "@/components/shared";
import { CellContent } from "@/components/data/cells";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCountdown } from "@/lib/utils";
import { cn } from "@/lib/utils";

const ORIGIN_META: Record<QueueOrigin, { icon: typeof Bot; labelKey: string }> = {
  agent: { icon: Bot, labelKey: "queue.originAgent" },
  "human-ui": { icon: User, labelKey: "queue.originHumanUi" },
  "schema-editor": { icon: Layers, labelKey: "queue.originSchema" },
};

type BadgeVariant = "destructive" | "warning" | "default";
const RISK_META: Record<RiskLevel, { variant: BadgeVariant; labelKey: string }> = {
  high: { variant: "destructive", labelKey: "queue.riskHigh" },
  medium: { variant: "warning", labelKey: "queue.riskMedium" },
  low: { variant: "default", labelKey: "queue.riskLow" },
};

export function ValidationQueue() {
  const { t } = useTranslation();
  const queue = useStore((s) => s.queue);
  const pending = queue.filter((q) => q.status === "pending");
  const resolved = queue.filter((q) => q.status !== "pending");
  const [now, setNow] = useState(0);

  // NOTE: 1s tick so the expiry countdowns actually count down.
  useEffect(() => {
    if (pending.length === 0) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [pending.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-brand" />
          <h1 className="text-[16px] font-semibold text-foreground">
            {t("queue.title")}
          </h1>
          <Badge variant="brand">{pending.length}</Badge>
        </div>
        <p className="mt-1 max-w-2xl text-[12.5px] text-muted-foreground">
          {t("queue.subtitle")}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {pending.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
            <ShieldCheck className="h-10 w-10 text-success/50" />
            <p className="text-[13px] text-muted-foreground">{t("queue.empty")}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {pending.map((entry) => (
              <QueueCard key={entry.id} entry={entry} now={now} />
            ))}
          </div>
        )}

        {resolved.length > 0 && (
          <div className="mt-8">
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("queue.recentlyResolved")}
            </h2>
            <div className="space-y-1.5">
              {resolved.slice(0, 8).map((entry) => {
                const succeeded =
                  entry.status === "approved" || entry.status === "used";
                return (
                <div
                  key={entry.id}
                  className="flex items-center gap-2 rounded-md border border-border bg-panel px-3 py-2 text-[12px]"
                >
                  {succeeded ? (
                    <Check className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <X className="h-3.5 w-3.5 text-destructive" />
                  )}
                  <span
                    className={cn(
                      "font-medium",
                      succeeded ? "text-success" : "text-destructive"
                    )}
                  >
                    {entry.status === "used" ? t("queue.statusUsed") : entry.status}
                  </span>
                  <code className="truncate font-mono text-muted-foreground">
                    {entry.sql.split("\n")[0]}
                  </code>
                  {entry.status === "failed" && entry.error && (
                    <span
                      className="ml-auto max-w-[40%] truncate text-destructive/80"
                      title={entry.error}
                    >
                      {t("queue.failed")} · {entry.error}
                    </span>
                  )}
                </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function QueueCard({ entry, now }: { entry: QueueEntry; now: number }) {
  const { t } = useTranslation();
  const approve = useStore((s) => s.approve);
  const reject = useStore((s) => s.reject);
  const [confirmText, setConfirmText] = useState("");

  const Origin = ORIGIN_META[entry.origin].icon;
  const expired = now > 0 && new Date(entry.expiresAt).getTime() <= now;
  // Retyping the profile name is required wherever the input is shown:
  // production writes, and destructive statements (DELETE/DDL) anywhere.
  const needsHardConfirm =
    entry.environment === "production" ||
    entry.statementKind === "delete" ||
    entry.statementKind === "ddl";
  const canApprove =
    !expired && (!needsHardConfirm || confirmText === entry.profileName);

  const risk = RISK_META[entry.risk];

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-panel",
        entry.environment === "production"
          ? "border-destructive/40"
          : "border-border"
      )}
    >
      <div className="flex items-center gap-2 border-b border-border bg-panel-2 px-4 py-2.5">
        <div
          className={cn(
            "flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium",
            entry.origin === "agent"
              ? "bg-brand/15 text-brand"
              : entry.origin === "schema-editor"
                ? "bg-info/15 text-info"
                : "bg-panel text-muted-foreground"
          )}
        >
          <Origin className="h-3.5 w-3.5" />
          {t(ORIGIN_META[entry.origin].labelKey)}
          <span className="opacity-70">· {entry.originLabel}</span>
        </div>
        <ArrowRight className="h-3 w-3 text-muted-foreground" />
        <span className="text-[12px] font-medium text-foreground">
          {entry.profileName}
        </span>
        <span className="text-[11px] text-muted-foreground">/ {entry.database}</span>
        <EnvBadge env={entry.environment} />
        <Badge variant={risk.variant}>{t(risk.labelKey)}</Badge>
        <div
          className={cn(
            "ml-auto flex items-center gap-1 text-[11px]",
            expired ? "font-medium text-destructive" : "text-muted-foreground"
          )}
        >
          <Clock className="h-3 w-3" />
          {expired
            ? t("queue.expired")
            : t("queue.expiresIn", { t: formatCountdown(entry.expiresAt) })}
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-4 p-4">
        <div className="min-w-0">
          <pre className="overflow-auto rounded-lg border border-border bg-input-bg p-3 font-mono text-[12.5px] leading-relaxed text-foreground/90">
            {entry.sql}
          </pre>

          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px]">
            <Meta label={t("queue.affected")} value={entry.affectedLabel} />
            <Meta
              label={t("queue.target")}
              value={entry.targetObjects.join(", ") || entry.database}
            />
            <Meta label={t("queue.statement")} value={entry.statementKind.toUpperCase()} />
          </div>

          {entry.diffs && entry.diffs.length > 0 && (
            <div className="mt-3 overflow-hidden rounded-lg border border-border">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="bg-panel-2 text-left text-muted-foreground">
                    <th className="px-3 py-1.5 font-medium">{t("queue.column")}</th>
                    <th className="px-3 py-1.5 font-medium">{t("queue.oldValue")}</th>
                    <th className="px-3 py-1.5 font-medium">{t("queue.newValue")}</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.diffs.map((d) => (
                    <tr key={d.column} className="border-t border-border/50">
                      <td className="px-3 py-1.5 font-mono text-foreground">{d.column}</td>
                      <td className="px-3 py-1.5">
                        <span className="rounded bg-destructive/10 px-1">
                          <CellContent value={d.oldValue} type="text" />
                        </span>
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="rounded bg-success/10 px-1">
                          <CellContent value={d.newValue} type="text" />
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex w-56 shrink-0 flex-col gap-2">
          {needsHardConfirm && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-2.5">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-warning">
                <AlertTriangle className="h-3.5 w-3.5" />
                {t("queue.reinforced")}
              </div>
              <p className="mb-1.5 text-[11px] text-muted-foreground">
                {entry.environment === "production"
                  ? t("queue.confirmProd")
                  : entry.statementKind === "delete"
                    ? t("queue.destructiveDelete")
                    : t("queue.schemaChange")}
              </p>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={entry.profileName}
                className="h-7 text-[12px]"
              />
            </div>
          )}
          <Button
            variant="brand"
            className="w-full"
            disabled={!canApprove}
            onClick={() => void approve(entry.id)}
          >
            <Check className="h-4 w-4" /> {t("common.approve")}
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => void reject(entry.id)}
          >
            <X className="h-4 w-4" /> {t("common.reject")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}
