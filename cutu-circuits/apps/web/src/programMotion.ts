import type { MotionDefinition, Operation } from "@cutucircuits/core";
export interface ProgramMotion {
  operationId: string;
  source: string;
  targets: Record<string, number>;
}
/** Only current command telemetry drives the illustration; finished records never imply a live pose. */
export function programMotion(
  motion: MotionDefinition | undefined,
  operations: Operation[],
  suppressedOperationId?: string,
  now = Date.now(),
): ProgramMotion | undefined {
  if (!motion) return;
  const operation = operations
    .filter((op) => op.status === "running")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .at(0);
  if (!operation || operation.id === suppressedOperationId) return;
  const telemetry = operation.telemetry;
  if (!telemetry) return;
  if (telemetry.telemetryStale === true) return;
  if (telemetry.source === "device") {
    const receivedAt = telemetry.receivedAtUnixMs;
    const staleAfter = telemetry.staleAfterMs;
    if (
      typeof receivedAt !== "number" ||
      !Number.isFinite(receivedAt) ||
      typeof staleAfter !== "number" ||
      !Number.isFinite(staleAfter) ||
      staleAfter < 100 ||
      staleAfter > 5000 ||
      now < receivedAt - 100 ||
      now - receivedAt > staleAfter
    )
      return;
    const state = record(telemetry.state);
    // STOP detaches outputs. Last commanded pulses must not imply a held live pose.
    if (
      !state ||
      typeof state.enabled_mask !== "number" ||
      !Number.isInteger(state.enabled_mask) ||
      state.enabled_mask < 1 ||
      state.enabled_mask > 7
    )
      return;
  }
  const pulses = record(telemetry.commandedPulseUs),
    commanded = record(telemetry.commanded);
  const targets: Record<string, number> = {};
  for (const [index, joint] of motion.joints.entries()) {
    if (telemetry.source === "device") {
      const mask = record(telemetry.state)!.enabled_mask as number;
      if ((mask & (1 << index)) === 0) continue;
    }
    const raw =
      pulses?.[joint.entityId] ??
      commanded?.[joint.channel ?? joint.entityId] ??
      commanded?.[joint.entityId];
    if (typeof raw === "number" && Number.isFinite(raw))
      targets[joint.entityId] = Math.min(
        joint.maxUs,
        Math.max(joint.minUs, raw),
      );
  }
  if (!Object.keys(targets).length) return;
  return {
    operationId: operation.id,
    source:
      typeof telemetry.source === "string"
        ? telemetry.source.slice(0, 80)
        : "project program",
    targets,
  };
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
