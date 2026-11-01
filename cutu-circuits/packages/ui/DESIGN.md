# Visual foundations

## Color and type

Inter is the UI font, with a system monospace stack for code. Most controls use
13–14 px text, with stronger weight for section headings. The SDK preserves its
semantic Tailwind tokens; `appearance.css` sets the application's 14 px small
text scale.

Material is the default palette: #212121 base, #eeffff ink, and #80cbc4 accent.
Its dark surface overrides include #1e2024 for the sidebar/deep surface,
#3b3d3d for controls, #323434 for popovers, and #2b2c2c for drawers. Additional
palettes are Codex, Catppuccin, GitHub, Nord, and Tokyo Night. Nord and Tokyo Night
carry dark palettes with the shared neutral light fallback.

`src/themes/` holds the palette seeds and contrast-aware color resolver.
`src/tokens.css` maps the resolved `--theme-*` values to semantic utility classes.

## Geometry and elevation

- Compact buttons use medium rounding, with optional superellipse geometry.
- Switches use a 40 × 24 px pill and an 18 px white thumb.
- Menus use a 16 px radius; selects use 18 px. Items use 12 px rounding.
- Dialogs use 24 px corners and a 22 px semibold title.
- Settings cards use 18 px corners and subtle row separators.
- Composer and message shells use 22 px corners; composer content is capped at 736 px.

Depth comes primarily from layered neutral surfaces and transparent ink overlays.
Floating menus, selects, and tooltips use an 85% popover surface with 8 px
backdrop blur, a 0.5 px edge, and a small shadow. Dialogs use a 0 16px 48px shadow
at 25% black. The composer has a faint inset highlight.

## Gradients

The Material sidebar preview uses a subtle 180° gradient from #1e2022 to #1b2230.
Controls generally use solid semantic surfaces, rather than decorative gradients.
The preserved message scroller mask fades content at the top and bottom.
Gradient and mask styles live in `src/appearance.css`.

## Interaction and motion

Menus and dialogs use short opacity, translation, and scale transitions
(approximately 140–200 ms). The stepped slider uses a 300 ms eased fill transition,
shortened during dragging. StreamingText supplies per-word fades and a caret.
The gallery respects the system reduced-motion preference.

Base UI supplies focus management and keyboard behavior for switches, menus,
selects, dialogs, tooltips, and continuous sliders. The custom stepped slider
supports arrow keys, Home/End, pointer capture, and focused wheel input.
