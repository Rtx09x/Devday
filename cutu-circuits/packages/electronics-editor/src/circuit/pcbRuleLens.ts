import type { AnyCircuitElement } from './circuitJson.ts';
import type { PcbScalarMinimums } from './projectGuidance.ts';
import type { ReviewedFabProfile, ReviewedFabProfileAssumptions, ReviewedFabProfileId } from './fabProfiles.ts';

export const MAX_PCB_RULE_LENS_TRACES = 256;
export const MAX_PCB_RULE_LENS_ROUTE_ENTRIES = 2_048;
export const MAX_PCB_RULE_LENS_VIAS = 512;
export const MAX_PCB_RULE_LENS_PLATED_HOLES = 512;
export const MAX_PCB_RULE_LENS_PADS = 1_024;
export const MAX_PCB_RULE_LENS_PAD_PAIRS = 200_000;
export const MAX_PCB_RULE_LENS_MARKERS = 64;
export const MAX_PCB_RULE_LENS_FINDINGS = 256;
export const MAX_PCB_RULE_LENS_EXACT_TEXT_BYTES = 256;

export type PcbRuleLensFindingKind =
  | 'trace-width'
  | 'via-hole-diameter'
  | 'via-pad-diameter'
  | 'trace-route-point-edge-gap'
  | 'via-pad-edge-gap'
  | 'pad-to-pad-edge-gap'
  | 'plated-hole-annular-ring'
  | 'missing-declaration'
  | 'uninspectable-geometry';

export interface PcbRuleLensFinding {
  kind: PcbRuleLensFindingKind;
  status: 'violation' | 'indeterminate';
  message: string;
  actualMm?: number;
  declaredMinimumMm?: number;
  pcbTraceId?: string;
  pcbViaId?: string;
  pcbPlatedHoleId?: string;
  pcbSmtpadIds?: [string, string];
  routeIndex?: number;
  x?: number;
  y?: number;
  layer?: string;
}

export interface PcbRuleLensResult {
  scope: 'evaluated-board-scalar-rule-envelope';
  status: 'clear' | 'violations' | 'incomplete' | 'not-exercised';
  units: 'mm';
  reference: {
    kind: PcbRuleLensReferenceKind;
    label: string;
    projectGuidanceSchemaVersion?: 1;
    profileId?: ReviewedFabProfileId;
    reviewedAt?: string;
    sourceUrl?: string;
    assumptions?: ReviewedFabProfileAssumptions;
    assumptionEvidence?: {
      request: 'explicit';
      boardLayerCount: 'matched' | 'not-recorded';
      boardMaterial: 'matched' | 'not-recorded';
      outerCopperOz: 'caller-confirmed-not-evaluated';
      outlineProcess: 'caller-confirmed-not-evaluated';
    };
    omittedComparisons?: string[];
  };
  board: {
    pcbBoardId: string;
    center?: { x: number; y: number };
    width: number;
    height: number;
    thickness?: number;
    numLayers?: number;
    material?: string;
  };
  declarations: {
    minTraceWidthMm?: number;
    minViaHoleDiameterMm?: number;
    minViaPadDiameterMm?: number;
    minBoardEdgeClearanceMm?: number;
    minPadToPadEdgeClearanceMm?: number;
    minPlatedHoleAnnularRingMm?: number;
  };
  observed: {
    traceCount: number;
    wireRouteEntryCount: number;
    viaCount: number;
    minimumTraceWidthMm?: number;
    minimumViaHoleDiameterMm?: number;
    minimumViaPadDiameterMm?: number;
    minimumTraceRoutePointEdgeGapMm?: number;
    minimumViaPadEdgeGapMm?: number;
    padCount?: number;
    inspectablePadCount?: number;
    inspectedPadPairCount?: number;
    minimumPadToPadEdgeGapMm?: number;
    platedHoleCount?: number;
    inspectableCircularPlatedHoleCount?: number;
    minimumPlatedHoleAnnularRingMm?: number;
  };
  counts: {
    violations: number;
    indeterminate: number;
    omittedFindings: number;
    markers: number;
    omittedMarkers: number;
  };
  findings: PcbRuleLensFinding[];
  limitation: string;
}

export interface ActivePcbRuleLens {
  result: PcbRuleLensResult;
  overlayElements: AnyCircuitElement[];
}

export type PcbRuleLensReferenceKind = 'board-declarations' | 'loaded-project-guidance' | 'reviewed-fab-profile';

export type PcbRuleLensReferenceRequest = 'board-declarations' | 'loaded-project-guidance' | ReviewedFabProfileId;

export interface PcbRuleLensRequest {
  reference?: PcbRuleLensReferenceRequest;
  profileAssumptions?: ReviewedFabProfileAssumptions;
}

export type PcbRuleLensReference =
  | { kind: 'board-declarations' }
  | { kind: 'loaded-project-guidance'; minimums: PcbScalarMinimums }
  | { kind: 'reviewed-fab-profile'; profile: ReviewedFabProfile };

const LIMITATION_SUFFIX = 'Board-edge comparison covers only finite wire route-point circular width envelopes and circular via-pad envelopes against one rectangular board. Pad-spacing comparison covers only same-layer unrounded axis-aligned rectangular and circular SMT-pad envelopes; markers are pair midpoints, not claimed contact points. Annular-ring comparison is opt-in loaded project guidance and covers only the nominal evaluated radial width of exact circular plated holes; it does not account for drill or plating tolerance. It does not prove intervening trace segments or joins, rounded/rotated/pill/polygon pads, non-circular plated holes, component bodies, pours, other holes, cutouts, or whole-board clearance. It does not measure clearances beyond those explicit envelopes, impedance, connectivity, stack-up, mask, plating thickness, ERC, DRC, DFM, fab acceptance, manufacturing, or physical hardware.';
const EPSILON = 1e-9;
const MARKER_COLOR = '#ff5d73';
const encoder = new TextEncoder();

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function exactText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  return encoder.encode(value).byteLength <= MAX_PCB_RULE_LENS_EXACT_TEXT_BYTES ? value : undefined;
}

function minimum(values: number[]): number | undefined {
  return values.length ? Math.min(...values) : undefined;
}

function rectangularEnvelopeEdgeGap(
  x: number,
  y: number,
  radius: number,
  center: { x: number; y: number },
  width: number,
  height: number,
): number {
  const left = center.x - width / 2;
  const right = center.x + width / 2;
  const bottom = center.y - height / 2;
  const top = center.y + height / 2;
  return Math.min(x - left, right - x, y - bottom, top - y) - radius;
}

function compareFindings(a: PcbRuleLensFinding, b: PcbRuleLensFinding): number {
  const ak = `${a.status}|${a.kind}|${a.pcbTraceId ?? ''}|${a.pcbViaId ?? ''}|${a.pcbPlatedHoleId ?? ''}|${a.pcbSmtpadIds?.join('|') ?? ''}|${a.routeIndex ?? -1}|${a.x ?? 0}|${a.y ?? 0}`;
  const bk = `${b.status}|${b.kind}|${b.pcbTraceId ?? ''}|${b.pcbViaId ?? ''}|${b.pcbPlatedHoleId ?? ''}|${b.pcbSmtpadIds?.join('|') ?? ''}|${b.routeIndex ?? -1}|${b.x ?? 0}|${b.y ?? 0}`;
  return ak < bk ? -1 : ak > bk ? 1 : 0;
}

type PadEnvelope =
  | { kind: 'circle'; id: string; layer: string; x: number; y: number; radius: number }
  | { kind: 'rect'; id: string; layer: string; x: number; y: number; halfWidth: number; halfHeight: number };

function padEnvelope(raw: AnyCircuitElement): PadEnvelope | undefined {
  const id = exactText(raw.pcb_smtpad_id);
  const layer = exactText(raw.layer);
  const x = finite(raw.x);
  const y = finite(raw.y);
  if (!id || !layer || x == null || y == null) return undefined;
  if (raw.shape === 'circle') {
    const radius = finitePositive(raw.radius);
    return radius ? { kind: 'circle', id, layer, x, y, radius } : undefined;
  }
  if (raw.shape === 'rect') {
    const width = finitePositive(raw.width);
    const height = finitePositive(raw.height);
    const borderRadius = raw.rect_border_radius == null ? 0 : finite(raw.rect_border_radius);
    const cornerRadius = raw.corner_radius == null ? 0 : finite(raw.corner_radius);
    const rotation = raw.ccw_rotation == null ? 0 : finite(raw.ccw_rotation);
    if (!width || !height || borderRadius !== 0 || cornerRadius !== 0 || rotation !== 0) return undefined;
    return { kind: 'rect', id, layer, x, y, halfWidth: width / 2, halfHeight: height / 2 };
  }
  return undefined;
}

function signedPointToRectGap(x: number, y: number, rect: Extract<PadEnvelope, { kind: 'rect' }>): number {
  const dx = Math.abs(x - rect.x) - rect.halfWidth;
  const dy = Math.abs(y - rect.y) - rect.halfHeight;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

function padEnvelopeGap(a: PadEnvelope, b: PadEnvelope): number {
  if (a.kind === 'circle' && b.kind === 'circle') {
    return Math.hypot(a.x - b.x, a.y - b.y) - a.radius - b.radius;
  }
  if (a.kind === 'rect' && b.kind === 'rect') {
    const dx = Math.abs(a.x - b.x) - a.halfWidth - b.halfWidth;
    const dy = Math.abs(a.y - b.y) - a.halfHeight - b.halfHeight;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
  }
  const circle = a.kind === 'circle' ? a : b as Extract<PadEnvelope, { kind: 'circle' }>;
  const rect = a.kind === 'rect' ? a : b as Extract<PadEnvelope, { kind: 'rect' }>;
  return signedPointToRectGap(circle.x, circle.y, rect) - circle.radius;
}

function marker(id: number, finding: PcbRuleLensFinding): AnyCircuitElement[] {
  const x = finding.x as number;
  const y = finding.y as number;
  const size = 0.55;
  const common = { layer: 'top', stroke_width: 0.16, color: MARKER_COLOR };
  return [
    { type: 'pcb_note_line', pcb_note_line_id: `pcb-rule-lens-${id}-a`, x1: x - size, y1: y - size, x2: x + size, y2: y + size, ...common },
    { type: 'pcb_note_line', pcb_note_line_id: `pcb-rule-lens-${id}-b`, x1: x - size, y1: y + size, x2: x + size, y2: y - size, ...common },
  ];
}

export function buildPcbRuleLens(
  elements: AnyCircuitElement[],
  reference: PcbRuleLensReference = { kind: 'board-declarations' },
): ActivePcbRuleLens {
  const boards = elements.filter((element) => element.type === 'pcb_board');
  if (boards.length !== 1) throw new Error(`PCB Rule Lens requires exactly one evaluated pcb_board; found ${boards.length}.`);
  const board = boards[0];
  const width = finitePositive(board.width);
  const height = finitePositive(board.height);
  const pcbBoardId = exactText(board.pcb_board_id);
  if (!width || !height || !pcbBoardId) throw new Error('PCB Rule Lens requires one evaluated board with an exact ID and finite positive rectangular width/height.');
  const centerRecord = board.center && typeof board.center === 'object' && !Array.isArray(board.center)
    ? board.center as Record<string, unknown>
    : undefined;
  const centerX = finite(centerRecord?.x);
  const centerY = finite(centerRecord?.y);
  const boardCenter = centerX == null || centerY == null ? undefined : { x: centerX, y: centerY };

  const traces = elements.filter((element) => element.type === 'pcb_trace');
  const vias = elements.filter((element) => element.type === 'pcb_via');
  const platedHoles = elements.filter((element) => element.type === 'pcb_plated_hole');
  if (traces.length > MAX_PCB_RULE_LENS_TRACES) throw new Error(`PCB Rule Lens supports at most ${MAX_PCB_RULE_LENS_TRACES} pcb_trace elements; found ${traces.length}.`);
  if (vias.length > MAX_PCB_RULE_LENS_VIAS) throw new Error(`PCB Rule Lens supports at most ${MAX_PCB_RULE_LENS_VIAS} pcb_via elements; found ${vias.length}.`);

  const referenceLabel = reference.kind === 'board-declarations'
    ? 'evaluated board declarations'
    : reference.kind === 'loaded-project-guidance'
      ? 'loaded project guidance'
      : reference.profile.label;
  let profileBoardLayerEvidence: 'matched' | 'not-recorded' | undefined;
  let profileBoardMaterialEvidence: 'matched' | 'not-recorded' | undefined;
  if (reference.kind === 'reviewed-fab-profile') {
    if (board.num_layers == null) profileBoardLayerEvidence = 'not-recorded';
    else if (board.num_layers === reference.profile.assumptions.layerCount) profileBoardLayerEvidence = 'matched';
    else throw new Error(`The reviewed fabrication profile requires exactly ${reference.profile.assumptions.layerCount} layers; the evaluated board declares ${String(board.num_layers)}.`);
    const material = exactText(board.material);
    if (!material) profileBoardMaterialEvidence = 'not-recorded';
    else if (material.replace(/[-_\s]/gu, '').toLowerCase() === 'fr4') profileBoardMaterialEvidence = 'matched';
    else throw new Error(`The reviewed fabrication profile requires FR4; the evaluated board declares ${material}.`);
  }
  const edgeMinimumAuthored = reference.kind === 'board-declarations'
    ? Object.prototype.hasOwnProperty.call(board, 'min_board_edge_clearance')
    : reference.kind === 'loaded-project-guidance'
      ? Object.prototype.hasOwnProperty.call(reference.minimums, 'minBoardEdgeClearanceMm')
      : Object.prototype.hasOwnProperty.call(reference.profile.minimums, 'minBoardEdgeClearanceMm');
  const padClearanceMinimumAuthored = reference.kind === 'board-declarations'
    ? Object.prototype.hasOwnProperty.call(board, 'min_pad_edge_to_pad_edge_clearance')
    : reference.kind === 'loaded-project-guidance'
      ? Object.prototype.hasOwnProperty.call(reference.minimums, 'minPadToPadEdgeClearanceMm')
      : Object.prototype.hasOwnProperty.call(reference.profile.minimums, 'minPadToPadEdgeClearanceMm');
  const platedHoleAnnularRingMinimumAuthored = reference.kind === 'loaded-project-guidance'
    && Object.prototype.hasOwnProperty.call(reference.minimums, 'minPlatedHoleAnnularRingMm');
  const minima = reference.kind === 'board-declarations' ? {
    minTraceWidthMm: finitePositive(board.min_trace_width),
    minViaHoleDiameterMm: finitePositive(board.min_via_hole_diameter),
    minViaPadDiameterMm: finitePositive(board.min_via_pad_diameter),
    minBoardEdgeClearanceMm: finitePositive(board.min_board_edge_clearance),
    minPadToPadEdgeClearanceMm: finitePositive(board.min_pad_edge_to_pad_edge_clearance),
    minPlatedHoleAnnularRingMm: undefined,
  } : reference.kind === 'loaded-project-guidance' ? {
    minTraceWidthMm: finitePositive(reference.minimums.minTraceWidthMm),
    minViaHoleDiameterMm: finitePositive(reference.minimums.minViaHoleDiameterMm),
    minViaPadDiameterMm: finitePositive(reference.minimums.minViaPadDiameterMm),
    minBoardEdgeClearanceMm: finitePositive(reference.minimums.minBoardEdgeClearanceMm),
    minPadToPadEdgeClearanceMm: finitePositive(reference.minimums.minPadToPadEdgeClearanceMm),
    minPlatedHoleAnnularRingMm: finitePositive(reference.minimums.minPlatedHoleAnnularRingMm),
  } : {
    minTraceWidthMm: finitePositive(reference.profile.minimums.minTraceWidthMm),
    minViaHoleDiameterMm: finitePositive(reference.profile.minimums.minViaHoleDiameterMm),
    minViaPadDiameterMm: finitePositive(reference.profile.minimums.minViaPadDiameterMm),
    minBoardEdgeClearanceMm: finitePositive(reference.profile.minimums.minBoardEdgeClearanceMm),
    minPadToPadEdgeClearanceMm: finitePositive(reference.profile.minimums.minPadToPadEdgeClearanceMm),
    minPlatedHoleAnnularRingMm: undefined,
  };
  const { minTraceWidthMm, minViaHoleDiameterMm, minViaPadDiameterMm, minBoardEdgeClearanceMm, minPadToPadEdgeClearanceMm, minPlatedHoleAnnularRingMm } = minima;
  const findings: PcbRuleLensFinding[] = [];
  if (!minTraceWidthMm) findings.push({ kind: 'missing-declaration', status: 'indeterminate', message: `${referenceLabel} has no finite positive minimum trace width.` });
  if (!minViaHoleDiameterMm) findings.push({ kind: 'missing-declaration', status: 'indeterminate', message: `${referenceLabel} has no finite positive minimum via-hole diameter.` });
  if (!minViaPadDiameterMm) findings.push({ kind: 'missing-declaration', status: 'indeterminate', message: `${referenceLabel} has no finite positive minimum via-pad diameter.` });
  if (edgeMinimumAuthored && !minBoardEdgeClearanceMm) findings.push({
    kind: 'missing-declaration', status: 'indeterminate',
    message: `${referenceLabel} has an explicit board-edge minimum that is not finite and positive.`,
  });
  if (padClearanceMinimumAuthored && !minPadToPadEdgeClearanceMm) findings.push({
    kind: 'missing-declaration', status: 'indeterminate',
    message: `${referenceLabel} has an explicit pad-to-pad edge minimum that is not finite and positive.`,
  });
  if (platedHoleAnnularRingMinimumAuthored && !minPlatedHoleAnnularRingMm) findings.push({
    kind: 'missing-declaration', status: 'indeterminate',
    message: `${referenceLabel} has an explicit plated-hole annular-ring minimum that is not finite and positive.`,
  });
  if (minBoardEdgeClearanceMm && !boardCenter) findings.push({
    kind: 'uninspectable-geometry', status: 'indeterminate',
    message: 'Board-edge comparison requires one finite evaluated pcb_board center.',
  });

  const traceWidths: number[] = [];
  const traceRoutePointEdgeGaps: number[] = [];
  let routeEntryCount = 0;
  for (const trace of traces) {
    const id = exactText(trace.pcb_trace_id);
    const route = Array.isArray(trace.route) ? trace.route as unknown[] : undefined;
    if (!id || !route) {
      findings.push({ kind: 'uninspectable-geometry', status: 'indeterminate', pcbTraceId: id, message: 'A pcb_trace lacks an exact ID or route array.' });
      continue;
    }
    routeEntryCount += route.length;
    if (routeEntryCount > MAX_PCB_RULE_LENS_ROUTE_ENTRIES) throw new Error(`PCB Rule Lens supports at most ${MAX_PCB_RULE_LENS_ROUTE_ENTRIES} total trace route entries.`);
    route.forEach((raw, routeIndex) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        findings.push({ kind: 'uninspectable-geometry', status: 'indeterminate', pcbTraceId: id, routeIndex, message: `${id} route[${routeIndex}] is not an inspectable object.` });
        return;
      }
      const entry = raw as Record<string, unknown>;
      if (entry.route_type !== 'wire') return;
      const widthMm = finitePositive(entry.width);
      const x = finite(entry.x);
      const y = finite(entry.y);
      const layer = exactText(entry.layer);
      if (!widthMm || x == null || y == null || !layer) {
        findings.push({ kind: 'uninspectable-geometry', status: 'indeterminate', pcbTraceId: id, routeIndex, message: `${id} wire route[${routeIndex}] lacks finite x/y/width or an exact layer.` });
        return;
      }
      traceWidths.push(widthMm);
      if (minTraceWidthMm && widthMm + EPSILON < minTraceWidthMm) {
        findings.push({
          kind: 'trace-width', status: 'violation', pcbTraceId: id, routeIndex, x, y, layer,
          actualMm: widthMm, declaredMinimumMm: minTraceWidthMm,
          message: `${id} route[${routeIndex}] declares ${widthMm} mm width below the ${referenceLabel} minimum ${minTraceWidthMm} mm.`,
        });
      }
      if (boardCenter && minBoardEdgeClearanceMm) {
        const edgeGapMm = rectangularEnvelopeEdgeGap(x, y, widthMm / 2, boardCenter, width, height);
        traceRoutePointEdgeGaps.push(edgeGapMm);
        if (edgeGapMm + EPSILON < minBoardEdgeClearanceMm) {
          findings.push({
            kind: 'trace-route-point-edge-gap', status: 'violation', pcbTraceId: id, routeIndex, x, y, layer,
            actualMm: edgeGapMm, declaredMinimumMm: minBoardEdgeClearanceMm,
            message: `${id} wire route[${routeIndex}] has a ${edgeGapMm} mm circular width-envelope gap to the rectangular board edge, below the ${referenceLabel} minimum ${minBoardEdgeClearanceMm} mm.`,
          });
        }
      }
    });
  }

  const viaHoles: number[] = [];
  const viaPads: number[] = [];
  const viaPadEdgeGaps: number[] = [];
  for (const via of vias) {
    const id = exactText(via.pcb_via_id);
    const x = finite(via.x);
    const y = finite(via.y);
    const hole = finitePositive(via.hole_diameter);
    const pad = finitePositive(via.outer_diameter);
    if (!id || x == null || y == null || !hole || !pad) {
      findings.push({ kind: 'uninspectable-geometry', status: 'indeterminate', pcbViaId: id, message: 'A pcb_via lacks an exact ID or finite x/y/hole_diameter/outer_diameter.' });
      continue;
    }
    viaHoles.push(hole);
    viaPads.push(pad);
    if (minViaHoleDiameterMm && hole + EPSILON < minViaHoleDiameterMm) {
      findings.push({ kind: 'via-hole-diameter', status: 'violation', pcbViaId: id, x, y, actualMm: hole, declaredMinimumMm: minViaHoleDiameterMm, message: `${id} declares ${hole} mm drill diameter below the ${referenceLabel} minimum ${minViaHoleDiameterMm} mm.` });
    }
    if (minViaPadDiameterMm && pad + EPSILON < minViaPadDiameterMm) {
      findings.push({ kind: 'via-pad-diameter', status: 'violation', pcbViaId: id, x, y, actualMm: pad, declaredMinimumMm: minViaPadDiameterMm, message: `${id} declares ${pad} mm pad diameter below the ${referenceLabel} minimum ${minViaPadDiameterMm} mm.` });
    }
    if (boardCenter && minBoardEdgeClearanceMm) {
      const edgeGapMm = rectangularEnvelopeEdgeGap(x, y, pad / 2, boardCenter, width, height);
      viaPadEdgeGaps.push(edgeGapMm);
      if (edgeGapMm + EPSILON < minBoardEdgeClearanceMm) {
        findings.push({
          kind: 'via-pad-edge-gap', status: 'violation', pcbViaId: id, x, y,
          actualMm: edgeGapMm, declaredMinimumMm: minBoardEdgeClearanceMm,
          message: `${id} has a ${edgeGapMm} mm circular pad-envelope gap to the rectangular board edge, below the ${referenceLabel} minimum ${minBoardEdgeClearanceMm} mm.`,
        });
      }
    }
  }

  let platedHoleCount: number | undefined;
  let inspectableCircularPlatedHoleCount: number | undefined;
  const platedHoleAnnularRings: number[] = [];
  if (minPlatedHoleAnnularRingMm) {
    platedHoleCount = platedHoles.length;
    if (platedHoles.length > MAX_PCB_RULE_LENS_PLATED_HOLES) {
      throw new Error(`PCB Rule Lens supports at most ${MAX_PCB_RULE_LENS_PLATED_HOLES} pcb_plated_hole elements for annular-ring comparison; found ${platedHoles.length}.`);
    }
    const ids = new Set<string>();
    for (const platedHole of platedHoles) {
      const id = exactText(platedHole.pcb_plated_hole_id);
      const x = finite(platedHole.x);
      const y = finite(platedHole.y);
      const holeDiameterMm = finitePositive(platedHole.hole_diameter);
      const outerDiameterMm = finitePositive(platedHole.outer_diameter);
      if (!id || platedHole.shape !== 'circle' || x == null || y == null || !holeDiameterMm || !outerDiameterMm || outerDiameterMm <= holeDiameterMm) {
        findings.push({
          kind: 'uninspectable-geometry', status: 'indeterminate', pcbPlatedHoleId: id,
          message: 'A pcb_plated_hole is not an exact finite circle with a unique bounded ID, finite x/y, and outer_diameter greater than hole_diameter.',
        });
        continue;
      }
      if (ids.has(id)) throw new Error(`PCB Rule Lens requires unique exact pcb_plated_hole IDs; found duplicate ${id}.`);
      ids.add(id);
      const annularRingMm = (outerDiameterMm - holeDiameterMm) / 2;
      platedHoleAnnularRings.push(annularRingMm);
      if (annularRingMm + EPSILON < minPlatedHoleAnnularRingMm) {
        findings.push({
          kind: 'plated-hole-annular-ring', status: 'violation', pcbPlatedHoleId: id, x, y,
          actualMm: annularRingMm, declaredMinimumMm: minPlatedHoleAnnularRingMm,
          message: `${id} has ${annularRingMm} mm nominal evaluated radial annular width below the ${referenceLabel} minimum ${minPlatedHoleAnnularRingMm} mm. This does not account for drill or plating tolerance.`,
        });
      }
    }
    inspectableCircularPlatedHoleCount = platedHoleAnnularRings.length;
  }

  let padCount: number | undefined;
  let inspectablePadCount: number | undefined;
  let inspectedPadPairCount: number | undefined;
  const padEdgeGaps: number[] = [];
  if (minPadToPadEdgeClearanceMm) {
    const pads = elements.filter((element) => element.type === 'pcb_smtpad');
    padCount = pads.length;
    if (pads.length > MAX_PCB_RULE_LENS_PADS) {
      throw new Error(`PCB Rule Lens supports at most ${MAX_PCB_RULE_LENS_PADS} pcb_smtpad elements for pad-spacing comparison; found ${pads.length}.`);
    }
    const envelopes: PadEnvelope[] = [];
    const ids = new Set<string>();
    for (const pad of pads) {
      const envelope = padEnvelope(pad);
      if (!envelope) {
        findings.push({
          kind: 'uninspectable-geometry', status: 'indeterminate',
          message: 'A pcb_smtpad is not an exact finite same-layer unrounded axis-aligned rect or circle envelope.',
        });
        continue;
      }
      if (ids.has(envelope.id)) throw new Error(`PCB Rule Lens requires unique exact pcb_smtpad IDs; found duplicate ${envelope.id}.`);
      ids.add(envelope.id);
      envelopes.push(envelope);
    }
    inspectablePadCount = envelopes.length;
    let pairCount = 0;
    for (let leftIndex = 0; leftIndex < envelopes.length; leftIndex += 1) {
      const left = envelopes[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < envelopes.length; rightIndex += 1) {
        const right = envelopes[rightIndex];
        if (left.layer !== right.layer) continue;
        pairCount += 1;
        if (pairCount > MAX_PCB_RULE_LENS_PAD_PAIRS) {
          throw new Error(`PCB Rule Lens supports at most ${MAX_PCB_RULE_LENS_PAD_PAIRS} same-layer SMT-pad pairs.`);
        }
        const edgeGapMm = padEnvelopeGap(left, right);
        padEdgeGaps.push(edgeGapMm);
        if (edgeGapMm + EPSILON < minPadToPadEdgeClearanceMm) {
          const pcbSmtpadIds = [left.id, right.id].sort() as [string, string];
          findings.push({
            kind: 'pad-to-pad-edge-gap', status: 'violation', pcbSmtpadIds,
            x: (left.x + right.x) / 2, y: (left.y + right.y) / 2, layer: left.layer,
            actualMm: edgeGapMm, declaredMinimumMm: minPadToPadEdgeClearanceMm,
            message: `${pcbSmtpadIds[0]} and ${pcbSmtpadIds[1]} have a ${edgeGapMm} mm exact supported-envelope gap on ${left.layer}, below the ${referenceLabel} minimum ${minPadToPadEdgeClearanceMm} mm. The marker is their center midpoint.`,
          });
        }
      }
    }
    inspectedPadPairCount = pairCount;
  }

  findings.sort(compareFindings);
  const violations = findings.filter((finding) => finding.status === 'violation');
  const indeterminate = findings.length - violations.length;
  const presentedFindings = findings.slice(0, MAX_PCB_RULE_LENS_FINDINGS);
  const markerFindings = violations.filter((finding) => finding.x != null && finding.y != null);
  const visibleMarkers = markerFindings.slice(0, MAX_PCB_RULE_LENS_MARKERS);
  const exercised = traceWidths.length + viaHoles.length + padEdgeGaps.length + platedHoleAnnularRings.length > 0;
  const status: PcbRuleLensResult['status'] = violations.length
    ? 'violations'
    : indeterminate
      ? 'incomplete'
      : exercised
        ? 'clear'
        : 'not-exercised';

  return {
    result: {
      scope: 'evaluated-board-scalar-rule-envelope', status, units: 'mm',
      reference: {
        kind: reference.kind,
        label: referenceLabel,
        ...(reference.kind === 'loaded-project-guidance' ? { projectGuidanceSchemaVersion: 1 as const } : {}),
        ...(reference.kind === 'reviewed-fab-profile' ? {
          profileId: reference.profile.id,
          reviewedAt: reference.profile.reviewedAt,
          sourceUrl: reference.profile.sourceUrl,
          assumptions: { ...reference.profile.assumptions },
          assumptionEvidence: {
            request: 'explicit' as const,
            boardLayerCount: profileBoardLayerEvidence as 'matched' | 'not-recorded',
            boardMaterial: profileBoardMaterialEvidence as 'matched' | 'not-recorded',
            outerCopperOz: 'caller-confirmed-not-evaluated' as const,
            outlineProcess: 'caller-confirmed-not-evaluated' as const,
          },
          omittedComparisons: [...reference.profile.omittedComparisons],
        } : {}),
      },
      board: {
        pcbBoardId, ...(boardCenter ? { center: boardCenter } : {}), width, height,
        ...(finitePositive(board.thickness) ? { thickness: finitePositive(board.thickness) } : {}),
        ...(typeof board.num_layers === 'number' && Number.isSafeInteger(board.num_layers) && board.num_layers > 0 ? { numLayers: board.num_layers } : {}),
        ...(exactText(board.material) ? { material: exactText(board.material) } : {}),
      },
      declarations: {
        minTraceWidthMm, minViaHoleDiameterMm, minViaPadDiameterMm,
        ...(minBoardEdgeClearanceMm == null ? {} : { minBoardEdgeClearanceMm }),
        ...(minPadToPadEdgeClearanceMm == null ? {} : { minPadToPadEdgeClearanceMm }),
        ...(minPlatedHoleAnnularRingMm == null ? {} : { minPlatedHoleAnnularRingMm }),
      },
      observed: {
        traceCount: traces.length, wireRouteEntryCount: traceWidths.length, viaCount: vias.length,
        minimumTraceWidthMm: minimum(traceWidths), minimumViaHoleDiameterMm: minimum(viaHoles), minimumViaPadDiameterMm: minimum(viaPads),
        ...(minimum(traceRoutePointEdgeGaps) == null ? {} : { minimumTraceRoutePointEdgeGapMm: minimum(traceRoutePointEdgeGaps) }),
        ...(minimum(viaPadEdgeGaps) == null ? {} : { minimumViaPadEdgeGapMm: minimum(viaPadEdgeGaps) }),
        ...(padCount == null ? {} : { padCount }),
        ...(inspectablePadCount == null ? {} : { inspectablePadCount }),
        ...(inspectedPadPairCount == null ? {} : { inspectedPadPairCount }),
        ...(minimum(padEdgeGaps) == null ? {} : { minimumPadToPadEdgeGapMm: minimum(padEdgeGaps) }),
        ...(platedHoleCount == null ? {} : { platedHoleCount }),
        ...(inspectableCircularPlatedHoleCount == null ? {} : { inspectableCircularPlatedHoleCount }),
        ...(minimum(platedHoleAnnularRings) == null ? {} : { minimumPlatedHoleAnnularRingMm: minimum(platedHoleAnnularRings) }),
      },
      counts: {
        violations: violations.length, indeterminate,
        omittedFindings: findings.length - presentedFindings.length,
        markers: visibleMarkers.length, omittedMarkers: markerFindings.length - visibleMarkers.length,
      },
      findings: presentedFindings,
      limitation: `Read-only scalar comparison against ${referenceLabel}. ${reference.kind === 'reviewed-fab-profile' ? `${reference.profile.limitation} ${reference.profile.omittedComparisons.join(' ')} ` : ''}${LIMITATION_SUFFIX}`,
    },
    overlayElements: visibleMarkers.flatMap((finding, index) => marker(index, finding)),
  };
}
