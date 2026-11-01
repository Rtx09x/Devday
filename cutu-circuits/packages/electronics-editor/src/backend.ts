/**
 * Electronics Studio — firmware backend module
 *
 * Runs in an Electron utility-process (Node, prompted permission), the only
 * place that can do the privileged work the renderer can't: spawn a native
 * firmware toolchain (arduino-cli / PlatformIO) to compile a sketch, and run
 * ESP32 firmware under QEMU (Xtensa, which has no pure-JS emulator). It exposes
 * the `firmware.*` RPC methods over the host's backend-module bridge.
 *
 * IMPORTANT (host limitation as of app v0.66.2): the renderer side of an
 * extension (AI tools, custom editors) has no API to call a backend module --
 * only tracker-importer and aiAgentProvider contributions are wired to one. So
 * these methods are built to the documented `activate(ctx) => { methods }`
 * contract and are ready for when the host exposes generic renderer->backend
 * RPC (or for use via an agent provider), but they are not yet reachable from
 * `electronics.simulate`/`electronics.test`. The in-renderer test harness covers
 * AVR/RP2040 today; this backend covers firmware *compilation* and *ESP32*.
 *
 * Toolchains are detected, never auto-installed; every method degrades to a clear
 * "not installed" result so the agent can tell the user what to install.
 */

import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

const SPAWN_TIMEOUT_MS = 180_000;

interface ActivateCtx {
  services: {
    workspacePath: string;
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  };
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** GUI-launched Electron often misses /usr/local/bin etc. on PATH; add them. */
function enhancedPath(): string {
  const current = process.env.PATH || '';
  const extra: string[] = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    extra.push(path.join(appData, 'npm'), path.join(os.homedir(), '.platformio', 'penv', 'Scripts'));
  } else {
    extra.push(
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), '.platformio', 'penv', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin',
    );
  }
  const sep = process.platform === 'win32' ? ';' : ':';
  return [...extra, current].join(sep);
}

function run(cmd: string, args: string[], cwd?: string, timeout = SPAWN_TIMEOUT_MS): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      timeout,
      shell: false,
      cwd,
      env: { ...process.env, PATH: enhancedPath(), NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: null, stdout, stderr: err.message }));
  });
}

async function which(cmd: string): Promise<string | null> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const res = await run(probe, [cmd], undefined, 5000);
  return res.code === 0 ? res.stdout.split(/\r?\n/)[0].trim() || null : null;
}

interface ToolchainStatus {
  arduinoCli: string | null;
  platformio: string | null;
  qemuXtensa: string | null;
}

async function detectToolchains(): Promise<ToolchainStatus> {
  const [arduinoCli, platformio, pio, qemu] = await Promise.all([
    which('arduino-cli'),
    which('platformio'),
    which('pio'),
    which('qemu-system-xtensa'),
  ]);
  return { arduinoCli, platformio: platformio || pio, qemuXtensa: qemu };
}

/** Read a built artifact (hex/bin/uf2) and base64-encode it for transport. */
async function readArtifact(file: string): Promise<{ name: string; base64: string; bytes: number }> {
  const buf = await fs.readFile(file);
  return { name: path.basename(file), base64: buf.toString('base64'), bytes: buf.length };
}

async function findArtifact(dir: string, exts: string[]): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const nested = await findArtifact(full, exts);
      if (nested) return nested;
    } else if (exts.some((x) => e.name.toLowerCase().endsWith(x))) {
      return full;
    }
  }
  return null;
}

export function activate(ctx: ActivateCtx) {
  const { workspacePath, log } = ctx.services;
  const resolveIn = (p: string) => (path.isAbsolute(p) ? p : path.join(workspacePath, p));

  return {
    methods: {
      /** Report which firmware toolchains are installed on this machine. */
      'firmware.detectToolchains': async (): Promise<ToolchainStatus & { any: boolean }> => {
        const status = await detectToolchains();
        log('debug', 'firmware: toolchain detection', status);
        return { ...status, any: !!(status.arduinoCli || status.platformio || status.qemuXtensa) };
      },

      /**
       * Compile a sketch to firmware. With arduino-cli: `sketch` is a .ino dir
       * and `fqbn` the board (e.g. "arduino:avr:uno", "esp32:esp32:esp32"). With
       * PlatformIO: `projectDir` is a platformio.ini project. Returns the built
       * artifact (base64) so the renderer emulators can load it.
       */
      'firmware.build': async (params: {
        tool?: 'arduino-cli' | 'platformio';
        sketch?: string;
        fqbn?: string;
        projectDir?: string;
        environment?: string;
      }): Promise<{ ok: boolean; tool: string; artifact?: { name: string; base64: string; bytes: number }; log: string; error?: string }> => {
        const tc = await detectToolchains();
        const tool = params.tool ?? (tc.arduinoCli ? 'arduino-cli' : tc.platformio ? 'platformio' : 'arduino-cli');

        if (tool === 'arduino-cli') {
          if (!tc.arduinoCli) return { ok: false, tool, log: '', error: 'arduino-cli not installed. See arduino.github.io/arduino-cli.' };
          if (!params.sketch || !params.fqbn) return { ok: false, tool, log: '', error: 'arduino-cli build needs `sketch` (dir) and `fqbn` (board).' };
          const sketch = resolveIn(params.sketch);
          const outDir = path.join(os.tmpdir(), `es-build-${path.basename(sketch)}`);
          const res = await run('arduino-cli', ['compile', '--fqbn', params.fqbn, '--output-dir', outDir, sketch]);
          const fullLog = res.stdout + res.stderr;
          if (res.code !== 0) return { ok: false, tool, log: fullLog, error: `arduino-cli compile failed (exit ${res.code}).` };
          const artifactPath = await findArtifact(outDir, ['.hex', '.bin', '.uf2']);
          if (!artifactPath) return { ok: false, tool, log: fullLog, error: 'Build succeeded but no .hex/.bin/.uf2 artifact found.' };
          return { ok: true, tool, artifact: await readArtifact(artifactPath), log: fullLog };
        }

        // PlatformIO
        if (!tc.platformio) return { ok: false, tool, log: '', error: 'PlatformIO not installed. See platformio.org.' };
        if (!params.projectDir) return { ok: false, tool, log: '', error: 'PlatformIO build needs `projectDir` (a platformio.ini project).' };
        const projectDir = resolveIn(params.projectDir);
        const pioArgs = ['run', '-d', projectDir, ...(params.environment ? ['-e', params.environment] : [])];
        const pioBin = tc.platformio.endsWith('pio') ? 'pio' : 'platformio';
        const res = await run(pioBin, pioArgs, projectDir);
        const fullLog = res.stdout + res.stderr;
        if (res.code !== 0) return { ok: false, tool, log: fullLog, error: `PlatformIO build failed (exit ${res.code}).` };
        const artifactPath = await findArtifact(path.join(projectDir, '.pio'), ['.bin', '.hex', '.uf2']);
        if (!artifactPath) return { ok: false, tool, log: fullLog, error: 'Build succeeded but no artifact found under .pio/.' };
        return { ok: true, tool, artifact: await readArtifact(artifactPath), log: fullLog };
      },

      /**
       * Run an ESP32 firmware image under QEMU and capture serial output for a
       * bounded time. `firmwareBin` is a path to a merged flash .bin. Xtensa has
       * no pure-JS emulator, so this is the ESP32 simulation path.
       */
      'firmware.qemuEsp32': async (params: {
        firmwareBin: string;
        durationMs?: number;
        machine?: string;
      }): Promise<{ ok: boolean; serial: string; lines: string[]; error?: string }> => {
        const tc = await detectToolchains();
        if (!tc.qemuXtensa) {
          return { ok: false, serial: '', lines: [], error: 'qemu-system-xtensa not installed. Install the Espressif QEMU fork (espressif/qemu).' };
        }
        const bin = resolveIn(params.firmwareBin);
        if (!(await fs.stat(bin).then(() => true).catch(() => false))) {
          return { ok: false, serial: '', lines: [], error: `Firmware not found: ${bin}` };
        }
        const durationMs = Math.min(Math.max(params.durationMs ?? 4000, 500), 30_000);
        const machine = params.machine ?? 'esp32';
        const res = await run(
          'qemu-system-xtensa',
          ['-nographic', '-machine', machine, '-drive', `file=${bin},if=mtd,format=raw`, '-serial', 'mon:stdio'],
          undefined,
          durationMs + 2000,
        );
        const serial = res.stdout + res.stderr;
        const lines = serial.split(/\r?\n/).filter(Boolean);
        return { ok: true, serial, lines };
      },
    },
  };
}
