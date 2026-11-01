import { applyEditEventsToManualEditsFile } from '@tscircuit/core';
import {
  manual_edit_event,
  manual_edits_file,
  type ManualEditEvent,
  type ManualEditsFile,
} from '@tscircuit/props';
import type { AnyCircuitElement } from '../circuit/circuitJson';

export const MANUAL_EDITS_FILE_NAME = 'manual-edits.json';
export const MAX_MANUAL_EDITS_BYTES = 512 * 1024;
export const MAX_PENDING_MANUAL_EDIT_EVENTS = 128;

export interface ManualEditsParseResult {
  ok: boolean;
  value?: ManualEditsFile;
  error?: string;
}

export function parseManualEdits(content: string): ManualEditsParseResult {
  if (byteLength(content) > MAX_MANUAL_EDITS_BYTES) {
    return { ok: false, error: `manual-edits.json exceeds ${MAX_MANUAL_EDITS_BYTES} UTF-8 bytes.` };
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    const result = manual_edits_file.safeParse(parsed);
    if (!result.success) {
      return { ok: false, error: `Invalid upstream manual-edits.json: ${result.error.issues.map((issue) => issue.message).join('; ')}` };
    }
    return { ok: true, value: result.data };
  } catch (error) {
    return { ok: false, error: `Invalid manual-edits.json JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function serializeManualEdits(value: ManualEditsFile): string {
  const parsed = manual_edits_file.parse(value);
  const content = `${JSON.stringify(parsed, null, 2)}\n`;
  if (byteLength(content) > MAX_MANUAL_EDITS_BYTES) {
    throw new Error(`manual-edits.json exceeds ${MAX_MANUAL_EDITS_BYTES} UTF-8 bytes.`);
  }
  return content;
}

export function applySupportedManualEditEvents(options: {
  circuitJson: AnyCircuitElement[];
  manualEdits: ManualEditsFile;
  events: unknown[];
}): ManualEditsFile {
  if (options.events.length < 1 || options.events.length > MAX_PENDING_MANUAL_EDIT_EVENTS) {
    throw new Error(`Manual edit batches require 1-${MAX_PENDING_MANUAL_EDIT_EVENTS} events.`);
  }
  const events = options.events.map((event, index) => {
    const parsed = manual_edit_event.safeParse(event);
    if (!parsed.success) throw new Error(`Manual edit event ${index + 1} is invalid: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    if (parsed.data.edit_event_type !== 'edit_pcb_component_location'
      && parsed.data.edit_event_type !== 'edit_schematic_component_location') {
      throw new Error(`Manual edit event ${index + 1} (${eventType(parsed.data)}) is unsupported and was not persisted.`);
    }
    return parsed.data;
  });

  assertStableEventSelectors(options.circuitJson, events);
  const manualEdits = events.some((event) => event.edit_event_type === 'edit_pcb_component_location')
    ? seedInitialPcbPlacementSnapshot(options.circuitJson, options.manualEdits)
    : options.manualEdits;
  const updated = applyEditEventsToManualEditsFile({
    circuitJson: options.circuitJson as never,
    editEvents: events,
    manualEditsFile: manualEdits,
  });
  return manual_edits_file.parse(updated);
}

/**
 * Core's implicit PCB packer is disabled as soon as pcb_placements is non-empty.
 * Preserve the exact evaluated baseline for every component when the first PCB
 * gesture is persisted, otherwise all untouched auto-placed parts fall back to
 * the group origin on the next evaluation.
 */
function seedInitialPcbPlacementSnapshot(
  circuitJson: AnyCircuitElement[],
  manualEdits: ManualEditsFile,
): ManualEditsFile {
  if ((manualEdits.pcb_placements?.length ?? 0) > 0) return manualEdits;
  const sources = new Map<string, string>();
  const sourceNameCounts = new Map<string, number>();
  for (const element of circuitJson) {
    if (element.type !== 'source_component'
      || typeof element.source_component_id !== 'string'
      || typeof element.name !== 'string') continue;
    sources.set(element.source_component_id, element.name);
    sourceNameCounts.set(element.name, (sourceNameCounts.get(element.name) ?? 0) + 1);
  }
  const seenSources = new Set<string>();
  const pcbPlacements: NonNullable<ManualEditsFile['pcb_placements']> = [];
  for (const element of circuitJson) {
    if (element.type !== 'pcb_component' || typeof element.source_component_id !== 'string') continue;
    const selector = sources.get(element.source_component_id);
    const center = element.center as { x?: unknown; y?: unknown } | undefined;
    if (!selector || !center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) {
      throw new Error(`Cannot initialize manual PCB placement for ${String(element.pcb_component_id)} without exact source identity and finite center.`);
    }
    if (sourceNameCounts.get(selector) !== 1 || seenSources.has(element.source_component_id)) {
      throw new Error(`Cannot initialize manual PCB placement because selector ${selector} is ambiguous.`);
    }
    seenSources.add(element.source_component_id);
    pcbPlacements.push({
      selector,
      relative_to: 'group_center',
      center: { x: center.x as number, y: center.y as number },
    });
  }
  if (pcbPlacements.length === 0) {
    throw new Error('Cannot initialize manual PCB placements because the current projection has no exact PCB components.');
  }
  return { ...manualEdits, pcb_placements: pcbPlacements };
}

export function ensureManualEditsBinding(source: string): { source: string; changed: boolean } {
  const importMatches = [...source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]\.\/manual-edits\.json['"]\s*;?/g)];
  if (importMatches.length > 1) throw new Error('Multiple manual-edits.json default imports are ambiguous.');
  let binding = importMatches[0]?.[1];
  let next = source;
  let changed = false;

  if (!binding) {
    binding = 'manualEdits';
    if (new RegExp(`\\b(?:const|let|var|function|class|import)\\s+${binding}\\b`).test(source)) {
      throw new Error('The canonical manualEdits binding is already used; add the manual-edits.json import explicitly.');
    }
    const imports = [...source.matchAll(/^import\b.*(?:;\s*)?$/gm)];
    const insertAt = imports.at(-1)?.index != null
      ? imports.at(-1)!.index! + imports.at(-1)![0].length
      : 0;
    next = `${next.slice(0, insertAt)}${insertAt > 0 ? '\n' : ''}import ${binding} from "./manual-edits.json";\n${next.slice(insertAt)}`;
    changed = true;
  }

  const boardTags = [...next.matchAll(/<board\b[^>]*>/g)];
  if (boardTags.length !== 1) {
    throw new Error(`Manual edit setup requires exactly one intrinsic <board> opening tag; found ${boardTags.length}.`);
  }
  const boardTag = boardTags[0];
  if (/\bmanualEdits\s*=/.test(boardTag[0])) {
    if (!new RegExp(`\\bmanualEdits\\s*=\\s*\\{\\s*${escapeRegExp(binding)}\\s*\\}`).test(boardTag[0])) {
      throw new Error('The board already has a different manualEdits binding.');
    }
    return { source: next, changed };
  }
  const tagEnd = boardTag.index! + boardTag[0].length - 1;
  next = `${next.slice(0, tagEnd)} manualEdits={${binding}}${next.slice(tagEnd)}`;
  return { source: next, changed: true };
}

export function manualEditsPathForCircuit(circuitPath: string): string {
  const normalized = circuitPath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? MANUAL_EDITS_FILE_NAME : `${normalized.slice(0, slash + 1)}${MANUAL_EDITS_FILE_NAME}`;
}

function assertStableEventSelectors(circuitJson: AnyCircuitElement[], events: ManualEditEvent[]): void {
  const sources = circuitJson.filter((element): element is AnyCircuitElement & {
    type: 'source_component'; source_component_id: string; name: string;
  } => element.type === 'source_component' && typeof element.source_component_id === 'string' && typeof element.name === 'string');
  const sourceNameCounts = new Map<string, number>();
  for (const source of sources) sourceNameCounts.set(source.name, (sourceNameCounts.get(source.name) ?? 0) + 1);

  for (const event of events) {
    const rendered = event.edit_event_type === 'edit_pcb_component_location'
      ? circuitJson.find((element) => element.type === 'pcb_component' && element.pcb_component_id === event.pcb_component_id)
      : event.edit_event_type === 'edit_schematic_component_location'
        ? circuitJson.find((element) => element.type === 'schematic_component' && element.schematic_component_id === event.schematic_component_id)
        : undefined;
    const sourceId = rendered && 'source_component_id' in rendered ? rendered.source_component_id : undefined;
    const source = sources.find((candidate) => candidate.source_component_id === sourceId);
    if (!source) throw new Error(`Manual edit target ${renderedEventId(event)} has no exact source component identity.`);
    if (sourceNameCounts.get(source.name) !== 1) {
      throw new Error(`Manual edit selector ${source.name} is ambiguous in the current projection.`);
    }
  }
}

function renderedEventId(event: ManualEditEvent): string {
  return event.edit_event_type === 'edit_pcb_component_location'
    ? event.pcb_component_id
    : event.edit_event_type === 'edit_schematic_component_location'
      ? event.schematic_component_id
      : event.edit_event_id;
}

function eventType(event: ManualEditEvent): string {
  return 'edit_event_type' in event && event.edit_event_type
    ? event.edit_event_type
    : 'pcb_edit_event_type' in event && event.pcb_edit_event_type
      ? event.pcb_edit_event_type
      : 'unknown';
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
