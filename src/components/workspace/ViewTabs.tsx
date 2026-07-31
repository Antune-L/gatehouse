import { useTranslation } from "react-i18next";
import type { TableSubView } from "@/store";
import { cn } from "@/lib/utils";

const TABS: { id: TableSubView; key: string }[] = [
  { id: "data", key: "nav.data" },
  { id: "structure", key: "nav.structure" },
  { id: "relations", key: "nav.relations" },
];

export function ViewTabs({
  value,
  onChange,
}: {
  value: TableSubView;
  onChange: (v: TableSubView) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            "rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors",
            value === tab.id
              ? "bg-brand-muted text-brand"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t(tab.key)}
        </button>
      ))}
    </div>
  );
}
