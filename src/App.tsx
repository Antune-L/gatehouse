import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Rail } from "@/components/layout/Rail";
import { ContextPanel } from "@/components/layout/ContextPanel";
import { ProfileTabs } from "@/components/layout/ProfileTabs";
import { TitleBar } from "@/components/layout/TitleBar";
import { Workspace } from "@/components/workspace/Workspace";
import { ValidationQueue } from "@/components/queue/ValidationQueue";
import { SettingsScreen } from "@/components/settings/SettingsScreen";
import { AgentActivityScreen } from "@/components/agents/AgentActivityScreen";
import { ConnectionDialog } from "@/components/connection/ConnectionDialog";
import { ConnectionsManager } from "@/components/connection/ConnectionsManager";
import { CommandPalette } from "@/components/CommandPalette";
import { KeyRound } from "lucide-react";
import { useStore } from "@/store";
import { inTauri, KEYCHAIN_ERROR_EVENT } from "@/lib/ipc";
import { matchesEvent } from "@/lib/shortcuts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const MENU_EVENT = "gatehouse://menu";
const SUBVIEW_TARGETS = [
  { id: "subview-data", view: "data" },
  { id: "subview-structure", view: "structure" },
  { id: "subview-relations", view: "relations" },
] as const;
const AGENT_ACTIVITY_EVENT = "gatehouse://agent-activity";
const QUEUE_CHANGED_EVENT = "gatehouse://queue-changed";

interface AgentActivityPayload {
  client: string;
  tool: string;
  duration_ms: number;
  rows: number | null;
}

function isEditableTarget(el: Element | null): boolean {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

export default function App() {
  const { t } = useTranslation();
  const section = useStore((s) => s.section);
  const connectionsManagerOpen = useStore((s) => s.connectionsManagerOpen);
  const setCommandPalette = useStore((s) => s.setCommandPalette);
  const setSection = useStore((s) => s.setSection);
  const openQueryTab = useStore((s) => s.openQueryTab);
  const keychainError = useStore((s) => s.keychainError);
  const setKeychainError = useStore((s) => s.setKeychainError);
  const initBackend = useStore((s) => s.initBackend);
  const [quitDialogOpen, setQuitDialogOpen] = useState(false);

  useEffect(() => {
    function onKeychainError(e: Event) {
      if (e instanceof CustomEvent && typeof e.detail === "string") {
        useStore.getState().setKeychainError(e.detail);
      }
    }
    window.addEventListener(KEYCHAIN_ERROR_EVENT, onKeychainError);
    return () => window.removeEventListener(KEYCHAIN_ERROR_EVENT, onKeychainError);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const st = useStore.getState();
      const sc = st.settings.shortcuts;
      if (matchesEvent(sc["command-palette"], e)) {
        e.preventDefault();
        setCommandPalette(true);
        return;
      }
      if (matchesEvent(sc["new-query"], e)) {
        e.preventDefault();
        openQueryTab();
        return;
      }
      if (matchesEvent(sc["validation-queue"], e)) {
        e.preventDefault();
        setSection("queue");
        return;
      }
      if (matchesEvent(sc["pin-tab"], e)) {
        if (!st.activeTabId) return;
        e.preventDefault();
        st.togglePinTab(st.activeTabId);
        return;
      }
      const prevTab = matchesEvent(sc["prev-tab"], e);
      if (prevTab || matchesEvent(sc["next-tab"], e)) {
        if (st.connectionsManagerOpen || st.tabs.length < 2) return;
        const idx = st.tabs.findIndex((x) => x.id === st.activeTabId);
        if (idx === -1) return;
        e.preventDefault();
        const dir = prevTab ? -1 : 1;
        const next = (idx + dir + st.tabs.length) % st.tabs.length;
        st.setActiveTab(st.tabs[next].id);
        return;
      }
      const subview = SUBVIEW_TARGETS.find((s) => matchesEvent(sc[s.id], e));
      const refresh = matchesEvent(sc["refresh-table"], e);
      if (subview || refresh) {
        const tab = st.tabs.find((x) => x.id === st.activeTabId);
        const workspaceVisible =
          !st.connectionsManagerOpen &&
          st.section !== "queue" &&
          st.section !== "agents" &&
          st.section !== "settings";
        if (workspaceVisible && tab?.kind === "table" && st.activeTabId) {
          e.preventDefault();
          if (subview) st.setTableSubView(st.activeTabId, subview.view);
          else st.bumpDataVersion();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setCommandPalette, setSection, openQueryTab]);

  // NOTE: native menu items (⌘W / ⌘Q / ⌘Z / ⇧⌘Z) never reach the webview as
  // keydown — the Rust menu forwards them as events, routed here.
  useEffect(() => {
    if (!inTauri()) return;
    function requestQuit() {
      if (useStore.getState().settings.confirmQuit) setQuitDialogOpen(true);
      else void getCurrentWindow().destroy();
    }
    const unMenu = listen<string>(MENU_EVENT, (e) => {
      const id = e.payload;
      if (id === "close-tab") {
        const { tabs, activeTabId, closeTab } = useStore.getState();
        if (activeTabId && tabs.length > 0) closeTab(activeTabId);
        else requestQuit();
      } else if (id === "quit") {
        requestQuit();
      } else if (id === "undo" || id === "redo") {
        if (isEditableTarget(document.activeElement)) {
          document.execCommand(id);
        } else {
          window.dispatchEvent(new CustomEvent(`gatehouse:${id}`));
        }
      } else if (id === "copy") {
        if (
          isEditableTarget(document.activeElement) ||
          window.getSelection()?.toString()
        ) {
          document.execCommand("copy");
        } else {
          window.dispatchEvent(new CustomEvent("gatehouse:copy"));
        }
      }
    });
    const unClose = getCurrentWindow().onCloseRequested((event) => {
      if (useStore.getState().settings.confirmQuit) {
        event.preventDefault();
        setQuitDialogOpen(true);
      }
    });
    // The embedded MCP server emits these on every agent tool call.
    const unActivity = listen<AgentActivityPayload>(AGENT_ACTIVITY_EVENT, (e) => {
      useStore.getState().noteAgentActivity({
        client: e.payload.client,
        tool: e.payload.tool,
        durationMs: e.payload.duration_ms,
        rows: e.payload.rows,
        at: new Date().toISOString(),
      });
    });
    const unQueue = listen<string>(QUEUE_CHANGED_EVENT, () => {
      void useStore.getState().refreshQueue();
    });
    return () => {
      void unMenu.then((f) => f());
      void unClose.then((f) => f());
      void unActivity.then((f) => f());
      void unQueue.then((f) => f());
    };
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-shell text-foreground">
      <TitleBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Rail />
        {!connectionsManagerOpen && <ProfileTabs />}
        {!connectionsManagerOpen && <ContextPanel />}
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
          {connectionsManagerOpen ? (
            <ConnectionsManager />
          ) : section === "queue" ? (
            <ValidationQueue />
          ) : section === "agents" ? (
            <AgentActivityScreen />
          ) : section === "settings" ? (
            <SettingsScreen />
          ) : (
            <Workspace />
          )}
        </main>
      </div>
      <ConnectionDialog />
      <CommandPalette />

      {keychainError && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[440px] rounded-xl border border-border bg-card p-6 shadow-xl">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-destructive/10">
                <KeyRound className="h-[18px] w-[18px] text-destructive" />
              </div>
              <h2 className="text-[16px] font-bold tracking-tight text-foreground">
                {t("app.keychainTitle")}
              </h2>
            </div>
            <p className="text-[13.5px] leading-relaxed text-muted-foreground">
              {t("app.keychainMessage")}
            </p>
            <p className="mt-2 break-all font-mono text-[11.5px] text-muted-foreground/70">
              {keychainError}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              {inTauri() && (
                <Button
                  variant="outline"
                  onClick={() => void getCurrentWindow().destroy()}
                >
                  {t("common.quit")}
                </Button>
              )}
              <Button
                variant="brand"
                onClick={() => {
                  setKeychainError(null);
                  void initBackend();
                }}
              >
                {t("app.keychainRetry")}
              </Button>
            </div>
          </div>
        </div>
      )}

      <Dialog open={quitDialogOpen} onOpenChange={setQuitDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("app.quitTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            {t("app.quitMessage")}
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setQuitDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void getCurrentWindow().destroy()}
            >
              {t("common.quit")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
