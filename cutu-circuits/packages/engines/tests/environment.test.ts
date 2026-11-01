import test from "node:test";
import assert from "node:assert/strict";
import { engineEnvironment } from "../src/index";

test("engineering children do not inherit provider keys, while normal process setup survives", () => {
  const original = { PATH: "path-value", SystemRoot: "system-value", CEREBRAS_API_KEY: "one", Exa_Api_Key: "two", OPENAI_API_KEY: "three" };
  const child = engineEnvironment(original);
  assert.deepEqual(child, { PATH: "path-value", SystemRoot: "system-value" });
  assert.equal(original.CEREBRAS_API_KEY, "one");
});
