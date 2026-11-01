import type {
  EditorHost,
  EditorHostFileSystem,
  ProjectFileChange,
  ProjectFileSnapshot,
  ProjectFileWriteReceipt,
} from '@cutucircuits/editor-host';
import type { AnyCircuitElement } from '../circuit/circuitJson';
import { evalTscircuitProject, type EvalResult } from '../circuit/evalCode';
import {
  applySupportedManualEditEvents,
  ensureManualEditsBinding,
  manualEditsPathForCircuit,
  parseManualEdits,
  serializeManualEdits,
} from './manualEdits';

export interface ManualEditTransactionResult {
  receipt: ProjectFileWriteReceipt;
  source: string;
  manualEditsContent: string;
  projection: EvalResult;
  undoChanges: ProjectFileChange[];
  redoChanges: ProjectFileChange[];
}

export function hasHostProjectFiles(host: EditorHost): boolean {
  return Boolean(host.fs);
}

export async function ensureManualEditsProject(host: EditorHost): Promise<ManualEditTransactionResult> {
  const fs = requireHostProjectFiles(host);
  const sidecarPath = manualEditsPathForCircuit(host.filePath);
  const [sourceFile, sidecarFile] = await readExactFiles(fs.read, host.filePath, sidecarPath);
  if (!sourceFile.exists || sourceFile.content === null || sourceFile.sha256 === null) {
    throw new Error('The editable circuit source is missing from the workspace.');
  }
  const bound = ensureManualEditsBinding(sourceFile.content);
  const currentManualEdits = sidecarFile.exists
    ? requireValidManualEdits(sidecarFile)
    : {};
  const manualEditsContent = serializeManualEdits(currentManualEdits);
  const changes: ProjectFileChange[] = [
    ...(bound.changed ? [{ path: host.filePath, expectedSha256: sourceFile.sha256, content: bound.source }] : []),
    ...(!sidecarFile.exists || sidecarFile.content !== manualEditsContent
      ? [{ path: sidecarPath, expectedSha256: sidecarFile.sha256, content: manualEditsContent }]
      : []),
  ];
  if (changes.length === 0) throw new Error('This circuit already has a valid upstream manual-edits.json binding.');
  const preflight = await evaluateBoundProject(host.filePath, bound.source, manualEditsContent);
  if (!preflight.ok) {
    throw new Error(`The manual-edit binding did not pass preflight evaluation; no files were changed: ${preflight.error}`);
  }
  const receipt = await fs.write({ label: 'Enable upstream manual edits', actor: 'user', changes });
  const { undoChanges, redoChanges } = buildUndoRedoChanges(changes, receipt, host.filePath, sidecarPath, sourceFile, sidecarFile);
  const projection = await evaluateBoundProject(host.filePath, bound.source, manualEditsContent);
  if (!projection.ok) throw new Error(`The grouped edit landed, but the bound project did not evaluate: ${projection.error}`);
  return { receipt, source: bound.source, manualEditsContent, projection, undoChanges, redoChanges };
}

export async function commitManualEditEvents(options: {
  host: EditorHost;
  expectedSource: string;
  circuitJson: AnyCircuitElement[];
  events: unknown[];
  actor?: 'user' | 'agent';
  label?: string;
}): Promise<ManualEditTransactionResult> {
  const fs = requireHostProjectFiles(options.host);
  const sidecarPath = manualEditsPathForCircuit(options.host.filePath);
  const [sourceFile, sidecarFile] = await readExactFiles(fs.read, options.host.filePath, sidecarPath);
  if (!sourceFile.exists || sourceFile.content === null || sourceFile.sha256 === null) {
    throw new Error('The editable circuit source is missing from the workspace.');
  }
  if (sourceFile.content !== options.expectedSource) {
    throw new Error('The circuit source changed before the manual edit could be committed.');
  }
  const bound = ensureManualEditsBinding(sourceFile.content);
  const currentManualEdits = sidecarFile.exists ? requireValidManualEdits(sidecarFile) : {};
  const updatedManualEdits = applySupportedManualEditEvents({
    circuitJson: options.circuitJson,
    manualEdits: currentManualEdits,
    events: options.events,
  });
  const manualEditsContent = serializeManualEdits(updatedManualEdits);
  const preflight = await evaluateBoundProject(options.host.filePath, bound.source, manualEditsContent);
  if (!preflight.ok) {
    throw new Error(`The manual edit did not pass preflight evaluation; no files were changed: ${preflight.error}`);
  }
  assertEventsAcknowledged(preflight.circuitJson, options.events);
  const changes: ProjectFileChange[] = [
    ...(bound.changed ? [{ path: options.host.filePath, expectedSha256: sourceFile.sha256, content: bound.source }] : []),
    { path: sidecarPath, expectedSha256: sidecarFile.sha256, content: manualEditsContent },
  ];
  const receipt = await fs.write({
    label: options.label ?? 'Move circuit component',
    actor: options.actor ?? 'user',
    changes,
  });
  const { undoChanges, redoChanges } = buildUndoRedoChanges(changes, receipt, options.host.filePath, sidecarPath, sourceFile, sidecarFile);
  const projection = await evaluateBoundProject(options.host.filePath, bound.source, manualEditsContent);
  if (!projection.ok) {
    throw new Error(`The manual edit was saved, but fresh project evaluation failed: ${projection.error}`);
  }
  assertEventsAcknowledged(projection.circuitJson, options.events);
  return { receipt, source: bound.source, manualEditsContent, projection, undoChanges, redoChanges };
}

// Build extension-owned undo/redo changes from the forward edit and the
// before-snapshots. Undo writes prior content back (guarded by the post-edit
// hash); a file that did not exist before is deleted (content: null).
function buildUndoRedoChanges(
  changes: ProjectFileChange[],
  receipt: ProjectFileWriteReceipt,
  sourcePath: string,
  sidecarPath: string,
  sourceFile: ProjectFileSnapshot,
  sidecarFile: ProjectFileSnapshot,
): { undoChanges: ProjectFileChange[]; redoChanges: ProjectFileChange[] } {
  const beforeContentForPath = (path: string): string | null => {
    if (samePath(path, sourcePath)) return sourceFile.exists ? sourceFile.content : null;
    if (samePath(path, sidecarPath)) return sidecarFile.exists ? sidecarFile.content : null;
    return null;
  };
  const undoChanges: ProjectFileChange[] = [];
  const redoChanges: ProjectFileChange[] = [];
  for (const c of changes) {
    const r = receipt.files.find((file) => samePath(file.path, c.path));
    if (!r) continue;
    undoChanges.push({ path: c.path, expectedSha256: r.afterSha256, content: beforeContentForPath(c.path) });
    redoChanges.push({ path: c.path, expectedSha256: r.beforeSha256, content: c.content });
  }
  return { undoChanges, redoChanges };
}

async function evaluateBoundProject(sourcePath: string, source: string, manualEditsContent: string): Promise<EvalResult> {
  const entrypoint = basename(sourcePath);
  return evalTscircuitProject({
    entrypoint,
    files: { [entrypoint]: source, 'manual-edits.json': manualEditsContent },
  });
}

function requireHostProjectFiles(host: EditorHost): EditorHostFileSystem {
  if (!host.fs) {
    throw new Error('This CutuCircuits host does not expose a project filesystem; manual editing remains disabled.');
  }
  return host.fs;
}

async function readExactFiles(
  read: EditorHostFileSystem['read'],
  sourcePath: string,
  sidecarPath: string,
): Promise<[ProjectFileSnapshot, ProjectFileSnapshot]> {
  const files = await read([sourcePath, sidecarPath]);
  const source = files.find((file) => samePath(file.path, sourcePath));
  const sidecar = files.find((file) => samePath(file.path, sidecarPath));
  if (!source || !sidecar || files.length !== 2) throw new Error('The host returned an incomplete project read.');
  return [source, sidecar];
}

function requireValidManualEdits(file: ProjectFileSnapshot) {
  if (file.content === null) throw new Error('manual-edits.json disappeared during the project read.');
  const parsed = parseManualEdits(file.content);
  if (!parsed.ok || !parsed.value) throw new Error(parsed.error ?? 'manual-edits.json is invalid.');
  return parsed.value;
}

function assertEventsAcknowledged(circuitJson: AnyCircuitElement[], events: unknown[]): void {
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const value = event as Record<string, unknown>;
    if (value.edit_event_type === 'edit_pcb_component_location') {
      const expected = value.new_center as { x?: unknown; y?: unknown };
      const component = circuitJson.find((element) => element.type === 'pcb_component' && element.pcb_component_id === value.pcb_component_id);
      const center = component?.center as { x?: unknown; y?: unknown } | undefined;
      if (!center || center.x !== expected.x || center.y !== expected.y) {
        throw new Error(`Fresh evaluation did not acknowledge PCB placement ${String(value.pcb_component_id)}.`);
      }
    }
    if (value.edit_event_type === 'edit_schematic_component_location') {
      const expected = value.new_center as { x?: unknown; y?: unknown };
      const component = circuitJson.find((element) => element.type === 'schematic_component' && element.schematic_component_id === value.schematic_component_id);
      const center = component?.center as { x?: unknown; y?: unknown } | undefined;
      if (!center || center.x !== expected.x || center.y !== expected.y) {
        throw new Error(`Fresh evaluation did not acknowledge schematic placement ${String(value.schematic_component_id)}.`);
      }
    }
  }
}

function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/') === b.replace(/\\/g, '/');
}
