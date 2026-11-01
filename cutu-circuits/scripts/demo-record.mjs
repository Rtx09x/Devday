#!/usr/bin/env node
/** Record actual production UI and packaged MCP on an isolated local broker. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect as baseExpect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.CUTUCIRCUITS_DEMO_PORT ?? 4330);
const base = `http://127.0.0.1:${port}`;
const output = path.join(root, 'artifacts/demo-validation/video');
await mkdir(output, { recursive: true });
const expect = baseExpect.configure({ timeout: 60_000 });
const evidence = { recordedAt: new Date().toISOString(), url: base, viewport: { width: 1440, height: 900 }, chapters: [], tools: [], pageErrors: [], failedResponses: [], optionalFileMisses: [], limitations: ['Actual automated production-browser recording, using software WebGL.', 'Packaged stdio MCP client performs the native edit and export; no Codex desktop client is shown or asserted.', 'Physical hardware unconnected and unverified. Geometry, calibration and dynamic parameters are estimates.'] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let runtime, browser, context, client, video, page, rawPath, runtimeLog = '', movieStart, videoEpoch, project;
async function json(route, data) {
  const response = await fetch(`${base}/api${route}`, { ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }), signal: AbortSignal.timeout(60_000) });
  assert(response.ok, `${route}: ${response.status}: ${(await response.clone().text()).slice(0, 500)}`);
  return response.json();
}
async function tool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  assert(!result.isError, `${name}: ${JSON.stringify(result.content).slice(0, 500)}`);
  evidence.tools.push({ name, atSeconds: movieStart ? (Date.now() - movieStart) / 1000 : null });
  return JSON.parse(result.content.find(item => item.type === 'text').text);
}
async function chapter(name, page) {
  const atSeconds = (Date.now() - movieStart) / 1000;
  evidence.chapters.push({ name, atSeconds });
  console.log(`${atSeconds.toFixed(1)}s ${name}`);
  await page.screenshot({ path: path.join(output, `${String(evidence.chapters.length).padStart(2, '0')}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`) });
}
async function command(program, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    let errorText = '';
    child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-2000); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${program} exited ${code}: ${errorText}`)));
  });
}
try {
  let occupied = false;
  try { await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }); occupied = true; } catch {}
  assert(!occupied, `${base} is occupied. Stop that recording runtime or choose CUTUCIRCUITS_DEMO_PORT.`);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cutucircuits-record-'));
  evidence.dataDir = dataDir;
  runtime = spawn(process.execPath, ['--import', 'tsx', 'packages/runtime/src/main.ts'], { cwd: root, env: { ...process.env, CUTUCIRCUITS_DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  runtime.on('error', error => { runtimeLog += error.message; });
  for (const stream of [runtime.stdout, runtime.stderr]) stream.on('data', chunk => { runtimeLog = (runtimeLog + chunk).slice(-4000); });
  for (let attempt = 0; ; attempt++) {
    try { await json('/health'); break; } catch (error) {
      if (attempt > 100 || runtime.exitCode !== null) throw new Error(`${error.message}\n${runtimeLog}`);
      await pause(200);
    }
  }
  project = await json('/projects', { name: 'Makada · live design rehearsal', template: 'spidey' });
  evidence.projectId = project.id;
  client = new Client({ name: 'cutucircuits-demo-recording', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'plugins/cutucircuits/scripts/launch.mjs')], cwd: tmpdir(), env: { ...process.env, CUTUCIRCUITS_URL: base }, stderr: 'pipe' }));
  await tool('runtime_status');
  evidence.toolCount = (await client.listTools()).tools.length;
  const original = await tool('read_file', { projectId: project.id, path: 'model.replicad.ts' });
  const baseline = await tool('compile', { projectId: project.id, path: original.path });
  evidence.baseline = { shapes: baseline.shapes.length, parameters: baseline.parameters, bounds: baseline.metrics.bounds };

  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}), args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  context = await browser.newContext({ viewport: evidence.viewport, reducedMotion: 'reduce', recordVideo: { dir: path.join(output, 'raw'), size: evidence.viewport } });
  await context.addInitScript(id => localStorage.setItem('cutucircuits:active-project', id), project.id);
  videoEpoch = Date.now();
  page = await context.newPage();
  video = page.video();
  page.setDefaultTimeout(60_000);
  page.on('pageerror', error => evidence.pageErrors.push(error.message));
  page.on('response', response => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    const detail = { status: response.status(), url: response.url() };
    // Native editors probe these optional sidecars before using their defaults.
    // Retain the observations separately; every other failed response fails.
    if (response.status() === 404 && url.pathname.endsWith('/files') && ['manual-edits.json', '.cutucircuits/replicad.yml'].includes(url.searchParams.get('path'))) evidence.optionalFileMisses.push(detail);
    else evidence.failedResponses.push(detail);
  });
  const tab = name => page.getByRole('tab', { name, exact: true });
  const cadReady = async () => {
    await expect(page.locator('.replicad-editor')).toBeVisible();
    await expect(page.locator('.replicad-status')).toContainText('Compiled', { timeout: 90_000 });
    await expect(page.getByRole('button', { name: 'Export model', exact: true })).toBeEnabled();
  };
  console.log('Warming actual production editors before recording…');
  await page.goto(base);
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
  await expect(page.getByText('Loading native CAD geometry…', { exact: true })).toBeHidden({ timeout: 90_000 });
  console.log('Assembly warmed');
  await tab('Circuit').click();
  await expect(page.locator('.es-canvas svg').first()).toBeVisible({ timeout: 90_000 });
  console.log('Circuit warmed');
  await tab('CAD').click();
  await cadReady();
  console.log('CAD warmed');
  await tab('Robot').click();
  await expect(page.getByRole('region', { name: 'Makada photo-informed hexapod URDF viewport', exact: true }).locator('canvas')).toBeVisible();
  await expect.poll(async () => (await page.locator('.cutu-robot-caption').innerText()).includes('4 links')).toBe(true);
  await tab('Assembly').click();
  await expect(page.getByText('Loading native CAD geometry…', { exact: true })).toBeHidden({ timeout: 90_000 });
  await page.waitForTimeout(1000);
  movieStart = Date.now();
  evidence.trimStartSeconds = (movieStart - videoEpoch) / 1000;
  await chapter('Assembly', page);
  await pause(1500);
  const canvas = page.locator('.canvas-area canvas').first();
  const box = await canvas.boundingBox();
  assert(box, 'Assembly canvas missing');
  await page.mouse.move(box.x + box.width * 0.48, box.y + box.height * 0.48);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.57, box.y + box.height * 0.52, { steps: 22 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Play motion preview', exact: true }).click();
  await pause(3000);
  await page.getByRole('button', { name: 'Pause motion preview', exact: true }).click();
  await pause(1000);

  await tab('Robot').click();
  await page.getByRole('button', { name: /^Joints/ }).click();
  await page.getByRole('slider', { name: 'left', exact: true }).focus();
  await page.keyboard.press('End');
  await page.getByRole('button', { name: 'Fit robot', exact: true }).click();
  await chapter('Articulated URDF', page);
  await pause(1500);
  await page.getByRole('button', { name: 'Reset pose', exact: true }).click();
  await page.getByRole('button', { name: 'Physics', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play physics', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Robot settings', exact: true }).click();
  await page.getByRole('switch', { name: 'Ground plane', exact: true }).click();
  await page.getByRole('switch', { name: 'Gravity', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play physics', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: /^Joints/ }).click();
  await page.getByRole('slider', { name: 'left', exact: true }).focus();
  await page.keyboard.press('End');
  await page.getByRole('button', { name: 'Play physics', exact: true }).click();
  await pause(2500);
  await page.getByRole('button', { name: 'Pause physics', exact: true }).click();
  evidence.physics = JSON.parse(await page.getByTestId('robot-snapshot').getAttribute('data-physics-snapshot'));
  assert(evidence.physics.time > 0.2 && evidence.physics.joints.left.position > 0.1, 'Actual Rapier motor did not advance');
  await chapter('Real Rapier motor', page);
  await pause(2000);
  await page.getByRole('button', { name: 'Step', exact: true }).click();
  await pause(1000);

  await tab('Circuit').click();
  await expect(page.locator('.es-canvas svg').first()).toBeVisible({ timeout: 90_000 });
  await chapter('Native circuit', page);
  await pause(3500);
  await tab('CAD').click();
  await cadReady();
  await page.getByRole('button', { name: 'Parameters', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'legSpan', exact: true })).toHaveValue('246');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await chapter('Native CAD baseline 246 mm', page);
  await pause(3000);

  // Leave the native parameter overrides behind while the source changes. On
  // reopening CAD, its actual new default is read from the saved source.
  await tab('Assembly').click();
  await chapter('Packaged MCP edits native source', page);
  const edited = await tool('write_file', { projectId: project.id, path: original.path, expectedSha256: original.sha256, content: original.content.replace('legSpan: 246', 'legSpan: 280') });
  const compiled = await tool('compile', { projectId: project.id, path: original.path });
  assert.equal(compiled.parameters.legSpan, 280);
  assert.equal(compiled.shapes.length, 81);
  assert(compiled.metrics.bounds.size[0] > baseline.metrics.bounds.size[0] + 25, 'Actual CAD width did not expand');
  evidence.edit = { sourceSha256: edited.sha256, originalLegSpan: 246, editedLegSpan: compiled.parameters.legSpan, originalBounds: baseline.metrics.bounds, editedBounds: compiled.metrics.bounds, shapes: compiled.shapes.length };
  const exported = await tool('export', { projectId: project.id, path: original.path, format: 'step' });
  assert(exported.content.includes('ISO-10303-21;'));
  const environment = await tool('project_environment', { projectId: project.id });
  const exportPath = path.join(environment.projectRoot, 'exports/spidey-demo.step');
  await writeFile(path.join(output, 'spidey-demo.step'), exported.content);
  evidence.export = { projectPath: exportPath, artifact: 'spidey-demo.step', bytes: Buffer.byteLength(exported.content), verifiedStepSyntax: true };
  await expect(page.getByText('Loading native CAD geometry…', { exact: true })).toBeHidden({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Fit assembly (F)', exact: true }).click();
  await pause(2000);
  await tab('CAD').click();
  await cadReady();
  const parameters = page.getByRole('button', { name: 'Parameters', exact: true });
  if (await parameters.getAttribute('aria-pressed') !== 'true') await parameters.click();
  await expect(page.getByRole('spinbutton', { name: 'legSpan', exact: true })).toHaveValue('280');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await chapter('Saved wider stance 280 mm', page);
  await pause(Math.max(5000, 78_000 - (Date.now() - movieStart)));
  evidence.durationSeconds = (Date.now() - movieStart) / 1000;
  evidence.status = 'pass';
  assert.equal(evidence.pageErrors.length, 0, `Browser errors: ${evidence.pageErrors.join('; ')}`);
  assert.equal(evidence.failedResponses.length, 0, `Failed responses: ${JSON.stringify(evidence.failedResponses)}`);
  await context.close();
  context = undefined;
  await mkdir(path.join(environment.projectRoot, 'exports'), { recursive: true });
  await writeFile(exportPath, exported.content);
  rawPath = await video.path();
  await rename(rawPath, path.join(output, 'raw-browser.webm'));
  await command('ffmpeg', ['-y', '-ss', String(evidence.trimStartSeconds), '-i', path.join(output, 'raw-browser.webm'), '-t', String(evidence.durationSeconds), '-an', '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '6', path.join(output, 'cutu-circuits-demo.webm')]);
  const chapters = evidence.chapters.map(chapter => `<li><button data-time="${chapter.atSeconds}">${Math.floor(chapter.atSeconds / 60)}:${String(Math.floor(chapter.atSeconds % 60)).padStart(2, '0')} · ${chapter.name}</button></li>`).join('');
  await writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cutu Circuits · actual demo rehearsal</title><style>body{margin:0;background:#212121;color:#eeffff;font:15px system-ui,sans-serif}main{max-width:1440px;margin:24px auto;padding:0 24px}h1{font-size:24px}p{color:#c0cccc;max-width:1000px;line-height:1.6}video{width:100%;border-radius:12px;background:#17191b}a,button{color:#80cbc4}button{background:#303636;border:0;border-radius:6px;padding:8px 12px;cursor:pointer}ul{display:flex;flex-wrap:wrap;gap:8px;padding:0;list-style:none}.note{border-left:3px solid #80cbc4;padding-left:14px}</style><main><h1>Cutu Circuits · real browser rehearsal</h1><p>Actual production UI at 1440 × 900. Native CAD, circuit and URDF views; real Rapier motors; a packaged stdio MCP client saves legSpan 246 → 280 mm and exports STEP. This recording shows the workspace responding to those calls. It does not show a Codex desktop conversation.</p><video controls preload="metadata" poster="01-assembly.png" src="cutu-circuits-demo.webm"></video><ul>${chapters}</ul><p class="note">Physical hardware was unconnected and unverified. Geometry and physical properties are estimates. Gait preview is commanded; physics positions are simulated. No measured shaft feedback is claimed.</p><p><a href="cutu-circuits-demo.webm" download>Download video</a> · <a href="spidey-demo.step" download>Actual exported STEP</a> · <a href="evidence.json">Inspect recording evidence</a></p></main><script>document.querySelectorAll('[data-time]').forEach(button=>button.onclick=()=>{const video=document.querySelector('video');video.currentTime=Number(button.dataset.time);video.play()})</script></html>`);
  console.log(`Recorded ${evidence.durationSeconds.toFixed(1)} seconds: ${path.join(output, 'index.html')}`);
} catch (error) {
  evidence.status = 'fail';
  evidence.error = error.message;
  console.error(error);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await client?.close().catch(() => {});
  if (runtime && runtime.exitCode === null) {
    runtime.kill('SIGTERM');
    await Promise.race([new Promise(resolve => runtime.once('exit', resolve)), pause(5000)]);
    if (runtime.exitCode === null) runtime.kill('SIGKILL');
  }
  evidence.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}
