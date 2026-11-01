import { Button, Menu, MenuItem, SettingsSelect } from "@cutucircuits/ui";
import type {
  Project,
  Asset,
  FileSnapshot,
  EngineResult,
} from "@cutucircuits/core";
import { download } from "./api";
interface Props {
  project: Project;
  asset?: Asset;
  assetId: string;
  file?: FileSnapshot;
  content: string;
  conflict: boolean;
  busy: string;
  dirty: boolean;
  compiled?: EngineResult;
  onAsset: (id: string) => void;
  compile: () => Promise<void>;
  exportAsset: (format: string) => Promise<void>;
  setContent: (value: string) => void;
  onReload: () => void;
}
export function SourceEditor({
  project,
  asset,
  assetId,
  file,
  content,
  conflict,
  busy,
  dirty,
  compiled,
  onAsset,
  compile,
  exportAsset,
  setContent,
  onReload,
}: Props) {
  return (
    <div className="source-view">
      <div className="source-toolbar">
        <SettingsSelect
          aria-label="Source file"
          value={assetId}
          onValueChange={onAsset}
          options={project.assets.map((a) => ({ value: a.id, label: a.name }))}
        />
        {asset && (asset.kind === "cad" || asset.kind === "circuit") && (
          <>
            <Button
              className="control-button"
              onClick={() => void compile()}
              disabled={!!busy || dirty}
            >
              Compile
            </Button>
            <Menu
              triggerLabel="Export format"
              trigger={(props) => (
                <Button
                  {...props}
                  className="control-button"
                  disabled={!!busy || dirty}
                >
                  Export…
                </Button>
              )}
            >
              {(asset.kind === "cad"
                ? ["step", "stl", "obj"]
                : ["svg", "bom"]
              ).map((format) => (
                <MenuItem key={format} onClick={() => void exportAsset(format)}>
                  {format.toUpperCase()}
                </MenuItem>
              ))}
            </Menu>
          </>
        )}
      </div>
      {conflict && (
        <div className="conflict" role="alert">
          This file changed outside this editor. Your edits are preserved.{" "}
          <Button onClick={onReload}>Reload latest</Button>
          <Button
            onClick={() =>
              file &&
              download(
                file.path.split("/").at(-1) ?? "source.txt",
                "text/plain",
                content,
              )
            }
          >
            Download my edits
          </Button>
        </div>
      )}
      <textarea
        aria-label="Native source editor"
        spellCheck={false}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        disabled={!file}
      />
      {compiled && (
        <div className="compile-result" role="status">
          {compiled.kind === "cad"
            ? `${compiled.shapes.length} shapes · ${compiled.metrics.triangleCount.toLocaleString()} triangles`
            : `${compiled.components.length} components`}{" "}
          ·{" "}
          {compiled.diagnostics.length
            ? compiled.diagnostics.map((d) => d.message).join(" · ")
            : "Compilation complete"}
        </div>
      )}
    </div>
  );
}
