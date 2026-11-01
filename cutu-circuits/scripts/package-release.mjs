// Produce a clean, independently uploadable product without touching the working Git repository.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "artifacts/release");
const product = resolve(output, "cutu-circuits");
const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? 1793404800);
if (!Number.isSafeInteger(epoch) || epoch < 315532800 || epoch > 4354819199) {
  throw new Error("SOURCE_DATE_EPOCH must be a whole UTC second within ZIP's 1980–2107 range");
}
const date = new Date(epoch * 1000);
const iso = date.toISOString();
const commitDate = process.env.SOURCE_DATE_EPOCH === undefined ? new Date().toISOString() : iso;
const directories = ["apps", "packages", "examples", "plugins", "tests"];
const files = [
  ".agents/plugins/marketplace.json", ".gitignore", "README.md", "THIRD-PARTY-NOTICES.md",
  "package.json", "package-lock.json", "sources.lock.json", "tsconfig.json", "playwright.config.ts",
  "docs/architecture.md", "docs/contracts.md", "docs/demo.md", "docs/model-reference.md",
  "docs/robotics-and-recovery.md", "docs/release.md",
  "scripts/prepare-upstream.mjs", "scripts/package-release.mjs", "scripts/demo-preflight.mjs",
  "scripts/demo-record.mjs", "scripts/start-demo.mjs",
];
// Keep native code and the history feature; exclude local history/data and development artifacts.
const forbidden = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "artifacts", "sources", "research",
  "__pycache__", ".pytest_cache", ".cache", ".vite", ".turbo", "coverage", "test-results",
  "playwright-report", ".pio", ".local", ".cutucircuits", ".cutucircuits-data",
  ".cutucircuits-history", ".cutucircuits-transactions", ".cutucircuits-transaction-conflicts",
]);
function excluded(path) {
  const parts = path.split("/");
  const name = parts.at(-1);
  return parts.some(part => forbidden.has(part) || part.startsWith(".cutucircuits-")) ||
    name === "AGENTS.md" || name === ".DS_Store" || name === "secrets.h" ||
    name.startsWith(".env") || /\.(?:pyc|pyo|tsbuildinfo|log)$/.test(name);
}
const selection = new Set(files);
async function collect(path) {
  if (excluded(path)) return;
  const stat = await lstat(resolve(root, path));
  if (stat.isSymbolicLink()) throw new Error(`Release source must not contain symlinks: ${path}`);
  if (stat.isDirectory()) {
    for (const entry of (await readdir(resolve(root, path))).sort()) await collect(`${path}/${entry}`);
  } else if (stat.isFile()) selection.add(path);
}
for (const directory of directories) await collect(directory);
// A copied Codex plugin must run without repository dependencies or a build step.
for (const file of ["server.mjs", "THIRD_PARTY_LICENSES.txt"]) {
  selection.add(`plugins/cutucircuits/dist/${file}`);
}
const paths = [...selection].sort();
for (const required of [
  "packages/electronics-editor/LICENSE", "packages/electronics-editor/THIRD_PARTY_NOTICES.md",
  "packages/cad-editor/LICENSE", "packages/cad-editor/THIRD-PARTY-NOTICES.md",
  "packages/ui/NOTICE.md", "packages/ui/src/streaming-text.LICENSE",
  "examples/spidey/firmware/src/main.cpp", "examples/spidey/model.replicad.ts",
  "examples/spidey/spidey.urdf", "apps/web/src/HistoryPanel.tsx",
]) {
  if (!selection.has(required)) throw new Error(`Required native source or notice missing: ${required}`);
}
for (const path of paths) {
  const stat = await lstat(resolve(root, path));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Required release file unavailable: ${path}`);
}
const meshes = paths.filter(path => path.startsWith("examples/spidey/meshes/") && path.endsWith(".stl"));
if (meshes.length !== 81) throw new Error(`Expected all 81 Makada STL files, found ${meshes.length}`);
for (const path of paths.filter(path => path.endsWith("/package.json") || path === "package.json")) {
  const pkg = JSON.parse(await readFile(resolve(root, path), "utf8"));
  if (pkg.name !== "cutucircuits" && !pkg.name?.startsWith("@cutucircuits/")) {
    throw new Error(`Product package lacks Cutu Circuits branding: ${path}`);
  }
}
for (const path of ["plugins/cutucircuits/plugin.json", "plugins/cutucircuits/.codex-plugin/plugin.json"]) {
  const manifest = JSON.parse(await readFile(resolve(root, path), "utf8"));
  if (manifest.name !== "cutucircuits") throw new Error(`Unexpected plugin name: ${path}`);
}

// Replacing only the generated output leaves working sources, data and Git metadata untouched.
await mkdir(output, { recursive: true });
await rm(product, { recursive: true, force: true });
await mkdir(product, { recursive: true });
const entries = [];
for (const path of paths) {
  const destination = resolve(product, path);
  await mkdir(dirname(destination), { recursive: true });
  let content = await readFile(resolve(root, path));
  if (path === "docs/model-reference.md") {
    const source = content.toString("utf8");
    const assumptions = source.slice(source.indexOf("## Estimated scale and parameters"), source.indexOf("## Validation evidence"))
      .replace("All remaining placement is estimated from the photograph's proportions and perspective.", "The remaining dimensions and placement are estimates.");
    if (!assumptions.startsWith("## Estimated scale")) throw new Error("Makada model reference structure changed");
    content = Buffer.from(`# Makada model reference\n\nThe native model in \`examples/spidey/model.replicad.ts\` describes a compact assembly of three micro servos, cross horns, bonded wire legs and leads. Its dimensions and material properties are estimates. A NodeMCU 1.0 ESP-12E is modeled at the rear (+Y), with estimated mounting and component envelopes, and a separate external regulated servo power rail. D5/GPIO14, D6/GPIO12 and D7/GPIO13 terminate at their physical header pads; the rail shares ground with the controller.\n\n## Construction reference\n\nDmitryDzz's [Robot Beetle Ringo](https://www.instructables.com/Beetle-Ringo/) describes the three-servo mechanism. [Tripod gait](https://www.instructables.com/Beetle-Ringo/#step4) explains the coupled front/hind wire legs and middle tilt pair. [Assembly](https://www.instructables.com/Beetle-Ringo/#step7) describes the vertical side shafts, horizontal middle shaft and cross horns. [Making legs](https://www.instructables.com/Beetle-Ringo/#step8) describes bent-wire parts, horn attachments and glue feet. These references explain construction; they do not establish measured dimensions for this model. The included firmware and wiring source define Makada's ESP8266 electrical configuration.\n\n${assumptions.trim()}\n`);
  }
  if (path === "docs/contracts.md") {
    content = Buffer.from(content.toString("utf8").replace(/^Root owns package\.json.*\n\n/m, ""));
  }
  await writeFile(destination, content);
  await chmod(destination, 0o644);
  entries.push({ path, content, sha256: createHash("sha256").update(content).digest("hex") });
}
// Store-only metadata is generated deterministically; source ZIP never contains .git.
const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const git = args => execFileSync("git", args, {
  cwd: product, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  env: { ...gitEnvironment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "0", GIT_AUTHOR_NAME: "Cutu Circuits Release",
    GIT_AUTHOR_EMAIL: "release@example.invalid", GIT_COMMITTER_NAME: "Cutu Circuits Release",
    GIT_COMMITTER_EMAIL: "release@example.invalid", GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate },
});
git(["init", "--initial-branch=main", "."]);
git(["config", "--local", "user.name", "Cutu Circuits Release"]);
git(["config", "--local", "user.email", "release@example.invalid"]);
git(["config", "--local", "commit.gpgsign", "false"]);
git(["config", "--local", "core.autocrlf", "false"]);
git(["add", "--force", "--", "."]);
git(["-c", "core.hooksPath=/dev/null", "commit", "--no-gpg-sign", "-m", "Initial Cutu Circuits release"]);
const commit = git(["rev-parse", "HEAD"]).trim();
if (git(["rev-list", "--all", "--count"]).trim() !== "1" || git(["remote"]).trim()) {
  throw new Error("Release repository must contain exactly one commit and no remotes");
}

// Minimal deterministic ZIP writer: normalized paths, permissions, timestamps, ordering and compression.
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
const local = [], central = [];
let offset = 0;
for (const entry of entries) {
  const name = Buffer.from(`cutu-circuits/${entry.path}`);
  const compressed = deflateRawSync(entry.content, { level: 9 });
  const crc = crc32(entry.content);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
  header.writeUInt16LE(dosTime, 10); header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(entry.content.length, 22); header.writeUInt16LE(name.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x314, 4);
  header.copy(directory, 6, 4, 28);
  directory.writeUInt32LE((0o100644 * 65536) >>> 0, 38); directory.writeUInt32LE(offset, 42);
  central.push(directory, name); local.push(header, name, compressed);
  offset += header.length + name.length + compressed.length;
}
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...local, directory, end]);
const archiveHash = createHash("sha256").update(archive).digest("hex");
await writeFile(resolve(output, "clean-source.zip"), archive);
await writeFile(resolve(output, "SHA256SUMS"), `${archiveHash}  clean-source.zip\n`);
await writeFile(resolve(output, "manifest.json"), `${JSON.stringify({
  product: "Cutu Circuits", version: JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).version,
  format: 1, reproducibleTimestamp: iso, initialCommit: commit, initialCommitDate: commitDate, sourceFiles: entries.length,
  archive: { name: "clean-source.zip", bytes: archive.length, sha256: archiveHash },
  files: entries.map(({ path, content, sha256 }) => ({ path, bytes: content.length, sha256 })),
}, null, 2)}\n`);
console.log(`Clean release: ${product}\nInitial commit: ${commit}\nArchive: ${archive.length} bytes; ${entries.length} files\nSHA-256: ${archiveHash}`);
