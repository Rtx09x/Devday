import { XMLParser, XMLValidator } from "fast-xml-parser";
import { identity, principalInertia, rpy } from "./math.js";
import type {
  Diagnostic,
  Geometry,
  RobotJoint,
  RobotLink,
  RobotModel,
  RobotShape,
  Transform,
  Vec3,
} from "./types.js";
const list = (x: any): any[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
function number(x: unknown, label: string, positive = false): number {
  const n = Number(x);
  if (
    x === undefined ||
    x === "" ||
    !Number.isFinite(n) ||
    (positive && n <= 0)
  )
    throw new Error(
      `${label} must be a ${positive ? "positive " : ""}finite number`,
    );
  return n;
}
function vector(x: unknown, label: string, fallback?: Vec3): Vec3 {
  if (x === undefined && fallback) return [...fallback];
  const a = String(x).trim().split(/\s+/);
  if (a.length !== 3) throw new Error(`${label} requires three numbers`);
  return a.map((v) => number(v, label)) as Vec3;
}
function origin(x: any): Transform {
  return x
    ? {
        position: vector(x.xyz, "origin xyz", [0, 0, 0]),
        quaternion: rpy(vector(x.rpy, "origin rpy", [0, 0, 0])),
      }
    : identity();
}
function name(x: any, label: string): string {
  if (typeof x !== "string" || !x.trim())
    throw new Error(`${label} requires a name`);
  return x;
}
function geometry(g: any): Geometry {
  if (!g || Object.keys(g).length !== 1)
    throw new Error("Each geometry requires exactly one supported shape");
  if (g.box) {
    const size = vector(g.box.size, "box size");
    if (size.some((n) => n <= 0)) throw new Error("box size must be positive");
    return { type: "box", size };
  }
  if (g.sphere)
    return {
      type: "sphere",
      radius: number(g.sphere.radius, "sphere radius", true),
    };
  if (g.cylinder)
    return {
      type: "cylinder",
      radius: number(g.cylinder.radius, "cylinder radius", true),
      length: number(g.cylinder.length, "cylinder length", true),
    };
  if (g.mesh) {
    const filename = name(g.mesh.filename, "mesh filename");
    let decoded: string;
    try {
      decoded = decodeURIComponent(filename);
    } catch {
      throw new Error("Mesh filename contains invalid percent encoding");
    }
    // The project resolver knows the URDF location and enforces filesystem
    // confinement. Parent-relative paths and ROS package resources are valid
    // here; this parser cannot decide their project-relative location.
    const resource = decoded.startsWith("package://")
      ? decoded.slice("package://".length)
      : decoded;
    if (
      resource.startsWith("/") ||
      /[:?#\\\x00-\x1f]/.test(resource) ||
      !resource ||
      (decoded.startsWith("package://") && !/^[^/]+\/.+/.test(resource))
    )
      throw new Error(
        "Mesh must use a project-local relative or package:// resource without absolute paths, remote schemes, queries or control characters",
      );
    if (!/\.(stl|dae)$/i.test(resource))
      throw new Error(
        "Unsupported mesh format; visual meshes support STL and DAE, collision physics supports STL",
      );
    const scale = vector(g.mesh.scale, "mesh scale", [1, 1, 1]);
    if (scale.some((x) => x <= 0))
      throw new Error("mesh scale must be positive");
    return { type: "mesh", filename, scale };
  }
  throw new Error(`Unsupported URDF geometry: ${Object.keys(g).join(", ")}`);
}
/** Strict tree and numeric validation before creating any physics resources. */
export function parseUrdf(xml: string): RobotModel {
  if (
    typeof xml !== "string" ||
    new TextEncoder().encode(xml).byteLength > 1_048_576
  )
    throw new Error("URDF must be XML text at most 1 MiB");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("URDF DTD and entity declarations are unsupported");
  const validation = XMLValidator.validate(xml);
  if (validation !== true)
    throw new Error(`Invalid URDF XML: ${validation.err.msg}`);
  const parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      parseAttributeValue: false,
      parseTagValue: false,
      trimValues: true,
    }).parse(xml),
    r = parsed.robot;
  if (!r || Array.isArray(r))
    throw new Error("URDF requires one robot element");
  if (list(r.link).length > 128 || list(r.joint).length > 127)
    throw new Error("URDF supports at most 128 links and 127 joints");
  const diagnostics: Diagnostic[] = [];
  const warn = (code: string, message: string) =>
    diagnostics.push({ severity: "warning", code, message });
  if (r.cutucircuits?.assumptions)
    warn("model-assumptions", String(r.cutucircuits.assumptions));
  const materials = new Map<string, any>();
  for (const m of list(r.material)) if (m.name) materials.set(m.name, m);
  function shapes(values: any): RobotShape[] {
    return list(values).map((s) => {
      const mat = s.material
        ? { ...materials.get(s.material.name), ...s.material }
        : undefined;
      let color: [number, number, number, number] | undefined;
      if (mat?.color?.rgba !== undefined) {
        const a = String(mat.color.rgba)
          .split(/\s+/)
          .map((x: string) => number(x, "material rgba"));
        if (a.length !== 4 || a.some((x: number) => x < 0 || x > 1))
          throw new Error("material rgba requires four values between 0 and 1");
        color = a as typeof color;
      }
      if (mat?.texture)
        warn(
          "texture-unsupported",
          "Texture materials are visual-only and are not loaded by the physics core",
        );
      return {
        name: s.name,
        origin: origin(s.origin),
        geometry: geometry(s.geometry),
        ...(mat ? { material: { name: mat.name, color } } : {}),
      };
    });
  }
  const links: RobotLink[] = list(r.link).map((l) => {
    const link: RobotLink = {
      name: name(l.name, "link"),
      visuals: shapes(l.visual),
      collisions: shapes(l.collision),
    };
    if (l.inertial) {
      const i = l.inertial;
      if (!i.inertia)
        throw new Error(`Link ${link.name} inertial requires a tensor`);
      const inertia = ["ixx", "ixy", "ixz", "iyy", "iyz", "izz"].map((k) =>
        number(i.inertia[k], `${link.name} ${k}`),
      ) as [number, number, number, number, number, number];
      principalInertia(inertia);
      link.inertial = {
        mass: number(i.mass?.value, `${link.name} mass`, true),
        origin: origin(i.origin),
        inertia,
      };
    } else
      warn(
        "estimated-inertia",
        `Link ${link.name}: missing inertial; simulation estimates 1 kg and shape-derived inertia`,
      );
    const physicsShapes = link.collisions.length
      ? link.collisions
      : link.visuals;
    if (
      physicsShapes.some(
        (shape) =>
          shape.geometry.type === "mesh" &&
          !/\.stl$/i.test(decodeURIComponent(shape.geometry.filename)),
      )
    )
      warn(
        "unsupported-collision-mesh",
        `Link ${link.name}: DAE is visual-only; author primitive or STL collision geometry before physics simulation`,
      );
    else if (!link.collisions.length && link.visuals.length)
      warn(
        "estimated-collision",
        `Link ${link.name}: missing collision; simulation uses visual geometry as collision approximation`,
      );
    if (!link.collisions.length && !link.visuals.length)
      warn(
        "no-collision",
        `Link ${link.name}: no collision geometry; simulation cannot contact this link`,
      );
    return link;
  });
  if (!links.length) throw new Error("URDF requires at least one link");
  const names = new Set(links.map((l) => l.name));
  if (names.size !== links.length) throw new Error("Duplicate link names");
  const joints: RobotJoint[] = list(r.joint).map((j) => {
    if (!["fixed", "revolute", "continuous", "prismatic"].includes(j.type))
      throw new Error(
        `Unsupported joint type ${j.type}; supported: fixed, revolute, continuous, prismatic`,
      );
    if (
      j.mimic !== undefined ||
      j.safety_controller !== undefined ||
      j.calibration !== undefined
    )
      throw new Error(
        `Joint ${j.name}: mimic, safety_controller and calibration are unsupported`,
      );
    const axis = vector(j.axis?.xyz, "joint axis", [1, 0, 0]),
      length = Math.hypot(...axis);
    if (length < 1e-10)
      throw new Error(`Joint ${j.name}: axis must be nonzero`);
    const joint: RobotJoint = {
      name: name(j.name, "joint"),
      type: j.type,
      parent: name(j.parent?.link, "joint parent"),
      child: name(j.child?.link, "joint child"),
      origin: origin(j.origin),
      axis: axis.map((n) => n / length) as Vec3,
    };
    if (!names.has(joint.parent) || !names.has(joint.child))
      throw new Error(`Joint ${joint.name}: unknown link`);
    if (joint.parent === joint.child)
      throw new Error("Joint cannot connect a link to itself");
    if (j.type === "revolute" || j.type === "prismatic") {
      const lower = number(j.limit?.lower, `${j.name} lower limit`),
        upper = number(j.limit?.upper, `${j.name} upper limit`);
      if (lower > upper)
        throw new Error("Joint lower limit exceeds upper limit");
      joint.limit = { lower, upper };
      if (lower > 0 || upper < 0)
        warn(
          "initial-limit",
          `Joint ${j.name}: zero initial position is outside limits; physics will resolve it`,
        );
    }
    if (j.type === "continuous")
      warn(
        "continuous-position-motor",
        `Joint ${j.name}: angle is reported modulo 2π and position targets are normalized to one revolution; multi-turn servo control is not modeled`,
      );
    if (j.limit) {
      const effort =
          j.limit.effort === undefined
            ? undefined
            : number(j.limit.effort, `${j.name} effort`, true),
        velocity =
          j.limit.velocity === undefined
            ? undefined
            : number(j.limit.velocity, `${j.name} velocity`, true);
      if (joint.limit) {
        joint.limit.effort = effort;
        joint.limit.velocity = velocity;
      }
      if (effort !== undefined || velocity !== undefined)
        warn(
          "actuator-model",
          `Joint ${j.name}: URDF effort/velocity ratings are metadata; position motors do not model servo torque saturation or speed ratings`,
        );
    }
    if (j.dynamics !== undefined)
      warn(
        "joint-dynamics",
        `Joint ${j.name}: URDF joint friction/damping are not applied; physics motor damping is configured separately`,
      );
    return joint;
  });
  if (new Set(joints.map((j) => j.name)).size !== joints.length)
    throw new Error("Duplicate joint names");
  const parents = new Map<string, RobotJoint>();
  for (const j of joints) {
    if (parents.has(j.child))
      throw new Error(`Link ${j.child} has multiple parents`);
    parents.set(j.child, j);
  }
  const roots = links.filter((l) => !parents.has(l.name));
  if (roots.length !== 1)
    throw new Error("URDF must form one connected tree with exactly one root");
  const seen = new Set<string>();
  function visit(n: string) {
    if (seen.has(n)) throw new Error("URDF joint cycle");
    seen.add(n);
    for (const j of joints.filter((j) => j.parent === n)) visit(j.child);
  }
  visit(roots[0].name);
  if (seen.size !== links.length)
    throw new Error("URDF contains a disconnected cycle");
  for (const feature of ["gazebo", "transmission"])
    if (r[feature] !== undefined)
      warn(
        "unsupported-extension",
        `${feature} extension is metadata only; plugins and transmissions are not executed`,
      );
  return {
    name: name(r.name, "robot"),
    root: roots[0].name,
    links,
    joints,
    diagnostics,
    units: "m-kg-s-rad",
  };
}
