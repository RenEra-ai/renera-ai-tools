import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../lib/state.mjs';

test('writeState then readState round-trips; socketPathFor is deterministic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-'));
  const store = new StateStore(dir);
  assert.equal(store.readState(), null);
  const rec = { threadId: 'abc', pid: 123, cwd: '/x', model: 'gpt-5.5' };
  store.writeState(rec);
  assert.deepEqual(store.readState(), rec);
  assert.equal(store.socketPathFor('abc'), join(dir, 'abc.sock'));
});
