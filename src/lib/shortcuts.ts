// NOTE: bindings are stored as "Mod+Alt+Shift+<token>" strings in
// settings.shortcuts. The token is e.code for the digit row (layout-
// independent: AZERTY sends "&"/"é"/'"' as e.key but Digit1/2/3 as e.code)
// and a normalized e.key otherwise (so letter shortcuts follow the layout,
// as users expect).
export const SHORTCUT_IDS = [
  "command-palette",
  "run-query",
  "new-query",
  "validation-queue",
  "subview-data",
  "subview-structure",
  "subview-relations",
  "refresh-table",
  "prev-tab",
  "next-tab",
  "cancel-query",
  "review-staged",
] as const;

export type ShortcutId = (typeof SHORTCUT_IDS)[number];
export type ShortcutMap = Record<ShortcutId, string>;

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  "command-palette": "Mod+P",
  "run-query": "Mod+Enter",
  "new-query": "Mod+T",
  "validation-queue": "Mod+Shift+V",
  "subview-data": "Mod+Digit1",
  "subview-structure": "Mod+Digit2",
  "subview-relations": "Mod+Digit3",
  "refresh-table": "Mod+R",
  "prev-tab": "Mod+Alt+ArrowLeft",
  "next-tab": "Mod+Alt+ArrowRight",
  "cancel-query": "Mod+.",
  "review-staged": "Mod+S",
};

const MODIFIER_NAMES = ["Mod", "Alt", "Shift"];
const MODIFIER_KEYS = ["Meta", "Control", "Alt", "Shift"];
// The native macOS menu owns these accelerators in the desktop build — a
// binding on them would silently never fire (see App.tsx MENU_EVENT note).
const RESERVED_TOKENS = ["W", "Q", "Z"];
const DIGIT_CODE = /^Digit(\d)$/;
const LETTER_CODE = /^Key([A-Z])$/;

interface ParsedBinding {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  token: string;
}

/// Structural subset shared by native KeyboardEvent and React's synthetic one.
export interface KeyComboEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  code: string;
}

function normalizeToken(token: string): string {
  return token.length === 1 ? token.toUpperCase() : token;
}

export function parseBinding(binding: string): ParsedBinding | null {
  const parts = binding.split("+");
  let token = parts.pop() ?? "";
  if (token === "" && parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
    token = "+";
  }
  if (token === "" || !parts.every((p) => MODIFIER_NAMES.includes(p))) {
    return null;
  }
  return {
    mod: parts.includes("Mod"),
    alt: parts.includes("Alt"),
    shift: parts.includes("Shift"),
    token: normalizeToken(token),
  };
}

function eventToken(e: KeyComboEvent): string {
  if (DIGIT_CODE.test(e.code)) return e.code;
  if (e.altKey) {
    const letter = LETTER_CODE.exec(e.code);
    if (letter) return letter[1];
  }
  return normalizeToken(e.key);
}

export function matchesEvent(
  binding: string | undefined,
  e: KeyComboEvent
): boolean {
  if (!binding) return false;
  const p = parseBinding(binding);
  if (!p) return false;
  return (
    (e.metaKey || e.ctrlKey) === p.mod &&
    e.altKey === p.alt &&
    e.shiftKey === p.shift &&
    eventToken(e) === p.token
  );
}

export type RecordedBinding =
  | { ok: true; binding: string }
  | { ok: false; reason: "needs-mod" | "reserved" };

/// Returns null while only modifiers are held (recording in progress).
export function bindingFromEvent(e: KeyComboEvent): RecordedBinding | null {
  if (MODIFIER_KEYS.includes(e.key)) return null;
  const token = eventToken(e);
  if (!(e.metaKey || e.ctrlKey)) return { ok: false, reason: "needs-mod" };
  if (!e.altKey && RESERVED_TOKENS.includes(token)) {
    return { ok: false, reason: "reserved" };
  }
  const parts = ["Mod"];
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(token);
  return { ok: true, binding: parts.join("+") };
}

const TOKEN_SYMBOLS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "↵",
  Backspace: "⌫",
  Delete: "⌦",
  Tab: "⇥",
  Escape: "⎋",
  " ": "␣",
};

export function formatBinding(binding: string | undefined): string {
  if (!binding) return "";
  const p = parseBinding(binding);
  if (!p) return binding;
  const digit = DIGIT_CODE.exec(p.token);
  const token = digit ? digit[1] : (TOKEN_SYMBOLS[p.token] ?? p.token);
  const mods = `${p.alt ? "⌥" : ""}${p.shift ? "⇧" : ""}${p.mod ? "⌘" : ""}`;
  return `${mods}${token}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/// Overlays valid persisted bindings on the defaults; unknown ids and
/// unparseable values (e.g. from an older schema) are dropped.
export function sanitizeShortcuts(v: unknown): ShortcutMap {
  const out = { ...DEFAULT_SHORTCUTS };
  if (!isRecord(v)) return out;
  for (const id of SHORTCUT_IDS) {
    const binding = v[id];
    if (typeof binding === "string" && parseBinding(binding)) {
      out[id] = binding;
    }
  }
  return out;
}
