import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { useStore } from "@/store";
import type { ExportFormat, KeywordCase } from "@/store";
import { setLanguage } from "@/lib/i18n";
import {
  DEFAULT_SHORTCUTS,
  bindingFromEvent,
  formatBinding,
  type ShortcutId,
} from "@/lib/shortcuts";
import { THEMES, type ThemeName } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatRelativeTime } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { AuditTable } from "@/components/AuditTable";

export function SettingsScreen() {
  const section = useStore((s) => s.settingsSection);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-8">
        {section === "general" && <GeneralSettings />}
        {section === "appearance" && <AppearanceSettings />}
        {section === "editor" && <EditorSettings />}
        {section === "agents" && <AgentSettings />}
        {section === "shortcuts" && <ShortcutSettings />}
      </div>
    </div>
  );
}

function PageTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-[22px] font-bold tracking-tight text-foreground">
        {title}
      </h1>
      {sub && <p className="mt-1 text-[13.5px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function SettingCard({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 rounded-xl border border-border bg-card px-5 py-4">
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-foreground">{label}</div>
        {desc && (
          <div className="mt-0.5 text-[12.5px] text-muted-foreground">{desc}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center rounded-lg border border-border bg-panel-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors",
            value === o.value
              ? "bg-brand-muted text-brand"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function GeneralSettings() {
  const { t, i18n } = useTranslation();
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const exportOptions: { value: ExportFormat; label: string }[] = [
    { value: "csv", label: "CSV" },
    { value: "json", label: "JSON" },
    { value: "markdown", label: "Markdown" },
    { value: "insert", label: "INSERT" },
  ];
  return (
    <div>
      <PageTitle title={t("settings.general")} />
      <div className="space-y-3">
        <SettingCard label={t("settings.rowLimit")} desc={t("settings.rowLimitDesc")}>
          <Select
            value={String(settings.rowLimit)}
            onValueChange={(v) => update({ rowLimit: Number(v) })}
          >
            <SelectTrigger className="h-9 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[100, 500, 1000, 5000].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingCard>

        <SettingCard
          label={t("settings.restoreTabs")}
          desc={t("settings.restoreTabsDesc")}
        >
          <Switch
            checked={settings.restoreTabs}
            onCheckedChange={(v) => update({ restoreTabs: v })}
          />
        </SettingCard>

        <SettingCard
          label={t("settings.confirmQuit")}
          desc={t("settings.confirmQuitDesc")}
        >
          <Switch
            checked={settings.confirmQuit}
            onCheckedChange={(v) => update({ confirmQuit: v })}
          />
        </SettingCard>

        <SettingCard
          label={t("settings.exportFormat")}
          desc={t("settings.exportFormatDesc")}
        >
          <Segmented
            value={settings.exportFormat}
            options={exportOptions}
            onChange={(v) => update({ exportFormat: v })}
          />
        </SettingCard>

        <SettingCard label={t("settings.language")}>
          <Select
            value={i18n.language.startsWith("fr") ? "fr" : "en"}
            onValueChange={(v) => {
              setLanguage(v === "fr" ? "fr" : "en");
              update({ language: v === "fr" ? "fr" : "en" });
            }}
          >
            <SelectTrigger className="h-9 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="fr">Français</SelectItem>
            </SelectContent>
          </Select>
        </SettingCard>
      </div>
    </div>
  );
}

const THEME_SWATCHES: Record<ThemeName, string[]> = {
  green: ["#e8edd4", "#d4dec2", "#a8c99a", "#6ba07d", "#3d7a62"],
  blue: ["#152036", "#1b2845", "#274060", "#3f6ea8", "#5899e2"],
};

const THEME_PREVIEW: Record<
  ThemeName,
  { bg: string; rail: string; line: string; button: string }
> = {
  green: { bg: "#f2f4dd", rail: "#e8edd4", line: "#cdd9b8", button: "#6ba07d" },
  blue: { bg: "#1b2845", rail: "#0e1a30", line: "#2c4569", button: "#5899e2" },
};

function AppearanceSettings() {
  const { t } = useTranslation();
  const theme = useStore((s) => s.settings.theme);
  const update = useStore((s) => s.updateSettings);
  const subFor: Record<ThemeName, string> = {
    green: t("settings.themeGreenSub"),
    blue: t("settings.themeBlueSub"),
  };
  const nameFor: Record<ThemeName, string> = {
    green: t("settings.themeGreen"),
    blue: t("settings.themeBlue"),
  };
  return (
    <div>
      <PageTitle title={t("settings.appearance")} sub={t("settings.themeSubtitle")} />
      <div className="mb-3 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("settings.theme")}
      </div>
      <div className="grid grid-cols-2 gap-5">
        {THEMES.map((th) => {
          const selected = theme === th;
          const p = THEME_PREVIEW[th];
          return (
            <button
              key={th}
              onClick={() => update({ theme: th })}
              className={cn(
                "overflow-hidden rounded-xl border text-left transition-all",
                selected
                  ? "border-brand ring-2 ring-brand/30"
                  : "border-border hover:border-border-strong"
              )}
            >
              <div
                className="flex h-40 gap-2 p-3"
                style={{ background: p.bg }}
              >
                <div
                  className="h-full w-10 rounded-md"
                  style={{ background: p.rail }}
                />
                <div className="flex flex-1 flex-col gap-2 pt-1">
                  <div
                    className="h-2.5 w-4/5 rounded-full"
                    style={{ background: p.line }}
                  />
                  <div
                    className="h-2.5 w-3/5 rounded-full"
                    style={{ background: p.line }}
                  />
                  <div
                    className="h-2.5 w-2/3 rounded-full"
                    style={{ background: p.line }}
                  />
                  <div
                    className="mt-1 h-6 w-20 rounded-md"
                    style={{ background: p.button }}
                  />
                </div>
              </div>
              <div className="flex items-center gap-3 border-t border-border bg-card px-4 py-3">
                <span
                  className={cn(
                    "flex h-5 w-5 items-center justify-center rounded-full border-2",
                    selected ? "border-brand bg-brand" : "border-border-strong"
                  )}
                >
                  {selected && (
                    <Check className="h-3 w-3 text-brand-foreground" strokeWidth={3} />
                  )}
                </span>
                <span className="text-[14px] font-semibold text-foreground">
                  {nameFor[th]}
                </span>
                <span className="text-[12.5px] text-muted-foreground">
                  {subFor[th]}
                </span>
                <div className="ml-auto flex gap-1">
                  {THEME_SWATCHES[th].map((c, i) => (
                    <span
                      key={i}
                      className="h-4 w-4 rounded-[3px]"
                      style={{ background: c }}
                    />
                  ))}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function EditorSettings() {
  const { t } = useTranslation();
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const caseOptions: { value: KeywordCase; label: string }[] = [
    { value: "upper", label: t("settings.caseUpper") },
    { value: "lower", label: t("settings.caseLower") },
  ];
  return (
    <div>
      <PageTitle title={t("settings.editor")} />
      <div className="space-y-3">
        <SettingCard
          label={t("settings.autocomplete")}
          desc={t("settings.autocompleteDesc")}
        >
          <Switch
            checked={settings.autocomplete}
            onCheckedChange={(v) => update({ autocomplete: v })}
          />
        </SettingCard>

        <SettingCard
          label={t("settings.keywordCase")}
          desc={t("settings.keywordCaseDesc")}
        >
          <Segmented
            value={settings.keywordCase}
            options={caseOptions}
            onChange={(v) => update({ keywordCase: v })}
          />
        </SettingCard>

        <SettingCard label={t("settings.fontSize")}>
          <Select
            value={String(settings.editorFontSize)}
            onValueChange={(v) => update({ editorFontSize: Number(v) })}
          >
            <SelectTrigger className="h-9 w-28">
              <SelectValue>{settings.editorFontSize} px</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {[11, 12, 13, 14, 16].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingCard>

        <SettingCard
          label={t("settings.historyRetention")}
          desc={t("settings.historyRetentionDesc")}
        >
          <Select
            value={String(settings.historyRetentionDays)}
            onValueChange={(v) => update({ historyRetentionDays: Number(v) })}
          >
            <SelectTrigger className="h-9 w-32">
              <SelectValue>
                {t("settings.days", { n: settings.historyRetentionDays })}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {[7, 30, 90, 365].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {t("settings.days", { n })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingCard>
      </div>
    </div>
  );
}

const RECENT_ACTIVITY_MS = 5 * 60_000;

function AgentSettings() {
  const { t } = useTranslation();
  const clients = useStore((s) => s.mcpClients);
  const revoke = useStore((s) => s.revokeClient);
  const pairClient = useStore((s) => s.pairClient);
  const profiles = useStore((s) => s.profiles);
  const toggleAgentAccess = useStore((s) => s.toggleAgentAccess);
  const audit = useStore((s) => s.audit);
  const chainValid = useStore((s) => s.auditChainValid);
  const [pairName, setPairName] = useState("");
  const [pairedToken, setPairedToken] = useState<string | null>(null);
  const [tokenCopyState, setTokenCopyState] = useState<"idle" | "ok" | "fail">(
    "idle"
  );
  const [openedAt] = useState(() => Date.now());

  async function confirmPair() {
    const name = pairName.trim();
    if (!name) return;
    const token = await pairClient(name);
    setPairName("");
    setPairedToken(token);
    setTokenCopyState("idle");
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2.5">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">
          {t("settings.agents")}
        </h1>
        <span className="h-2 w-2 rounded-full bg-success" />
        <span className="text-[13px] text-muted-foreground">
          {t("settings.serverActive")}
        </span>
      </div>
      <p className="mb-6 max-w-3xl text-[13.5px] text-muted-foreground">
        {t("settings.agentsIntro")}
      </p>

      <SectionLabel>{t("settings.connectedClients")}</SectionLabel>
      <div className="mb-3 overflow-hidden rounded-xl border border-border bg-card">
        {clients.length === 0 && (
          <div className="px-5 py-3.5 text-[13px] text-muted-foreground">
            {t("settings.noClients")}
          </div>
        )}
        {clients.map((c, i) => {
          const active =
            !!c.lastActivity &&
            openedAt - new Date(c.lastActivity).getTime() < RECENT_ACTIVITY_MS;
          return (
            <div
              key={c.id}
              className={cn(
                "flex items-center gap-3 px-5 py-3.5",
                i > 0 && "border-t border-border",
                c.revoked && "opacity-60"
              )}
            >
              <span
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  active && !c.revoked ? "bg-success" : "bg-muted-foreground/40"
                )}
              />
              <span className="text-[14px] font-semibold text-foreground">
                {c.name}
              </span>
              {c.revoked ? (
                <span className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[12px] font-semibold text-destructive">
                  {t("settings.revoked")}
                </span>
              ) : (
                <span className="text-[12.5px] text-muted-foreground">
                  {t("settings.lastActivity")} :{" "}
                  {c.lastActivity ? formatRelativeTime(c.lastActivity) : "—"}
                </span>
              )}
              {!c.revoked && (
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto text-destructive"
                  onClick={() => revoke(c.id)}
                >
                  {t("settings.revoke")}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <div className="mb-7">
        <div className="flex items-center gap-2">
          <Input
            value={pairName}
            onChange={(e) => setPairName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void confirmPair();
            }}
            placeholder={t("settings.pairNamePlaceholder")}
            className="h-8 w-64 text-[13px]"
          />
          <Button size="sm" disabled={!pairName.trim()} onClick={() => void confirmPair()}>
            {t("settings.pairClient")}
          </Button>
        </div>
        {pairedToken && (
          <div className="mt-3 rounded-lg border border-border bg-card px-4 py-3">
            <div className="mb-1.5 text-[12.5px] text-muted-foreground">
              {t("settings.pairTokenNote")}
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 select-all break-all rounded bg-muted px-2 py-1 font-mono text-[12px] text-foreground">
                {pairedToken}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(pairedToken)
                    .then(() => setTokenCopyState("ok"))
                    .catch(() => setTokenCopyState("fail"));
                }}
              >
                {tokenCopyState === "idle" && t("settings.copyToken")}
                {tokenCopyState === "ok" && "✓"}
                {tokenCopyState === "fail" && "✗"}
              </Button>
            </div>
          </div>
        )}
      </div>

      <SectionLabel>{t("settings.accessByProfile")}</SectionLabel>
      <div className="mb-7 overflow-hidden rounded-xl border border-border bg-card">
        {profiles.map((p, i) => {
            const prod = p.environment === "production";
            return (
              <div
                key={p.id}
                className={cn(
                  "flex items-center gap-3 px-5 py-3.5",
                  i > 0 && "border-t border-border",
                  prod && "bg-destructive/5"
                )}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: p.color }}
                />
                <span className="text-[14px] font-semibold text-foreground">
                  {p.group} · {p.name}
                </span>
                {prod ? (
                  <span className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[12px] font-semibold text-destructive">
                    {t("settings.readForbiddenProd")}
                  </span>
                ) : (
                  <span className="text-[12.5px] text-muted-foreground">
                    {t("settings.readWriteViaFile")}
                  </span>
                )}
                <div className="ml-auto">
                  <Switch
                    checked={!prod && p.agentAccess}
                    disabled={prod}
                    onCheckedChange={() => toggleAgentAccess(p.id)}
                  />
                </div>
              </div>
            );
          })}
      </div>

      <SectionLabel>{t("settings.auditLog")}</SectionLabel>
      {!chainValid && (
        <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
          {t("settings.auditChainInvalid")}
        </div>
      )}
      <AuditTable entries={audit} />
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

const SHORTCUT_ROWS: { id: ShortcutId; labelKey: string }[] = [
  { id: "command-palette", labelKey: "scPalette" },
  { id: "run-query", labelKey: "scRun" },
  { id: "new-query", labelKey: "scNewTab" },
  { id: "validation-queue", labelKey: "scQueue" },
  { id: "subview-data", labelKey: "scSubData" },
  { id: "subview-structure", labelKey: "scSubStructure" },
  { id: "subview-relations", labelKey: "scSubRelations" },
  { id: "refresh-table", labelKey: "scRefresh" },
  { id: "prev-tab", labelKey: "scPrevTab" },
  { id: "next-tab", labelKey: "scNextTab" },
  { id: "cancel-query", labelKey: "scCancel" },
  { id: "review-staged", labelKey: "scReview" },
];

// The native menu owns ⌘Z/⇧⌘Z in the desktop build — display only.
const FIXED_SHORTCUT_ROWS: { id: string; labelKey: string; binding: string }[] =
  [{ id: "undo-redo", labelKey: "scUndo", binding: "⌘Z · ⇧⌘Z" }];

const SHORTCUT_LABELS: Record<string, { fr: string; en: string }> = {
  scPalette: {
    fr: "Chercher une table / palette de commandes",
    en: "Search a table / command palette",
  },
  scRun: { fr: "Exécuter la requête", en: "Run query" },
  scNewTab: { fr: "Nouvel onglet SQL", en: "New SQL tab" },
  scQueue: { fr: "Ouvrir la file de validation", en: "Open validation queue" },
  scSubData: { fr: "Afficher la vue Données", en: "Show Data view" },
  scSubStructure: { fr: "Afficher la vue Structure", en: "Show Structure view" },
  scSubRelations: { fr: "Afficher la vue Relations", en: "Show Relations view" },
  scRefresh: {
    fr: "Rafraîchir les données de la table",
    en: "Refresh table data",
  },
  scPrevTab: { fr: "Onglet précédent", en: "Previous tab" },
  scNextTab: { fr: "Onglet suivant", en: "Next tab" },
  scCancel: { fr: "Annuler la requête en cours", en: "Cancel running query" },
  scReview: {
    fr: "Envoyer les modifications de la grille en file de validation",
    en: "Send staged grid changes to the validation queue",
  },
  scUndo: {
    fr: "Annuler / rétablir une modification de la grille",
    en: "Undo / redo a grid edit",
  },
};

interface ShortcutError {
  id: ShortcutId;
  message: string;
}

function ShortcutSettings() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith("fr") ? "fr" : "en";
  const shortcuts = useStore((s) => s.settings.shortcuts);
  const updateSettings = useStore((s) => s.updateSettings);
  const [filter, setFilter] = useState("");
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
  const [error, setError] = useState<ShortcutError | null>(null);

  // Capture-phase window listener so the recorded combo never reaches the
  // global shortcut handler in App.tsx while recording.
  useEffect(() => {
    if (!recordingId) return;
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !(e.metaKey || e.ctrlKey)) {
        setRecordingId(null);
        return;
      }
      const recorded = bindingFromEvent(e);
      if (!recorded) return;
      if (!recordingId) return;
      if (!recorded.ok) {
        const message =
          recorded.reason === "reserved"
            ? t("settings.shortcutReserved")
            : t("settings.shortcutNeedsMod");
        setError({ id: recordingId, message });
        setRecordingId(null);
        return;
      }
      const holder = SHORTCUT_ROWS.find(
        (r) => r.id !== recordingId && shortcuts[r.id] === recorded.binding
      );
      if (holder) {
        setError({
          id: recordingId,
          message: t("settings.shortcutInUse", {
            label: SHORTCUT_LABELS[holder.labelKey][lang],
          }),
        });
        setRecordingId(null);
        return;
      }
      updateSettings({
        shortcuts: { ...shortcuts, [recordingId]: recorded.binding },
      });
      setRecordingId(null);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recordingId, shortcuts, updateSettings, lang, t]);

  function startRecording(id: ShortcutId) {
    setError(null);
    setRecordingId(id);
  }

  function resetDefaults() {
    setError(null);
    setRecordingId(null);
    updateSettings({ shortcuts: { ...DEFAULT_SHORTCUTS } });
  }

  const matchesFilter = (labelKey: string) =>
    SHORTCUT_LABELS[labelKey][lang]
      .toLowerCase()
      .includes(filter.toLowerCase());
  const rows = SHORTCUT_ROWS.filter((s) => matchesFilter(s.labelKey));
  const fixedRows = FIXED_SHORTCUT_ROWS.filter((s) => matchesFilter(s.labelKey));
  const isDefault = SHORTCUT_ROWS.every(
    (r) => shortcuts[r.id] === DEFAULT_SHORTCUTS[r.id]
  );

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">
          {t("settings.shortcuts")}
        </h1>
        <div className="flex items-center gap-2">
          <input
            autoCorrect="off"
            spellCheck={false}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("settings.filterPlaceholder")}
            className="h-9 w-64 rounded-lg border border-input bg-input-bg px-3 text-[13px] outline-none focus:border-border-strong"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={isDefault}
            onClick={resetDefaults}
          >
            {t("settings.resetShortcuts")}
          </Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {rows.map((s, i) => {
          const recording = recordingId === s.id;
          const modified = shortcuts[s.id] !== DEFAULT_SHORTCUTS[s.id];
          return (
            <div
              key={s.id}
              className={cn(
                "flex items-center justify-between px-5 py-3.5",
                i > 0 && "border-t border-border"
              )}
            >
              <div className="min-w-0">
                <span className="text-[14px] text-foreground">
                  {SHORTCUT_LABELS[s.labelKey][lang]}
                </span>
                {error?.id === s.id && (
                  <div className="mt-0.5 text-[12px] text-destructive">
                    {error.message}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => startRecording(s.id)}
                className={cn(
                  "rounded-md border px-2.5 py-1 font-mono text-[12.5px]",
                  recording
                    ? "animate-pulse border-border-strong bg-panel text-muted-foreground"
                    : "border-border bg-panel-2 text-foreground hover:border-border-strong",
                  !recording && modified && "border-info/50"
                )}
              >
                {recording
                  ? t("settings.pressShortcut")
                  : formatBinding(shortcuts[s.id])}
              </button>
            </div>
          );
        })}
        {fixedRows.map((s) => (
          <div
            key={s.id}
            className="flex items-center justify-between border-t border-border px-5 py-3.5"
          >
            <span className="text-[14px] text-foreground">
              {SHORTCUT_LABELS[s.labelKey][lang]}
            </span>
            <kbd
              title={t("settings.fixedShortcut")}
              className="rounded-md border border-border bg-panel-2 px-2.5 py-1 font-mono text-[12.5px] text-muted-foreground"
            >
              {s.binding}
            </kbd>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12.5px] text-muted-foreground">
        {t("settings.reassignHint")}
      </p>
    </div>
  );
}
