import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot } from "lucide-react";
import { useStore } from "@/store";
import { AuditTable } from "@/components/AuditTable";
import { cn } from "@/lib/utils";

export function AgentActivityScreen() {
  const { t } = useTranslation();
  const audit = useStore((s) => s.audit);
  const chainValid = useStore((s) => s.auditChainValid);
  const [clientFilter, setClientFilter] = useState<string | null>(null);

  const clients = Array.from(new Set(audit.map((a) => a.client)));
  const entries = clientFilter
    ? audit.filter((a) => a.client === clientFilter)
    : audit;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-8">
        <h1 className="mb-2 text-[22px] font-bold tracking-tight text-foreground">
          {t("agents.title")}
        </h1>
        <p className="mb-6 max-w-3xl text-[13.5px] text-muted-foreground">
          {t("agents.intro")}
        </p>

        {!chainValid && (
          <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
            {t("settings.auditChainInvalid")}
          </div>
        )}

        {clients.length > 1 && (
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            <FilterChip
              active={clientFilter === null}
              onClick={() => setClientFilter(null)}
            >
              {t("agents.allClients")}
            </FilterChip>
            {clients.map((c) => (
              <FilterChip
                key={c}
                active={clientFilter === c}
                onClick={() => setClientFilter(c)}
              >
                {c}
              </FilterChip>
            ))}
          </div>
        )}

        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card py-14 text-muted-foreground">
            <Bot className="h-8 w-8" />
            <span className="text-[13.5px]">{t("agents.noActivity")}</span>
          </div>
        ) : (
          <AuditTable entries={entries} showDate />
        )}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-[12px] font-medium transition-colors",
        active
          ? "border-brand bg-brand/10 text-brand"
          : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
