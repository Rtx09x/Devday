import assert from "node:assert/strict";
import test from "node:test";
import { createRobotSimulation, parseUrdf } from "../src/index.js";
const inertial =
  '<inertial><mass value="1"/><inertia ixx="0.01" ixy="0" ixz="0" iyy="0.01" iyz="0" izz="0.01"/></inertial>';
const box = (name: string) =>
  `<link name="${name}">${inertial}<visual><geometry><box size="0.1 0.1 0.1"/></geometry></visual><collision><geometry><box size="0.1 0.1 0.1"/></geometry></collision></link>`;
const articulated = (type = "revolute", rpy = "0 0 0", axis = "0 0 1") =>
  `<robot name="arm">${box("base")}${box("tip")}<joint name="joint" type="${type}"><parent link="base"/><child link="tip"/><origin xyz="0 0 0.3" rpy="${rpy}"/><axis xyz="${axis}"/><limit lower="-0.5" upper="0.5"/></joint></robot>`;
test("URDF validates connected trees, numeric values and physical inertia", () => {
  for (const xml of [
    "<robot/>",
    articulated("floating"),
    articulated().replace("0 0 1", "0 0 0"),
    articulated().replace('upper="0.5"', 'upper="-1"'),
    articulated().replace('ixx="0.01"', 'ixx="-1"'),
    articulated().replace('<parent link="base"/>', '<parent link="missing"/>'),
    `<robot name="x">${box("a")}${box("b")}</robot>`,
  ])
    assert.throws(() => parseUrdf(xml));
  assert.equal(parseUrdf(articulated()).units, "m-kg-s-rad");
  assert.throws(() => parseUrdf('<!DOCTYPE robot><robot name="x"/>'));
});
test("real gravity free fall and ground contacts settle", async () => {
  const sim = await createRobotSimulation(
    parseUrdf(`<robot name="drop">${box("box")}</robot>`),
    { position: [0, 0, 1] },
  );
  try {
    const early = sim.step(12);
    assert.ok(early.links.box.position[2] < 0.97);
    assert.ok(early.links.box.position[2] > 0.9);
    const settled = sim.step(600);
    assert.ok(Math.abs(settled.links.box.position[2] - 0.05) < 0.003);
    assert.ok(settled.contacts > 0);
  } finally {
    sim.dispose();
  }
});
test("fixed base and physical fixed joint preserve authored frames", async () => {
  const sim = await createRobotSimulation(
    parseUrdf(articulated("fixed", "0.2 0.3 0.4")),
    { fixedBase: true, ground: false },
  );
  try {
    const s = sim.step(300);
    assert.ok(Math.abs(s.links.base.position[2]) < 1e-6);
    assert.ok(Math.abs(s.links.tip.position[2] - 0.3) < 0.001);
    assert.ok(Math.abs(s.links.tip.quaternion[0]) > 0.05);
    assert.throws(() => sim.setJointTarget("joint", 0));
  } finally {
    sim.dispose();
  }
});
test("revolute motor obeys target bounds and physical constraint", async () => {
  const sim = await createRobotSimulation(parseUrdf(articulated()), {
    fixedBase: true,
    ground: false,
  });
  try {
    sim.setJointTarget("joint", 2);
    const s = sim.step(900);
    assert.equal(s.joints.joint.target, 0.5);
    assert.ok(s.joints.joint.position > 0.45 && s.joints.joint.position < 0.51);
    assert.ok(Math.abs(s.links.tip.position[2] - 0.3) < 0.002);
  } finally {
    sim.dispose();
  }
});
test("rotated joint axes and prismatic motion follow URDF origin", async () => {
  const sim = await createRobotSimulation(
    parseUrdf(articulated("prismatic", "0 0 1.5707963267948966", "1 0 0")),
    { fixedBase: true, ground: false, gravity: [0, 0, 0] },
  );
  try {
    sim.setJointTarget("joint", 0.2);
    const s = sim.step(900);
    assert.ok(Math.abs(s.links.tip.position[0]) < 0.002);
    assert.ok(Math.abs(s.links.tip.position[1] - 0.2) < 0.01);
    assert.ok(Math.abs(s.joints.joint.position - 0.2) < 0.01);
  } finally {
    sim.dispose();
  }
});
test("reset reproduces physical trajectory and disposal guards use", async () => {
  const sim = await createRobotSimulation(
    parseUrdf(`<robot name="drop">${box("box")}</robot>`),
    { position: [0, 0, 1] },
  );
  const first = sim.step(30);
  assert.equal(sim.reset().time, 0);
  const second = sim.step(30);
  assert.deepEqual(second, first);
  sim.dispose();
  sim.dispose();
  assert.throws(() => sim.step());
});
test("revolute origin orientation and continuous periodic targets are explicit", async () => {
  for (const type of ["revolute", "continuous"]) {
    const sim = await createRobotSimulation(
      parseUrdf(articulated(type, "0 0 1.5707963267948966", "1 0 0")),
      { fixedBase: true, ground: false, gravity: [0, 0, 0] },
    );
    try {
      sim.setJointTarget(
        "joint",
        type === "continuous" ? Math.PI * 2 + 0.3 : 0.3,
      );
      const s = sim.step(600);
      assert.ok(Math.abs(s.joints.joint.position - 0.3) < 0.01);
      assert.ok(Math.abs(s.links.tip.position[2] - 0.3) < 0.001);
      if (type === "continuous")
        assert.ok(
          sim.diagnostics.some((x) => x.code === "continuous-position-motor"),
        );
    } finally {
      sim.dispose();
    }
  }
});
test("local STL collision hull really contacts ground; unsafe paths reject", async () => {
  const vertices = [
    [0, 0, 0],
    [0.1, 0, 0],
    [0, 0.1, 0],
    [0, 0, 0.1],
  ];
  const stl =
    "solid tetra\n" +
    [
      [0, 2, 1],
      [0, 1, 3],
      [0, 3, 2],
      [1, 2, 3],
    ]
      .map(
        (face) =>
          "facet normal 0 0 0\nouter loop\n" +
          face.map((i) => "vertex " + vertices[i].join(" ")).join("\n") +
          "\nendloop\nendfacet",
      )
      .join("\n") +
    "\nendsolid";
  const xml = `<robot name="mesh"><link name="mesh">${inertial}<collision><geometry><mesh filename="meshes/tetra.stl"/></geometry></collision></link></robot>`;
  assert.equal(
    parseUrdf(xml.replace("meshes/tetra.stl", "../meshes/tetra.stl")).links[0]
      .collisions[0].geometry.type,
    "mesh",
  );
  assert.throws(() =>
    parseUrdf(xml.replace("meshes/tetra.stl", "https://example.com/a.stl")),
  );
  const sim = await createRobotSimulation(parseUrdf(xml), {
    position: [0, 0, 0.5],
    meshResolver: async () => new TextEncoder().encode(stl).buffer,
  });
  try {
    assert.ok(sim.diagnostics.some((x) => x.code === "convex-mesh-collision"));
    const s = sim.step(600);
    assert.ok(s.contacts > 0);
    assert.ok(s.links.mesh.position[2] < 0.1);
  } finally {
    sim.dispose();
  }
});
test("ROS local resources allow DAE visuals plus STL collision physics", async () => {
  const stl =
    "solid tetra\n" +
    [
      [
        [0, 0, 0],
        [0, 0.1, 0],
        [0.1, 0, 0],
      ],
      [
        [0, 0, 0],
        [0.1, 0, 0],
        [0, 0, 0.1],
      ],
      [
        [0, 0, 0],
        [0, 0, 0.1],
        [0, 0.1, 0],
      ],
      [
        [0.1, 0, 0],
        [0, 0.1, 0],
        [0, 0, 0.1],
      ],
    ]
      .map(
        (face) =>
          "facet normal 0 0 0\nouter loop\n" +
          face.map((p) => `vertex ${p.join(" ")}`).join("\n") +
          "\nendloop\nendfacet",
      )
      .join("\n") +
    "\nendsolid";
  for (const resource of [
    "package://test_robot/meshes/body%20one",
    "../meshes/body%20one",
    "./meshes/body one",
  ]) {
    const visual = `<visual><geometry><mesh filename="${resource}.dae"/></geometry></visual>`;
    const collision = `<collision><geometry><mesh filename="${resource}.stl"/></geometry></collision>`;
    const xml = `<robot name="ros_local"><link name="body">${inertial}${visual}${collision}</link></robot>`;
    const requested: string[] = [];
    const sim = await createRobotSimulation(parseUrdf(xml), {
      position: [0, 0, 0.5],
      meshResolver: async (filename) => {
        requested.push(filename);
        return new TextEncoder().encode(stl).buffer;
      },
    });
    try {
      assert.deepEqual(requested, [`${resource}.stl`]);
      assert.ok(sim.step(600).contacts > 0);
    } finally {
      sim.dispose();
    }
    const visualOnly = parseUrdf(xml.replace(collision, ""));
    assert.ok(
      visualOnly.diagnostics.some(
        (d) => d.code === "unsupported-collision-mesh",
      ),
    );
    await assert.rejects(
      createRobotSimulation(visualOnly),
      /collision physics requires STL meshes/,
    );
  }
  for (const filename of [
    "https://example.com/a.stl",
    "http://example.com/a.dae",
    "file:///tmp/a.stl",
    "/tmp/a.stl",
    "C:/a.stl",
    "meshes/a.stl?download=1",
    "meshes/a%23part.stl",
    "meshes/a%00.stl",
    "meshes/a%5cb.stl",
    "package:///absolute.stl",
    "bad%encoding.stl",
    "meshes/body.obj",
  ]) {
    assert.throws(
      () =>
        parseUrdf(
          `<robot name="invalid"><link name="body"><visual><geometry><mesh filename="${filename}"/></geometry></visual></link></robot>`,
        ),
      filename,
    );
  }
});
