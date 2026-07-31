import { useTranslation } from "react-i18next";
import { X, Plus, Table2, FileCode, Database as DbIcon } from "lucide-react";
import { useStore, type TableSubView } from "@/store";
import { DataGrid } from "@/components/data/DataGrid";
import { StructureView } from "@/components/data/StructureView";
import { RelationsView } from "@/components/data/RelationsView";
import { SqlEditor } from "@/components/editor/SqlEditor";
import { cn } from "@/lib/utils";

const MIDDLE_MOUSE_BUTTON = 1;

export function Workspace() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);
  const setTableSubView = useStore((s) => s.setTableSubView);
  const openQueryTab = useStore((s) => s.openQueryTab);

  const active = tabs.find((t) => t.id === activeTabId);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-sidebar">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              onMouseDown={(e) => {
                if (e.button === MIDDLE_MOUSE_BUTTON) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button !== MIDDLE_MOUSE_BUTTON) return;
                e.preventDefault();
                closeTab(tab.id);
              }}
              className={cn(
                "group flex min-w-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 text-[12.5px] transition-colors",
                isActive
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:bg-panel-2 hover:text-foreground"
              )}
            >
              {tab.kind === "table" ? (
                <Table2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <FileCode className="h-3.5 w-3.5 shrink-0 text-brand" />
              )}
              <span className="max-w-[160px] truncate">{tab.title}</span>
              {tab.dirty && (
                <span className="h-1.5 w-1.5 rounded-full bg-brand" />
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="ml-1 rounded p-0.5 opacity-0 hover:bg-panel-2 group-hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        <button
          onClick={() => openQueryTab()}
          className="flex items-center px-3 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="New query"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {!active ? (
        <EmptyWorkspace />
      ) : active.kind === "query" ? (
        <SqlEditor key={active.id} tab={active} />
      ) : (
        <TableWorkspace
          tab={active}
          onSub={(sub) => setTableSubView(active.id, sub)}
        />
      )}
    </div>
  );
}

function TableWorkspace({
  tab,
  onSub,
}: {
  tab: { id: string; tableName?: string; subView?: string };
  onSub: (sub: TableSubView) => void;
}) {
  const sub = (tab.subView ?? "data") as TableSubView;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sub === "data" && (
        <DataGrid tableName={tab.tableName!} subView={sub} onSub={onSub} />
      )}
      {sub === "structure" && (
        <StructureView tableName={tab.tableName!} subView={sub} onSub={onSub} />
      )}
      {sub === "relations" && (
        <RelationsView tableName={tab.tableName!} subView={sub} onSub={onSub} />
      )}
    </div>
  );
}

function EmptyWorkspace() {
  const { t } = useTranslation();
  const openQueryTab = useStore((s) => s.openQueryTab);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <DbIcon className="h-10 w-10 text-muted-foreground/40" />
      <div className="text-[13px] text-muted-foreground">
        {t("editor.emptyHint")}
      </div>
      <button
        onClick={() => openQueryTab()}
        className="text-[13px] font-medium text-brand hover:underline"
      >
        {t("editor.openNewQuery")}
      </button>
    </div>
  );
}
