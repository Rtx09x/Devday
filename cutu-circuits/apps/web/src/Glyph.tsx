import { Icon, type IconName } from "@cutucircuits/ui";
const names: Record<string, IconName> = {
  menu: "sidebar",
  down: "chevron-down",
  more: "more-horizontal",
  cube: "worktree",
  code: "code",
  chip: "plugins",
  play: "play",
  stop: "pause",
  plus: "plus",
  close: "x",
  search: "search",
  fit: "maximize",
  reset: "undo",
  chevron: "chevronRight",
  bolt: "bolt",
  folder: "folder",
  download: "arrow-down",
  save: "check",
};
export function Glyph({ name }: { name: string }) {
  return <Icon name={names[name] ?? "file"} size="sm" />;
}
