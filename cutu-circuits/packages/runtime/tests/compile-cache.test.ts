import test from "node:test";
import assert from "node:assert/strict";
import { cadCacheKey, createCompileCache } from "../src/compile-cache";

test("CAD keys isolate project, source and parameters while ignoring parameter order", () => {
  const key = cadCacheKey("a", "model", "hash", { b: true, a: 3 });
  assert.equal(key, cadCacheKey("a", "model", "hash", { a: 3, b: true }));
  assert.notEqual(key, cadCacheKey("b", "model", "hash", { a: 3, b: true }));
  assert.notEqual(key, cadCacheKey("a", "model", "new-hash", { a: 3, b: true }));
  assert.notEqual(key, cadCacheKey("a", "model", "hash", { a: 4, b: true }));
  assert.equal(cadCacheKey("a", "model", "hash", { a: {} }), undefined);
});

test("reuses concurrent successes, evicts errors and honors bounds", async () => {
  const cache = createCompileCache<string>(2, 12);
  let calls = 0;
  const compute = async () => { calls++; return "ok"; };
  await Promise.all([cache.get("one", compute), cache.get("one", compute)]);
  await cache.get("one", compute);
  assert.equal(calls, 1);
  await assert.rejects(cache.get("bad", async () => { throw Error("failure"); }));
  await cache.get("bad", compute);
  assert.equal(calls, 2);
  await cache.get("large", async () => "12345678901234567890");
  await cache.get("large", compute);
  assert.equal(calls, 3);
});

test("forced refresh supersedes an older pending compile without stale overwrite", async () => {
  const cache = createCompileCache<string>();
  let finish!: (value: string) => void;
  const old = cache.get("key", () => new Promise<string>((resolve) => { finish = resolve; }));
  await Promise.resolve();
  const fresh = await cache.get("key", async () => "fresh", true);
  finish("old");
  assert.equal(await old, "old");
  assert.equal(fresh, "fresh");
  assert.equal(await cache.get("key", async () => "wrong"), "fresh");
});
