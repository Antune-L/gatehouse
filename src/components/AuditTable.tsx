import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import type { AuditEntry } from "@/lib/types";
import {
  AUDIT_OUTCOME_CLASS,
  AUDIT_OUTCOME_LABEL,
} from "@/lib/auditOutcome";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;
const COLUMN_COUNT = 5;
const DETAIL_MAX_LENGTH = 500;

export function AuditTable({
  entries,
  showDate = false,
}: {
  entries: AuditEntry[];
  showDate?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [rawPage, setRawPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const lang = i18n.language.startsWith("fr") ? "fr" : "en";
  const timeFormat: Intl.DateTimeFormatOptions = showDate
    ? { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" };
  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const page = Math.min(rawPage, pageCount - 1);
  const start = page * PAGE_SIZE;
  const pageEntries = entries.slice(start, start + PAGE_SIZE);
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
          {pageEntries.map((a) => {
            const outcomeClass =
              AUDIT_OUTCOME_CLASS[a.outcome] ?? AUDIT_OUTCOME_CLASS.executed;
            const detail = a.detail?.trim();
            const expandable = Boolean(detail);
            const expanded = expandable && expandedId === a.id;
            const toggle = () => setExpandedId(expanded ? null : a.id);
            return (
              <Fragment key={a.id}>
                <tr
                  className={cn(
                    "border-t border-border",
                    expandable && "cursor-pointer hover:bg-muted/40"
                  )}
                  aria-expanded={expandable ? expanded : undefined}
                  onClick={expandable ? toggle : undefined}
                >
                  <td className="whitespace-nowrap px-5 py-2.5 font-mono tabular-nums text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      {expandable && (
                        <ChevronDown
                          aria-label={t(
                            expanded
                              ? "settings.auditHideDetail"
                              : "settings.auditShowDetail"
                          )}
                          className={cn(
                            "h-3.5 w-3.5 shrink-0 transition-transform",
                            !expanded && "-rotate-90"
                          )}
                        />
                      )}
                      {new Date(a.at).toLocaleString(lang, timeFormat)}
                    </span>
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
                {expanded && detail && (
                  <tr className="border-t border-border">
                    <td colSpan={COLUMN_COUNT} className="bg-muted/40 px-5 py-3">
                      <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-foreground/90">
                        {detail}
                      </pre>
                      {(a.detail?.length ?? 0) >= DETAIL_MAX_LENGTH && (
                        <p className="mt-2 text-[11px] text-muted-foreground">
                          {t("settings.auditDetailTruncated", {
                            max: DETAIL_MAX_LENGTH,
                          })}
                        </p>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {pageCount > 1 && (
        <div className="flex items-center justify-between border-t border-border px-5 py-2">
          <span className="text-[12px] tabular-nums text-muted-foreground">
            {t("settings.auditPageRange", {
              start: start + 1,
              end: start + pageEntries.length,
              total: entries.length,
            })}
          </span>
          <div className="flex items-center gap-1">
            <PageButton
              label={t("settings.auditPrevPage")}
              disabled={page === 0}
              onClick={() => setRawPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </PageButton>
            <PageButton
              label={t("settings.auditNextPage")}
              disabled={page >= pageCount - 1}
              onClick={() => setRawPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </PageButton>
          </div>
        </div>
      )}
    </div>
  );
}

function PageButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-md border border-border p-1 text-muted-foreground transition-colors",
        disabled
          ? "opacity-40"
          : "hover:border-border-strong hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
