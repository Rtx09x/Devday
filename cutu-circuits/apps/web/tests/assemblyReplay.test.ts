import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assemblyStageFor,
  assemblyStages,
  completeAssemblyStage,
  controllerStage,
  wiringStage,
  nextAssemblyStage,
  revealStep,
} from "../src/assemblyReveal";

test("Makada builds all meshes with each leg and foot paired in its own stage", async () => {
  const project = JSON.parse(
    await readFile(
      new URL(
        "../../../examples/spidey/cutucircuits.project.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const groups = Array.from(
    { length: completeAssemblyStage },
    () => [] as string[],
  );
  for (const entity of project.entities)
    groups[assemblyStageFor(entity.id)].push(entity.id);
  assert.equal(groups.flat().length, 81);
  assert.ok(groups.every((group) => group.length > 0));
  assert.equal(assemblyStageFor("servo-tilt"), 0);
  assert.equal(assemblyStageFor("horn-tilt-screw"), 1);
  for (const [side, offset] of [
    ["left", 2],
    ["right", 5],
  ] as const) {
    for (let leg = 1; leg <= 3; leg++) {
      const stage = offset + leg - 1;
      assert.equal(assemblyStageFor(`leg-${side}-${leg}`), stage);
      assert.equal(assemblyStageFor(`foot-${side}-${leg}`), stage);
      assert.deepEqual(groups[stage].sort(), [
        `foot-${side}-${leg}`,
        `leg-${side}-${leg}`,
      ]);
    }
  }
  assert.equal(assemblyStageFor("controller-pin-D7"), controllerStage);
  assert.equal(assemblyStageFor("controller-common-ground"), wiringStage);
  assert.equal(assemblyStageFor("cable-left-0"), wiringStage);
  assert.equal(
    assemblyStages.reduce((duration, stage) => duration + stage.durationMs, 0),
    36800,
  );
  assert.ok(assemblyStages.every((stage) => stage.durationMs >= 3000));
  assert.equal(assemblyStages[completeAssemblyStage].title, "Makada complete");
});

test("reveal interpolation is time based, monotonic and settles without perpetual rendering", () => {
  let alpha = 0;
  for (let i = 0; i < 240; i++) {
    const next = revealStep(alpha, 1, 1 / 60, false);
    assert.ok(next >= alpha && next <= 1);
    alpha = next;
  }
  assert.equal(alpha, 1);
  assert.equal(revealStep(0, 1, 1 / 60, true), 1);
  assert.equal(revealStep(1, 0, 1 / 60, true), 0);
  const whole = revealStep(0, 1, 0.1, false);
  const half = revealStep(revealStep(0, 1, 0.05, false), 1, 0.05, false);
  assert.ok(Math.abs(whole - half) < 1e-12);
  assert.equal(nextAssemblyStage(0, -1), 0);
  assert.equal(
    nextAssemblyStage(completeAssemblyStage, 1),
    completeAssemblyStage,
  );
  assert.equal(nextAssemblyStage(2, 1), 3);
});
