import { useTranslation } from "react-i18next";
import { useStore } from "@/store";
import { inTauri } from "@/lib/ipc";

// Live ticker of the most recent agent tool call. In the desktop build it is
// fed by real MCP server events; the browser demo falls back to seed data.
export function AgentActivity() {
  const { t } = useTranslation();
  const clients = useStore((s) => s.mcpClients);
  const activity = useStore((s) => s.agentActivity);
  const audit = useStore((s) => s.audit);

  if (activity) {
    return (
      <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-success" />
        <span className="font-medium text-foreground/80">{t("status.agent")}</span>
        <span>·</span>
        <span className="font-mono">{activity.client}</span>
        <span className="font-mono">{activity.tool}</span>
        <span>({t("status.readOnly")})</span>
        <span>·</span>
        <span className="tabular-nums">{Math.max(1, Math.round(activity.durationMs))} ms</span>
        {activity.rows !== null && (
          <>
            <span>·</span>
            <span className="tabular-nums">
              {activity.rows} {t("common.rows")}
            </span>
          </>
        )}
      </div>
    );
  }

  if (inTauri() || clients.length === 0) return null;

  const lastRead = audit.find((a) => /SELECT/i.test(a.requestType));
  const client = clients[0].name;
  const target = lastRead
    ? lastRead.requestType.replace(/^SELECT\s*·\s*/i, "")
    : "invoices";

  return (
    <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-success" />
      <span className="font-medium text-foreground/80">{t("status.agent")}</span>
      <span>·</span>
      <span className="font-mono">{client}</span>
      <span>
        {t("status.reads")} <span className="font-mono">{target}</span> (
        {t("status.readOnly")})
      </span>
      <span>·</span>
      <span className="font-mono">SELECT</span>
      <span>·</span>
      <span className="tabular-nums">84 ms</span>
      <span>·</span>
      <span className="tabular-nums">128 {t("common.rows")}</span>
    </div>
  );
}
