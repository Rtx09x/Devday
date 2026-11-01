import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {readFile, writeFile, readdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const output = fileURLToPath(new URL('../../../plugins/cutucircuits/dist/server.mjs', import.meta.url));
const result = await build({metafile: true, entryPoints: [entry], outfile: output, bundle: true, platform: 'node', target: 'node24', format: 'esm', legalComments: 'eof', banner: {js: 'import {createRequire as __cutuCreateRequire} from "node:module"; const require = __cutuCreateRequire(import.meta.url);'}});

// Ship the full license text for every dependency represented in the bundle.
const packageRoots = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/);
  if (match) packageRoots.add(resolve(match[1]));
}
const notices = [];
for (const root of [...packageRoots].sort()) {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const files = (await readdir(root)).filter(name => /^(license|copying|notice)(\.|$)/i.test(name));
  notices.push(`${pkg.name}@${pkg.version} (${pkg.license ?? 'see license'})`);
  for (const file of files) notices.push(`${file}\n${await readFile(resolve(root, file), 'utf8')}`);
}
await writeFile(resolve(dirname(output), 'THIRD_PARTY_LICENSES.txt'), notices.join('\n\n')); 
