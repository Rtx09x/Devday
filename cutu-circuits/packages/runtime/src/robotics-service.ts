import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CutuError } from "@cutucircuits/core";
import type { RobotWorkerRequest } from "./robot-worker.js";

/** Headless physics runs outside the HTTP process and has a hard deadline. */
function computeRobotSimulation(request: RobotWorkerRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = fork(
      fileURLToPath(new URL("./robot-worker.ts", import.meta.url)),
      [],
      {
        execArgv: [
          "--import",
          pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
        ],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
      },
    );
    let finished = false;
    const finish = (error?: Error, result?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish(
          new CutuError(
            "SIMULATION_TIMEOUT",
            "Robot simulation exceeded its 10 second computation deadline",
            408,
          ),
        ),
      10_000,
    );
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) =>
      finish(
        new CutuError(
          "SIMULATION_FAILED",
          `Robot physics process exited (${signal ?? code})`,
          422,
        ),
      ),
    );
    child.once("message", (message: { error?: string; result?: unknown }) => {
      if (message.error)
        finish(new CutuError("SIMULATION_FAILED", message.error, 422));
      else finish(undefined, message.result);
    });
    child.send(request, (error) => {
      if (error) finish(error);
    });
  });
}

let activeSimulations = 0;
export async function runRobotSimulation(
  request: RobotWorkerRequest,
): Promise<unknown> {
  if (activeSimulations >= 2)
    throw new CutuError(
      "SIMULATION_BUSY",
      "Two robot simulations are already running. Retry after one finishes.",
      429,
    );
  activeSimulations++;
  try {
    return await computeRobotSimulation(request);
  } finally {
    activeSimulations--;
  }
}
