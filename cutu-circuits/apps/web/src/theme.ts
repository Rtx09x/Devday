import { getAppTheme, resolveTheme } from "@cutucircuits/ui";
import { materialSurfaceColors } from "@cutucircuits/ui/themes/foundation";
import { useSyncExternalStore } from "react";
export type ColorMode = "light" | "dark";
const eventName = "cutu-theme-change";
export function savedColorMode(): ColorMode {
  try { return localStorage.getItem("cutu:color-mode") === "dark" ? "dark" : "light"; }
  catch { return "light"; }
}
export function useColorMode(): ColorMode {
  return useSyncExternalStore(
    callback => { window.addEventListener(eventName, callback); return () => window.removeEventListener(eventName, callback); },
    () => document.documentElement.dataset.colorMode === "dark" ? "dark" : "light",
    () => "light",
  );
}
export function applyTheme(mode: ColorMode = savedColorMode()) {
  const root = document.documentElement;
  root.dataset.theme = "material";
  root.dataset.colorMode = mode;
  root.style.colorScheme = mode;
  for (const [key, value] of Object.entries({
    ...resolveTheme(getAppTheme("material")[mode]),
    ...(mode === "dark" ? materialSurfaceColors : {
      surface: "#ffffff", "surface-deep": "#f1f5f9", "surface-sidebar": "#f1f5f9",
      "surface-sidebar-translucent": "#f1f5f9", "surface-control": "#e2e8f0",
      "surface-popover": "#ffffff", "surface-drawer": "#ffffff", "surface-recessed": "#f1f5f9",
      "surface-raised": "#f8fafc", "surface-elevated-secondary": "#f1f5f9",
      ink: "#0f172a", "ink-strong": "#0f172a", "ink-muted": "#334155", "ink-faint": "#475569",
      "ink-inverse": "#ffffff", accent: "#075985", "accent-ink": "#075985",
      border: "#cbd5e1", "border-muted": "#cbd5e1", "border-strong": "#64748b",
      "overlay-hover": "#e8eef5", "overlay-pressed": "#dbeafe",
    }),
  }))
    root.style.setProperty(`--theme-${key}`, value);
  try { localStorage.setItem("cutu:color-mode", mode); } catch { /* In-memory mode still works. */ }
  window.dispatchEvent(new Event(eventName));
}
