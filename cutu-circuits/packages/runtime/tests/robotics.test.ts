import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRuntime } from "../src/server.ts";
import { robotAssetPath } from "../src/robot-assets.ts";

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cutu-robot-api-"));
  const dataDir = path.join(directory, ".project-data");
  const runtime = await createRuntime({
    dataDir,
    seed: false,
    port: 0,
    pollIntervalMs: 0,
  });
  const server = await runtime.listen();
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api`;
  const request = (url: string, body?: unknown) =>
    fetch(
      base + url,
      body === undefined
        ? undefined
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
  return {
    runtime,
    dataDir,
    base,
    request,
    async close() {
      await runtime.close();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}
test("robot HTTP imports, local assets and real headless dynamics share a persisted project", async () => {
  const f = await fixture();
  try {
    const p = await (
      await f.request("/projects", { name: "Robot API", template: "robot" })
    ).json();
    const root = `/projects/${p.id}`;
    assert.equal(p.assets[0].kind, "urdf");
    const inspected = await f.request(`${root}/robotics/inspect`, {
      path: "arm.urdf",
    });
    assert.equal(inspected.status, 200);
    const model = await inspected.json();
    assert.equal(model.model.units, "m-kg-s-rad");
    assert.equal(model.model.links.length, 3);
    const simulated = await f.request(`${root}/robotics/simulate`, {
      path: "arm.urdf",
      fixedBase: true,
      durationSeconds: 0.5,
      jointTargets: { shoulder: 0.4, extension: 0.1 },
    });
    assert.equal(simulated.status, 200, await simulated.clone().text());
    const state = await simulated.json();
    assert.equal(state.source, "simulated");
    assert.equal(state.sourceSha256, model.sourceSha256);
    assert(state.final.time >= 0.5 - 1e-6);
    assert(state.final.joints.shoulder.position > 0.1);
    assert(Math.abs(state.final.joints.shoulder.position) < 1.21);
    const falling = await f.request(`${root}/robotics/simulate`, {
      path: "arm.urdf",
      fixedBase: false,
      ground: true,
      position: [0, 0, 0.3],
      durationSeconds: 1,
    });
    assert.equal(falling.status, 200, await falling.clone().text());
    const fall = await falling.json();
    assert(
      fall.final.links.base.position[2] <
        fall.initial.links.base.position[2] - 0.05,
    );
    assert(fall.maxContacts > 0);
    const raw = await fetch(`${f.base}${root}/assets/raw?path=arm.urdf`);
    assert.equal(raw.status, 200);
    assert.match(await raw.text(), /<robot/);
    const xml = await fs.readFile(
      path.resolve("examples/robot/arm.urdf"),
      "utf8",
    );
    const imported = await f.request(`${root}/robotics/import`, {
      path: "robots/imported.urdf",
      content: xml,
      name: "Imported robot",
    });
    assert.equal(imported.status, 201, await imported.clone().text());
    const saved = await imported.json();
    assert.equal(saved.asset.kind, "urdf");
    assert(saved.project.assets.some((a: any) => a.id === saved.asset.id));
    assert.equal(saved.file.content, xml);
    assert.equal(
      (
        await f.request(`${root}/robotics/import`, {
          path: "robots/imported.urdf",
          content: xml,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(`${root}/robotics/simulate`, {
          path: "arm.urdf",
          durationSeconds: 1000,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request(`${root}/robotics/import`, {
          path: "bad.urdf",
          content: '<!DOCTYPE robot><robot name="x"/>',
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await fetch(
          `${f.base}${root}/assets/raw?path=${encodeURIComponent("../outside.stl")}`,
        )
      ).status,
      400,
    );
    assert.equal(
      (await fetch(`${f.base}${root}/assets/raw?path=missing.stl`)).status,
      404,
    );
    assert.equal(
      (
        await fetch(
          `${f.base}${root}/assets/raw?path=cutucircuits.project.json`,
        )
      ).status,
      400,
    );
    await fs.symlink(
      path.resolve("examples/spidey/meshes"),
      path.join(f.dataDir, p.id, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(
      (await fetch(`${f.base}${root}/assets/raw?path=escape/body.stl`)).status,
      400,
    );
  } finally {
    await f.close();
  }
});
test("history HTTP previews are immutable and stale restores preserve newer content", async () => {
  const f = await fixture();
  try {
    const p = await f.runtime.store.create("History API", "blank");
    const first = await f.runtime.store.write(
      p.id,
      "controller.py",
      "print('first')\n",
      null,
    );
    const second = await f.runtime.store.write(
      p.id,
      "controller.py",
      "print('second')\n",
      first.sha256,
    );
    const root = `/projects/${p.id}`;
    const entries = await (
      await f.request(`${root}/history?path=controller.py&limit=100`)
    ).json();
    const old = entries.find((e: any) => e.sha256 === first.sha256);
    assert(old);
    assert.equal(
      (await (await f.request(`${root}/history/${old.id}`)).json()).content,
      first.content,
    );
    const third = await f.runtime.store.write(
      p.id,
      "controller.py",
      "print('terminal')\n",
      second.sha256,
    );
    assert.equal(
      (
        await f.request(`${root}/history/${old.id}/restore`, {
          expectedSha256: second.sha256,
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.runtime.store.read(p.id, "controller.py")).content,
      third.content,
    );
    const restored = await f.request(`${root}/history/${old.id}/restore`, {
      expectedSha256: third.sha256,
    });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).content, first.content);
    const versions = await (
      await f.request(`${root}/history?path=controller.py`)
    ).json();
    assert(versions.some((v: any) => v.sha256 === third.sha256));
    assert(versions.some((v: any) => v.reason === "restore"));
    assert.equal((await f.request(`${root}/history?limit=1000`)).status, 400);
    assert.equal(
      (
        await f.request(
          `${root}/history?path=${encodeURIComponent(".cutucircuits-history/x")}`,
        )
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});
test("URDF resources resolve deterministically inside the project", () => {
  assert.equal(
    robotAssetPath("robots/arm.urdf", "../meshes/link.stl"),
    "meshes/link.stl",
  );
  assert.equal(
    robotAssetPath(
      "robots/arm.urdf",
      "package://arm_description/meshes/a%20b.stl",
    ),
    "arm_description/meshes/a b.stl",
  );
  for (const invalid of [
    "../../outside.stl",
    "https://example.test/x.stl",
    "/etc/a.stl",
    "file:///a.stl",
    ".cutucircuits-history/x.stl",
    "../.cutucircuits-history/x.stl",
  ])
    assert.throws(() => robotAssetPath("robots/arm.urdf", invalid));
});

test("hidden runtime data serves all authored native STL resources byte for byte", async () => {
  const f = await fixture();
  try {
    const project = await f.runtime.store.create(
      "Makada mesh delivery",
      "spidey",
    );
    const directory = path.join(f.dataDir, project.id, "meshes");
    const names = (await fs.readdir(directory)).filter((name) =>
      name.endsWith(".stl"),
    );
    assert.equal(names.length, 81);
    for (const name of names) {
      const response = await fetch(
        `${f.base}/projects/${project.id}/assets/raw?path=${encodeURIComponent(`meshes/${name}`)}`,
      );
      assert.equal(response.status, 200, name);
      const actual = Buffer.from(await response.arrayBuffer());
      assert(actual.length > 84, name);
      assert.deepEqual(
        actual,
        await fs.readFile(path.join(directory, name)),
        name,
      );
    }
    assert.equal(
      (
        await fetch(
          `${f.base}/projects/${project.id}/assets/raw?path=${encodeURIComponent(".cutucircuits-history/secret.stl")}`,
        )
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});
