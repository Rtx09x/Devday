// Preserve the exact viewer fixes shipped by the source electronics extension.
import { readFile, writeFile, readdir, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch, parsePatch, reversePatch } from "diff";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const patchDir = resolve(root, "packages/electronics-editor/patches");
try {
  await access(patchDir);
} catch {
  process.exit(0);
}
for (const name of await readdir(patchDir)) {
  if (!name.endsWith(".patch")) continue;
  const match = name.match(/^(@[^_]+)__([^@]+)@(.+)\.patch$/);
  if (!match) throw new Error(`Unsupported upstream patch filename: ${name}`);
  const packageName = `${match[1]}/${match[2]}`;
  const expected = match[3];
  // npm may retain an exact peer-compatible viewer below its workspace.
  const candidates = [root];
  for (const kind of ["packages", "apps"]) {
    for (const entry of await readdir(resolve(root, kind), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) candidates.push(resolve(root, kind, entry.name));
    }
  }
  let found = false;
  for (const base of candidates) {
    const directory = resolve(base, "node_modules", packageName);
    let installed;
    try {
      installed = JSON.parse(
        await readFile(resolve(directory, "package.json"), "utf8"),
      );
    } catch {
      continue;
    }
    if (installed.version !== expected) continue;
    found = true;
    const patches = parsePatch(await readFile(resolve(patchDir, name), "utf8"));
    const pending = [];
    for (const patch of patches) {
      const relative = patch.oldFileName?.replace(/^a\//, "");
      if (
        !relative ||
        relative.startsWith("/") ||
        relative.split("/").includes("..")
      ) {
        throw new Error(`${packageName}: invalid patch target`);
      }
      const file = resolve(directory, relative);
      const source = await readFile(file, "utf8");
      const changed = applyPatch(source, patch);
      if (changed === false) {
        if (applyPatch(source, reversePatch(patch)) === false) {
          throw new Error(
            `${packageName}: source patch no longer applies to ${relative}`,
          );
        }
      } else pending.push({ file, changed });
    }
    // Preflight every target before changing any, including on Windows without GNU patch.
    for (const { file, changed } of pending) await writeFile(file, changed);
    console.log(
      `${packageName}: ${pending.length ? "preserved upstream viewer patch" : "source patch already applied"}`,
    );
  }
  if (!found) throw new Error(`${packageName}@${expected} is not installed`);
}
