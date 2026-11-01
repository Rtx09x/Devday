import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HardwareRunner } from "../src/index.ts";
import type { Capability, Operation } from "@cutucircuits/core";
const schema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
};
const cap = (program: string, extra: Partial<Capability> = {}): Capability => ({
  id: "test",
  label: "Test program",
  description: "Subprocess test",
  kind: "read",
  command: process.execPath,
  args: ["-e", program, "{{value}}"],
  inputSchema: schema,
  timeoutMs: 3000,
  ...extra,
});
async function finished(runner: HardwareRunner, id: string) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const op = runner.list("test").find((x) => x.id === id)!;
    if (op.status !== "running") return op;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("operation did not finish");
}
test("literal argv, JSON stdin, cwd and telemetry use a real child", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutu-hardware-"));
  const updates: Operation[] = [];
  const runner = new HardwareRunner({ onUpdate: (op) => updates.push(op) });
  try {
    const value = "$(touch INJECTION); value with spaces";
    const op = runner.run(
      "test",
      root,
      cap(
        `let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>console.log(JSON.stringify({value:process.argv[1],input:JSON.parse(s),cwd:process.cwd()})))`,
      ),
      { value },
    );
    const done = await finished(runner, op.id);
    assert.equal(done.status, "succeeded");
    assert.deepEqual(done.telemetry, { value, input: { value }, cwd: root });
    assert.ok(updates.length >= 2);
    updates[0].status = "failed";
    assert.equal(runner.list("test")[0].status, "succeeded");
  } finally {
    await runner.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
test("JSON Schema constraints, string argv and one project owner are enforced", async () => {
  const runner = new HardwareRunner({ onUpdate: () => {} });
  try {
    assert.throws(() => runner.run("test", tmpdir(), cap(""), { value: 3 }));
    assert.throws(() =>
      runner.run(
        "test",
        tmpdir(),
        cap("", { args: [1 as unknown as string] }),
        { value: "x" },
      ),
    );
    assert.throws(() =>
      runner.run(
        "test",
        tmpdir(),
        cap("", {
          inputSchema: {
            type: "object",
            properties: { value: { type: "string", pattern: "^allowed$" } },
          },
        }),
        { value: "wrong" },
      ),
    );
    const op = runner.run("test", tmpdir(), cap("setInterval(()=>{},1000)"), {
      value: "x",
    });
    assert.throws(
      () => runner.run("test", tmpdir(), cap(""), { value: "x" }),
      /already owns/,
    );
    assert.equal((await runner.cancel(op.id)).status, "cancelled");
  } finally {
    await runner.dispose();
  }
});
test("stdout/stderr bounded, JSONL telemetry and credentials redacted across chunks", async () => {
  const runner = new HardwareRunner({ onUpdate: () => {} });
  try {
    const program = String.raw`process.stdout.write('x'.repeat(90000)+'\n');process.stderr.write('y'.repeat(90000));process.stdout.write('private=abc');setTimeout(()=>console.log('def\n'+JSON.stringify({token:'abcdef',reading:12})),20)`;
    const op = runner.run(
      "test",
      tmpdir(),
      cap(program, {
        inputSchema: {
          type: "object",
          properties: { token: { type: "string" } },
          required: ["token"],
        },
        args: ["-e", program],
      }),
      { token: "abcdef" },
    );
    const done = await finished(runner, op.id);
    assert.equal(done.status, "succeeded");
    assert.ok(done.output.length <= 65536);
    assert.ok(!JSON.stringify(done).includes("abcdef"));
    assert.deepEqual(done.telemetry, { token: "[REDACTED]", reading: 12 });
  } finally {
    await runner.dispose();
  }
});
test("nonzero exit and missing executable become failed operations", async () => {
  const runner = new HardwareRunner({ onUpdate: () => {} });
  try {
    let op = runner.run("test", tmpdir(), cap("process.exit(7)"), {
      value: "x",
    });
    assert.equal((await finished(runner, op.id)).exitCode, 7);
    op = runner.run(
      "test",
      tmpdir(),
      cap("", { command: "cutucircuits-no-such-command" }),
      { value: "x" },
    );
    assert.equal((await finished(runner, op.id)).status, "failed");
  } finally {
    await runner.dispose();
  }
});
test("timeout and cancellation kill a process tree and allow graceful adapter stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutu-stop-"));
  const runner = new HardwareRunner({ onUpdate: () => {} });
  try {
    const marker = join(root, "stopped");
    await writeFile(
      join(root, "program.cjs"),
      `const fs=require('node:fs');const {spawn}=require('node:child_process');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); const stop=()=>{fs.writeFileSync(${JSON.stringify(marker)},'STOP');p.kill();process.exit(0)};process.on('SIGTERM',stop);require('node:readline').createInterface({input:process.stdin}).on('line',s=>{if(JSON.parse(s).type==='cancel')stop()});console.log(JSON.stringify({pid:p.pid}));setInterval(()=>{},1000);`,
    );
    const op = runner.run(
      "test",
      root,
      cap("", {
        args: ["program.cjs"],
        persistent: process.platform === "win32",
      }),
      {
        value: "x",
      },
    );
    while (!runner.list("test")[0].telemetry)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const pid = runner.list("test")[0].telemetry!.pid as number;
    const stopped = await runner.cancel(op.id);
    assert.equal(stopped.status, "cancelled");
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(marker, "utf8"), "STOP");
    // Linux may briefly keep an exited orphan as a zombie; it must not be running.
    if (process.platform === "linux") {
      try {
        assert.match(await readFile(`/proc/${pid}/stat`, "utf8"), /\) Z /);
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const timeout = runner.run(
      "test",
      root,
      cap("setInterval(()=>{},1000)", { timeoutMs: 30 }),
      { value: "x" },
    );
    assert.equal(
      (await finished(runner, timeout.id)).error,
      "Program timed out",
    );
  } finally {
    await runner.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("timeout terminates an uncooperative subprocess tree", async () => {
  const runner = new HardwareRunner({ onUpdate: () => {} });
  let pid: number | undefined;
  try {
    const op = runner.run(
      "test",
      tmpdir(),
      cap(
        `const p=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify({pid:p.pid}));setInterval(()=>{},1000);`,
        { timeoutMs: 1000 },
      ),
      { value: "x" },
    );
    const readyDeadline = Date.now() + 4000;
    while (!runner.list("test")[0].telemetry && Date.now() < readyDeadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    pid = runner.list("test")[0].telemetry?.pid as number;
    assert.ok(
      Number.isInteger(pid),
      "child process reported its descendant PID",
    );
    assert.equal((await finished(runner, op.id)).error, "Program timed out");
    const { readFile } = await import("node:fs/promises");
    const deadline = Date.now() + 2000;
    let running = true;
    while (running && Date.now() < deadline) {
      try {
        if (process.platform === "linux")
          running = !/\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"));
        else process.kill(pid, 0);
      } catch (error: any) {
        if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
        running = false;
      }
      if (running) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(running, false, "timeout left a running descendant");
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
    await runner.dispose();
  }
});

test("persistent programs accept bounded JSONL controls without spawning another process", async () => {
  const updates: Operation[] = [];
  const runner = new HardwareRunner({ onUpdate: (op) => updates.push(op) });
  const program = String.raw`const r=require('node:readline').createInterface({input:process.stdin});r.on('line',s=>{const x=JSON.parse(s);if(x.type==='cancel')process.exit(0);console.log(JSON.stringify(x));});`;
  try {
    const op = runner.run(
      "test",
      tmpdir(),
      cap(program, { persistent: true }),
      { value: "initial" },
    );
    runner.send(op.id, { type: "command", token: "control-secret", value: 42 });
    assert.throws(
      () => runner.send(op.id, { value: "x".repeat(20000) }),
      /16 KiB/,
    );
    const deadline = Date.now() + 2000;
    while (
      runner.list("test")[0].telemetry?.value !== 42 &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const state = runner.list("test")[0];
    assert.deepEqual(state.telemetry, {
      type: "command",
      token: "[REDACTED]",
      value: 42,
    });
    assert.ok(!state.output.includes("control-secret"));
    assert.ok(updates.length > 2);
    await runner.cancel(op.id);
    assert.throws(() => runner.send(op.id, { type: "status" }), /no live/);
  } finally {
    await runner.dispose();
  }
});
