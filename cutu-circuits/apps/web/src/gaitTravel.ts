import type { MotionDefinition, Vec3 } from "@cutucircuits/core";

/** Ground travel is an authored illustration, not displacement inferred from servo pulses. */
export function gaitTravel(
  motion: MotionDefinition | undefined,
  elapsedSeconds: number,
): Vec3 {
  const travel = motion?.previewTravel;
  const cycleMs =
    motion?.phases.reduce(
      (sum, phase) => sum + phase.durationMs + phase.settleMs,
      0,
    ) ?? 0;
  if (
    !travel ||
    cycleMs <= 0 ||
    !Number.isFinite(elapsedSeconds) ||
    elapsedSeconds <= 0
  )
    return [0, 0, 0];
  const length = Math.hypot(travel.direction[0], travel.direction[1]);
  if (
    !length ||
    !Number.isFinite(length) ||
    !Number.isFinite(travel.strideMm) ||
    travel.strideMm <= 0
  )
    return [0, 0, 0];
  const distance = ((elapsedSeconds * 1000) / cycleMs) * travel.strideMm;
  return [
    (travel.direction[0] / length) * distance,
    (travel.direction[1] / length) * distance,
    0,
  ];
}
