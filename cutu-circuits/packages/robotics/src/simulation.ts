import RAPIER from "@dimforge/rapier3d-compat";
import {
  add,
  compose,
  dot,
  identity,
  inverse,
  mul,
  principalInertia,
  rotate,
  sub,
} from "./math.js";
import { stlVertices } from "./stl.js";
import type {
  Diagnostic,
  Quat,
  RobotModel,
  RobotSimulation,
  RobotSnapshot,
  SimulationOptions,
  Transform,
  Vec3,
} from "./types.js";
const v = (a: Vec3) => ({ x: a[0], y: a[1], z: a[2] });
const q = (a: Quat) => ({ x: a[0], y: a[1], z: a[2], w: a[3] });
const tuple = (a: { x: number; y: number; z: number }): Vec3 => [a.x, a.y, a.z];
const quat = (a: { x: number; y: number; z: number; w: number }): Quat => [
  a.x,
  a.y,
  a.z,
  a.w,
];
let initialized: Promise<void> | undefined;
/** Real Rapier rigid-body/contact simulation. No measured robot state or hardware commands. */
export async function createRobotSimulation(
  model: RobotModel,
  options: SimulationOptions = {},
): Promise<RobotSimulation> {
  initialized ??= RAPIER.init();
  await initialized;
  const timestep = options.timestep ?? 1 / 120;
  if (!Number.isFinite(timestep) || timestep < 1 / 1000 || timestep > 1 / 30)
    throw new Error("timestep must be between 0.001 and 1/30 seconds");
  const gravity = options.gravity ?? [0, 0, -9.81],
    position = options.position ?? [0, 0, 0];
  if ([...gravity, ...position].some((n) => !Number.isFinite(n)))
    throw new Error("Gravity and position must be finite");
  const stiffness = options.motorStiffness ?? 10000,
    damping = options.motorDamping ?? 200;
  if (
    !Number.isFinite(stiffness) ||
    stiffness <= 0 ||
    !Number.isFinite(damping) ||
    damping < 0
  )
    throw new Error("Motor stiffness must be positive and damping nonnegative");
  const diagnostics: Diagnostic[] = [...model.diagnostics];
  const initial = new Map<string, Transform>();
  initial.set(model.root, { position, quaternion: [0, 0, 0, 1] });
  function traverse(parent: string) {
    for (const j of model.joints.filter((j) => j.parent === parent)) {
      initial.set(j.child, compose(initial.get(parent)!, j.origin));
      traverse(j.child);
    }
  }
  traverse(model.root);
  const meshCache = new Map<string, Float32Array>();
  for (const l of model.links)
    for (const s of l.collisions.length ? l.collisions : l.visuals)
      if (s.geometry.type === "mesh") {
        const filename = s.geometry.filename;
        if (!/\.stl$/i.test(decodeURIComponent(filename)))
          throw new Error(
            `Link ${l.name}: collision physics requires STL meshes; ${filename} is visual-only. Author a primitive or STL collision geometry instead of relying on non-STL visual fallback`,
          );
        if (!meshCache.has(filename)) {
          if (!options.meshResolver)
            throw new Error(
              `Collision mesh ${filename} needs a local meshResolver`,
            );
          meshCache.set(
            filename,
            stlVertices(await options.meshResolver(filename)),
          );
        }
        diagnostics.push({
          severity: "warning",
          code: "convex-mesh-collision",
          message: `Link ${l.name}: STL collision uses a convex hull; concavity and wire flexibility are not represented`,
        });
      }
  let world: RAPIER.World;
  let bodies: Map<string, RAPIER.RigidBody>;
  let joints: Map<string, RAPIER.UnitImpulseJoint>;
  let targets = new Map<string, number>();
  let time = 0,
    disposed = false;
  function build() {
    world = new RAPIER.World(v(gravity));
    world.timestep = timestep;
    world.numSolverIterations = 12;
    world.numAdditionalFrictionIterations = 4;
    bodies = new Map();
    joints = new Map();
    targets = new Map();
    time = 0;
    if (options.ground !== false) {
      const ground = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, -0.05),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(50, 50, 0.05).setFriction(0.7),
        ground,
      );
    }
    for (const link of model.links) {
      const pose = initial.get(link.name)!;
      const desc =
        options.fixedBase && link.name === model.root
          ? RAPIER.RigidBodyDesc.fixed()
          : RAPIER.RigidBodyDesc.dynamic();
      desc
        .setTranslation(...pose.position)
        .setCcdEnabled(true)
        .setCanSleep(true);
      if (link.inertial) {
        const i = link.inertial,
          p = principalInertia(i.inertia);
        desc.setAdditionalMassProperties(
          i.mass,
          v(rotate(pose.quaternion, i.origin.position)),
          v(p.moments),
          q(mul(mul(pose.quaternion, i.origin.quaternion), p.quaternion)),
        );
      }
      const body = world.createRigidBody(desc);
      bodies.set(link.name, body);
      const shapes = link.collisions.length ? link.collisions : link.visuals;
      for (const shape of shapes) {
        const g = shape.geometry;
        let collider: RAPIER.ColliderDesc;
        let rotation = mul(pose.quaternion, shape.origin.quaternion);
        switch (g.type) {
          case "box":
            collider = RAPIER.ColliderDesc.cuboid(
              g.size[0] / 2,
              g.size[1] / 2,
              g.size[2] / 2,
            );
            break;
          case "sphere":
            collider = RAPIER.ColliderDesc.ball(g.radius);
            break;
          case "cylinder":
            collider = RAPIER.ColliderDesc.cylinder(g.length / 2, g.radius);
            rotation = mul(rotation, [Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
            break;
          case "mesh": {
            const vertices = meshCache.get(g.filename)!.slice();
            for (let i = 0; i < vertices.length; i++)
              vertices[i] *= g.scale[i % 3];
            const hull = RAPIER.ColliderDesc.convexHull(vertices);
            if (!hull)
              throw new Error(
                `Mesh ${g.filename} has no nondegenerate convex hull`,
              );
            collider = hull;
            break;
          }
        }
        collider
          .setTranslation(...rotate(pose.quaternion, shape.origin.position))
          .setRotation(q(rotation))
          .setFriction(0.7)
          .setRestitution(0);
        if (link.inertial) collider.setDensity(0);
        else collider.setMass(1 / shapes.length);
        world.createCollider(collider, body);
      }
      if (!link.inertial && !shapes.length)
        body.setAdditionalMassProperties(
          1,
          v([0, 0, 0]),
          v([0.001, 0.001, 0.001]),
          q([0, 0, 0, 1]),
          true,
        );
    }
    for (const joint of model.joints) {
      const parent = initial.get(joint.parent)!,
        child = initial.get(joint.child)!,
        anchor = sub(child.position, parent.position);
      let desc: RAPIER.JointData;
      if (joint.type === "fixed")
        desc = RAPIER.JointData.fixed(
          v(anchor),
          q([0, 0, 0, 1]),
          v([0, 0, 0]),
          q([0, 0, 0, 1]),
        );
      else {
        const axis = rotate(child.quaternion, joint.axis);
        desc =
          joint.type === "prismatic"
            ? RAPIER.JointData.prismatic(v(anchor), v([0, 0, 0]), v(axis))
            : RAPIER.JointData.revolute(v(anchor), v([0, 0, 0]), v(axis));
      }
      const created = world.createImpulseJoint(
        desc,
        bodies.get(joint.parent)!,
        bodies.get(joint.child)!,
        true,
      );
      created.setContactsEnabled(false);
      if (joint.type !== "fixed") {
        const unit = created as RAPIER.UnitImpulseJoint;
        if (joint.limit) unit.setLimits(joint.limit.lower, joint.limit.upper);
        joints.set(joint.name, unit);
      }
    }
  }
  try {
    build();
  } catch (error) {
    world!?.free();
    throw error;
  }
  const assertLive = () => {
    if (disposed) throw new Error("Simulation has been disposed");
  };
  function snapshot(): RobotSnapshot {
    assertLive();
    const links: RobotSnapshot["links"] = {},
      jointValues: RobotSnapshot["joints"] = {};
    for (const link of model.links) {
      const b = bodies.get(link.name)!;
      links[link.name] = {
        position: tuple(b.translation()),
        quaternion: mul(quat(b.rotation()), initial.get(link.name)!.quaternion),
      };
    }
    for (const joint of model.joints) {
      const parent = links[joint.parent],
        child = links[joint.child],
        frame = compose(parent, joint.origin);
      let value = 0;
      if (joint.type === "prismatic")
        value = dot(
          rotate(
            inverse(frame.quaternion),
            sub(child.position, frame.position),
          ),
          joint.axis,
        );
      else if (joint.type !== "fixed") {
        const relative = mul(inverse(frame.quaternion), child.quaternion),
          s = dot([relative[0], relative[1], relative[2]], joint.axis);
        value = 2 * Math.atan2(s, relative[3]);
        if (value > Math.PI) value -= 2 * Math.PI;
        if (value < -Math.PI) value += 2 * Math.PI;
      }
      jointValues[joint.name] = {
        position: value,
        ...(targets.has(joint.name) ? { target: targets.get(joint.name) } : {}),
      };
    }
    let contacts = 0;
    const seen = new Set<string>();
    world.colliders.forEach((c) =>
      world.contactPairsWith(c, (other) => {
        const key = [c.handle, other.handle].sort((a, b) => a - b).join(":");
        if (seen.has(key)) return;
        seen.add(key);
        world.contactPair(c, other, (m) => {
          for (let i = 0; i < m.numContacts(); i++)
            if (m.contactDist(i) <= 0.001) contacts++;
        });
      }),
    );
    return { time, links, joints: jointValues, contacts };
  }
  return {
    diagnostics,
    timestep,
    snapshot,
    step(steps = 1) {
      assertLive();
      if (!Number.isInteger(steps) || steps < 1 || steps > 12000)
        throw new Error("step count must be an integer from 1 to 12000");
      for (let i = 0; i < steps; i++) {
        world.step();
        time += timestep;
      }
      return snapshot();
    },
    setJointTarget(name, value) {
      assertLive();
      const joint = model.joints.find((j) => j.name === name),
        motor = joints.get(name);
      if (!joint || !motor) throw new Error(`Unknown or fixed joint ${name}`);
      if (!Number.isFinite(value))
        throw new Error("Joint target must be finite");
      const bounded = joint.limit
        ? Math.max(joint.limit.lower, Math.min(joint.limit.upper, value))
        : joint.type === "continuous"
          ? Math.atan2(Math.sin(value), Math.cos(value))
          : value;
      targets.set(name, bounded);
      motor.configureMotorModel(RAPIER.MotorModel.AccelerationBased);
      motor.configureMotorPosition(bounded, stiffness, damping);
      bodies.get(joint.child)!.wakeUp();
      bodies.get(joint.parent)!.wakeUp();
    },
    reset() {
      assertLive();
      world.free();
      build();
      return snapshot();
    },
    dispose() {
      if (!disposed) {
        world.free();
        disposed = true;
      }
    },
  };
}
