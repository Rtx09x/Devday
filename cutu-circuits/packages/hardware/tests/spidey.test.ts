import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const execute = promisify(execFile);
test(
  "project-owned Makada broker passes fake-device protocol tests",
  { timeout: 45_000 },
  async () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const result = await execute(
      process.platform === "win32" ? "python" : "python3",
      ["-m", "unittest", "discover", "-s", "examples/spidey/tests", "-v"],
      { cwd: root, timeout: 40_000, maxBuffer: 128 * 1024 },
    );
    assert.match(result.stderr, /Ran 18 tests/);
    assert.match(result.stderr, /OK/);
  },
);


