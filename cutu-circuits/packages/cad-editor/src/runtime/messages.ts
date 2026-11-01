import type {
  AnimationData,
  CompileMessage,
  ExportArtifact,
  ModelStats,
  ParamDef,
  ParamValues,
  ShapeResult,
  StepAsset,
  FontAsset,
  ExportFormat,
} from '../types';

export interface InitMessage {
  type: 'init';
  /** base64-encoded OpenCascade.js wasm payload (read from dist/replicad.wasm.b64). */
  wasmBase64: string;
  /** base64-encoded default TTF (read from dist/replicad.font.b64); registered as
   * the 'default' font family so `drawText` works without project setup. */
  fontBase64?: string;
}

export interface ReadyMessage {
  type: 'ready';
}

export interface CompileWorkerRequest {
  id: number;
  type: 'compile';
  source: string;
  filePath: string;
  params?: ParamValues;
  stepAssets?: StepAsset[];
  fontAssets?: FontAsset[];
  exports?: ExportFormat[];
  tolerance?: number;
  angularTolerance?: number;
}

export interface CompileWorkerResponse {
  id: number;
  type: 'compile-result';
  success: boolean;
  shapes: ShapeResult[];
  params: ParamDef[];
  stats?: ModelStats;
  exports?: ExportArtifact[];
  animation?: AnimationData;
  diagnostics: CompileMessage[];
  warnings: string[];
  errors: string[];
  renderTimeMs: number;
}

/** Inspect an external STEP file: mesh + metrics, without running a user script. */
export interface InspectStepRequest {
  id: number;
  type: 'inspect-step';
  name: string;
  content: string;
  tolerance?: number;
  angularTolerance?: number;
}

export interface InspectStepResponse {
  id: number;
  type: 'inspect-step-result';
  success: boolean;
  name: string;
  shapes: ShapeResult[];
  stats?: ModelStats;
  errors: string[];
  renderTimeMs: number;
}

export type WorkerInbound = InitMessage | CompileWorkerRequest | InspectStepRequest;
export type WorkerOutbound = ReadyMessage | CompileWorkerResponse | InspectStepResponse;
