import { test } from "node:test";
import assert from "node:assert/strict";
import type { MotionDefinition, Operation } from "@cutucircuits/core";
import { programMotion } from "../src/programMotion";
const motion: MotionDefinition = {
  id: "motion",
  name: "Motion",
  description: "",
  source: "commanded",
  calibrated: false,
  joints: [
    {
      entityId: "joint-a",
      channel: "A",
      axis: [0, 0, 1],
      centerUs: 1500,
      minUs: 1000,
      maxUs: 2000,
    },
    {
      entityId: "joint-b",
      axis: [0, 1, 0],
      centerUs: 1500,
      minUs: 1200,
      maxUs: 1800,
    },
  ],
  phases: [],
};
function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op",
    projectId: "project",
    capabilityId: "program",
    label: "Program",
    status: "running",
    startedAt: "2026-10-31T00:00:00Z",
    output: "",
    ...overrides,
  };
}
test("entity command pulses are bounded to each declared joint", () => {
  assert.deepEqual(
    programMotion(motion, [
      operation({
        telemetry: {
          source: "offline-preview",
          commandedPulseUs: { "joint-a": 2500, "joint-b": 1100, unknown: 1700 },
        },
      }),
    ]),
    {
      operationId: "op",
      source: "offline-preview",
      targets: { "joint-a": 2000, "joint-b": 1200 },
    },
  );
});
test("generic channel telemetry uses declared mapping and ignores invalid values", () => {
  assert.deepEqual(
    programMotion(motion, [
      operation({
        telemetry: {
          source: "device",
          receivedAtUnixMs: Date.now(),
          staleAfterMs: 500,
          state: { enabled_mask: 7 },
          commanded: { A: 1600, "joint-b": NaN, unknown: 1500 },
          measured: { A: 1900 },
        },
      }),
    ])?.targets,
    { "joint-a": 1600 },
  );
  assert.equal(
    programMotion(motion, [
      operation({
        telemetry: { measured: { A: 1900 }, commanded: { A: "1600" } },
      }),
    ]),
    undefined,
  );
});
test("finished and cancelled operations never override manual preview", () => {
  for (const status of ["succeeded", "failed", "cancelled"] as const)
    assert.equal(
      programMotion(motion, [
        operation({
          status,
          telemetry: { commandedPulseUs: { "joint-a": 1600 } },
        }),
      ]),
      undefined,
    );
});
test("manual override suppresses current program but a newer running program can take over", () => {
  const first = operation({
    telemetry: { commandedPulseUs: { "joint-a": 1600 } },
  });
  assert.equal(programMotion(motion, [first], "op"), undefined);
  const next = operation({
    id: "next",
    startedAt: "2026-10-31T00:01:00Z",
    telemetry: {
      source: "device",
      receivedAtUnixMs: Date.now(),
      staleAfterMs: 500,
      state: { enabled_mask: 7 },
      commanded: { A: 1700 },
    },
  });
  assert.equal(programMotion(motion, [next, first], "op")?.operationId, "next");
  assert.equal(
    programMotion(motion, [
      first,
      operation({ id: "newer", startedAt: next.startedAt }),
    ]),
    undefined,
  );
});

test("device snapshots expire without another event and stale or detached records never override", () => {
  const now = 100000;
  const telemetry = {
    source: "device",
    receivedAtUnixMs: now,
    staleAfterMs: 500,
    state: { enabled_mask: 7 },
    commandedPulseUs: { "joint-a": 1600 },
  };
  assert.equal(
    programMotion(motion, [operation({ telemetry })], undefined, now + 400)
      ?.targets["joint-a"],
    1600,
  );
  assert.equal(
    programMotion(motion, [operation({ telemetry })], undefined, now + 501),
    undefined,
  );
  for (const patch of [
    { telemetryStale: true },
    { state: { enabled_mask: 0 } },
    { receivedAtUnixMs: undefined },
    { receivedAtUnixMs: now + 200 },
    { staleAfterMs: Infinity },
  ])
    assert.equal(
      programMotion(
        motion,
        [operation({ telemetry: { ...telemetry, ...patch } })],
        undefined,
        now,
      ),
      undefined,
    );
});
