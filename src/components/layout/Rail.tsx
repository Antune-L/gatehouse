import { useTranslation } from "react-i18next";
import {
  Database,
  History,
  Bot,
  Bookmark,
  ShieldCheck,
  Settings,
} from "lucide-react";
import { pendingCount, useStore, type RailSection } from "@/store";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const ICONS: {
  section: RailSection;
  Icon: typeof Database;
  labelKey: string;
}[] = [
  { section: "connections", Icon: Database, labelKey: "nav.connections" },
  { section: "history", Icon: History, labelKey: "nav.history" },
  { section: "agents", Icon: Bot, labelKey: "nav.agents" },
  { section: "saved", Icon: Bookmark, labelKey: "nav.saved" },
  { section: "queue", Icon: ShieldCheck, labelKey: "nav.queue" },
];

export function Rail() {
  const { t } = useTranslation();
  const section = useStore((s) => s.section);
  const setSection = useStore((s) => s.setSection);
  const pending = useStore(pendingCount);

  return (
    <nav className="flex h-full w-[52px] shrink-0 flex-col items-center gap-1 bg-sidebar-rail py-3">
      {ICONS.map(({ section: s, Icon, labelKey }) => {
        const active = section === s;
        const showBadge = s === "queue" && pending > 0;
        return (
          <Tooltip key={s}>
            <TooltipTrigger asChild>
              <button
                onClick={() => setSection(s)}
                className={cn(
                  "relative flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-panel-2 hover:text-foreground",
                  active && "bg-panel-2 text-brand"
                )}
                aria-label={t(labelKey)}
              >
                {active && (
                  <span className="absolute -left-3 h-5 w-1 rounded-r-full bg-brand" />
                )}
                <Icon className="h-[18px] w-[18px]" />
                {showBadge && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-brand-foreground">
                    {pending}
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{t(labelKey)}</TooltipContent>
          </Tooltip>
        );
      })}

      <div className="flex-1" />

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setSection("settings")}
            className={cn(
              "relative flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-panel-2 hover:text-foreground",
              section === "settings" && "bg-panel-2 text-brand"
            )}
            aria-label={t("nav.settings")}
          >
            {section === "settings" && (
              <span className="absolute -left-3 h-5 w-1 rounded-r-full bg-brand" />
            )}
            <Settings className="h-[18px] w-[18px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{t("nav.settings")}</TooltipContent>
      </Tooltip>
    </nav>
  );
}
