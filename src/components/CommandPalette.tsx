import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, Table2, Eye, FileCode, ShieldCheck, Settings } from "lucide-react";
import { useStore } from "@/store";
import { allTables } from "@/lib/backend";
import { formatBinding } from "@/lib/shortcuts";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface Item {
  id: string;
  label: string;
  hint: string;
  icon: typeof Table2;
  action: () => void;
}

export function CommandPalette() {
  const open = useStore((s) => s.commandPaletteOpen);
  const setOpen = useStore((s) => s.setCommandPalette);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        hideClose
        className="top-[20%] max-w-[540px] translate-y-0 gap-0 overflow-hidden p-0"
      >
        {/* Radix unmounts DialogContent when closed, so PaletteBody remounts
            with fresh query/selection state on every open. */}
        <PaletteBody onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const openTable = useStore((s) => s.openTable);
  const openQueryTab = useStore((s) => s.openQueryTab);
  const setSection = useStore((s) => s.setSection);
  const schema = useStore((s) => s.schema);
  const shortcuts = useStore((s) => s.settings.shortcuts);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  const items = useMemo<Item[]>(() => {
    const tables = allTables(schema).map((tb) => ({
      id: `tbl-${tb.name}`,
      label: tb.name,
      hint: tb.kind === "view" ? "view" : `table · ${tb.rowCount} rows`,
      icon: tb.kind === "view" ? Eye : Table2,
      action: () => {
        openTable(tb.name);
        onClose();
      },
    }));
    const actions: Item[] = [
      {
        id: "new-query",
        label: t("editor.newTab"),
        hint: formatBinding(shortcuts["new-query"]),
        icon: FileCode,
        action: () => {
          openQueryTab();
          onClose();
        },
      },
      {
        id: "queue",
        label: t("nav.queue"),
        hint: formatBinding(shortcuts["validation-queue"]),
        icon: ShieldCheck,
        action: () => {
          setSection("queue");
          onClose();
        },
      },
      {
        id: "settings",
        label: t("nav.settings"),
        hint: "",
        icon: Settings,
        action: () => {
          setSection("settings");
          onClose();
        },
      },
    ];
    return [...tables, ...actions];
  }, [schema, shortcuts, openTable, openQueryTab, setSection, onClose, t]);

  const filtered = items.filter((i) =>
    i.label.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="h-4 w-4 text-muted-foreground" />
        <input
          autoFocus
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              filtered[sel]?.action();
            }
          }}
          placeholder={t("palette.placeholder")}
          className="h-12 w-full bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground/60"
        />
        <kbd className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          esc
        </kbd>
      </div>
      <div className="max-h-[320px] overflow-y-auto p-1.5">
        {filtered.length === 0 ? (
          <div className="py-8 text-center text-[13px] text-muted-foreground">
            {t("palette.noResults")}
          </div>
        ) : (
          filtered.map((item, i) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onMouseEnter={() => setSel(i)}
                onClick={item.action}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left",
                  i === sel ? "bg-brand/15" : "hover:bg-panel-2"
                )}
              >
                <Icon
                  className={cn(
                    "h-4 w-4",
                    i === sel ? "text-brand" : "text-muted-foreground"
                  )}
                />
                <span className="flex-1 text-[13px] text-foreground">
                  {item.label}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {item.hint}
                </span>
              </button>
            );
          })
        )}
      </div>
    </>
  );
}
