// Domain types shared across the worker, client, editor, and AI tools.
//
// The substrate is Replicad (OCCT-in-wasm). A model is a `*.replicad.ts` module
// whose default export (or `main`) returns one or more B-rep shapes. The worker
// tessellates those shapes into an indexed mesh for the Three.js viewer and can
// export them to STL / STEP / 3MF / OBJ on demand.

export type ParamKind = 'number' | 'boolean' | 'enum' | 'vector' | 'string';

/**
 * A single parameter the model exposes for the Customizer panel and for the
 * agent to drive. Derived from the script's `defaultParams` (shape-inferred) or
 * from an explicit `parameterDefinitions` descriptor export.
 */
export interface ParamDef {
  name: string;
  kind: ParamKind;
  /** Default value, typed per `kind` (vectors are [x, y, z]). */
  default: number | boolean | string | [number, number, number];
  label?: string;
  /** Optional grouping for the panel; ungrouped params fall under "Parameters". */
  group?: string;
  /** Numeric bounds / step (kind === 'number'). */
  min?: number;
  max?: number;
  step?: number;
  /** Allowed values (kind === 'enum'). */
  options?: string[];
  description?: string;
}

/** Concrete parameter values keyed by name. Vectors arrive as [x, y, z]. */
export type ParamValues = Record<string, number | boolean | string | [number, number, number]>;

export interface ReplicadFaceGroup {
  /** Offset into the flat `triangles` index array. */
  start: number;
  /** Number of entries in the flat `triangles` index array. */
  count: number;
  /** Stable OCCT hash for the B-rep face within this compiled shape. */
  faceId: number;
  surfaceType?: 'planar' | 'cylindrical';
  /** Cylinder radius in model units (mm by convention). */
  radiusMm?: number;
}

/** Indexed triangle mesh in the Three.js-friendly layout Replicad emits. */
export interface ReplicadMesh {
  /** Flat vertex positions: [x0, y0, z0, x1, y1, z1, ...]. */
  vertices: number[];
  /** Triangle vertex indices into `vertices`. */
  triangles: number[];
  /** Per-vertex normals, parallel to `vertices`. */
  normals: number[];
  /** Triangle ranges mapped back to the B-rep faces that produced them. */
  faceGroups?: ReplicadFaceGroup[];
  /** Flat edge line segments for wireframe overlay, if computed. */
  edges?: number[];
}

/** One named shape produced by a compile (a model may return several). */
export interface ShapeResult {
  name: string;
  mesh: ReplicadMesh;
  color?: string;
  opacity?: number;
}

export interface BoundingBox {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

export interface ReplicadFaceSelection {
  id: number;
  /** Tessellated face area in mm^2. */
  areaMm2: number;
  /** Area-weighted average normal in model Z-up coordinates. */
  normal: [number, number, number];
  boundingBox: BoundingBox;
  triangleCount: number;
  surfaceType?: 'planar' | 'cylindrical';
  radiusMm?: number;
}

/** Geometry selected in the live preview, expressed in model Z-up coordinates. */
export interface ReplicadSelection {
  modelFilePath: string;
  units: 'mm';
  coordinateSystem: 'model-z-up';
  shapeName: string;
  shapeBoundingBox: BoundingBox;
  clickPoint: [number, number, number];
  face: ReplicadFaceSelection | null;
}

export interface ModelStats {
  triangleCount: number;
  /** Kernel-measured volume (mm^3) when available, else mesh-estimated. */
  volume: number;
  /** Kernel-measured surface area (mm^2) when available, else mesh-estimated. */
  surfaceArea: number;
  boundingBox: BoundingBox;
  /** Whether the tessellated mesh is closed (every edge shared by two faces). */
  watertight: boolean;
}

export interface CompileMessage {
  level: 'info' | 'warn' | 'error';
  text: string;
  /** 1-based location in the original model-file source, when known. */
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export type ExportFormat = 'stl' | 'step' | '3mf' | 'obj';

/** A serialized export payload. STL ASCII / STEP / OBJ are text; binary is base64. */
export interface ExportArtifact {
  format: ExportFormat;
  /** File extension without the dot. */
  extension: string;
  /** UTF-8 text for text formats, base64 for binary. */
  content: string;
  encoding: 'utf8' | 'base64';
  byteLength: number;
}

export interface StepAsset {
  /** Logical name the script references via `imported(name)`. */
  name: string;
  /** Raw STEP file text. */
  content: string;
}

export interface FontAsset {
  /** Source file name (e.g. `myfont.ttf.b64`). */
  name: string;
  /** base64-encoded TTF/OTF bytes. A font ships as base64 text because the SDK
   * filesystem reader is text-only and cannot return raw binary. */
  base64: string;
}

export interface CompileRequest {
  /** Raw `*.replicad.ts` source to transpile + run. */
  source: string;
  /** Logical path of the source (for diagnostics only). */
  filePath: string;
  /** Parameter overrides merged over the script's defaults. */
  params?: ParamValues;
  /** STEP assets to make available to the script via `imported(name)`. */
  stepAssets?: StepAsset[];
  /** Project font overrides (base64) for `drawText`; the first replaces the
   * worker's built-in default font for this compile. */
  fontAssets?: FontAsset[];
  /** Export formats to serialize in this compile (empty = none). */
  exports?: ExportFormat[];
  /** Mesh tolerances (kernel deflection). */
  tolerance?: number;
  angularTolerance?: number;
}

export interface CompileResult {
  success: boolean;
  filePath: string;
  shapes: ShapeResult[];
  /** Parameter descriptor the worker resolved from the script. */
  params: ParamDef[];
  stats?: ModelStats;
  exports?: ExportArtifact[];
  /** Transform-track animation, if the model exports `animate(t, params)`. */
  animation?: AnimationData;
  diagnostics: CompileMessage[];
  warnings: string[];
  errors: string[];
  renderTimeMs: number;
}

// --- Animation (Phase 1: transform tracks) -----------------------------------

/**
 * A single rigid transform applied to a named shape relative to its rest pose,
 * in model (Z-up) space, as T(position) * T(pivot) * R(rotation) * S(scale) *
 * T(-pivot). Rotation is XYZ Euler in degrees.
 */
export interface TransformOp {
  position?: [number, number, number];
  rotation?: [number, number, number];
  pivot?: [number, number, number];
  scale?: number | [number, number, number];
}

/** A transform, or a list composed in order (innermost/applied-first to last). */
export type Transform = TransformOp | TransformOp[];

/** What a model's `animate(t, params)` returns: a transform per named shape. */
export type AnimationFrameTransforms = Record<string, Transform>;

export interface AnimationConfig {
  durationMs?: number;
  frames?: number;
  loop?: boolean;
}

/**
 * Sampled animation: per shape, one column-major 4x4 matrix (16 floats) per
 * frame. The viewer interpolates between frames. Shapes absent from `tracks`
 * stay at their rest pose.
 */
export interface AnimationData {
  fps: number;
  frames: number;
  durationMs: number;
  loop: boolean;
  /** shapeName -> per-frame column-major 4x4 matrices. */
  tracks: Record<string, number[][]>;
}

export interface OverhangFinding {
  /** Overhang angle measured from a vertical wall (90 deg = flat ceiling). */
  angleFromVerticalDeg: number;
  /** Fraction of total surface area in this overhang severity bucket. */
  areaFraction: number;
}

export interface PrintabilityReport {
  /** Overall heuristic verdict. */
  ok: boolean;
  /** Bed footprint vs. configured printer bed. */
  bed: {
    sizeMm: [number, number, number];
    bedMm: [number, number] | null;
    fits: boolean | null;
  };
  /** Largest unsupported overhang detected (faces past the overhang threshold). */
  overhang: {
    thresholdDeg: number;
    worstAngleDeg: number;
    unsupportedAreaFraction: number;
    findings: OverhangFinding[];
  };
  /** Minimum wall thickness estimate vs. nozzle-derived floor. */
  wall: {
    minNozzleMultiple: number;
    estimatedMinWallMm: number | null;
    nozzleMm: number | null;
    thinWalls: {
      /** Number of surface samples that found a valid opposing surface. */
      sampleCount: number;
      /** Absolute thinnest valid sample; p5 is used for the robust estimate. */
      minMm: number | null;
      p5Mm: number | null;
      /** Fraction below the nozzle-derived threshold, or null without a nozzle. */
      belowThresholdFraction: number | null;
      /** Model-space centroids (mm, Z-up) of up to five thinnest samples. */
      worstSpots: Array<[number, number, number]>;
    };
  };
  /** Flat-base / stability hint. */
  base: {
    hasFlatBase: boolean;
    flatBaseAreaFraction: number;
  };
  notes: string[];
}

// --- Project model -----------------------------------------------------------

export interface ReplicadParamSummary {
  name: string;
  kind: ParamKind;
  default: ParamDef['default'];
}

export interface ReplicadModuleEntry {
  path: string;
  relativePath: string;
  /** Local `*.replicad.ts` / `*.ts` modules this file imports (resolved). */
  imports: string[];
  /** Whether this file exports a default / `main` (i.e. is a runnable model). */
  isModel: boolean;
  /** Param names this model surfaces, if any. */
  params: ReplicadParamSummary[];
  documentation?: string;
}

export interface ReplicadProjectGraph {
  workspacePath: string;
  files: ReplicadModuleEntry[];
  /** Runnable entry points, best-first. */
  roots: string[];
  /** Discovered STEP assets available for import. */
  stepAssets: string[];
  /** Discovered base64 font sidecars (`*.ttf.b64` / `*.otf.b64`) that override
   * the built-in default font for `drawText`. */
  fontAssets: string[];
  unresolvedImports: Array<{ source: string; rawTarget: string }>;
}

export interface ReplicadConventions {
  roots: string[];
  units?: string;
  defaultTolerance?: number;
  libraries: string[];
  material?: string;
  printerNozzle?: number;
  /** Printer bed size [x, y] in mm. */
  printerBed?: [number, number];
  notes: string[];
  raw?: Record<string, unknown>;
}

// --- Editor <-> AI bridge ----------------------------------------------------

export interface PreviewState {
  rootFilePath: string | null;
  wireframe: boolean;
  params: ParamValues;
  lastCompiledAt?: string;
  renderTimeMs?: number;
}

export type ViewName = 'iso' | 'top' | 'front' | 'right';

/** Imperative API the editor registers so AI tools can drive the live buffer. */
export interface ReplicadEditorAPI {
  getActiveRoot(): string | null;
  setActiveRoot(filePath: string): Promise<void>;
  getPreviewState(): PreviewState;
  getLatestDiagnostics(): CompileMessage[];
  getLatestStats(): ModelStats | null;
  getSelection(): ReplicadSelection | null;
  getParams(): ParamDef[];
  setParamValues(values: ParamValues): Promise<void>;
  /** Capture the current viewport as a PNG data URL. */
  capturePreview(): Promise<string | null>;
  /** Capture multiple fixed camera angles. Returns view-name -> PNG data URL. */
  captureViews(views?: ViewName[]): Promise<Partial<Record<ViewName, string>>>;
  requestCompile(options?: { params?: ParamValues; force?: boolean }): Promise<CompileResult>;
  getProjectGraph(): Promise<ReplicadProjectGraph>;
}
