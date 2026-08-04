import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { useStore } from "@/store";
import type { ConnectionProfile } from "@/lib/types";
import { cn } from "@/lib/utils";

const MIN_TABS_TO_SHOW = 1;
const INITIALS_COUNT = 2;
const HEX_RADIX = 16;
const HEX_PAIR_LENGTH = 2;
const HEX_FULL_LENGTH = 6;
const RGB_MAX = 255;
const SRGB_LINEAR_THRESHOLD = 0.04045;
const SRGB_LINEAR_DIVISOR = 12.92;
const SRGB_GAMMA_OFFSET = 0.055;
const SRGB_GAMMA_SCALE = 1.055;
const SRGB_GAMMA_EXPONENT = 2.4;
const LUMINANCE_RED_WEIGHT = 0.2126;
const LUMINANCE_GREEN_WEIGHT = 0.7152;
const LUMINANCE_BLUE_WEIGHT = 0.0722;
const LIGHT_BACKGROUND_LUMINANCE = 0.5;
const DARK_TEXT_COLOR = "#1f2a22";
const LIGHT_TEXT_COLOR = "#ffffff";

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= INITIALS_COUNT) {
    return words
      .slice(0, INITIALS_COUNT)
      .map((word) => word.charAt(0))
      .join("")
      .toUpperCase();
  }
  return name.trim().slice(0, INITIALS_COUNT).toUpperCase();
}

function channelToLinear(channel: number): number {
  const ratio = channel / RGB_MAX;
  if (ratio <= SRGB_LINEAR_THRESHOLD) return ratio / SRGB_LINEAR_DIVISOR;
  return Math.pow(
    (ratio + SRGB_GAMMA_OFFSET) / SRGB_GAMMA_SCALE,
    SRGB_GAMMA_EXPONENT
  );
}

function textColorOn(background: string): string {
  const hex = background.replace("#", "");
  if (hex.length !== HEX_FULL_LENGTH) return LIGHT_TEXT_COLOR;
  const channels = [0, 1, 2].map((index) =>
    Number.parseInt(
      hex.slice(index * HEX_PAIR_LENGTH, (index + 1) * HEX_PAIR_LENGTH),
      HEX_RADIX
    )
  );
  if (channels.some((channel) => Number.isNaN(channel))) return LIGHT_TEXT_COLOR;
  const [red, green, blue] = channels.map(channelToLinear);
  const luminance =
    LUMINANCE_RED_WEIGHT * red +
    LUMINANCE_GREEN_WEIGHT * green +
    LUMINANCE_BLUE_WEIGHT * blue;
  return luminance > LIGHT_BACKGROUND_LUMINANCE
    ? DARK_TEXT_COLOR
    : LIGHT_TEXT_COLOR;
}

export function ProfileTabs() {
  const { t } = useTranslation();
  const profiles = useStore((s) => s.profiles);
  const openProfileIds = useStore((s) => s.openProfileIds);
  const activeProfileId = useStore((s) => s.activeProfileId);
  const setActiveProfile = useStore((s) => s.setActiveProfile);
  const closeProfile = useStore((s) => s.closeProfile);
  const openConnectionsManager = useStore((s) => s.openConnectionsManager);
  const reorderOpenProfiles = useStore((s) => s.reorderOpenProfiles);

  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  function endDrag() {
    setDraggedId(null);
    setDropTargetId(null);
  }

  const open = openProfileIds
    .map((id) => profiles.find((p) => p.id === id))
    .filter((p): p is ConnectionProfile => p !== undefined);
  if (open.length < MIN_TABS_TO_SHOW) return null;

  return (
    <aside className="flex h-full w-12 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-border bg-sidebar py-2">
      <button
        type="button"
        aria-label={t("profileTabs.add")}
        title={t("profileTabs.add")}
        onClick={() => openConnectionsManager()}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:border-border-strong hover:bg-panel-2 hover:text-foreground"
      >
        <Plus className="h-4 w-4" />
      </button>
      {open.map((p) => (
        <div
          key={p.id}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", p.id);
            e.dataTransfer.effectAllowed = "move";
            setDraggedId(p.id);
          }}
          onDragEnd={endDrag}
          onDragOver={(e) => {
            if (!draggedId || draggedId === p.id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropTargetId(p.id);
          }}
          onDragLeave={() => {
            setDropTargetId((current) => (current === p.id ? null : current));
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (draggedId) reorderOpenProfiles(draggedId, p.id);
            endDrag();
          }}
          className={cn(
            "group relative shrink-0 cursor-grab rounded-lg active:cursor-grabbing",
            draggedId === p.id && "opacity-40",
            dropTargetId === p.id &&
              "ring-2 ring-brand ring-offset-2 ring-offset-sidebar"
          )}
        >
          <button
            type="button"
            title={p.name}
            onClick={() => setActiveProfile(p.id)}
            style={{ backgroundColor: p.color, color: textColorOn(p.color) }}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-lg text-[11px] font-semibold transition-opacity",
              p.id === activeProfileId
                ? "opacity-100 ring-2 ring-foreground ring-offset-2 ring-offset-sidebar"
                : "opacity-60 hover:opacity-100"
            )}
          >
            {initials(p.name)}
          </button>
          <button
            type="button"
            aria-label={t("profileTabs.close")}
            onClick={() => closeProfile(p.id)}
            className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border bg-panel-2 text-foreground opacity-0 transition-opacity hover:bg-border group-hover:opacity-100"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      ))}
    </aside>
  );
}
