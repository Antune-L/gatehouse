export type ThemeName = "green" | "blue";

export const THEMES: ThemeName[] = ["green", "blue"];

const STORAGE_KEY = "gatehouse.theme";

function isTheme(value: string | null): value is ThemeName {
  return value === "green" || value === "blue";
}

export function storedTheme(): ThemeName {
  const value =
    typeof localStorage !== "undefined"
      ? localStorage.getItem(STORAGE_KEY)
      : null;
  return isTheme(value) ? value : "green";
}

export function applyTheme(theme: ThemeName) {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", theme);
  }
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY, theme);
  }
}
