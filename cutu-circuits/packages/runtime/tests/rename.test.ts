import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/store.ts';

for (const externalEdit of [false, true]) {
  test(`Windows transient replacement lock ${externalEdit ? 'rechecks CAS and preserves an external edit' : 'retries the atomic save'}`, { skip: process.platform !== 'win32' }, async t => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cutu-rename-'));
    const store = await new ProjectStore({dataDir, seed:false, pollIntervalMs:0}).init();
    try {
      const project = await store.create('Lock recovery', 'blank');
      const before = await store.write(project.id, 'notes.txt', 'original', null);
      const target = path.join(store.root(project.id), 'notes.txt');
      const rename = fs.rename.bind(fs);
      let locked = false;
      t.mock.method(fs, 'rename', async (...[source, destination]: Parameters<typeof fs.rename>) => {
        if (!locked && String(destination) === target) {
          locked = true;
          if (externalEdit) await fs.writeFile(target, 'external');
          throw Object.assign(new Error('Temporary replacement lock'), {code:'EPERM'});
        }
        return rename(source, destination);
      });
      if (externalEdit) {
        await assert.rejects(store.write(project.id, 'notes.txt', 'replacement', before.sha256), (e:any) => e.code === 'HASH_CONFLICT');
        assert.equal(await fs.readFile(target,'utf8'), 'external');
      } else {
        await store.write(project.id, 'notes.txt', 'replacement', before.sha256);
        assert.equal(await fs.readFile(target,'utf8'), 'replacement');
      }
      assert.equal(locked, true);
    } finally {
      t.mock.restoreAll();
      await store.close();
      await fs.rm(dataDir, {recursive:true,force:true});
    }
  });
}
