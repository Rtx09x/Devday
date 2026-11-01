import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { HardwareRunner } from "../src/index.ts";

test(
  "successful parent exit cleans background descendants before releasing ownership",
  { skip: process.platform === "win32" },
  async () => {
    const runner = new HardwareRunner({ onUpdate() {} });
    let descendantPid: number | undefined;
    try {
      const operation = runner.run(
        "ownership",
        tmpdir(),
        {
          id: "background",
          label: "Background process",
          description: "",
          kind: "read",
          command: process.execPath,
          args: [
            "-e",
            `const p=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify({pid:p.pid}));p.unref()`,
          ],
          inputSchema: { type: "object" },
          timeoutMs: 3000,
        },
        {},
      );
      const deadline = Date.now() + 5000;
      let finished = runner.list("ownership")[0];
      while (finished.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        finished = runner.list("ownership").find((o) => o.id === operation.id)!;
      }
      assert.equal(finished.status, "succeeded");
      descendantPid = finished.telemetry?.pid as number;
      assert.ok(Number.isInteger(descendantPid));
      let running = true;
      const cleanupDeadline = Date.now() + 1000;
      while (running && Date.now() < cleanupDeadline) {
        try {
          if (process.platform === "linux") {
            running = !/\) Z /.test(
              await readFile(`/proc/${descendantPid}/stat`, "utf8"),
            );
          } else process.kill(descendantPid, 0);
        } catch (error: any) {
          if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
          running = false;
        }
        if (running) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        running,
        false,
        "a finished operation must not leave a running descendant",
      );
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
      await runner.dispose();
    }
  },
);

test("a deadline expiring during cancellation does not replace the cancelled result", async () => {
  const runner = new HardwareRunner({ onUpdate() {} });
  try {
    const op = runner.run(
      "cancel-race",
      tmpdir(),
      {
        id: "cancel-race",
        label: "Cancellation race",
        description: "",
        kind: "read",
        command: process.execPath,
        args: [
          "-e",
          `process.on('SIGTERM',()=>{});console.log(JSON.stringify({ready:true}));setInterval(()=>{},1000)`,
        ],
        inputSchema: { type: "object" },
        timeoutMs: 1000,
        persistent: true,
      },
      {},
    );
    const deadline = Date.now() + 900;
    while (!runner.list("cancel-race")[0].telemetry && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(runner.list("cancel-race")[0].telemetry?.ready, true);
    assert.equal((await runner.cancel(op.id)).status, "cancelled");
  } finally {
    await runner.dispose();
  }
});
