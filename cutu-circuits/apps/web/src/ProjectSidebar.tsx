import { useState } from "react";
import {
  Button,
  IconButton,
  Menu,
  MenuItem,
  MenuLabel,
  Tooltip,
} from "@cutucircuits/ui";
import { SidebarRow } from "@cutucircuits/ui/patterns";
import type { Project, ProjectSummary, Asset } from "@cutucircuits/core";
import { Glyph } from "./Glyph";
export type View = "assembly" | "circuit" | "cad" | "source" | "robot";
export const artifactLabel = (asset: Asset) => {
  if (asset.kind === "cad") return "Mechanical design";
  if (asset.kind === "circuit") return "Circuit design";
  if (asset.kind === "urdf") return "Robot model";
  return asset.name
    .replace(/\.(tsx?|jsx?|json|cpp|py)$/, "")
    .replace(/[_.-]/g, " ");
};
interface Props {
  projects: ProjectSummary[];
  project?: Project;
  view: View;
  assetId: string;
  selectedId?: string | null;
  onCreate: () => void;
  onProject: (id: string) => void;
  onView: (view: View) => void;
  onAsset: (id: string, source?: boolean) => void;
  onSelect: (id: string) => void;
}
export function ProjectSidebar({
  projects,
  project,
  view,
  assetId,
  selectedId,
  onCreate,
  onProject,
  onView,
  onAsset,
  onSelect,
}: Props) {
  const [objects, setObjects] = useState(false);
  const [files, setFiles] = useState(false);
  const designs =
    project?.assets.filter((a) =>
      ["cad", "circuit", "urdf"].includes(a.kind),
    ) ?? [];
  const sources =
    project?.assets.filter((a) => a.kind !== "cad" && a.kind !== "circuit") ??
    [];
  return (
    <aside className="project-sidebar" aria-label="Project navigation">
      <div className="sidebar-heading">
        <span>Workspace</span>
        <Tooltip content="Create a project">
          <IconButton label="New project" size="sm" onClick={onCreate}>
            <Glyph name="plus" />
          </IconButton>
        </Tooltip>
      </div>
      <Menu
        align="start"
        triggerLabel="Current project"
        trigger={(props) => (
          <Button {...props} className="project-picker">
            <span className="project-avatar">
              <Glyph name="folder" />
            </span>
            <span className="project-picker-copy">
              <strong>{project?.name ?? "Choose a project"}</strong>
              <small>Local project</small>
            </span>
            <Glyph name="down" />
          </Button>
        )}
      >
        <MenuLabel>Your projects</MenuLabel>
        {projects.map((p) => (
          <MenuItem
            key={p.id}
            icon={<Glyph name="folder" />}
            trailing={project?.id === p.id ? <Glyph name="save" /> : undefined}
            onClick={() => onProject(p.id)}
          >
            {p.name}
          </MenuItem>
        ))}
        <MenuItem icon={<Glyph name="plus" />} onClick={onCreate}>
          New project
        </MenuItem>
      </Menu>
      <nav className="tree-section" aria-label="Project views">
        <span className="section-label">Design</span>
        <SidebarRow
          className="tree-row"
          aria-current={view === "assembly" ? "page" : undefined}
          onClick={() => onView("assembly")}
        >
          <Glyph name="cube" />
          <span>Assembly</span>
          <span className="row-meta">3D</span>
        </SidebarRow>
        {designs.map((a) => (
          <SidebarRow
            key={a.id}
            className="tree-row"
            aria-current={
              a.id === assetId && view !== "assembly" ? "page" : undefined
            }
            onClick={() => onAsset(a.id)}
          >
            <Glyph name={a.kind === "circuit" ? "chip" : "cube"} />
            <span>{artifactLabel(a)}</span>
          </SidebarRow>
        ))}
      </nav>
      <div className="tree-section">
        <SidebarRow
          className="section-toggle"
          aria-expanded={objects}
          onClick={() => setObjects(!objects)}
        >
          <Glyph name={objects ? "down" : "chevron"} />
          <span>Objects</span>
          <span className="row-meta">{project?.entities.length ?? 0}</span>
        </SidebarRow>
        {objects && (
          <div className="object-tree disclosure-content">
            {project?.entities.map((e) => (
              <SidebarRow
                className="tree-row object-row"
                aria-current={selectedId === e.id ? "true" : undefined}
                key={e.id}
                onClick={() => {
                  onView("assembly");
                  onSelect(e.id);
                }}
                style={{ paddingLeft: e.parentId ? 24 : 12 }}
              >
                <span
                  className={`object-dot ${e.kind}`}
                  style={{ background: e.color }}
                />
                <span>{e.name}</span>
              </SidebarRow>
            ))}
          </div>
        )}
        <SidebarRow
          className="section-toggle"
          aria-expanded={files}
          onClick={() => setFiles(!files)}
        >
          <Glyph name={files ? "down" : "chevron"} />
          <span>Files & programs</span>
          <span className="row-meta">{project?.assets.length ?? 0}</span>
        </SidebarRow>
        {files && (
          <div className="disclosure-content">
            {project?.assets.map((a) => (
              <SidebarRow
                key={a.id}
                className="tree-row file-row"
                onClick={() => onAsset(a.id, a.kind !== "urdf")}
              >
                <Glyph name="code" />
                <span>{a.name}</span>
              </SidebarRow>
            ))}
            {!sources.length && !project?.assets.length && (
              <p className="quiet-note">No files in this project yet.</p>
            )}
          </div>
        )}
      </div>
      <div className="sidebar-footer">
        <Glyph name="folder" />
        <span>Saved on this device</span>
        <span className="row-meta">
          {project ? `r${project.revision}` : ""}
        </span>
      </div>
    </aside>
  );
}
