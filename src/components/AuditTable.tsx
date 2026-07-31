import { useTranslation } from "react-i18next";
import type { AuditEntry } from "@/lib/types";
import {
  AUDIT_OUTCOME_CLASS,
  AUDIT_OUTCOME_LABEL,
} from "@/lib/auditOutcome";
import { cn } from "@/lib/utils";

export function AuditTable({
  entries,
  showDate = false,
}: {
  entries: AuditEntry[];
  showDate?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith("fr") ? "fr" : "en";
  const timeFormat: Intl.DateTimeFormatOptions = showDate
    ? { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" };
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="px-5 py-2.5 font-medium">{t("settings.colTime")}</th>
            <th className="px-3 py-2.5 font-medium">{t("settings.colClient")}</th>
            <th className="px-3 py-2.5 font-medium">{t("settings.colProfile")}</th>
            <th className="px-3 py-2.5 font-medium">{t("settings.colQuery")}</th>
            <th className="px-5 py-2.5 text-right font-medium">
              {t("settings.colStatus")}
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((a) => {
            const outcomeClass =
              AUDIT_OUTCOME_CLASS[a.outcome] ?? AUDIT_OUTCOME_CLASS.executed;
            return (
              <tr key={a.id} className="border-t border-border">
                <td className="whitespace-nowrap px-5 py-2.5 font-mono tabular-nums text-muted-foreground">
                  {new Date(a.at).toLocaleString(lang, timeFormat)}
                </td>
                <td className="px-3 py-2.5 font-mono text-foreground/90">
                  {a.client}
                </td>
                <td className="px-3 py-2.5 font-mono text-foreground/90">
                  {a.profileName}
                </td>
                <td className="px-3 py-2.5 font-mono text-foreground/90">
                  {a.requestType}
                </td>
                <td
                  className={cn(
                    "px-5 py-2.5 text-right font-medium",
                    outcomeClass
                  )}
                >
                  {AUDIT_OUTCOME_LABEL[a.outcome]?.[lang] ?? a.outcome}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
