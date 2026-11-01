import {
  Button,
  IconButton,
  Menu,
  MenuItem,
  MenuLabel,
  Tooltip,
} from "@cutucircuits/ui";
import type { View } from "./ProjectSidebar";
import { Glyph } from "./Glyph";
export function ViewToolbar({
  view,
  onView,
  dirty,
  busy,
  onSave,
  onTools,
  onCreate,
  onHistory,
  onImportRobot,
  hasRobot,
  hasProject,
}: {
  view: View;
  onView: (view: View) => void;
  dirty: boolean;
  busy: boolean;
  onSave: () => void;
  onTools: () => void;
  onCreate: () => void;
  onHistory: () => void;
  onImportRobot: () => void;
  hasRobot: boolean;
  hasProject: boolean;
}) {
  return (
    <div className="view-toolbar" data-view={view}>
      <div className="view-tabs" role="tablist" aria-label="Engineering view">
        {(
          [
            "assembly",
            "circuit",
            "cad",
            ...(hasRobot ? ["robot" as const] : []),
          ] as const
        ).map((v) => (
          <Button
            role="tab"
            aria-selected={view === v}
            key={v}
            onClick={() => onView(v)}
          >
            <Glyph name={v === "circuit" ? "chip" : "cube"} />
            <span>
              {v === "cad"
                ? "CAD"
                : v === "assembly"
                  ? "Assembly"
                  : v === "robot"
                    ? "Robot"
                    : "Circuit"}
            </span>
          </Button>
        ))}
      </div>
      {view === "source" && (
        <span className="source-view-label">
          <Glyph name="code" /> Source
        </span>
      )}
      <div className="top-spacer" />
      <div className="view-toolbar-actions">
        {view === "source" && (
          <Button
            variant="filled"
            className="control-button"
            disabled={!dirty || busy}
            onClick={onSave}
          >
            <Glyph name="save" />
            {dirty ? "Save changes" : "Saved"}
          </Button>
        )}
        <Tooltip content="Run a project capability">
          <IconButton label="Project capabilities" onClick={onTools}>
            <Glyph name="bolt" />
          </IconButton>
        </Tooltip>
        <Menu
          triggerLabel="Workspace actions"
          trigger={(props) => (
            <IconButton {...props} label="Workspace actions">
              <Glyph name="more" />
            </IconButton>
          )}
        >
          <MenuLabel>Workspace</MenuLabel>
          <MenuItem
            icon={<Glyph name="code" />}
            onClick={() => onView("source")}
          >
            Edit source files
          </MenuItem>
          <MenuItem
            icon={<Glyph name="plus" />}
            onClick={onImportRobot}
            disabled={!hasProject}
          >
            Import URDF
          </MenuItem>
          <MenuItem
            icon={<Glyph name="folder" />}
            onClick={onHistory}
            disabled={!hasProject}
          >
            Version history
          </MenuItem>
          <MenuItem icon={<Glyph name="plus" />} onClick={onCreate}>
            New project
          </MenuItem>
        </Menu>
      </div>
    </div>
  );
}
