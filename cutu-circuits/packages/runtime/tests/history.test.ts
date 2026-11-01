import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectStore } from "../src/store.ts";

async function fixture(t: any) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cutu-history-"));
  const options = {
    dataDir,
    templatesDir: path.resolve(import.meta.dirname, "../../../examples"),
    seed: false,
    pollIntervalMs: 0,
  };
  const store = await new ProjectStore(options).init();
  t.after(async () => {
    await store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const project = await store.create("History", "blank");
  return { store, project, options };
}

test("first source save retains the existing native source and immutable versions; restore uses CAS and survives restart", async (t) => {
  const { store, project, options } = await fixture(t);
  const relative = "native.circuit.tsx";
  await fs.writeFile(
    path.join(store.root(project.id), relative),
    "original source",
  );
  const first = await store.read(project.id, relative);
  const saved = await store.write(
    project.id,
    relative,
    "saved source",
    first.sha256,
  );
  const versions = await store.history(project.id, relative);
  assert.deepEqual(
    versions.map((v) => v.reason),
    ["save", "baseline"],
  );
  assert.deepEqual(
    versions.map((v) => v.sizeBytes),
    [12, 15],
  );
  const original = versions[1];
  await assert.rejects(
    store.restoreVersion(project.id, original.id, first.sha256),
    (e: any) => e.code === "HASH_CONFLICT",
  );
  const restored = await store.restoreVersion(
    project.id,
    original.id,
    saved.sha256,
  );
  assert.equal(restored.content, "original source");
  assert.equal(
    (await store.history(project.id, relative))[0].reason,
    "restore",
  );
  assert.equal(
    (await store.historyVersion(project.id, versions[0].id)).content,
    "saved source",
  );
  const restarted = await new ProjectStore(options).init();
  t.after(() => restarted.close());
  assert.equal(
    (await restarted.historyVersion(project.id, original.id)).content,
    "original source",
  );
  assert.equal((await restarted.get(project.id)).revision, 2);
  assert.ok(
    !(await store.files(project.id)).some(
      (p) => p.includes("history") || p.includes("transactions"),
    ),
  );
});

test("observed terminal versions are retained without claiming unseen edits", async (t) => {
  const { store, project } = await fixture(t);
  const relative = "terminal.txt";
  await store.write(project.id, relative, "first", null);
  await fs.writeFile(
    path.join(store.root(project.id), relative),
    "unseen intermediate",
  );
  await fs.writeFile(
    path.join(store.root(project.id), relative),
    "observed terminal",
  );
  await store.poll();
  const entries = await store.history(project.id, relative);
  assert.equal(entries[0].reason, "external");
  assert.deepEqual(
    await Promise.all(
      entries.map(
        async (v) => (await store.historyVersion(project.id, v.id)).content,
      ),
    ),
    ["observed terminal", "first"],
  );
});

test("history validates limits, confines versions to their project and rejects private symlinks", async (t) => {
  const { store, project } = await fixture(t);
  const other = await store.create("Other", "blank");
  await store.write(project.id, "native.txt", "source", null);
  const [version] = await store.history(project.id, "native.txt");
  for (const limit of [0, -1, 101, 1.2, NaN, "2"])
    await assert.rejects(
      store.history(project.id, undefined, limit as number),
      (e: any) => e.code === "INVALID_INPUT",
    );
  for (const relative of [
    "../outside",
    ".cutucircuits-history/x",
    "/etc/passwd",
  ])
    await assert.rejects(
      store.history(project.id, relative),
      (e: any) => e.code === "INVALID_PATH",
    );
  await assert.rejects(
    store.historyVersion(other.id, version.id),
    (e: any) => e.code === "NOT_FOUND",
  );
  await assert.rejects(
    store.historyVersion(project.id, "../outside"),
    (e: any) => e.code === "INVALID_INPUT",
  );
  const historyDir = path.join(store.root(project.id), ".cutucircuits-history");
  const record = path.join(historyDir, `${version.id}.json`);
  await fs.rename(record, record + ".original");
  // Junctions exercise the same symbolic-entry guard without Windows symlink privileges.
  await fs.symlink(
    process.platform === "win32" ? historyDir : record + ".original",
    record,
    process.platform === "win32" ? "junction" : "file",
  );
  await assert.rejects(
    store.historyVersion(project.id, version.id),
    (e: any) => e.code === "INVALID_PATH",
  );
  await fs.rm(historyDir, { recursive: true });
  await fs.symlink(
    store.root(other.id),
    historyDir,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    store.history(project.id),
    (e: any) => e.code === "INVALID_PATH",
  );
  await assert.rejects(
    store.write(project.id, "native.txt", "changed", version.sha256),
    (e: any) => e.code === "INVALID_PATH",
  );
});
