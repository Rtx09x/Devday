// Construct a fresh submission artifact; never change source bytes, metadata, or Git history.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const productName = 'cutu-devday-delhi-2026-11-01';
const rootFiles = ['Start-Workspace.ps1', '.env.local.example', 'README.md', 'Setup-Workspace.ps1', 'Activate-Workspace.ps1', 'workspace.ps1', '.gitignore'];
const optionalRootFiles = ['scripts/build-makada.mjs', 'requirements.txt', 'requirements-dev.txt', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'NOTICE', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md'];
const providerNames = { Cerebras: '@cutucircuits/cerebras', Exa: '@cutucircuits/exa' };
const pluginDist = new Set(['cutu-circuits/plugins/cutucircuits/dist/server.mjs', 'cutu-circuits/plugins/cutucircuits/dist/THIRD_PARTY_LICENSES.txt']);
const blocked = new Set(['.git', '.hg', '.svn', '.tools', '.venv', 'node_modules', 'dist', 'artifacts', 'test-results', 'playwright-report', '.pio', '.cache', '.local', '.ssh', '.aws', '.azure', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.vite', '.turbo', 'coverage']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = path => path.split(sep).join('/');
function within(root, target) {
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Target must remain strictly within the workspace.');
  return target;
}
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function excluded(path) {
  const parts = path.split('/');
  const name = parts.at(-1).toLowerCase();
  return parts.some(part => blocked.has(part.toLowerCase()) || part.toLowerCase().startsWith('.cutucircuits')) ||
    (name.startsWith('.env') && name !== '.env.example' && path !== '.env.local.example') ||
    /^(?:secrets?\.(?:h|json|ya?ml|toml|txt)|credentials(?:\..*)?|id_rsa|id_ed25519|\.npmrc|\.netrc|\.pypirc|\.ds_store)$/i.test(name) ||
    /\.(?:pem|key|p12|pfx|pyc|pyo|log|tsbuildinfo)$/i.test(name);
}
async function regular(root, path) {
  const target = within(root, resolve(root, path));
  const info = await lstat(target);
  within(root, await realpath(target));
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Required regular source file missing: ${path}`);
  return info;
}
export async function selectSubmission(root) {
  root = await realpath(root);
  const selected = new Set();
  async function collect(path) {
    if (excluded(path)) return;
    const target = within(root, resolve(root, path));
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`Symlinks are not permitted in the submission: ${path}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(target)).sort()) await collect(`${path}/${name}`);
    } else if (info.isFile()) selected.add(path);
    else throw new Error(`Unsupported source file type: ${path}`);
  }
  for (const path of rootFiles) { await regular(root, path); selected.add(path); }
  for (const path of optionalRootFiles) if (await exists(resolve(root, path))) { await regular(root, path); selected.add(path); }
  for (const folder of ['Cerebras', 'Exa', 'cutu-circuits']) await collect(folder);
  // Include this helper so the submission's packaging procedure remains inspectable.
  if (await exists(resolve(root, 'scripts/package-submission.mjs'))) {
    await regular(root, 'scripts/package-submission.mjs'); selected.add('scripts/package-submission.mjs');
  }
  for (const path of pluginDist) if (await exists(resolve(root, path))) { await regular(root, path); selected.add(path); }
  const pluginServer = 'cutu-circuits/plugins/cutucircuits/dist/server.mjs';
  const pluginLicense = 'cutu-circuits/plugins/cutucircuits/dist/THIRD_PARTY_LICENSES.txt';
  if (selected.has(pluginServer) !== selected.has(pluginLicense)) throw new Error('Plugin bundle and its third-party license file must appear together.');
  for (const [folder, name] of Object.entries(providerNames)) {
    for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'src/index.ts', 'README.md', '.env.example']) {
      if (!selected.has(`${folder}/${path}`)) throw new Error(`Required provider entrypoint missing: ${folder}/${path}`);
    }
    const pkg = JSON.parse(await readFile(resolve(root, folder, 'package.json'), 'utf8'));
    if (pkg.name !== name || pkg.type !== 'module' || pkg.exports?.['.']?.import !== './dist/index.js' || pkg.exports?.['.']?.types !== './dist/index.d.ts' || !pkg.scripts?.build) {
      throw new Error(`Unexpected provider package contract: ${folder}`);
    }
  }
  for (const path of ['cutu-circuits/package.json', 'cutu-circuits/package-lock.json', 'cutu-circuits/requirements.txt', 'cutu-circuits/THIRD-PARTY-NOTICES.md']) {
    if (!selected.has(path)) throw new Error(`Required application input missing: ${path}`);
  }
  // Attribution for the vendored editors and streaming UI is a release requirement.
  for (const path of [
    'packages/electronics-editor/LICENSE', 'packages/electronics-editor/THIRD_PARTY_NOTICES.md',
    'packages/cad-editor/LICENSE', 'packages/cad-editor/THIRD-PARTY-NOTICES.md',
    'packages/ui/NOTICE.md', 'packages/ui/src/streaming-text.LICENSE',
  ]) if (!selected.has(`cutu-circuits/${path}`)) throw new Error(`Required third-party attribution missing: ${path}`);
  const files = [];
  for (const path of [...selected].sort()) {
    if (excluded(path) && !pluginDist.has(path)) throw new Error(`Forbidden submission path: ${path}`);
    const bytes = await readFile(resolve(root, path));
    if ((path.endsWith('/.env.example') || path === '.env.local.example') && bytes.toString('utf8').split(/\r?\n/).some(line => line.trim() && !line.trim().startsWith('#') && !/^[A-Za-z_][A-Za-z0-9_]*=\s*$/.test(line.trim()))) {
      throw new Error(`Only blank environment examples may be packaged: ${path}`);
    }
    files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
  }
  return files;
}

// Standard ZIP (deflate), UTF-8 names, UTC-derived DOS timestamps at artifact creation.
function makeZip(entries, date) {
  if (entries.length > 65535) throw new Error('ZIP64 required; too many files.');
  const year = date.getUTCFullYear();
  if (year < 1980 || year > 2107) throw new Error('Current date is outside ZIP timestamp range.');
  const time = date.getUTCHours() << 11 | date.getUTCMinutes() << 5 | date.getUTCSeconds() >> 1;
  const day = (year - 1980) << 9 | (date.getUTCMonth() + 1) << 5 | date.getUTCDate();
  const table = Array.from({ length: 256 }, (_, n) => {
    for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1;
    return n >>> 0;
  });
  const local = [], central = [];
  let offset = 0;
  for (const { path, content } of entries) {
    let crc = 0xffffffff;
    for (const byte of content) crc = table[(crc ^ byte) & 255] ^ crc >>> 8;
    crc = (crc ^ 0xffffffff) >>> 0;
    const name = Buffer.from(`${productName}/${path}`);
    const compressed = deflateRawSync(content, { level: 6 });
    if (content.length > 0xffffffff || compressed.length > 0xffffffff || offset > 0xffffffff) throw new Error('ZIP64 required; archive too large.');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(time, 10); header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(content.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x314, 4);
    header.copy(directory, 6, 4, 28);
    directory.writeUInt32LE((0o100644 * 65536) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  if (offset + directory.length > 0xffffffff) throw new Error('ZIP64 required; archive too large.');
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function packageSubmission(root, { dryRun = false, initGit = false } = {}) {
  root = await realpath(root);
  const files = await selectSubmission(root);
  const now = new Date();
  const manifest = {
    format: 1, product: 'Cutu Circuits', generatedAt: now.toISOString(),
    provenance: 'Fresh release snapshot of existing sources. Artifact creation time is not original authorship time. Existing source bytes, licenses, notices and provenance are preserved; original files and Git history are untouched.',
    archiveTimestamps: 'ZIP entries use artifact creation time in UTC-derived DOS fields (two-second precision, no timezone field); copied files receive their actual current filesystem write times. Historical source dates are not rewritten.',
    build: 'Run Setup-Workspace.ps1. Provider dist is generated from included sources. Only the standalone plugin bundle and its licenses are retained from dist when present.',
    freshLocalGitRequested: initGit, files,
  };
  if (dryRun) { console.log(JSON.stringify({ dryRun: true, ...manifest }, null, 2)); return; }
  // Resolve real parent before creating output. No recursive deletion or overwrite is used.
  const tools = within(root, resolve(root, '.tools'));
  await mkdir(tools, { recursive: true });
  within(root, await realpath(tools));
  const parent = within(root, resolve(tools, 'submission'));
  await mkdir(parent, { recursive: true });
  within(root, await realpath(parent));
  let output = within(root, resolve(parent, productName));
  if (await exists(output)) output = within(root, resolve(parent, `${productName}-${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`));
  await mkdir(output); // Exclusive directory creation, never replace an existing artifact.
  const entries = [];
  for (const file of files) {
    const content = await readFile(resolve(root, file.path));
    if (digest(content) !== file.sha256) throw new Error(`Source changed during packaging; rerun after it is stable: ${file.path}`);
    const destination = within(output, resolve(output, file.path));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, { flag: 'wx' });
    entries.push({ path: file.path, content });
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(resolve(output, 'SUBMISSION-MANIFEST.json'), manifestBytes, { flag: 'wx' });
  entries.push({ path: 'SUBMISSION-MANIFEST.json', content: manifestBytes });
  const archive = makeZip(entries, now), archivePath = `${output}.zip`;
  await writeFile(archivePath, archive, { flag: 'wx' });
  await writeFile(`${output}.sha256`, `${digest(archive)}  ${archivePath.split(sep).at(-1)}\n`, { flag: 'wx' });
  if (initGit) {
    // Explicit flag creates a local snapshot only, with current actual commit dates.
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const git = args => execFileSync('git', args, { cwd: output, encoding: 'utf8', env: { ...cleanEnv,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Cutu Circuits Release', GIT_AUTHOR_EMAIL: 'release@example.invalid',
      GIT_COMMITTER_NAME: 'Cutu Circuits Release', GIT_COMMITTER_EMAIL: 'release@example.invalid',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '--initial-branch=main']);
    git(['-c', 'core.autocrlf=false', 'add', '--force', '--', '.']);
    git(['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, 'commit', '--no-gpg-sign', '-m', 'Release snapshot for DevDay Delhi submission; existing source provenance retained']);
    if (git(['remote']).trim()) throw new Error('Unexpected Git remote in fresh local snapshot.');
  }
  console.log(JSON.stringify({ output, archive: archivePath, sha256: digest(archive), files: files.length, generatedAt: manifest.generatedAt, localGitInitialized: initGit }, null, 2));
}

async function selfTest() {
  // Temporary external fixture exercises selection only; no real source packaging or Git work.
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const assert = (await import('node:assert/strict')).default;
  const temp = await mkdtemp(resolve(tmpdir(), 'cutu-submission-selection-'));
  try {
    const put = async (path, value = 'fixture') => { const dest = within(temp, resolve(temp, path)); await mkdir(dirname(dest), { recursive: true }); await writeFile(dest, value); };
    for (const path of rootFiles) await put(path, path === '.env.local.example' ? '# Provider keys\nCEREBRAS_API_KEY=\nEXA_API_KEY=\n' : 'fixture');
    for (const [folder, name] of Object.entries(providerNames)) {
      await put(`${folder}/package.json`, JSON.stringify({ name, type: 'module', exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } }, scripts: { build: 'tsc' } }));
      for (const name of ['package-lock.json', 'tsconfig.json', 'src/index.ts', 'README.md']) await put(`${folder}/${name}`);
      await put(`${folder}/.env.example`, '# key stays blank\nAPI_KEY=\n');
    }
    for (const path of ['package.json', 'package-lock.json', 'requirements.txt', 'THIRD-PARTY-NOTICES.md', 'packages/runtime/src/agent.ts', 'examples/device/LICENSE',
      'packages/electronics-editor/LICENSE', 'packages/electronics-editor/THIRD_PARTY_NOTICES.md',
      'packages/cad-editor/LICENSE', 'packages/cad-editor/THIRD-PARTY-NOTICES.md',
      'packages/ui/NOTICE.md', 'packages/ui/src/streaming-text.LICENSE',
    ]) await put(`cutu-circuits/${path}`);
    for (const path of ['.env', '.env.production', 'secrets.h', 'auth.key', '.cutucircuits-data/history.json', 'node_modules/private.txt', 'dist/cache.js', 'artifacts/old.zip', '__pycache__/a.pyc']) await put(`cutu-circuits/${path}`);
    await put('old-starting.zip'); await put('unrelated-root.txt');
    let chosen = await selectSubmission(temp);
    assert(chosen.some(x => x.path.endsWith('agent.ts')));
    assert(chosen.some(x => x.path.endsWith('/LICENSE')));
    assert(!chosen.some(x => /private|history|production|secrets|auth\.key|old-starting|unrelated-root|cache\.js/.test(x.path)));
    // No plugin bundle is valid; when bundled, its attribution must travel with it.
    await put('cutu-circuits/plugins/cutucircuits/dist/server.mjs');
    await assert.rejects(selectSubmission(temp), /third-party license/);
    await put('cutu-circuits/plugins/cutucircuits/dist/THIRD_PARTY_LICENSES.txt');
    chosen = await selectSubmission(temp);
    assert(chosen.some(x => x.path.endsWith('/dist/server.mjs')));
    await put('Exa/.env.example', 'EXA_API_KEY=secret\n');
    await assert.rejects(selectSubmission(temp), /blank environment/);
    await put('Exa/.env.example', 'EXA_API_KEY=\n');
    await put('Exa/package.json', JSON.stringify({ name: 'wrong' }));
    await assert.rejects(selectSubmission(temp), /provider package contract/);
    console.log('Selection fixture passed: secrets/history/build artifacts excluded; sources/licenses retained; plugin pair, blank env and provider contracts enforced.');
  } finally {
    // Only remove the exact verified directory created by mkdtemp in the OS temp root.
    const absolute = await realpath(temp);
    within(await realpath(tmpdir()), absolute);
    if (!absolute.split(sep).at(-1).startsWith('cutu-submission-selection-')) throw new Error('Unexpected fixture cleanup target.');
    await rm(absolute, { recursive: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--dry-run', '--init-git', '--self-test'].includes(arg))) throw new Error('Usage: node scripts/package-submission.mjs [--dry-run] [--init-git] | --self-test');
  if (args.includes('--self-test')) {
    if (args.length !== 1) throw new Error('--self-test cannot be combined with packaging flags.');
    await selfTest();
  } else await packageSubmission(workspace, { dryRun: args.includes('--dry-run'), initGit: args.includes('--init-git') });
}



