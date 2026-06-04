import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRepoResult } from '../lib/wrap-terminal.mjs';

test('ready_to_land with branch+base_sha → ready', () => {
  const r = classifyRepoResult({ terminal: 'ready_to_land', branch: 'codex/issue-9', base_sha: 'abc123' });
  assert.deepEqual(r, { status: 'ready', branch: 'codex/issue-9', base_sha: 'abc123' });
});

test('ready_to_land missing branch → failed', () => {
  const r = classifyRepoResult({ terminal: 'ready_to_land', base_sha: 'abc' });
  assert.equal(r.status, 'failed');
});

test('non-ready terminal → needs_land_check (could be a noLand violation)', () => {
  const r = classifyRepoResult({ terminal: 'landed' });
  assert.equal(r.status, 'needs_land_check');
});

test('null/empty result → failed', () => {
  assert.equal(classifyRepoResult(null).status, 'failed');
  assert.equal(classifyRepoResult({}).status, 'needs_land_check');
});
