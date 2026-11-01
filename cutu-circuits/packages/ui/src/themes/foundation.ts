import type {ThemeVariant} from "@cutucircuits/ui/themes/theme";
import {cutucircuitsTheme} from "@cutucircuits/ui/themes/cutucircuits";

/** Original CutuCircuits Material surfaces; keep these together when tuning the theme. */
export const materialSurfaceColors = {
  "surface-deep": "#1e2024",
  "surface-sidebar": "#1e2024",
  "surface-sidebar-translucent": "rgb(30 32 36 / 0.9)",
  "surface-control": "#3b3d3d",
  "surface-popover": "#323434",
  "surface-drawer": "#2b2c2c",
  "surface-raised": "rgb(255 255 255 / 0.032)",
  "surface-elevated-secondary": "rgb(255 255 255 / 0.052)",
  "ink-muted": "color-mix(in srgb, #eeffff 65%, transparent)",
  "ink-faint": "rgb(255 255 255 / 0.498)",
  border: "rgb(255 255 255 / 0.084)",
  "border-muted": "rgb(255 255 255 / 0.084)",
  "border-strong": "rgb(255 255 255 / 0.156)",
  "overlay-hover": "rgb(255 255 255 / 0.078)",
  "overlay-pressed": "rgb(255 255 255 / 0.08)",
};

function palette<const T extends string>(id: T, name: string, dark: readonly [string, string, string], light?: readonly [string, string, string]) {
  const variant = (mode: "dark" | "light", seeds: readonly [string, string, string]): ThemeVariant => ({
    ...cutucircuitsTheme[mode],
    theme: {...cutucircuitsTheme[mode].theme, surface: seeds[0], ink: seeds[1], accent: seeds[2]},
  });
  return {id, name, dark: variant("dark", dark), light: light ? variant("light", light) : cutucircuitsTheme.light, darkOnly: !light};
}

/** Palettes retained from the former product UI, applied to Cutu Circuits's native surfaces. */
export const foundationThemes = [
  {...palette("material", "Material", ["#212121", "#eeffff", "#80cbc4"]), darkOnly: false},
  palette("codex", "Codex", ["#111111", "#fcfcfc", "#0169cc"], ["#ffffff", "#0d0d0d", "#0169cc"]),
  palette("catppuccin", "Catppuccin", ["#1e1e2e", "#cdd6f4", "#cba6f7"], ["#eff1f5", "#4c4f69", "#8839ef"]),
  palette("github", "GitHub", ["#0d1117", "#e6edf3", "#1f6feb"], ["#ffffff", "#1f2328", "#0969da"]),
  palette("nord", "Nord", ["#2e3440", "#d8dee9", "#88c0d0"]),
  palette("tokyo-night", "Tokyo Night", ["#1a1b26", "#a9b1d6", "#3d59a1"]),
] as const;
