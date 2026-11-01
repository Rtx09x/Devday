#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const checking = process.argv.includes('--check');
const skipBuild = process.argv.includes('--skip-build');
let ownedRuntime;
let stopping = false;
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${signal ?? code}`)));
  });
}
async function build() {
  const npm = process.env.npm_execpath;
  if (npm) await run(process.execPath, [npm, 'run', 'build']);
  else await run('npm', ['run', 'build'], { shell: process.platform === 'win32' });
}
async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 10; port++) {
    const free = await new Promise(resolve => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('No free demo port. Close an old demo process and try again.');
}
async function json(base, route, body) {
  const response = await fetch(base + route, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? `${route}: HTTP ${response.status}`);
  return data;
}
async function warm(base) {
  let projects = await json(base, '/api/projects');
  if (!projects.some(project => project.name === 'Robot lab')) {
    await json(base, '/api/projects', { name: 'Robot lab', template: 'robot' });
    projects = await json(base, '/api/projects');
  }
  const spidey = projects.find(project => project.name === 'Makada Demo') ?? projects.find(project => project.name === 'Makada');
  if (!spidey) throw new Error('Makada example is missing. Create a Makada project before presenting.');
  const project = await json(base, `/api/projects/${spidey.id}`);
  const assets = project.assets.filter(asset => asset.kind === 'cad' || asset.kind === 'circuit' || asset.kind === 'urdf');
  for (const asset of assets) {
    process.stdout.write(`Preparing ${asset.name}… `);
    await json(base, `/api/projects/${spidey.id}/${asset.kind === 'urdf' ? 'robotics/inspect' : 'compile'}`, { path: asset.path });
    console.log('ready');
  }
}
function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  ownedRuntime?.kill(signal);
}
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop());

try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Install Node.js 24 or newer before the demo.');
  try { await access(path.join(root, 'node_modules/tsx')); }
  catch { throw new Error('Dependencies are missing. Run npm ci once, then npm run demo.'); }
  if (!skipBuild) await build();
  if (checking) {
    const port = await availablePort(4319);
    await run(process.execPath, ['scripts/demo-preflight.mjs', '--start'], {
      env: { ...process.env, CUTUCIRCUITS_URL: `http://127.0.0.1:${port}` },
    });
  } else {
    const preferred = Number(process.env.PORT ?? 4310);
    if (!Number.isInteger(preferred) || preferred < 1024 || preferred > 65525) throw new Error('PORT must be between 1024 and 65525.');
    const preferredUrl = `http://127.0.0.1:${preferred}`;
    let existing = false;
    try {
      const health = await fetch(preferredUrl + '/api/health', { signal: AbortSignal.timeout(1200) }).then(response => response.json());
      existing = health.name === 'Cutu Circuits' && health.status === 'ok';
    } catch {}
    if (existing) {
      console.log(`Using the running Cutu Circuits workspace: ${preferredUrl}`);
      await warm(preferredUrl);
      console.log(`Demo ready. Open ${preferredUrl}`);
    } else {
      const port = await availablePort(preferred);
      const base = `http://127.0.0.1:${port}`;
      const dataDir = process.env.CUTUCIRCUITS_DATA_DIR ?? path.join(root, '.cutucircuits-demo');
      console.log('Opening saved projects and checking native files…');
      ownedRuntime = spawn(process.execPath, ['--import', 'tsx', 'packages/runtime/src/main.ts'], {
        cwd: root, stdio: 'inherit',
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CUTUCIRCUITS_DATA_DIR: dataDir },
      });
      ownedRuntime.once('error', error => { console.error(error.message); process.exitCode = 1; });
      const exited = new Promise(resolve => ownedRuntime.once('exit', (code, signal) => resolve({ code, signal })));
      const deadline = Date.now() + 120_000;
      while (true) {
        try { await json(base, '/api/health'); break; }
        catch (error) {
          if (ownedRuntime.exitCode !== null || Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
      console.log(`Preparing Cutu Circuits at ${base}`);
      await warm(base);
      console.log(`\nDemo ready. Open ${base}\nDemo projects: ${dataDir}\nNo physical hardware operation has been started. Press Ctrl+C to stop.`);
      const result = await exited;
      if (!stopping && result.code !== 0) throw new Error(`Runtime stopped unexpectedly (${result.signal ?? result.code}).`);
    }
  }
} catch (error) {
  console.error(`Cutu Circuits demo: ${error instanceof Error ? error.message : error}`);
  stop();
  process.exitCode = 1;
}
