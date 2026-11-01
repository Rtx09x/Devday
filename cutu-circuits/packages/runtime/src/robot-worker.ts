import { promises as fs } from "node:fs";
import { parseUrdf, createRobotSimulation } from "@cutucircuits/robotics";
import type { SimulationOptions } from "@cutucircuits/robotics";
import { ProjectStore } from "./store.js";
import { robotAssetPath } from "./robot-assets.js";

export interface RobotWorkerRequest {
  source: string;
  path: string;
  dataDir: string;
  projectId: string;
  durationSeconds: number;
  jointTargets: Record<string, number>;
  options: Pick<
    SimulationOptions,
    "fixedBase" | "ground" | "gravity" | "position"
  >;
}
process.once("message", async (request: RobotWorkerRequest) => {
  let simulation: Awaited<ReturnType<typeof createRobotSimulation>> | undefined;
  try {
    const model = parseUrdf(request.source);
    const guard = new ProjectStore({
      dataDir: request.dataDir,
      seed: false,
      pollIntervalMs: 0,
    });
    const resources = new Map<string, Promise<ArrayBuffer>>();
    let totalBytes = 0;
    simulation = await createRobotSimulation(model, {
      ...request.options,
      timestep: 1 / 120,
      meshResolver: (resource) => {
        const relative = robotAssetPath(request.path, resource);
        let pending = resources.get(relative);
        if (!pending) {
          pending = (async () => {
            const filename = await guard.resolveFile(
              request.projectId,
              relative,
            );
            const stat = await fs.stat(filename);
            if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
              throw new Error("Robot mesh exceeds 16 MiB or is not a file");
            totalBytes += stat.size;
            if (totalBytes > 64 * 1024 * 1024)
              throw new Error(
                "Robot collision meshes exceed the 64 MiB computation limit",
              );
            const bytes = await fs.readFile(filename);
            return Uint8Array.from(bytes).buffer;
          })();
          resources.set(relative, pending);
        }
        return pending;
      },
    });
    const initial = simulation.snapshot();
    for (const [name, target] of Object.entries(request.jointTargets))
      simulation.setJointTarget(name, target);
    const steps = Math.ceil(request.durationSeconds / simulation.timestep);
    let final = initial;
    let maxContacts = initial.contacts;
    for (let index = 0; index < steps; index++) {
      final = simulation.step();
      maxContacts = Math.max(maxContacts, final.contacts);
    }
    process.send?.({
      result: {
        source: "simulated",
        units: model.units,
        robot: model.name,
        timestep: simulation.timestep,
        steps,
        fixedBase: request.options.fixedBase ?? true,
        initial,
        final,
        maxContacts,
        diagnostics: simulation.diagnostics,
      },
    });
  } catch (error) {
    process.send?.({
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    simulation?.dispose();
  }
});
