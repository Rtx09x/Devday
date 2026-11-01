import { Button, Dialog, Input, SettingsSelect } from "@cutucircuits/ui";
import { Glyph } from "./Glyph";
interface CreateProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete?: (open: boolean) => void;
  name: string;
  onName: (name: string) => void;
  template: string;
  onTemplate: (template: string) => void;
  busy: boolean;
  onCreate: () => void;
}
const templates = [
  { value: "blank", label: "Blank workspace" },
  { value: "spidey", label: "Makada · walking robot" },
  { value: "sensor", label: "Sensor · electronics + enclosure" },
  { value: "robot", label: "Robot · URDF + physics" },
];
const descriptions: Record<string, string> = {
  blank: "A clean workspace for your next idea.",
  spidey: "An articulated robot, control circuit and forward gait preview.",
  sensor: "A sensor circuit and a parametric enclosure, ready to explore.",
  robot: "An articulated URDF model with joint controls and simulated physics.",
};
export function CreateProjectDialog({
  open,
  onOpenChange,
  onOpenChangeComplete,
  name,
  onName,
  template,
  onTemplate,
  busy,
  onCreate,
}: CreateProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
      title="Create a project"
      className="workspace-dialog"
      containerClassName="workspace-dialog-container"
    >
      <form
        className="dialog-inner"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() && !busy) onCreate();
        }}
      >
        <p>Bring your circuits, parts and motion together.</p>
        <label>
          Project name
          <Input
            autoFocus
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder="Give your idea a name"
            required
          />
        </label>
        <div className="form-field">
          <span id="template-label">Starting point</span>
          <SettingsSelect
            aria-label="Starting point"
            value={template}
            onValueChange={onTemplate}
            options={templates}
          />
        </div>
        <div className="template-preview">
          <span className="template-icon">
            <Glyph name={template === "sensor" ? "chip" : "cube"} />
          </span>
          <div>
            <strong>
              {
                templates
                  .find((t) => t.value === template)
                  ?.label.split(" · ")[0]
              }
            </strong>
            <p>{descriptions[template]}</p>
          </div>
        </div>
        <div className="dialog-actions">
          <Button
            variant="ghost"
            size="sm"
            className="dialog-cancel"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            variant="filled"
            type="submit"
            className="control-button accent"
            disabled={!name.trim() || busy}
          >
            {busy ? "Creating…" : "Create project"}
            <Glyph name="chevron" />
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
export interface Command {
  label: string;
  action: () => void;
}
export function ToolPalette({
  open,
  onOpenChange,
  onOpenChangeComplete,
  query,
  onQuery,
  commands,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete?: (open: boolean) => void;
  query: string;
  onQuery: (query: string) => void;
  commands: Command[];
}) {
  const matches = commands
    .filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 12);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
      title="Find a tool"
      hideHeader
      className="workspace-dialog tool-dialog"
      containerClassName="workspace-dialog-container"
    >
      <div className="dialog-inner">
        <div className="palette-search">
          <Glyph name="search" />
          <Input
            autoFocus
            aria-label="Search workspace tools"
            placeholder="Find a view, object, or tool…"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-items">
          {matches.map((c) => (
            <Button
              className="palette-row"
              key={c.label}
              onClick={() => {
                c.action();
                onOpenChange(false);
                onQuery("");
              }}
            >
              {c.label}
              <Glyph name="chevron" />
            </Button>
          ))}
          {!matches.length && (
            <p className="palette-empty">
              No matching tools. Try a view or object name.
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
