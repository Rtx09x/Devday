import { Button, IconButton, Tooltip } from "@cutucircuits/ui";
import type { Project, Entity, Asset } from "@cutucircuits/core";
import { Glyph } from "./Glyph";
const labels: Record<string, string> = {
  ref: "Reference",
  circuitRef: "Circuit reference",
  gpio: "GPIO",
  boardPin: "Board pin",
  centerUs: "Center pulse",
  minUs: "Minimum pulse",
  maxUs: "Maximum pulse",
  feedback: "Feedback",
  calibration: "Calibration",
  driver: "Driven by",
  illustrative: "Geometry",
};
function formatValue(key: string, value: unknown, project: Project) {
  if (key === "illustrative")
    return value ? "Illustrative" : "Project geometry";
  if (key === "driver")
    return project.entities.find((e) => e.id === value)?.name ?? String(value);
  if (/Us$/.test(key)) return `${String(value)} µs`;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
export function EntityInspector({
  project,
  selected,
  select,
  onOpenAsset,
}: {
  project: Project;
  selected: Entity;
  select: (id: string | null) => void;
  onOpenAsset?: (asset: Asset, source?: boolean) => void;
}) {
  const connections = project.links.filter(
    (l) => l.source === selected.id || l.target === selected.id,
  );
  const properties = Object.entries(selected.metadata).filter(
    ([key, value]) =>
      key !== "circuitRef" && key !== "firmware" && typeof value !== "object",
  );
  const assets = project.assets.filter(
    (a) =>
      a.entityIds.includes(selected.id) || selected.geometry?.assetId === a.id,
  );
  return (
    <aside className="inspector" aria-label="Selected object">
      <div className="inspector-heading">
        <span>{selected.kind}</span>
        <Tooltip content="Clear selection">
          <IconButton
            label="Clear selection"
            size="sm"
            onClick={() => select(null)}
          >
            <Glyph name="close" />
          </IconButton>
        </Tooltip>
      </div>
      <h2>{selected.name}</h2>
      <dl>
        <dt>Position</dt>
        <dd>
          {selected.position.map((v) => Math.round(v * 100) / 100).join(", ")}{" "}
          mm
        </dd>
        {properties.slice(0, 8).map(([key, value]) => (
          <div className="property" key={key}>
            <dt>{labels[key] ?? key.replace(/([A-Z])/g, " $1")}</dt>
            <dd>{formatValue(key, value, project)}</dd>
          </div>
        ))}
      </dl>
      {!!connections.length && (
        <>
          <span className="section-label">Connections</span>
          {connections.map((link) => {
            const peer = project.entities.find(
              (e) =>
                e.id ===
                (link.source === selected.id ? link.target : link.source),
            );
            return (
              <Button
                key={link.id}
                className="connection"
                onClick={() => select(peer?.id ?? null)}
              >
                <span className="status-dot" />
                <span className="connection-copy">
                  <span>{peer?.name ?? "Connected object"}</span>
                  <small>{link.label ?? link.kind}</small>
                </span>
                <Glyph name="chevron" />
              </Button>
            );
          })}
        </>
      )}
      {!!assets.length && onOpenAsset && (
        <div className="inspector-assets">
          {assets.map((asset) => (
            <Button
              key={asset.id}
              className="connection"
              onClick={() => onOpenAsset(asset)}
            >
              <Glyph name={asset.kind === "circuit" ? "chip" : "code"} />
              {asset.kind === "circuit"
                ? "Open Circuit"
                : asset.kind === "cad"
                  ? "Open CAD"
                  : asset.kind === "urdf"
                    ? "Open Robot"
                    : `Open ${asset.name}`}
              <Glyph name="chevron" />
            </Button>
          ))}
        </div>
      )}
      <details className="technical-details">
        <summary>Technical details</summary>
        <dl>
          <dt>Identity</dt>
          <dd>{selected.id}</dd>
          {selected.geometry && (
            <>
              <dt>Geometry</dt>
              <dd>{selected.geometry.type}</dd>
            </>
          )}
          {selected.metadata.firmware != null && (
            <>
              <dt>Firmware</dt>
              <dd>{String(selected.metadata.firmware)}</dd>
            </>
          )}
        </dl>
      </details>
    </aside>
  );
}
