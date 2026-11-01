export const TSCIRCUIT_CAPACITY_AUTOROUTER_VERSION = '0.0.583' as const;

export const MAX_AUTOROUTE_TRACES = 500;
export const MAX_AUTOROUTE_POINTS_PER_TRACE = 4_096;
export const MAX_AUTOROUTE_TOTAL_POINTS = 20_000;
export const MAX_AUTOROUTE_DIAGNOSTICS = 32;
export const MAX_AUTOROUTE_IDENTIFIER_LENGTH = 2_048;

export type NormalizedAutoroutePoint =
  | { route_type: 'wire'; x: number; y: number; width: number; layer: string }
  | {
    route_type: 'via';
    x: number;
    y: number;
    to_layer: string;
    from_layer: string;
    via_diameter?: number;
    via_hole_diameter?: number;
  }
  | {
    route_type: 'through_obstacle';
    start: { x: number; y: number };
    end: { x: number; y: number };
    from_layer: string;
    to_layer: string;
    width: number;
  };

export interface NormalizedSimplifiedPcbTrace {
  type: 'pcb_trace';
  pcb_trace_id: string;
  connection_name: string;
  route: NormalizedAutoroutePoint[];
}

export interface CapacityAutorouterContractInspection {
  usable: boolean;
  reason: string;
}

export function inspectCapacityAutorouterContract(value: unknown): CapacityAutorouterContractInspection {
  if (!value || typeof value !== 'object') {
    return { usable: false, reason: 'The capacity autorouter module is unavailable.' };
  }
  const constructor = (value as { AutoroutingPipelineSolver?: unknown }).AutoroutingPipelineSolver;
  if (typeof constructor !== 'function') {
    return { usable: false, reason: 'The AutoroutingPipelineSolver export is missing.' };
  }
  const prototype = (constructor as { prototype?: Record<string, unknown> }).prototype;
  if (!prototype || typeof prototype.step !== 'function'
    || typeof prototype.getOutputSimplifiedPcbTraces !== 'function'
    || typeof prototype.getOutputSimpleRouteJson !== 'function') {
    return { usable: false, reason: 'The pinned autorouter does not expose the expected step/output contract.' };
  }
  return {
    usable: true,
    reason: `Pinned local @tscircuit/capacity-autorouter ${TSCIRCUIT_CAPACITY_AUTOROUTER_VERSION} exposes the synchronous step/output contract.`,
  };
}

function recordAt(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is not an object.`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string, options?: { positive?: boolean; maximum?: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > (options?.maximum ?? 1_000_000)) {
    throw new Error(`${label} must be a bounded finite number.`);
  }
  if (options?.positive && value <= 0) throw new Error(`${label} must be positive.`);
  return value;
}

function normalizeRoutePoint(value: unknown, traceIndex: number, pointIndex: number): NormalizedAutoroutePoint {
  const label = `Autoroute trace ${traceIndex + 1} point ${pointIndex + 1}`;
  const point = recordAt(value, label);
  const routeType = point.route_type;
  if (routeType === 'through_obstacle') {
    const start = recordAt(point.start, `${label} start`);
    const end = recordAt(point.end, `${label} end`);
    return {
      route_type: 'through_obstacle',
      start: {
        x: finiteNumber(start.x, `${label} start x`),
        y: finiteNumber(start.y, `${label} start y`),
      },
      end: {
        x: finiteNumber(end.x, `${label} end x`),
        y: finiteNumber(end.y, `${label} end y`),
      },
      from_layer: boundedString(point.from_layer, `${label} from_layer`, 64),
      to_layer: boundedString(point.to_layer, `${label} to_layer`, 64),
      width: finiteNumber(point.width, `${label} width`, { positive: true, maximum: 100 }),
    };
  }
  const x = finiteNumber(point.x, `${label} x`);
  const y = finiteNumber(point.y, `${label} y`);
  if (routeType === 'wire') {
    return {
      route_type: 'wire', x, y,
      width: finiteNumber(point.width, `${label} width`, { positive: true, maximum: 100 }),
      layer: boundedString(point.layer, `${label} layer`, 64),
    };
  }
  if (routeType === 'via') {
    const viaDiameter = point.via_diameter == null
      ? undefined
      : finiteNumber(point.via_diameter, `${label} via_diameter`, { positive: true, maximum: 100 });
    const viaHoleDiameter = point.via_hole_diameter == null
      ? undefined
      : finiteNumber(point.via_hole_diameter, `${label} via_hole_diameter`, { positive: true, maximum: 100 });
    return {
      route_type: 'via', x, y,
      to_layer: boundedString(point.to_layer, `${label} to_layer`, 64),
      from_layer: boundedString(point.from_layer, `${label} from_layer`, 64),
      ...(viaDiameter == null ? {} : { via_diameter: viaDiameter }),
      ...(viaHoleDiameter == null ? {} : { via_hole_diameter: viaHoleDiameter }),
    };
  }
  throw new Error(`${label} has unsupported route_type ${String(routeType)}.`);
}

export function normalizeSimplifiedPcbTraces(value: unknown): NormalizedSimplifiedPcbTrace[] {
  if (!Array.isArray(value)) throw new Error('The autorouter returned a non-array trace result.');
  if (value.length > MAX_AUTOROUTE_TRACES) {
    throw new Error(`The autorouter exceeded ${MAX_AUTOROUTE_TRACES} proposed traces.`);
  }
  let totalPoints = 0;
  return value.map((entry, traceIndex) => {
    const trace = recordAt(entry, `Autoroute trace ${traceIndex + 1}`);
    if (trace.type !== 'pcb_trace') throw new Error(`Autoroute trace ${traceIndex + 1} is not a pcb_trace.`);
    if (!Array.isArray(trace.route)) throw new Error(`Autoroute trace ${traceIndex + 1} has no route array.`);
    if (trace.route.length > MAX_AUTOROUTE_POINTS_PER_TRACE) {
      throw new Error(`Autoroute trace ${traceIndex + 1} exceeded ${MAX_AUTOROUTE_POINTS_PER_TRACE} route points.`);
    }
    totalPoints += trace.route.length;
    if (totalPoints > MAX_AUTOROUTE_TOTAL_POINTS) {
      throw new Error(`The autorouter exceeded ${MAX_AUTOROUTE_TOTAL_POINTS} total route points.`);
    }
    return {
      type: 'pcb_trace',
      pcb_trace_id: boundedString(trace.pcb_trace_id, `Autoroute trace ${traceIndex + 1} pcb_trace_id`, MAX_AUTOROUTE_IDENTIFIER_LENGTH),
      connection_name: boundedString(trace.connection_name, `Autoroute trace ${traceIndex + 1} connection_name`, MAX_AUTOROUTE_IDENTIFIER_LENGTH),
      route: trace.route.map((point, pointIndex) => normalizeRoutePoint(point, traceIndex, pointIndex)),
    };
  });
}

export function normalizeAutorouteDiagnostics(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('The autorouter returned non-array diagnostics.');
  if (value.length > MAX_AUTOROUTE_DIAGNOSTICS) {
    throw new Error(`The autorouter exceeded ${MAX_AUTOROUTE_DIAGNOSTICS} diagnostics.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length > 2_048) {
      throw new Error(`Autoroute diagnostic ${index + 1} is not a string of at most 2048 characters.`);
    }
    return entry;
  });
}
