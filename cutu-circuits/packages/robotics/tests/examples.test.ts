import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRobotSimulation, parseUrdf } from "../src/index.js";
import { stlVertices } from "../src/stl.js";
const example = (path: string) =>
  new URL(`../../../examples/${path}`, import.meta.url);
test("native arm example motors, gravity and bounded extension run through real physics", async () => {
  const model = parseUrdf(await readFile(example("robot/arm.urdf"), "utf8"));
  const sim = await createRobotSimulation(model, { fixedBase: true });
  try {
    sim.setJointTarget("shoulder", 0.6);
    sim.setJointTarget("extension", 1);
    const state = sim.step(1200);
    assert.equal(state.joints.extension.target, 0.16);
    assert.ok(Math.abs(state.joints.shoulder.position - 0.6) < 0.1);
    assert.ok(
      state.joints.extension.position > 0.14 &&
        state.joints.extension.position < 0.165,
    );
    for (const t of Object.values(state.links))
      assert.ok(t.position.every(Number.isFinite));
  } finally {
    sim.dispose();
  }
});
test("Makada uses authored native visual meshes and estimated real collision dynamics", async () => {
  const model = parseUrdf(
    await readFile(example("spidey/spidey.urdf"), "utf8"),
  );
  assert.equal(model.links.length, 4);
  assert.equal(model.joints.length, 3);
  assert.ok(model.diagnostics.some((x) => x.code === "model-assumptions"));
  let triangles = 0;
  for (const l of model.links)
    for (const visual of l.visuals) {
      assert.equal(visual.geometry.type, "mesh");
      if (visual.geometry.type === "mesh") {
        const data = await readFile(
          example(`spidey/${visual.geometry.filename}`),
        );
        triangles +=
          stlVertices(
            data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength,
            ),
          ).length / 9;
      }
    }
  assert.ok(triangles > 0);
  const project = JSON.parse(await readFile(example("spidey/cutucircuits.project.json"), "utf8"));
  const expected = project.entities.filter((entity: { geometry?: { type: string } }) => entity.geometry?.type === "mesh").map((entity: { geometry: { shapeName: string } }) => entity.geometry.shapeName);
  assert.deepEqual(model.links.flatMap((link) => link.visuals.map((visual) => visual.name)).sort(), expected.sort());
  const names = model.links.flatMap((link) => link.visuals.map((visual) => visual.name));
  for (const name of ["controller", "controller-usb", "controller-labels", "controller-pin-D5", "controller-pin-D6", "controller-pin-D7", "controller-common-ground"]) assert.ok(names.includes(name), `Missing ${name}`);
  const sim = await createRobotSimulation(model, { fixedBase: false });
  try {
    const initial = sim.snapshot();
    const state = sim.step(600);
    assert.ok(state.contacts > 0);
    assert.notDeepEqual(state.links.body.position, initial.links.body.position);
    for (const t of Object.values(state.links))
      assert.ok(t.position.every((n) => Number.isFinite(n) && Math.abs(n) < 1));
  } finally {
    sim.dispose();
  }
});

test("Makada's sideways middle casing stays aligned and uses the matching motion pivot", async () => {
  const data = await readFile(example("spidey/meshes/servo-tilt.stl"));
  const vertices = stlVertices(
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  );
  const ys = Array.from(vertices).filter((_, index) => index % 3 === 1);
  // The rectangular casing face is at -11.5 mm; only its round bearing
  // extends to -14.9 mm. The old placement projected to -23.9 mm.
  assert.ok(Math.abs(Math.min(...ys) - -0.0149) < 1e-6);
  assert.ok(Math.abs(Math.max(...ys) - 0.014) < 1e-6);
  const project = JSON.parse(
    await readFile(example("spidey/cutucircuits.project.json"), "utf8"),
  );
  const servo = project.entities.find(
    (entity: { id: string }) => entity.id === "servo-tilt",
  );
  assert.deepEqual(servo.metadata.jointPivot, [0, -16.5, 60.5]);
  const model = parseUrdf(
    await readFile(example("spidey/spidey.urdf"), "utf8"),
  );
  const joint = model.joints.find((joint) => joint.name === "tilt")!;
  assert.deepEqual(joint.axis, [0, 1, 0]);
  assert.deepEqual(joint.origin.position, [0, -0.0165, 0.0605]);
});


test("rear NodeMCU physical D5/D6/D7 pads agree with the graph, wiring and firmware", async () => {
  const project = JSON.parse(await readFile(example("spidey/cutucircuits.project.json"), "utf8"));
  const circuit = await readFile(example("spidey/circuit.circuit.tsx"), "utf8");
  const firmware = await readFile(example("spidey/firmware/src/main.cpp"), "utf8");
  assert.match(firmware, /constexpr int pins\[3\] = \{14, 12, 13\}/);
  const controller = project.entities.find((e: { id: string }) => e.id === "controller");
  assert.equal(controller.geometry.shapeName, "controller");
  assert.equal(controller.metadata.sceneHidden, false);
  assert.ok(controller.position[1] > 14, "Controller is behind the cluster (+Y)");
  const rightOrder = ["D0", "D1", "D2", "D3", "D4", "3V3-R1", "GND-R1", "D5", "D6", "D7", "D8", "RX", "TX", "GND-R2", "3V3-R2"];
  const headers = project.entities.filter((e: { id: string }) => e.id.startsWith("controller-pin-"));
  assert.equal(headers.length, 30);
  for (const [index, pin] of rightOrder.entries()) {
    const entity = headers.find((e: { id: string }) => e.id === `controller-pin-${pin}`);
    assert.equal(entity.metadata.headerIndex, index + 1);
    const expected = [17.78 - index * 2.54, 24.6, 66.93];
    for (const axis of [0, 1, 2]) assert.ok(Math.abs(entity.metadata.padPosition[axis] - expected[axis]) < 1e-8);
    const data = await readFile(example(`spidey/meshes/controller-pin-${pin}.stl`));
    const vertices = stlVertices(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    for (const axis of [0, 2]) {
      const values = Array.from(vertices).filter((_, i) => i % 3 === axis);
      const center = (Math.min(...values) + Math.max(...values)) / 2;
      assert.ok(Math.abs(center * 1000 - entity.metadata.padPosition[axis]) < 1e-4, `Physical mesh pad ${pin} axis ${axis}`);
    }
  }
  for (const [label, pin, gpio] of [["left", "D5", 14], ["right", "D6", 12], ["tilt", "D7", 13]] as const) {
    const pad = headers.find((e: { id: string }) => e.id === `controller-pin-${pin}`);
    assert.equal(pad.metadata.gpio, gpio);
    const signal = project.links.find((link: { id: string }) => link.id === `servo-${label}-signal`);
    assert.equal(signal.sourcePort, pin);
    assert.ok(circuit.includes(`from=".MCU > .${pin}" to=".${label.toUpperCase()} > .SIG"`));
    const cable = project.entities.find((e: { id: string }) => e.id === `cable-${label}-2`);
    assert.equal(cable.metadata.sourceEntityId, pad.id);
    const data = await readFile(example(`spidey/meshes/cable-${label}-2.stl`));
    const vertices = stlVertices(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    let nearest = Infinity;
    for (let i = 0; i < vertices.length; i += 3) nearest = Math.min(nearest, Math.hypot(...pad.metadata.padPosition.map((n: number, axis: number) => vertices[i + axis] * 1000 - n)));
    assert.ok(nearest < 0.45, `${pin} signal mesh reaches physical pad`);
  }
  const ground = project.links.find((link: { id: string }) => link.id === "common-ground");
  assert.deepEqual([ground.source, ground.sourcePort, ground.target, ground.targetPort], ["power-bus", "GND", "controller", "GND"]);
  assert.ok(circuit.includes('from=".MCU > .GND" to=".BEC > .GND"'));
  const servoPower = project.links.filter((link: { id: string }) => /servo-.*-5v/.test(link.id));
  assert.equal(servoPower.length, 3);
  assert.ok(servoPower.every((link: { source: string; sourcePort: string }) => link.source === "power-bus" && link.sourcePort === "V5"));
});


test("NodeMCU PCB stands in the rear XZ plane with inward headers clear of the servo backs", async () => {
  const project = JSON.parse(await readFile(example("spidey/cutucircuits.project.json"), "utf8"));
  const model = parseUrdf(await readFile(example("spidey/spidey.urdf"), "utf8"));
  const bounds = async (name: string) => {
    const data = await readFile(example(`spidey/meshes/${name}.stl`));
    const vertices = stlVertices(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    assert.ok(Array.from(vertices).every(Number.isFinite));
    return [0, 1, 2].map((axis) => {
      const values = Array.from(vertices).filter((_, i) => i % 3 === axis).map((value) => value * 1000);
      return [Math.min(...values), Math.max(...values)];
    });
  };
  const pcb = await bounds("controller");
  const expected = [[-24.13, 24.13], [21.5, 23.1], [42.8, 68.2]];
  for (const axis of [0, 1, 2]) for (const end of [0, 1]) assert.ok(Math.abs(pcb[axis][end] - expected[axis][end]) < 1e-4);
  const body = model.links.find((link) => link.name === "body")!;
  assert.ok(body.visuals.some((visual) => visual.name === "controller"));
  const boardCollision = body.collisions.find((collision) => collision.geometry.type === "box" && Math.abs(collision.origin.position[1] - 0.0213) < 1e-8)!;
  assert.ok(boardCollision);
  if (boardCollision.geometry.type === "box") {
    for (const axis of [0, 1, 2]) {
      const center = boardCollision.origin.position[axis] * 1000;
      const halfSize = boardCollision.geometry.size[axis] * 500;
      assert.ok(pcb[axis][0] >= center - halfSize - 1e-4 && pcb[axis][1] <= center + halfSize + 1e-4);
    }
  }
  for (const side of ["servo-left", "servo-right", "servo-tilt"]) {
    const casing = await bounds(side);
    assert.ok(casing[1][1] < 16.3, "Rearward header tips clear the fixed servo casings");
  }
  for (const entity of project.entities.filter((entity: { id: string }) => entity.id.startsWith("controller-pin-"))) {
    const pin = await bounds(entity.id);
    assert.ok(Math.abs(pin[1][0] - 16.3) < 1e-4);
    assert.ok(Math.abs(pin[1][1] - 24.6) < 1e-4);
    for (const axis of [0, 2]) assert.ok(Math.abs((pin[axis][0] + pin[axis][1]) / 2 - entity.metadata.padPosition[axis]) < 1e-4);
    assert.ok(Math.abs(entity.metadata.padPosition[1] - 24.6) < 1e-8);
  }
  const module = await bounds("controller-module");
  assert.ok(module[1][0] >= pcb[1][1] - 1e-4 && module[1][1] > pcb[1][1], "Components face outward +Y");
  const antenna = await bounds("controller-antenna");
  const usb = await bounds("controller-usb");
  assert.ok(antenna[0][0] > 0 && usb[0][1] < 0, "Landscape board has antenna +X and USB -X");
});
