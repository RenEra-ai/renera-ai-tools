import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testAppServerOpts, testWaitMs } from '../lib/test-appserver.mjs';

test('no override env -> the real app-server, untouched', () => {
  assert.deepEqual(testAppServerOpts({}), {});
  assert.equal(testWaitMs({}), null);
});

test('the seam is honoured only in test mode', () => {
  const env = { CODEX_DRIVE_TEST_MODE: '1', CODEX_DRIVE_TEST_APPSERVER: '["/usr/bin/node","/abs/mock.mjs","--review-mode","ok"]' };
  assert.deepEqual(testAppServerOpts(env), { command: '/usr/bin/node', args: ['/abs/mock.mjs', '--review-mode', 'ok'] });
  assert.equal(testWaitMs({ CODEX_DRIVE_TEST_MODE: '1', CODEX_DRIVE_TEST_WAIT_MS: '2000' }), 2000);
});

test('set WITHOUT test mode fails loudly — an ambient collision must not swap the review backend', () => {
  assert.throws(() => testAppServerOpts({ CODEX_DRIVE_TEST_APPSERVER: '["/bin/echo"]' }),
    /CODEX_DRIVE_TEST_MODE=1 is not/);
  assert.throws(() => testWaitMs({ CODEX_DRIVE_TEST_WAIT_MS: '5' }), /CODEX_DRIVE_TEST_MODE=1 is not/);
});

test('malformed values are hard errors, never a silent fallback to the real binary', () => {
  const m = { CODEX_DRIVE_TEST_MODE: '1' };
  assert.throws(() => testAppServerOpts({ ...m, CODEX_DRIVE_TEST_APPSERVER: 'node mock.mjs' }), /JSON array of strings/);
  assert.throws(() => testAppServerOpts({ ...m, CODEX_DRIVE_TEST_APPSERVER: '[]' }), /non-empty JSON array/);
  assert.throws(() => testAppServerOpts({ ...m, CODEX_DRIVE_TEST_APPSERVER: '"node"' }), /non-empty JSON array/);
  assert.throws(() => testAppServerOpts({ ...m, CODEX_DRIVE_TEST_APPSERVER: '[1,2]' }), /non-empty JSON array/);
  assert.throws(() => testWaitMs({ ...m, CODEX_DRIVE_TEST_WAIT_MS: 'soon' }), /positive integer/);
  assert.throws(() => testWaitMs({ ...m, CODEX_DRIVE_TEST_WAIT_MS: '0' }), /positive integer/);
  // A fraction between 0 and 1 cleared the old n<=0 guard, then floored to 0 — and sendCommand
  // reads 0 as "no timeout" (client.mjs:8), so the cap silently became unbounded.
  assert.throws(() => testWaitMs({ ...m, CODEX_DRIVE_TEST_WAIT_MS: '0.5' }), /positive integer/);
  assert.throws(() => testWaitMs({ ...m, CODEX_DRIVE_TEST_WAIT_MS: '1500.7' }), /positive integer/);
});

test('a relative command is rejected: the child is spawned with the REVIEW cwd, not ours', () => {
  // A relative path would resolve against the temp-dir git fixture under test and silently fail to spawn.
  assert.throws(() => testAppServerOpts({ CODEX_DRIVE_TEST_MODE: '1', CODEX_DRIVE_TEST_APPSERVER: '["node","mock.mjs"]' }),
    /must be an absolute path/);
});

test('the value is never shell-split: a path containing spaces survives intact', () => {
  const env = { CODEX_DRIVE_TEST_MODE: '1', CODEX_DRIVE_TEST_APPSERVER: '["/opt/my tools/node","/a b/mock.mjs"]' };
  assert.deepEqual(testAppServerOpts(env), { command: '/opt/my tools/node', args: ['/a b/mock.mjs'] });
});
