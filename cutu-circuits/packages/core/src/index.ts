/** Shared, JSON-serializable project contract. Native files retain their own formats. */
export type Vec3 = [number, number, number];
export type JsonSchema = Record<string, unknown>;
export type EntityKind =
  | "controller"
  | "servo"
  | "board"
  | "part"
  | "sensor"
  | "connector"
  | "joint"
  | "group";
export interface Geometry {
  type: "box" | "cylinder" | "wire" | "mesh";
  size?: Vec3;
  radius?: number;
  length?: number;
  points?: Vec3[];
  assetId?: string;
  shapeName?: string;
}
export interface Entity {
  id: string;
  name: string;
  kind: EntityKind;
  parentId?: string;
  position: Vec3;
  rotation?: Vec3;
  color?: string;
  geometry?: Geometry;
  metadata: Record<string, unknown>;
}
export interface EngineeringLink {
  id: string;
  source: string;
  target: string;
  kind: "electrical" | "mechanical" | "control";
  label?: string;
  sourcePort?: string;
  targetPort?: string;
}
export interface Asset {
  id: string;
  name: string;
  path: string;
  kind: "circuit" | "cad" | "firmware" | "program" | "data" | "urdf";
  entityIds: string[];
}
export interface MotionJoint {
  entityId: string;
  channel?: string;
  axis: Vec3;
  centerUs: number;
  minUs: number;
  maxUs: number;
  /** Preview mapping only, unless explicitly calibrated by the project owner. */
  pulsePerDegree?: number;
  drivenEntityIds?: string[];
}
export interface MotionPhase {
  label: string;
  targets: Record<string, number>;
  durationMs: number;
  settleMs: number;
}
export interface MotionDefinition {
  id: string;
  name: string;
  description: string;
  source: "commanded";
  calibrated: boolean;
  joints: MotionJoint[];
  phases: MotionPhase[];
  /** Illustrative ground travel per gait cycle, independent of measured hardware. */
  previewTravel?: { direction: Vec3; strideMm: number };
}
export interface Capability {
  id: string;
  label: string;
  description: string;
  kind: "read" | "write" | "motion";
  command: string;
  args: string[];
  inputSchema: JsonSchema;
  timeoutMs?: number;
  /** Long-running capabilities are cancellable and may emit JSON Lines telemetry. */
  persistent?: boolean;
}
export interface HardwareManifest {
  version: 1;
  name: string;
  description: string;
  capabilities: Capability[];
}
export interface Project {
  version: 1;
  id: string;
  name: string;
  description: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  units: "mm";
  entities: Entity[];
  links: EngineeringLink[];
  assets: Asset[];
  motion?: MotionDefinition;
  hardware?: HardwareManifest;
}
export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  revision: number;
  updatedAt: string;
  entityCount: number;
  assetCount: number;
}
export interface FileSnapshot {
  path: string;
  content: string;
  sha256: string;
}
/** Immutable versions kept privately by the project runtime. */
export interface FileHistoryEntry {
  id: string;
  path: string;
  sha256: string;
  createdAt: string;
  sizeBytes: number;
  reason: "baseline" | "save" | "external" | "restore" | "recovery";
}
export interface FileHistoryVersion {
  entry: FileHistoryEntry;
  content: string;
}
export interface SelectionContext {
  id: string;
  label: string;
  description: string;
  icon?: string;
  groupLabel?: string;
  data?: unknown;
  includeData?: boolean;
}
export interface Selection {
  entityId: string | null;
  assetId?: string;
  origin: "workspace" | "codex";
  updatedAt: string;
  context?: SelectionContext[];
}
export interface Operation {
  id: string;
  projectId: string;
  capabilityId: string;
  label: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  output: string;
  error?: string;
  telemetry?: Record<string, unknown>;
}
export interface WorkspaceEvent {
  id: string;
  projectId: string;
  type:
    | "project.updated"
    | "file.updated"
    | "selection.updated"
    | "operation.updated"
    | "engine.updated"
    | "editor-tool-request"
    | "presentation.requested";
  timestamp: string;
  data: unknown;
}
export interface Diagnostic {
  level: "error" | "warning" | "info";
  message: string;
  line?: number;
}
export interface CircuitComponent {
  id: string;
  name: string;
  type: string;
  value?: string;
  pins?: string[];
}
export interface CircuitResult {
  kind: "circuit";
  path: string;
  sourceSha256: string;
  compiledAt: string;
  circuitJson: Record<string, unknown>[];
  components: CircuitComponent[];
  schematicSvg: string;
  pcbSvg: string;
  diagnostics: Diagnostic[];
}
export interface MeshData {
  vertices: number[];
  triangles: number[];
  normals: number[];
  edges?: number[];
}
export interface CadShape {
  name: string;
  mesh: MeshData;
  color?: string;
  opacity?: number;
}
export interface CadResult {
  kind: "cad";
  path: string;
  sourceSha256: string;
  compiledAt: string;
  shapes: CadShape[];
  parameters: Record<string, number | boolean | string>;
  metrics: {
    volume: number;
    surfaceArea: number;
    triangleCount: number;
    bounds: { min: Vec3; max: Vec3; size: Vec3 };
  };
  diagnostics: Diagnostic[];
}
export type EngineResult = CircuitResult | CadResult;
export interface ArtifactResult {
  name: string;
  mimeType: string;
  content: string;
}
export interface CompileInput {
  path: string;
  parameters?: Record<string, number | boolean | string>;
}
export const PROJECT_FILE = "cutucircuits.project.json";
export class CutuError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "CutuError";
  }
}
