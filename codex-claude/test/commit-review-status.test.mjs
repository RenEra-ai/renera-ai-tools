// scripts/commit-review-status.mjs — the recovery reader for a retained run directory.
//
// These drive the REAL shipped script via execFile against hand-built run directories (recovery reads a
// retained directory; no daemon is involved). The point is the predicate that separates a genuine
// completion from a look-alike: a completion is ONLY a regular `last-reviewed-sha` file whose content
// equals `start-head`. Path existence — a directory, an empty file, a stale placeholder — is never it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const STATUS = fileURLToPath(new URL('../scripts/commit-review-status.mjs', import.meta.url));
const SHA = '0123456789abcdef0123456789abcdef01234567';
// The provenance a genuine completed run always carries; completion now requires it alongside the marker.
const TEARDOWN = 'confirmed stopped\n';

const DIRS = [];
after(() => { for (const d of DIRS) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } DIRS.length = 0; });

// A value of `<dir>` creates the entry as a directory (the correlated-failure shape); `<symlink:target>`
// creates it as a symlink to `target`; anything else is written as file content.
function makeRunDir(files) {
  const d = mkdtempSync(join(tmpdir(), 'cdx-status-'));
  DIRS.push(d);
  for (const [name, val] of Object.entries(files)) {
    if (val === '<dir>') mkdirSync(join(d, name));
    else if (typeof val === 'string' && val.startsWith('<symlink:')) symlinkSync(val.slice(9, -1), join(d, name));
    else writeFileSync(join(d, name), val);
  }
  return d;
}

async function status(dir) {
  const { stdout } = await run(process.execPath, [STATUS, '--state-dir', dir]);
  return stdout.trim();
}

test('a regular SHA marker equal to start-head, with teardown evidence, reads as completed', async () => {
  assert.equal(await status(makeRunDir({ 'start-head': `${SHA}\n`, 'last-reviewed-sha': `${SHA}\n`, teardown: TEARDOWN })), 'completed');
});

test('a matching marker WITHOUT teardown evidence is not completed', async () => {
  // Provenance: the collector writes teardown (proving the daemon was torn down) before the marker, so
  // a marker with no teardown is not a genuine finished run.
  assert.equal(await status(makeRunDir({ 'start-head': `${SHA}\n`, 'last-reviewed-sha': `${SHA}\n` })), 'unknown');
});

test('a non-SHA marker equal to a non-SHA start-head is not completed', async () => {
  // Equality is not enough: a matching not-a-sha (or non-hex placeholder) must be rejected.
  assert.equal(await status(makeRunDir({ 'start-head': 'not-a-sha\n', 'last-reviewed-sha': 'not-a-sha\n', teardown: TEARDOWN })), 'unknown');
});

test('a SYMLINKED marker pointing at a valid SHA file is not completed', async () => {
  // A symlinked record has no provenance — lstatSync must reject it even though it resolves to a
  // regular file holding the exact SHA.
  const d = makeRunDir({ 'start-head': `${SHA}\n`, 'real-sha': `${SHA}\n`, 'last-reviewed-sha': '<symlink:real-sha>', teardown: TEARDOWN });
  assert.equal(await status(d), 'unknown');
});

test('a last-reviewed-sha DIRECTORY is NEVER completion — the correlated-failure shape reads unknown', async () => {
  // THE regression: the double-write-failure path leaves last-reviewed-sha as a directory. A
  // "present ⇒ completed" reader would report a false success; the regular-file + content check must not.
  assert.equal(await status(makeRunDir({ 'start-head': `${SHA}\n`, 'last-reviewed-sha': '<dir>', phase: '<dir>' })), 'unknown');
});

test('a last-reviewed-sha DIRECTORY with a failed phase reads as failed', async () => {
  assert.equal(await status(makeRunDir({ 'start-head': `${SHA}\n`, 'last-reviewed-sha': '<dir>', phase: 'failed\n' })), 'failed');
});

test('a marker whose content is NOT the reviewed SHA is not completion', async () => {
  // A stale placeholder — exactly what the removed plan step (`cp baseline last-reviewed-sha`) created —
  // must not read as completed unless it holds the exact start-head.
  assert.equal(await status(makeRunDir({ 'start-head': `${SHA}\n`, 'last-reviewed-sha': 'deadbeef\n' })), 'unknown');
});

test('an empty marker file is not completion', async () => {
  assert.equal(await status(makeRunDir({ 'start-head': `${SHA}\n`, 'last-reviewed-sha': '' })), 'unknown');
});

test('a missing start-head makes an otherwise-matching marker unverifiable → unknown', async () => {
  // Without the recorded start-head there is nothing to validate the marker against; fail closed.
  assert.equal(await status(makeRunDir({ 'last-reviewed-sha': `${SHA}\n` })), 'unknown');
});

test('phase timeout and failed are reported when there is no completion record', async () => {
  assert.equal(await status(makeRunDir({ 'start-head': `${SHA}\n`, phase: 'timeout\n' })), 'timeout');
  assert.equal(await status(makeRunDir({ 'start-head': `${SHA}\n`, phase: 'failed\n' })), 'failed');
});

test('an unrecognized phase value is unknown, never a verdict', async () => {
  assert.equal(await status(makeRunDir({ 'start-head': `${SHA}\n`, phase: 'initialized\n' })), 'unknown');
});

test('a run directory with no records reads unknown', async () => {
  assert.equal(await status(makeRunDir({ 'start-head': `${SHA}\n` })), 'unknown');
});

test('a valid completion marker is authoritative even if a stale phase also exists', async () => {
  // Completion is checked first; a leftover phase cannot override a marker that holds the exact SHA.
  assert.equal(await status(makeRunDir({ 'start-head': `${SHA}\n`, 'last-reviewed-sha': `${SHA}\n`, teardown: TEARDOWN, phase: 'failed\n' })), 'completed');
});

test('usage error without --state-dir exits 1', async () => {
  const r = await run(process.execPath, [STATUS]).then(() => ({ code: 0 }), (e) => ({ code: e.code, stderr: e.stderr }));
  assert.equal(r.code, 1);
});
