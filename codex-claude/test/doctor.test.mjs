import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, latestThreadIdFromIndex } from '../lib/doctor.mjs';

test('parseVersion extracts a semver from `codex --version` output', () => {
  assert.equal(parseVersion('codex-cli 0.130.0'), '0.130.0');
  assert.equal(parseVersion('codex 1.2.3\n'), '1.2.3');
});

test('latestThreadIdFromIndex picks the newest non-archived thread for a cwd', () => {
  const rows = [
    { id: 'old', cwd: '/repo', archived: 0, updated_at_ms: 100 },
    { id: 'new', cwd: '/repo', archived: 0, updated_at_ms: 300 },
    { id: 'newer-archived', cwd: '/repo', archived: 1, updated_at_ms: 400 },
    { id: 'other', cwd: '/elsewhere', archived: 0, updated_at_ms: 500 },
  ];
  assert.equal(latestThreadIdFromIndex(rows, '/repo'), 'new');
});
