/** URDF and physics values use SI metres, kilograms, seconds and radians. World is Z-up. */
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export interface Transform {
  position: Vec3;
  quaternion: Quat;
}
export interface Diagnostic {
  severity: "warning" | "info";
  code: string;
  message: string;
}
export type Geometry =
  | { type: "box"; size: Vec3 }
  | { type: "sphere"; radius: number }
  | { type: "cylinder"; radius: number; length: number }
  | { type: "mesh"; filename: string; scale: Vec3 };
export interface RobotShape {
  name?: string;
  origin: Transform;
  geometry: Geometry;
  material?: { name?: string; color?: [number, number, number, number] };
}
export interface RobotInertial {
  mass: number;
  origin: Transform;
  inertia: [number, number, number, number, number, number];
}
export interface RobotLink {
  name: string;
  visuals: RobotShape[];
  collisions: RobotShape[];
  inertial?: RobotInertial;
}
export interface RobotJoint {
  name: string;
  type: "fixed" | "revolute" | "continuous" | "prismatic";
  parent: string;
  child: string;
  origin: Transform;
  axis: Vec3;
  limit?: { lower: number; upper: number; effort?: number; velocity?: number };
}
export interface RobotModel {
  name: string;
  root: string;
  links: RobotLink[];
  joints: RobotJoint[];
  diagnostics: Diagnostic[];
  units: "m-kg-s-rad";
}
export interface SimulationOptions {
  fixedBase?: boolean;
  ground?: boolean;
  timestep?: number;
  gravity?: Vec3;
  position?: Vec3;
  meshResolver?: (filename: string) => Promise<ArrayBuffer>;
  motorStiffness?: number;
  motorDamping?: number;
}
export interface RobotSnapshot {
  time: number;
  links: Record<string, Transform>;
  joints: Record<string, { position: number; target?: number }>;
  contacts: number;
}
export interface RobotSimulation {
  readonly diagnostics: Diagnostic[];
  readonly timestep: number;
  step(steps?: number): RobotSnapshot;
  snapshot(): RobotSnapshot;
  setJointTarget(name: string, position: number): void;
  reset(): RobotSnapshot;
  dispose(): void;
}
