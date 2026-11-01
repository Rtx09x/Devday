#!/usr/bin/env node
// Resolve from this installed script, never the host's arbitrary working directory.
import {existsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.CUTUCIRCUITS_REPO ? resolve(process.env.CUTUCIRCUITS_REPO) : resolve(here, '../../..');
const bundled = resolve(here, '../dist/server.mjs');
const entry = resolve(root, 'packages/plugin/src/main.ts');
const tsx = resolve(root, 'node_modules/tsx/dist/cli.mjs');
const useBundle = existsSync(bundled);
if (!useBundle && (!existsSync(entry) || !existsSync(tsx))) {
  process.stderr.write('Cutu Circuits plugin needs its repository dependencies. Run npm install and npm run build -w @cutucircuits/plugin in the Cutu Circuits repository; if the plugin was copied elsewhere set CUTUCIRCUITS_REPO to that repository.\n');
  process.exit(1);
}
const child = spawn(process.execPath, useBundle ? [bundled] : [tsx, entry], {cwd: useBundle ? resolve(here, '..') : root, env: process.env, stdio: 'inherit'});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {child.kill(signal);});
child.on('error', error => {process.stderr.write(`Cutu Circuits plugin failed to launch: ${error.message}\n`); process.exit(1);});
child.on('exit', (code, signal) => {process.exit(code ?? (signal ? 1 : 0));});
