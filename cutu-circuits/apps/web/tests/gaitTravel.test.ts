import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gaitTravel } from "../src/gaitTravel";
import { validateProject } from "../../../packages/runtime/src/validation";

const makada = validateProject(
  JSON.parse(
    await readFile(
      new URL(
        "../../../examples/spidey/cutucircuits.project.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
test("Makada advances one authored stride per full gait cycle, with continuous phase progress", () => {
  const motion = makada.motion!;
  const seconds =
    motion.phases.reduce(
      (sum, phase) => sum + phase.durationMs + phase.settleMs,
      0,
    ) / 1000;
  assert.equal(makada.name, "Makada");
  assert.deepEqual(gaitTravel(motion, seconds), [0, -16, 0]);
  assert.deepEqual(gaitTravel(motion, seconds * 2.5), [0, -40, 0]);
  assert.deepEqual(gaitTravel(motion, 0), [0, 0, 0]);
  assert.deepEqual(
    gaitTravel({ ...motion, previewTravel: undefined }, seconds),
    [0, 0, 0],
  );
  assert.deepEqual(gaitTravel({ ...motion, phases: [] }, seconds), [0, 0, 0]);
});
test("walking preview rejects vertical travel and invalid stride lengths", () => {
  for (const previewTravel of [
    { direction: [0, 0, 0], strideMm: 16 },
    { direction: [0, -1, 1], strideMm: 16 },
    { direction: [0, -1, 0], strideMm: -1 },
  ])
    assert.throws(() =>
      validateProject({
        ...makada,
        motion: { ...makada.motion, previewTravel },
      }),
    );
});
