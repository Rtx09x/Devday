import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type {
  ArtifactResult,
  CadResult,
  CircuitResult,
} from "@cutucircuits/core";
import { CutuError } from "@cutucircuits/core";

type Params = Record<string, number | boolean | string>;
export interface EngineRequest {
  kind: "circuit" | "cad";
  source: string;
  path: string;
  parameters?: Params;
  format?: "svg" | "bom" | "step" | "stl" | "obj";
}
/** Prevent routine provider credentials from being inherited by design code.
 * The process is not a sandbox: project code still has local filesystem and network access. */
export function engineEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const providerKeys = new Set(["CEREBRAS_API_KEY", "EXA_API_KEY", "OPENAI_API_KEY"]);
  return Object.fromEntries(Object.entries(env).filter(([key]) => !providerKeys.has(key.toUpperCase())));
}
/** Disposable processes isolate CPU loops and kernel failures. This is not an OS sandbox. */
export function runEngine<T>(
  request: EngineRequest,
  timeoutMs = 30_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = fork(
      fileURLToPath(new URL("./worker.ts", import.meta.url)),
      [],
      {
        execArgv: [
          "--import",
          pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
        ],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        serialization: "advanced",
        env: engineEnvironment(process.env),
      },
    );
    let finished = false;
    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-4000);
    });
    const finish = (error?: Error, value?: T) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(value as T);
    };
    const timer = setTimeout(
      () =>
        finish(
          new CutuError(
            "ENGINE_TIMEOUT",
            `Engineering computation exceeded ${timeoutMs} ms`,
            408,
          ),
        ),
      timeoutMs,
    );
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) =>
      finish(
        new CutuError(
          "ENGINE_FAILED",
          `Engineering process exited (${signal ?? code})${stderr ? `: ${stderr}` : ""}`,
          422,
        ),
      ),
    );
    child.once("message", (message: any) => {
      if (message.error)
        finish(new CutuError("ENGINE_FAILED", message.error, 422));
      else finish(undefined, message.result);
    });
    child.send(request, (error) => {
      if (error) finish(error);
    });
  });
}
export const compileCircuit = (
  source: string,
  path: string,
): Promise<CircuitResult> => runEngine({ kind: "circuit", source, path });
export const compileCad = (
  source: string,
  path: string,
  parameters?: Params,
): Promise<CadResult> => runEngine({ kind: "cad", source, path, parameters });
export const exportCircuit = (
  source: string,
  path: string,
  format: "svg" | "bom",
): Promise<ArtifactResult> =>
  runEngine({ kind: "circuit", source, path, format });
export const exportCad = (
  source: string,
  path: string,
  format: "step" | "stl" | "obj",
  parameters?: Params,
): Promise<ArtifactResult> =>
  runEngine({ kind: "cad", source, path, format, parameters });
export const sourceSha256 = (source: string) =>
  createHash("sha256").update(source).digest("hex");
