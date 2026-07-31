import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import i18n from "@/lib/i18n";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const fr = i18n.language.startsWith("fr");
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return fr ? `il y a ${sec} s` : `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return fr ? `il y a ${min} min` : `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return fr ? `il y a ${h} h` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return fr ? `il y a ${d} j` : `${d}d ago`;
}

// Forward-looking countdown to a future timestamp ("3 min", "45 s").
export function formatCountdown(iso: string): string {
  const diff = Math.max(0, new Date(iso).getTime() - Date.now());
  const fr = i18n.language.startsWith("fr");
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return fr ? `${sec} s` : `${sec}s`;
  const min = Math.floor(sec / 60);
  return fr ? `${min} min` : `${min}m`;
}
