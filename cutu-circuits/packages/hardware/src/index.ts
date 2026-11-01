import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import { CutuError, type Capability, type Operation } from "@cutucircuits/core";

const LIMIT = 64 * 1024;
const SECRET = /password|token|secret|credential|authorization|api.?key/i;
const ajv = new Ajv({ allErrors: true, strict: false });
interface Active {
  persistent: boolean;
  child: ChildProcess;
  timer: NodeJS.Timeout;
  done: Promise<void>;
  stop?: "cancelled" | "timeout";
  secrets: string[];
}
/** Executes trusted project programs. One active program per project owns device access.
 * This is deliberately an execution boundary, not an operating-system sandbox. */
export class HardwareRunner {
  private operations = new Map<string, Operation>();
  private active = new Map<string, Active>();
  private closed = false;
  constructor(private options: { onUpdate: (operation: Operation) => void }) {}
  private publish(op: Operation) {
    this.options.onUpdate(structuredClone(op));
  }
  list(projectId: string): Operation[] {
    return [...this.operations.values()]
      .filter((x) => x.projectId === projectId)
      .map((x) => structuredClone(x));
  }
  run(
    projectId: string,
    projectRoot: string,
    capability: Capability,
    inputs: Record<string, unknown>,
  ): Operation {
    if (this.closed)
      throw new CutuError("RUNNER_CLOSED", "Hardware runner is disposed", 503);
    if (
      [...this.operations.values()].some(
        (x) => x.projectId === projectId && x.status === "running",
      )
    )
      throw new CutuError(
        "HARDWARE_BUSY",
        "A program already owns this project. Stop it before starting another.",
        409,
      );
    let valid;
    try {
      valid = ajv.compile(capability.inputSchema);
    } catch {
      throw new CutuError(
        "INVALID_SCHEMA",
        "Capability input schema is invalid",
      );
    }
    if (!valid(inputs))
      throw new CutuError("INVALID_INPUTS", ajv.errorsText(valid.errors));
    if (
      typeof capability.command !== "string" ||
      !capability.command ||
      /[\x00\r\n]/.test(capability.command) ||
      !Array.isArray(capability.args) ||
      capability.args.some((x) => typeof x !== "string" || /\x00/.test(x))
    )
      throw new CutuError(
        "INVALID_COMMAND",
        "Command and arguments must be valid strings",
      );
    const args = capability.args.map((arg) =>
      arg.replace(/\{\{([^{}]+)\}\}/g, (_, key: string) => {
        if (
          !Object.hasOwn(inputs, key) ||
          !["string", "number", "boolean"].includes(typeof inputs[key])
        )
          throw new CutuError(
            "INVALID_ARGUMENT",
            "Argument placeholders require a scalar input",
          );
        const value = String(inputs[key]);
        if (value.includes("\0"))
          throw new CutuError(
            "INVALID_ARGUMENT",
            "Arguments cannot contain NUL",
          );
        return value;
      }),
    );
    const timeoutMs =
      capability.timeoutMs ?? (capability.persistent ? 3_600_000 : 30_000);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000)
      throw new CutuError(
        "INVALID_TIMEOUT",
        "Timeout must be between 1 ms and 24 hours",
      );
    const secrets: string[] = [];
    const scan = (value: unknown, key = "") => {
      if (SECRET.test(key) && typeof value === "string" && value.length)
        secrets.push(value);
      else if (value && typeof value === "object")
        for (const [k, v] of Object.entries(value)) scan(v, k);
    };
    scan(inputs);
    const redact = (value: unknown): unknown => {
      if (typeof value === "string")
        return secrets
          .reduce((s, secret) => s.split(secret).join("[REDACTED]"), value)
          .replace(
            /((?:password|token|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi,
            "$1[REDACTED]",
          );
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [
            k,
            SECRET.test(k) ? "[REDACTED]" : redact(v),
          ]),
        );
      return value;
    };
    const op: Operation = {
      id: randomUUID(),
      projectId,
      capabilityId: capability.id,
      label: capability.label,
      status: "running",
      startedAt: new Date().toISOString(),
      output: "",
    };
    this.operations.set(op.id, op);
    const child = spawn(capability.command, args, {
      cwd: projectRoot,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const entry: Active = {
      persistent: capability.persistent ?? false,
      child,
      timer: setTimeout(() => {
        entry.stop = "timeout";
        void this.terminate(entry);
      }, timeoutMs),
      done,
      secrets,
    };
    this.active.set(op.id, entry);
    let pending = "";
    const output = (raw: string) => {
      op.output = (op.output + String(redact(raw))).slice(-LIMIT);
      this.publish(op);
    };
    // Keep an incomplete line private until complete: split tokens cannot bypass redaction.
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const record = JSON.parse(line);
          if (record && typeof record === "object" && !Array.isArray(record))
            op.telemetry = redact(record) as Record<string, unknown>;
        } catch {
          /* Plain output is supported. */
        }
        output(line + "\n");
      }
      if (pending.length > LIMIT) {
        pending = "";
        output("[oversized stdout line discarded]\n");
      }
    });
    let stderr = "";
    child.stderr!.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-LIMIT);
    });
    child.stdin!.on("error", () => {});
    child.stdin!.write(JSON.stringify(inputs) + "\n");
    if (!capability.persistent) child.stdin!.end();
    child.on("error", (error) => {
      op.error = String(redact(error.message));
    });
    child.on("close", (code) => {
      clearTimeout(entry.timer);
      // A successful parent can leave background descendants with closed stdio.
      // Reap its owned POSIX group before publishing completion/releasing ownership.
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* The process group has already exited. */
        }
      }
      if (pending) output(pending);
      if (stderr) output(stderr);
      op.status =
        entry.stop === "cancelled"
          ? "cancelled"
          : entry.stop === "timeout" || code !== 0 || op.error
            ? "failed"
            : "succeeded";
      if (entry.stop === "timeout") op.error = "Program timed out";
      if (code !== 0 && !op.error && !entry.stop)
        op.error = `Program exited with code ${code}`;
      op.exitCode = code;
      op.finishedAt = new Date().toISOString();
      this.active.delete(op.id);
      this.publish(op);
      resolveDone();
    });
    this.publish(op);
    return structuredClone(op);
  }
  /** Deliver a project-defined JSONL control record to a live saved program. */
  send(operationId: string, message: Record<string, unknown>): Operation {
    const op = this.operations.get(operationId);
    if (!op) throw new CutuError("NOT_FOUND", "Operation not found", 404);
    const entry = this.active.get(operationId);
    if (!entry || !entry.persistent || !entry.child.stdin?.writable)
      throw new CutuError(
        "NOT_INTERACTIVE",
        "Operation has no live persistent input stream",
        409,
      );
    if (!message || typeof message !== "object" || Array.isArray(message))
      throw new CutuError(
        "INVALID_MESSAGE",
        "Control message must be a JSON object",
      );
    let encoded: string;
    try {
      encoded = JSON.stringify(message);
    } catch {
      throw new CutuError(
        "INVALID_MESSAGE",
        "Control message must be JSON serializable",
      );
    }
    if (Buffer.byteLength(encoded) > 16384)
      throw new CutuError("INVALID_MESSAGE", "Control message exceeds 16 KiB");
    if (entry.child.stdin.writableLength > 65536)
      throw new CutuError("PROGRAM_BUSY", "Program input buffer is full", 429);
    const scan = (value: unknown, key = "") => {
      if (SECRET.test(key) && typeof value === "string" && value.length)
        entry.secrets.push(value);
      else if (value && typeof value === "object")
        for (const [k, v] of Object.entries(value)) scan(v, k);
    };
    scan(message);
    entry.child.stdin.write(encoded + "\n");
    this.publish(op);
    return structuredClone(op);
  }
  private async terminate(entry: Active) {
    const signal = (sig: NodeJS.Signals) => {
      if (!entry.child.pid) return;
      try {
        if (process.platform === "win32") {
          // Windows has no POSIX process-group signals. Keep the parent alive
          // during the JSONL grace period, then terminate its complete tree.
          spawn("taskkill", ["/pid", String(entry.child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          }).on("error", () => {
            entry.child.kill();
          });
        } else process.kill(-entry.child.pid, sig);
      } catch {
        /* Already exited. */
      }
    };
    // Persistent adapters may handle this JSONL control record on every platform.
    if (entry.child.stdin?.writable)
      entry.child.stdin.end('{"type":"cancel"}\n');
    const graceful = setTimeout(
      () => signal("SIGTERM"),
      process.platform === "win32" ? 1800 : 300,
    );
    // Give device adapters time to issue STOP on their existing connection.
    const force = setTimeout(
      () => signal("SIGKILL"),
      process.platform === "win32" ? 2200 : 1500,
    );
    await entry.done;
    clearTimeout(force);
    clearTimeout(graceful);
    // A program may have exited while leaving descendants holding no stdio.
    signal("SIGKILL");
  }
  async cancel(operationId: string): Promise<Operation> {
    const op = this.operations.get(operationId);
    if (!op) throw new CutuError("NOT_FOUND", "Operation not found", 404);
    const entry = this.active.get(operationId);
    if (entry) {
      // The deadline must not overwrite an already accepted cancellation while
      // its graceful STOP/process-tree cleanup is still in progress.
      clearTimeout(entry.timer);
      entry.stop = "cancelled";
      await this.terminate(entry);
    }
    return structuredClone(op);
  }
  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.active.keys()].map((id) => this.cancel(id)));
  }
}
