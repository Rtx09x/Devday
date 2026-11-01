import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { PROJECT_FILE } from "@cutucircuits/core";
import { ProjectStore } from "../src/store.ts";

async function fixture(t: any) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cutu-restart-"));
  const options = {
    dataDir,
    templatesDir: path.resolve(import.meta.dirname, "../../../examples"),
    seed: false,
    pollIntervalMs: 0,
  };
  const store = await new ProjectStore(options).init();
  t.after(async () => {
    t.mock.restoreAll();
    await store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const project = await store.create("Recovery", "blank");
  return { store, project, options };
}

for (const terminal of [
  "none",
  "source",
  "manifest",
  "both",
  "malformed manifest",
]) {
  test(`restart after source rename then manifest failure preserves ${terminal} terminal edits`, async (t) => {
    const { store, project, options } = await fixture(t);
    const initial = await store.write(project.id, "native.txt", "before", null);
    const filename = path.join(store.root(project.id), "native.txt");
    const manifest = path.join(store.root(project.id), PROJECT_FILE);
    const rename = fs.rename.bind(fs);
    let failed = false;
    t.mock.method(
      fs,
      "rename",
      async (...args: Parameters<typeof fs.rename>) => {
        if (String(args[1]) === manifest) {
          failed = true;
          throw Object.assign(new Error("injected manifest failure"), {
            code: "EIO",
          });
        }
        return rename(...args);
      },
    );
    await assert.rejects(
      store.write(project.id, "native.txt", "after", initial.sha256),
      /injected manifest failure/,
    );
    assert.equal(failed, true);
    assert.equal(await fs.readFile(filename, "utf8"), "after");
    assert.equal((await store.get(project.id)).revision, 1);
    t.mock.restoreAll();
    await store.close();
    if (["source", "both"].includes(terminal))
      await fs.writeFile(filename, "terminal source");
    if (["manifest", "both"].includes(terminal)) {
      const external = JSON.parse(await fs.readFile(manifest, "utf8"));
      external.name = "Terminal manifest";
      await fs.writeFile(manifest, JSON.stringify(external));
    }
    if (terminal === "malformed manifest")
      await fs.writeFile(manifest, "terminal invalid JSON");
    const restarted = await new ProjectStore(options).init();
    t.after(() => restarted.close());
    assert.equal(
      await fs.readFile(filename, "utf8"),
      ["source", "both"].includes(terminal) ? "terminal source" : "after",
    );
    if (terminal === "malformed manifest")
      assert.equal(
        await fs.readFile(manifest, "utf8"),
        "terminal invalid JSON",
      );
    else {
      const current = await restarted.get(project.id);
      assert.equal(current.revision, terminal === "none" ? 2 : 1);
      assert.equal(
        current.name,
        ["manifest", "both"].includes(terminal)
          ? "Terminal manifest"
          : "Recovery",
      );
      const entries = await restarted.history(project.id, "native.txt");
      const contents = await Promise.all(
        entries.map(
          async (entry) =>
            (await restarted.historyVersion(project.id, entry.id)).content,
        ),
      );
      assert.ok(contents.includes("before"));
      assert.ok(contents.includes("after"));
      if (["source", "both"].includes(terminal))
        assert.ok(contents.includes("terminal source"));
    }
    assert.deepEqual(
      await fs.readdir(
        path.join(store.root(project.id), ".cutucircuits-transactions"),
      ),
      [],
    );
    if (terminal !== "none")
      assert.equal(
        (
          await fs.readdir(
            path.join(
              store.root(project.id),
              ".cutucircuits-transaction-conflicts",
            ),
          )
        ).length,
        1,
      );
    await restarted.close();
    const again = await new ProjectStore(options).init();
    await again.close();
    assert.equal(
      await fs.readFile(filename, "utf8"),
      ["source", "both"].includes(terminal) ? "terminal source" : "after",
    );
  });
}

for (const operation of ["patch", "write", "poll"]) {
  test(`${operation} checks the manifest hash immediately before replacement and retains conflict versions`, async (t) => {
    const { store, project } = await fixture(t);
    const manifest = path.join(store.root(project.id), PROJECT_FILE);
    const observed = await fs.readFile(manifest, "utf8");
    const external = JSON.parse(observed);
    external.name = "Terminal changed manifest";
    const externalContent = JSON.stringify(external);
    const open = fs.open.bind(fs);
    let injected = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (
        !injected &&
        String(args[0]).startsWith(
          store.root(project.id) + path.sep + ".cutucircuits-",
        ) &&
        String(args[0]).endsWith(".tmp")
      ) {
        injected = true;
        const sync = handle.sync.bind(handle);
        t.mock.method(handle, "sync", async () => {
          await sync();
          await fs.writeFile(manifest, externalContent);
        });
      }
      return handle;
    });
    if (operation === "poll")
      await fs.writeFile(
        path.join(store.root(project.id), "external.txt"),
        "external source",
      );
    const action =
      operation === "patch"
        ? store.patch(project.id, 0, { name: "Broker change" })
        : operation === "write"
          ? store.write(project.id, "new.txt", "source", null)
          : store.poll();
    await assert.rejects(
      action,
      (e: any) => e.code === "REVISION_CONFLICT" && e.status === 409,
    );
    assert.equal(injected, true);
    assert.equal(await fs.readFile(manifest, "utf8"), externalContent);
    const entries = await store.history(project.id, PROJECT_FILE);
    const contents = await Promise.all(
      entries.map(
        async (entry) =>
          (await store.historyVersion(project.id, entry.id)).content,
      ),
    );
    assert.ok(contents.includes(observed));
    assert.ok(contents.includes(externalContent));
    assert.ok(entries.some((entry) => entry.reason === "recovery"));
  });
}

for (const point of [
  "before source rename",
  "after source rename",
  "after manifest rename",
]) {
  test(`restart resolves an interrupted save ${point} without replaying an uncommitted source`, async (t) => {
    const { store, project, options } = await fixture(t);
    const initial = await store.write(project.id, "native.txt", "before", null);
    const source = path.join(store.root(project.id), "native.txt");
    const manifest = path.join(store.root(project.id), PROJECT_FILE);
    const rename = fs.rename.bind(fs);
    t.mock.method(
      fs,
      "rename",
      async (...args: Parameters<typeof fs.rename>) => {
        const destination = String(args[1]);
        if (point === "before source rename" && destination === source)
          throw new Error("interruption");
        const result = await rename(...args);
        if (
          (point === "after source rename" && destination === source) ||
          (point === "after manifest rename" && destination === manifest)
        )
          throw new Error("interruption");
        return result;
      },
    );
    await assert.rejects(
      store.write(project.id, "native.txt", "after", initial.sha256),
      /interruption/,
    );
    t.mock.restoreAll();
    await store.close();
    const restarted = await new ProjectStore(options).init();
    t.after(() => restarted.close());
    assert.equal(
      (await restarted.read(project.id, "native.txt")).content,
      point === "before source rename" ? "before" : "after",
    );
    assert.equal(
      (await restarted.get(project.id)).revision,
      point === "before source rename" ? 1 : 2,
    );
    const entries = await restarted.history(project.id, "native.txt");
    assert.ok(
      (
        await Promise.all(
          entries.map(
            async (v) =>
              (await restarted.historyVersion(project.id, v.id)).content,
          ),
        )
      ).includes("after"),
    );
    assert.deepEqual(
      await fs.readdir(
        path.join(store.root(project.id), ".cutucircuits-transactions"),
      ),
      [],
    );
  });
}

test("a terminal edit after source replacement is preserved and prevents manifest advancement", async (t) => {
  const { store, project, options } = await fixture(t);
  const initial = await store.write(project.id, "native.txt", "before", null);
  const source = path.join(store.root(project.id), "native.txt");
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    const result = await rename(...args);
    if (String(args[1]) === source)
      await fs.writeFile(source, "terminal after rename");
    return result;
  });
  await assert.rejects(
    store.write(project.id, "native.txt", "after", initial.sha256),
    (e: any) => e.code === "HASH_CONFLICT",
  );
  assert.equal((await store.get(project.id)).revision, 1);
  t.mock.restoreAll();
  await store.close();
  const restarted = await new ProjectStore(options).init();
  t.after(() => restarted.close());
  assert.equal(
    (await restarted.read(project.id, "native.txt")).content,
    "terminal after rename",
  );
  assert.equal((await restarted.get(project.id)).revision, 1);
});

test("abrupt process exit after durable source rename recovers the manifest on startup", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { store, project, options } = await fixture(t);
  const initial = await store.write(project.id, "native.txt", "before", null);
  await store.close();
  const program = `
    import { promises as fs } from 'node:fs';
    import { ProjectStore } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../src/store.ts")).href)};
    const store = await new ProjectStore(${JSON.stringify(options)}).init();
    const rename = fs.rename.bind(fs);
    fs.rename = async (...args) => {
      if (String(args[1]) === ${JSON.stringify(path.join(store.root(project.id), PROJECT_FILE))}) process.exit(73);
      return rename(...args);
    };
    await store.write(${JSON.stringify(project.id)}, 'native.txt', 'process source', ${JSON.stringify(initial.sha256)});
    process.exit(99);
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", program],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 73, result.stderr);
  const restarted = await new ProjectStore(options).init();
  t.after(() => restarted.close());
  assert.equal(
    (await restarted.read(project.id, "native.txt")).content,
    "process source",
  );
  assert.equal((await restarted.get(project.id)).revision, 2);
});

test("new native asset content and registration share the recoverable save journal", async (t) => {
  const { store, project, options } = await fixture(t);
  const asset = {
    id: "robot-source",
    name: "Robot",
    path: "models/imported.urdf",
    kind: "urdf" as const,
    entityIds: [],
  };
  const manifest = path.join(store.root(project.id), PROJECT_FILE);
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === manifest)
      throw new Error("import manifest interruption");
    return rename(...args);
  });
  await assert.rejects(
    store.importAsset(project.id, asset, "<robot name='native'/>"),
    /import manifest interruption/,
  );
  assert.equal(
    (await store.get(project.id)).assets.some((a) => a.id === asset.id),
    false,
  );
  assert.equal(
    await fs.readFile(path.join(store.root(project.id), asset.path), "utf8"),
    "<robot name='native'/>",
  );
  t.mock.restoreAll();
  await store.close();
  const restarted = await new ProjectStore(options).init();
  t.after(() => restarted.close());
  const recovered = await restarted.get(project.id);
  assert.equal(recovered.revision, 1);
  assert.deepEqual(
    recovered.assets.find((a) => a.id === asset.id),
    asset,
  );
  await assert.rejects(
    restarted.importAsset(
      project.id,
      { ...asset, path: "models/second.urdf" },
      "content",
    ),
    (e: any) => e.code === "ASSET_CONFLICT",
  );
  await assert.rejects(
    restarted.read(project.id, "models/second.urdf"),
    (e: any) => e.code === "NOT_FOUND",
  );
  await assert.rejects(
    restarted.importAsset(project.id, { ...asset, id: "other" }, "content"),
    (e: any) => e.code === "HASH_CONFLICT",
  );
  const result = await restarted.importAsset(
    project.id,
    { ...asset, id: "new", path: "models/new.urdf" },
    "native source",
  );
  assert.equal(result.file.content, "native source");
  assert.equal(result.project.revision, 2);
  assert.equal(result.asset.path, "models/new.urdf");
});
