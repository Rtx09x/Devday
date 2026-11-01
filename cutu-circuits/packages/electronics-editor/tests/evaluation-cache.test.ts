import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvaluationCache } from '../src/circuit/evaluationCache';

test('successful projection is isolated, context and every virtual file are part of the key', async () => {
  let calls = 0;
  const evalCached = createEvaluationCache(async () => ({ ok: true, circuitJson: [{ type: 'source_component', source_component_id: String(++calls) }] as any, durationMs: 42 }));
  const input = { entrypoint: 'board.tsx', files: { 'board.tsx': 'source', 'manual-edits.json': 'one' } };
  const first = await evalCached('project-a', input);
  first.circuitJson[0].source_component_id = 'mutated';
  const hit = await evalCached('project-a', input);
  assert.equal(hit.circuitJson[0].source_component_id, '1');
  assert.equal(hit.cached, true);
  assert.equal(hit.durationMs, undefined);
  assert.equal(calls, 1);
  await evalCached('project-b', input);
  await evalCached('project-a', { ...input, files: { ...input.files, 'manual-edits.json': 'two' } });
  await evalCached('project-a', input, { bypass: true });
  assert.equal(calls, 4);
  assert.equal((await evalCached('project-a', input)).circuitJson[0].source_component_id, '4');
});

test('failed and cancelled evaluations are not retained', async () => {
  let calls = 0;
  const evalCached = createEvaluationCache(async () => ({ ok: ++calls !== 1, circuitJson: [] }));
  const input = { entrypoint: 'x', files: { x: 'source' } };
  await evalCached('p', input);
  await evalCached('p', input, { active: () => false });
  await evalCached('p', input);
  assert.equal(calls, 3);
  assert.equal((await evalCached('p', input)).cached, true);
});

test('failed explicit refresh evicts an earlier success', async () => {
  let calls = 0;
  const evalCached = createEvaluationCache(async () => ({ ok: ++calls !== 2, circuitJson: [] }));
  const input = { entrypoint: 'x', files: { x: 'source' } };
  await evalCached('p', input);
  assert.equal((await evalCached('p', input, { bypass: true })).ok, false);
  assert.equal((await evalCached('p', input)).cached, undefined);
  assert.equal(calls, 3);
});
