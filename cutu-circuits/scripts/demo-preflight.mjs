#!/usr/bin/env node
/** Real, headless production preflight. Never connects to physical hardware. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const start = process.argv.includes('--start');
const base = process.env.CUTUCIRCUITS_URL ?? 'http://127.0.0.1:4310';
const address = new URL(base);
assert(['127.0.0.1', 'localhost'].includes(address.hostname), 'Use a local runtime URL');
const output = path.join(root, 'artifacts/demo-validation');
await mkdir(output, { recursive: true });
const receipt = { startedAt: new Date().toISOString(), url: base, isolatedRuntime: start, checks: [], limitations: ['No browser rendering check in this preflight.', 'No physical hardware connection or installed Codex client is asserted.'] };
let runtime, client, runtimeLog = '', dataDir;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(route, body, binary = false) {
  const response = await fetch(`${base}${route}`, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45_000),
  });
  assert(response.ok, `${route}: HTTP ${response.status}: ${(await response.clone().text()).slice(0, 500)}`);
  return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
}
async function check(name, action) {
  const began = Date.now();
  process.stdout.write(`CHECK ${name} ... `);
  try {
    const detail = await action();
    receipt.checks.push({ name, status: 'pass', durationMs: Date.now() - began, detail });
    console.log('PASS');
    return detail;
  } catch (error) {
    receipt.checks.push({ name, status: 'fail', durationMs: Date.now() - began, error: error.message });
    console.log('FAIL');
    throw error;
  }
}
async function tool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  assert(!result.isError, `${name}: ${JSON.stringify(result.content).slice(0, 1000)}`);
  return JSON.parse(result.content.find(item => item.type === 'text').text);
}
try {
  await check('production build and Node', async () => {
    assert(Number(process.versions.node.split('.')[0]) >= 24, 'Node.js 24 or newer is required');
    await access(path.join(root, 'apps/web/dist/index.html'));
    await access(path.join(root, 'plugins/cutucircuits/dist/server.mjs'));
    return { node: process.version };
  });
  if (start) {
    let occupied = false;
    try { await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1200) }); occupied = true; } catch {}
    assert(!occupied, `${base} is occupied. Stop its runtime or omit --start to check it without stopping it.`);
    dataDir = await mkdtemp(path.join(tmpdir(), 'cutucircuits-demo-'));
    receipt.dataDir = dataDir;
    runtime = spawn(process.execPath, ['--import', 'tsx', 'packages/runtime/src/main.ts'], {
      cwd: root,
      env: { ...process.env, CUTUCIRCUITS_DATA_DIR: dataDir, HOST: address.hostname, PORT: address.port || '4310' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runtime.on('error', error => { runtimeLog += error.message; });
    for (const stream of [runtime.stdout, runtime.stderr]) stream.on('data', chunk => { runtimeLog = (runtimeLog + chunk).slice(-4000); });
  }
  await check('runtime reachable', async () => {
    const deadline = Date.now() + (start ? 30_000 : 1500);
    while (true) {
      try {
        const health = await request('/api/health');
        assert.equal(health.status, 'ok');
        return health;
      } catch (error) {
        if (runtime?.exitCode !== null && runtime?.exitCode !== undefined) throw new Error(`Runtime exited: ${runtimeLog}`);
        if (Date.now() >= deadline) throw error;
        await delay(250);
      }
    }
  });
  await check('built UI and lazy assets served', async () => {
    const html = await fetch(base, { signal: AbortSignal.timeout(10_000) }).then(response => response.text());
    assert(!html.includes('/@vite/client'), 'Development server detected; use built production assets');
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"#]+)"/g)].map(match => match[1]);
    assert(assets.length > 0, 'Production entry assets were not found');
    for (const asset of assets) {
      const response = await fetch(`${base}${asset}`, { signal: AbortSignal.timeout(15_000) });
      assert(response.ok && Number(response.headers.get('content-length')) > 0, `Missing asset ${asset}`);
      await response.arrayBuffer();
    }
    const bundled = await readdir(path.join(root, 'apps/web/dist/assets'));
    let payloadBytes = 0;
    for (const filename of bundled) {
      const response = await fetch(`${base}/assets/${encodeURIComponent(filename)}`, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
      const bytes = Number(response.headers.get('content-length'));
      assert(response.ok && bytes > 0, `Missing production resource: ${filename}`);
      assert(!response.headers.get('content-type')?.includes('text/html'), `Asset returned application HTML: ${filename}`);
      payloadBytes += bytes;
    }
    // Asset delivery is checked here; the browser rehearsal executes the lazy
    // modules. API phases exercise independent disposable engineering workers.
    return { entryAssets: assets, bundledResources: bundled.length, payloadBytes };
  });
  const project = await check('fresh Makada demo copy', async () => {
    const p = await request('/api/projects', { name: `Demo preflight ${new Date().toISOString()}`, template: 'spidey' });
    assert(p.assets.some(asset => asset.path === 'spidey.urdf'));
    assert.equal(p.motion.source, 'commanded');
    receipt.projectId = p.id;
    return { id: p.id, assets: p.assets.length, actuators: p.motion.joints.length };
  });
  const route = `/api/projects/${encodeURIComponent(project.id)}`;
  const baselineCad = await check('native CAD compile', async () => {
    const result = await request(`${route}/compile`, { path: 'model.replicad.ts' });
    assert.equal(result.shapes.length, 81);
    assert(result.metrics.triangleCount > 0);
    for (const name of ["controller", "controller-pin-D5", "controller-pin-D6", "controller-pin-D7"]) assert(result.shapes.some(shape => shape.name === name), `Missing ${name}`);
    return { shapes: result.shapes.length, triangles: result.metrics.triangleCount, parameters: result.parameters, bounds: result.metrics.bounds };
  });
  await check('native circuit compile and SVG export', async () => {
    const result = await request(`${route}/compile`, { path: 'circuit.circuit.tsx' });
    assert(result.components.length >= 5);
    assert(!result.diagnostics.some(item => item.severity === 'error'), JSON.stringify(result.diagnostics));
    const svg = await request(`${route}/export`, { path: 'circuit.circuit.tsx', format: 'svg' });
    assert(svg.content.includes('<svg'));
    await writeFile(path.join(output, 'spidey-wiring.svg'), svg.content);
    return { components: result.components.length, svgBytes: Buffer.byteLength(svg.content) };
  });
  await check('all 81 articulated mesh resources', async () => {
    const source = await request(`${route}/files?path=spidey.urdf`);
    const resources = [...new Set([...source.content.matchAll(/<mesh\s+filename="([^"]+)"/g)].map(match => match[1]))];
    assert.equal(resources.length, 81);
    let bytes = 0;
    for (const resource of resources) {
      const actual = await request(`${route}/assets/raw?path=${encodeURIComponent(resource)}`, undefined, true);
      const expected = await readFile(path.join(root, 'examples/spidey', resource));
      assert.deepEqual(actual, expected, `Resource mismatch: ${resource}`);
      assert(actual.length > 84 && actual.readUInt32LE(80) * 50 + 84 === actual.length, `Invalid binary STL: ${resource}`);
      bytes += actual.length;
    }
    return { resources: resources.length, bytes };
  });
  await check('URDF parse and real Rapier dynamics', async () => {
    const inspection = await request(`${route}/robotics/inspect`, { path: 'spidey.urdf' });
    const result = await request(`${route}/robotics/simulate`, { path: 'spidey.urdf', durationSeconds: 0.5, fixedBase: true, ground: false, gravity: [0, 0, 0], jointTargets: { left: 0.3, right: -0.25, tilt: 0.2 } });
    assert.equal(result.source, 'simulated');
    assert(result.final.time >= 0.49);
    assert(Math.abs(result.final.joints.left.position) > 0.05, 'Physics joint did not move');
    await writeFile(path.join(output, 'spidey-physics.json'), JSON.stringify(result, null, 2) + '\n');
    return { links: inspection.model.links.length, joints: inspection.model.joints.length, simulatedSeconds: result.final.time, leftPosition: result.final.joints.left.position };
  });
  await check('packaged MCP tools, guarded edit and STEP export', async () => {
    client = new Client({ name: 'cutucircuits-demo-preflight', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'plugins/cutucircuits/scripts/launch.mjs')], cwd: tmpdir(), env: { ...process.env, CUTUCIRCUITS_URL: base }, stderr: 'pipe' }));
    const { tools } = await client.listTools();
    for (const name of ['runtime_status', 'read_file', 'write_file', 'compile', 'export', 'simulate_robot']) assert(tools.some(item => item.name === name), `Missing tool: ${name}`);
    await tool('runtime_status');
    const original = await tool('read_file', { projectId: project.id, path: 'model.replicad.ts' });
    assert(original.content.includes('legSpan: 246'), 'Demo parameter no longer matches template');
    const edited = await tool('write_file', { projectId: project.id, path: original.path, expectedSha256: original.sha256, content: original.content.replace('legSpan: 246', 'legSpan: 280') });
    try {
      const compiled = await tool('compile', { projectId: project.id, path: original.path });
      assert.equal(compiled.parameters.legSpan, 280);
      assert.equal(compiled.shapes.length, 81);
      assert(compiled.metrics.bounds.size[0] > baselineCad.bounds.size[0] + 25, 'The wider stance must expand actual CAD bounds');
      const artifact = await tool('export', { projectId: project.id, path: original.path, format: 'step' });
      assert(artifact.content.includes('ISO-10303-21;'), 'Export did not contain STEP data');
      await writeFile(path.join(output, 'spidey-edited.step'), artifact.content);
      return { tools: tools.length, editedParameter: 'legSpan 246 → 280 mm', originalWidth: baselineCad.bounds.size[0], editedWidth: compiled.metrics.bounds.size[0], stepBytes: Buffer.byteLength(artifact.content), sourceHash: edited.sha256 };
    } finally {
      await tool('write_file', { projectId: project.id, path: original.path, expectedSha256: edited.sha256, content: original.content });
    }
  });
  receipt.status = 'pass';
  console.log(`READY: ${receipt.checks.length} real checks passed. Browser rehearsal remains required.`);
} catch (error) {
  receipt.status = 'fail';
  receipt.error = error.message;
  console.error(`NOT READY: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  if (runtime && runtime.exitCode === null) {
    runtime.kill('SIGTERM');
    await Promise.race([new Promise(resolve => runtime.once('exit', resolve)), delay(5000)]);
    if (runtime.exitCode === null) runtime.kill('SIGKILL');
  }
  receipt.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'preflight.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(`Receipt: ${path.join(output, 'preflight.json')}`);
  if (dataDir) console.log(`Isolated rehearsal data: ${dataDir}`);
}
