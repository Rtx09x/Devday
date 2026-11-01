import {
  makeBox,
  makeCylinder,
  makeEllipsoid,
  makeCompound,
  makeCircle,
  makeLine,
  makeBezierCurve,
  assembleWire,
  genericSweep,
} from "replicad";

// Photo-informed reconstruction in millimetres, Z up. Dimensions are estimates,
// scaled from a nominal 23 × 12 × 29 mm SG90. See docs/model-reference.md.
// Exactly three actuators: each side drives its front/hind wire pair; the
// horizontal centre shaft tilts both middle legs. NodeMCU is placed behind the cluster; its mounting is an estimate.
export const defaultParams = {
  wireRadius: 0.55,
  bodyWidth: 38,
  bodyHeight: 43,
  legSpan: 246,
  stanceLength: 206,
  kneeHeight: 109,
};

export default function main(p) {
  const result = [];
  const halfSpacing = (p.bodyWidth - 12) / 2;
  const base = p.bodyHeight;
  // Rotating the 25.5 mm casing onto its side changes its depth. Put its
  // forward blue face at Y=-11.5, flush with the two upright blue casings.
  const tiltOffsetY = 25.5 - 11.5;
  const tiltShiftY = tiltOffsetY - 5;
  const add = (name, shape, color, opacity = 1) =>
    result.push({ name, shape, color, opacity });
  // A circular profile swept along a real OCCT wire; bends retain straight
  // steel runs instead of a Catmull-Rom approximation or floating cylinders.
  const pipe = (pts, radius, smooth = false) => {
    const tangent = pts[1].map((v, i) => v - pts[0][i]);
    const spine = assembleWire(
      smooth
        ? [makeBezierCurve(pts)]
        : pts.slice(1).map((pt, i) => makeLine(pts[i], pt)),
    );
    return genericSweep(
      assembleWire([makeCircle(radius, pts[0], tangent)]),
      spine,
      { transitionMode: "round" },
    );
  };
  const mount = (shape, side) =>
    side === 0
      ? shape
          .rotate(90, [0, 0, 0], [1, 0, 0])
          .translate([0, tiltOffsetY, base + 12])
      : shape.translate([side * halfSpacing, 0, base]);
  const localHorn = () => {
    let h = makeBox([-11.5, -2, 29], [11.5, 2, 30.5])
      .fuse(makeBox([-2, -10, 29], [2, 10, 30.5]))
      .fuse(makeCylinder(3.1, 2.3, [0, 0, 28.8]));
    for (const pt of [
      [8, 0],
      [-8, 0],
      [0, 7],
      [0, -7],
    ])
      h = h.cut(makeCylinder(0.65, 3, [pt[0], pt[1], 28.5]));
    return h;
  };
  for (const [label, side] of [
    ["left", -1],
    ["right", 1],
    ["tilt", 0],
  ]) {
    // Three stepped blue mouldings, seam ledges and a round output bearing.
    const shell = makeCompound([
      makeBox([-6, -11.5, 0], [6, 11.5, 3]),
      makeBox([-5.8, -11.3, 3.25], [5.8, 11.3, 22.7]),
      makeBox([-6, -11.5, 23], [6, 11.5, 25.5]),
      makeCylinder(5.3, 2, [0, 5.5, 25.5]),
      makeCylinder(2.5, 1.4, [0, 5.5, 27.5]),
      // Small remaining moulded tabs; the photographed build has no platform.
      makeBox([-4, -13.2, 2], [4, -11.5, 3.5]),
      makeBox([-4, 11.5, 2], [4, 13.2, 3.5]),
    ]);
    add(`servo-${label}`, mount(shell, side), "#184fc1", 0.96);
    const lid = makeCompound([
      makeBox([-5.7, -11.2, 22.7], [5.7, 11.2, 23]),
      makeBox([-5.7, -11.2, 3], [5.7, 11.2, 3.25]),
      makeCylinder(3, 0.8, [0, 5.5, 28.4]),
    ]);
    add(`servo-${label}-seams`, mount(lid, side), "#103887");
    let horn = localHorn();
    if (side) horn = horn.rotate(side * 45, [0, 0, 0], [0, 0, 1]);
    horn = horn.translate([0, 5.5, 0]);
    add(`horn-${label}`, mount(horn, side), "#f1efdf");
    const screw = makeCylinder(1.35, 0.7, [0, 5.5, 30.8]).cut(
      makeBox([-0.25, 4.2, 31.1], [0.25, 6.8, 31.6]),
    );
    add(`horn-${label}-screw`, mount(screw, side), "#b3b5b2");
    const glue = makeCompound([
      makeEllipsoid(5.6, 3.2, 1.6).translate([0, 5.5, 32]),
      makeEllipsoid(3.7, 2.7, 1.5).translate([4.4, 6.8, 31.7]),
      makeEllipsoid(2.7, 3, 1.8).translate([-4.2, 4.7, 31.8]),
      makeEllipsoid(1.9, 2, 1.2).translate([7, 6.4, 31.4]),
    ]);
    add(`glue-${label}`, mount(glue, side), "#e3eced", 0.6);
  }
  for (const [label, side] of [
    ["left", -1],
    ["right", 1],
  ]) {
    const x = side * halfSpacing;
    for (const [index, fore] of [
      [1, -1],
      [3, 1],
    ]) {
      const pts = [
        [x, 5.5, base + 32],
        [x + side * 13, 5.5 + fore * 11, base + 32],
        [side * 42, fore * 26, p.kneeHeight - 15],
        [side * 56, fore * 43, p.kneeHeight],
        [side * (p.legSpan / 2 - 10), (fore * p.stanceLength) / 2, 1.2],
      ];
      const id = `leg-${label}-${index}`;
      add(id, pipe(pts, p.wireRadius), "#b9c6d0");
      add(
        `foot-${label}-${index}`,
        makeEllipsoid(1.3, 1.7, 1.1).translate(pts[pts.length - 1]),
        "#d2e0e3",
        0.65,
      );
    }
    const pts = [
      [0, -27.2 + tiltShiftY, base + 17.5],
      [side * 28, -27.2 + tiltShiftY, base + 16.2],
      [side * 35, -24 + tiltShiftY, base + 18],
      [side * 59, -8, p.kneeHeight - 18],
      [(side * p.legSpan) / 2, 1, 1.2],
    ];
    add(`leg-${label}-2`, pipe(pts, p.wireRadius), "#b9c6d0");
    add(
      `foot-${label}-2`,
      makeEllipsoid(1.3, 1.7, 1.1).translate(pts[pts.length - 1]),
      "#d2e0e3",
      0.65,
    );
  }
  // NodeMCU DevKit v1.0 / ESP-12E (firmware board=nodemcuv2).
  // Local board frame: antenna +Y, USB -Y; rigid rear mounting below
  // maps antenna to world +X and USB to -X. Full upstream 2 x 15 pin order,
  // 2.54 mm pitch, 22.86 mm row spacing. Envelope/placement are estimates.
  const boardY = 42;
  const boardZ = base + 9;
  // The PCB lies in the rear XZ plane, landscape across the servo backs.
  // Its components face outward (+Y); header tails clear the servo cases.
  const rearY = 21.5;
  const rearZ = base + 12.5;
  const controllerPoint = ([x, y, z]) => [y - boardY, rearY + z - boardZ, rearZ + x];
  const mountController = (shape) => shape
    .rotate(-90, [0, boardY, boardZ], [0, 1, 0])
    .rotate(-90, [0, boardY, boardZ], [0, 0, 1])
    .translate([0, rearY - boardY, rearZ - boardZ]);
  const addController = (name, shape, color) => add(name, mountController(shape), color);
  const railPoint = (point) => {
    const [x, y, z] = controllerPoint(point);
    return [x - 30, y, z - 23.5];
  };
  const addRail = (name, shape, color) => add(name, mountController(shape).translate([-30, 0, -23.5]), color);
  const at = (x, y, z = 0) => [x, boardY + y, boardZ + z];
  const box = (a, b) => makeBox(at(...a), at(...b));
  let pcb = box([-12.7, -24.13, 0], [12.7, 24.13, 1.6]);
  for (const x of [-11.43, 11.43])
    for (const y of [-21, 21]) pcb = pcb.cut(makeCylinder(1.25, 2, at(x, y, -0.2)));
  addController("controller", pcb, "#183c32");
  addController("controller-module", makeCompound([
    box([-8, 4, 1.6], [8, 23, 2.5]),
    box([-7.7, 4.5, 2.5], [7.7, 16.5, 4.8]),
  ]), "#b9bdbe");
  addController("controller-antenna", makeCompound([
    box([-8, 16.5, 2.5], [8, 23, 2.8]),
  ]), "#242824");
  const antenna = [];
  for (let i = 0; i < 5; i++) {
    antenna.push(box([-6 + i * 2.6, 17.3, 2.8], [-5.7 + i * 2.6, 22, 2.95]));
    if (i < 4) antenna.push(box([-6 + i * 2.6, i % 2 ? 17.3 : 21.7, 2.8], [-3.1 + i * 2.6, i % 2 ? 17.6 : 22, 2.95]));
  }
  addController("controller-antenna-trace", makeCompound(antenna), "#d5ad53");
  addController("controller-usb", box([-4, -25, 1.6], [4, -19, 4.6]).cut(box([-3.2, -25.2, 2], [3.2, -22, 4])), "#b4bac0");
  addController("controller-components", makeCompound([
    box([-3, -13, 1.6], [3, -7, 3]),
    box([-7, -19, 1.6], [-3, -15, 3.4]),
    box([-7, -3, 1.6], [-3, 2, 3.2]),
    box([4, -18, 1.6], [7, -14, 3.6]),
    box([-7, -23, 1.6], [-4.5, -20, 3]),
    box([4.5, -23, 1.6], [7, -20, 3]),
  ]), "#262b2e");
  const rows = [
    [-1, ["A0", "RSV1", "RSV2", "SD3", "SD2", "SD1", "CMD", "SD0", "CLK", "GND-L1", "3V3-L", "EN", "RST", "GND-L2", "VIN"]],
    [1, ["D0", "D1", "D2", "D3", "D4", "3V3-R1", "GND-R1", "D5", "D6", "D7", "D8", "RX", "TX", "GND-R2", "3V3-R2"]],
  ];
  const pads = {};
  const headerBodies = [];
  for (const [side, names] of rows) {
    headerBodies.push(box([side * 11.43 - 1.25, -19.03, -2.5], [side * 11.43 + 1.25, 19.03, 0]));
    names.forEach((name, index) => {
      const x = side * 11.43, y = 17.78 - index * 2.54;
      pads[name] = controllerPoint(at(x, y, 3.1));
      addController(`controller-pin-${name}`, makeCompound([
        makeCylinder(0.85, 0.15, at(x, y, 1.6)),
        box([x - 0.32, y - 0.32, -5.2], [x + 0.32, y + 0.32, 3.1]),
      ]), ["D5", "D6", "D7"].includes(name) ? "#efb64f" : "#c8b36f");
    });
  }
  addController("controller-headers", makeCompound(headerBodies), "#1d2327");
  // Small code-native silkscreen glyphs; labels sit beside their physical pads.
  const glyphs = {
    D: ["110", "101", "101", "101", "110"],
    G: ["011", "100", "101", "101", "011"],
    N: ["101", "111", "111", "111", "101"],
    V: ["101", "101", "101", "101", "010"],
    I: ["111", "010", "010", "010", "111"],
    "3": ["110", "001", "010", "001", "110"],
    "5": ["111", "100", "110", "001", "110"],
    "6": ["011", "100", "110", "101", "010"],
    "7": ["111", "001", "010", "010", "010"],
  };
  const ink = [];
  const text = (word, x, y) => [...word].forEach((letter, i) => {
    glyphs[letter].forEach((line, row) => [...line].forEach((bit, col) => {
      if (bit === "1") ink.push(box([x + (i * 4 + col) * 0.27, y - row * 0.27, 1.62], [x + (i * 4 + col) * 0.27 + 0.23, y - row * 0.27 + 0.23, 1.69]));
    }));
  });
  text("D5", 6.6, 0.55); text("D6", 6.6, -1.99); text("D7", 6.6, -4.53);
  text("GND", 5.5, 3.09); text("3V3", 5.5, 5.63); text("VIN", -8.9, -17.23);
  addController("controller-labels", makeCompound(ink), "#f2f0d9");
  // Separate external regulated servo rail: never from NodeMCU 3V3/VIN.
  const railZ = boardZ + 2;
  addRail("power-bus", makeBox([20, 32, boardZ], [27, 46, railZ + 2]), "#293038");
  const railPads = [];
  for (let i = 0; i < 3; i++) for (const x of [22, 25])
    railPads.push(makeCylinder(0.8, 0.5, [x, 34 + i * 4, railZ + 2]));
  addRail("power-bus-pads", makeCompound(railPads), "#c8b36f");
  for (const [i, label] of ["left", "tilt", "right"].entries()) {
    const x = (i - 1) * halfSpacing;
    const pin = { left: "D5", right: "D6", tilt: "D7" }[label];
    for (const [n, color] of ["#8a492b", "#d44428", "#ed922f"].entries()) {
      const end = n === 2 ? pads[pin] : railPoint([n === 0 ? 25 : 22, 34 + i * 4, railZ + 2.5]);
      const pts = [
        [x + (n - 1) * 1.05, label === "tilt" ? tiltOffsetY : 10, base + 3],
        [x + (n - 1) * 1.05, 23, base + 1],
        [end[0] + (i - 1) * 2, end[1] - 5, end[2] + 6], end,
      ];
      add(`cable-${label}-${n}`, pipe(pts, 0.42, true), color);
    }
    const end = pads[pin];
    add(`plug-${label}`, makeBox([end[0] - 0.95, end[1] - 0.2, end[2] - 0.95], [end[0] + 0.95, end[1] + 2, end[2] + 0.95]), "#282d31");
  }
  add("controller-common-ground", pipe([pads["GND-R1"], [-8, rearY + 8.5, base + 30], [-26, rearY + 8.5, base + 22], railPoint([25, 42, railZ + 2.5])], 0.42, true), "#8a492b");
  // Small hot-glue seam binding cases, not a fabricated chassis.
  add(
    "body",
    makeCompound([
      makeEllipsoid(1.2, 8, 2).translate([-6.5, -5, base + 15]),
      makeEllipsoid(1.2, 8, 2).translate([6.5, -5, base + 15]),
    ]),
    "#dbe6e8",
    0.55,
  );
  return result;
}
