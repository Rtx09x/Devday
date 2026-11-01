import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectStore } from "../src/store.ts";

for (const existing of [true, false]) {
  test(`external ${existing ? "edit" : "creation"} during save preserves disk content and recovery versions`, async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cutu-integrity-"));
    const store = await new ProjectStore({
      dataDir,
      templatesDir: path.resolve(import.meta.dirname, "../../../examples"),
      seed: false,
      pollIntervalMs: 0,
    }).init();
    try {
      const project = await store.create("Integrity check", "blank");
      const relative = "audit/source.txt";
      const before = existing
        ? await store.write(project.id, relative, "observed source", null)
        : null;
      const filename = path.join(store.root(project.id), relative);
      const open = fs.open.bind(fs);
      let injected = false;
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (
          !injected &&
          String(args[0]).startsWith(path.dirname(filename) + path.sep)
        ) {
          injected = true;
          const sync = handle.sync.bind(handle);
          t.mock.method(handle, "sync", async () => {
            await sync();
            // A real external writer changes the destination while the broker's
            // replacement file is being prepared, after its initial hash check.
            await fs.writeFile(filename, "terminal source");
          });
        }
        return handle;
      });
      await assert.rejects(
        store.write(
          project.id,
          relative,
          "attempted source",
          before?.sha256 ?? null,
        ),
        (error: any) => error.code === "HASH_CONFLICT" && error.status === 409,
      );
      assert.equal(injected, true);
      assert.equal(await fs.readFile(filename, "utf8"), "terminal source");
      assert.equal((await store.get(project.id)).revision, existing ? 1 : 0);
      const recoveryDir = path.join(
        store.root(project.id),
        ".cutucircuits-recovery",
      );
      const entries = await fs.readdir(recoveryDir);
      assert.equal(entries.length, 1);
      const recovery = JSON.parse(
        await fs.readFile(path.join(recoveryDir, entries[0]), "utf8"),
      );
      assert.equal(
        recovery.observedBase64 === null
          ? null
          : Buffer.from(recovery.observedBase64, "base64").toString(),
        existing ? "observed source" : null,
      );
      assert.equal(
        Buffer.from(recovery.interveningBase64, "base64").toString(),
        "terminal source",
      );
      assert.equal(recovery.attemptedContent, "attempted source");
      assert.ok(
        !(await store.files(project.id)).some((p) => p.includes("recovery")),
      );
      await assert.rejects(
        store.read(project.id, `.cutucircuits-recovery/${entries[0]}`),
        (error: any) => error.code === "INVALID_PATH",
      );
    } finally {
      t.mock.restoreAll();
      await store.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
}
