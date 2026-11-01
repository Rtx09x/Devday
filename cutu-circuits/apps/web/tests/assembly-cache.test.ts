import test from "node:test";
import assert from "node:assert/strict";
import { createAssemblyCache, sceneIdentity } from "../src/assemblyCache";
import type { CadResult, EngineResult, FileSnapshot, Project } from "@cutucircuits/core";

test("assembly reuses a successful result, isolates projects, and recompiles changed source", async () => {
  let sha = "a", count = 0;
  const load = createAssemblyCache(
    async (_id, path) => ({ path, content: "", sha256: sha } as FileSnapshot),
    async () => { count++; return { kind: "cad", sourceSha256: sha } as EngineResult; },
  );
  const first = await load("a", "model.cad.ts");
  assert.equal(await load("a", "model.cad.ts"), first);
  assert.equal(count, 1);
  await load("b", "model.cad.ts");
  assert.equal(count, 2);
  sha = "b";
  assert.notEqual(await load("a", "model.cad.ts"), first);
  assert.equal(count, 3);
});

test("source race and failed compilation are not cached", async () => {
  let calls = 0;
  const load = createAssemblyCache(
    async () => ({ path: "x", content: "", sha256: "before" } as FileSnapshot),
    async () => { calls++; return { kind: "cad", sourceSha256: calls === 1 ? "after" : "before" } as CadResult; },
  );
  await assert.rejects(load("p", "x"), /changed during compilation/);
  await load("p", "x");
  assert.equal(calls, 2);
});

test("a project switch during the source read does not start compilation", async () => {
  let finish!: (snapshot: FileSnapshot) => void;
  let calls = 0;
  const load = createAssemblyCache(
    () => new Promise<FileSnapshot>((resolve) => { finish = resolve; }),
    async () => { calls++; return { kind: "cad", sourceSha256: "a" } as CadResult; },
  );
  let active = true;
  const pending = load("old-project", "x", () => active);
  active = false;
  finish({ path: "x", content: "", sha256: "a" });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 0);
});

test("explicit refresh bypasses browser cache and asks the runtime to recompute", async () => {
  const forces: boolean[] = [];
  const load = createAssemblyCache(
    async () => ({ path: "x", content: "", sha256: "a" } as FileSnapshot),
    async (_id, _path, force) => { forces.push(force); return { kind: "cad", sourceSha256: "a" } as CadResult; },
  );
  await load("p", "x");
  await load("p", "x");
  await load("p", "x", () => true, true);
  assert.deepEqual(forces, [false, true]);
});

test("scene identity tracks geometry and motion, not unrelated project revisions", () => {
  const project = { id: "a", entities: [{ id: "part", position: [0, 0, 0] }], motion: { phases: [] }, revision: 1 } as unknown as Project;
  assert.equal(sceneIdentity(project), sceneIdentity({ ...project, revision: 2 }));
  assert.notEqual(sceneIdentity(project), sceneIdentity({ ...project, entities: [{ ...project.entities[0], position: [1, 0, 0] }] }));
  assert.notEqual(sceneIdentity(project), sceneIdentity({ ...project, id: "b" }));
});
