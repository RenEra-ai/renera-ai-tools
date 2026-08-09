// scripts/gate-attest-status.mjs — the recovery reader for a retained gate run directory.
//
// These drive the REAL shipped script via execFile against hand-built run directories (recovery
// reads a retained directory; no daemon is involved). The point is the predicate separating a
// durably recorded outcome from a look-alike: `attested` is ONLY a regular attestation.json holding
// a valid schema-1 confirmed-teardown record; `refused: <reason>` is ONLY a regular refusal.json
// with an identifier-shaped reason. Path existence — a directory, a symlink, garbage — is never it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const STATUS = fileURLToPath(new URL('../scripts/gate-attest-status.mjs', import.meta.url));

const DIRS = [];
after(() => { for (const d of DIRS) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } DIRS.length = 0; });

// A value of `<dir>` creates the entry as a directory; `<symlink:target>` creates it as a symlink to
// `target`; anything else is written as file content.
function makeRunDir(files = {}) {
  const d = mkdtempSync(join(tmpdir(), 'cdx-ga-status-'));
  DIRS.push(d);
  for (const [name, val] of Object.entries(files)) {
    if (val === '<dir>') mkdirSync(join(d, name));
    else if (typeof val === 'string' && val.startsWith('<symlink:')) symlinkSync(val.slice(9, -1), join(d, name));
    else writeFileSync(join(d, name), val);
  }
  return d;
}

async function status(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [STATUS, ...args]);
    return { code: 0, stdout, stderr };
  } catch (e) { return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' }; }
}

/** The minimal record the reader accepts as attested — the shape the collector actually writes. */
const validRecord = (extra = {}) => `${JSON.stringify({
  schema: 1, gateProtocol: 2, gate: 'review', collectedAt: '2026-08-09T00:00:00.000Z',
  turn: { status: 'completed', kind: 'turn', turnToken: 1 },
  artifact: { path: '/tmp/x/review.md', sha256: 'a'.repeat(64) },
  parsedVerdict: 'NO ISSUES', teardown: 'confirmed', ...extra,
})}\n`;

test('a valid attestation record reads attested — exactly one line', async () => {
  const d = makeRunDir({ 'attestation.json': validRecord() });
  const r = await status(['--state-dir', d]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'attested\n');
});

test('a refusal record reads refused with its reason', async () => {
  const d = makeRunDir({ 'refusal.json': `${JSON.stringify({ reason: 'wrong_turn_kind', stopped: true, collectedAt: 'x' })}\n` });
  const r = await status(['--state-dir', d]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'refused: wrong_turn_kind\n');
});

test('an empty directory (or one holding only start.json + lock) is unknown', async () => {
  // The pre-fix incident shape: collect refused, stdout was consumed, and the directory held only
  // collect.lock and start.json — the reader must say "nothing durably recorded", not guess.
  for (const files of [{}, { 'start.json': '{"ok":true}\n', 'collect.lock': '' }]) {
    const r = await status(['--state-dir', makeRunDir(files)]);
    assert.equal(r.stdout, 'unknown\n');
  }
  // A nonexistent dir too (same rule as the sibling reader): a typo'd path reads as no-record, and
  // unknown is treated as not-attested — the fail-safe direction.
  assert.equal((await status(['--state-dir', join(makeRunDir(), 'no-such-subdir')])).stdout, 'unknown\n');
});

test('attested requires the FULL record shape, not existence', async () => {
  const cases = [
    ['not json\n', 'garbage'],
    ['{}\n', 'empty object'],
    [validRecord({ schema: 2 }), 'wrong schema'],
    [validRecord({ teardown: undefined }), 'missing teardown'],
    [validRecord({ teardown: 'attempted' }), 'unconfirmed teardown'],
    [validRecord({ gate: 'sideways' }), 'unknown gate'],
    [validRecord({ artifact: undefined }), 'missing artifact'],
    [validRecord({ artifact: { path: '' } }), 'empty artifact path'],
    ['<dir>', 'a directory'],
  ];
  for (const [content, label] of cases) {
    const r = await status(['--state-dir', makeRunDir({ 'attestation.json': content })]);
    assert.equal(r.stdout, 'unknown\n', `must not attest ${label}`);
  }
});

test('a symlinked record has no provenance and reads unknown', async () => {
  const elsewhere = join(makeRunDir(), 'real.json');
  writeFileSync(elsewhere, validRecord());
  const d = makeRunDir({ 'attestation.json': `<symlink:${elsewhere}>` });
  assert.equal((await status(['--state-dir', d])).stdout, 'unknown\n');

  const realRefusal = join(makeRunDir(), 'real-refusal.json');
  writeFileSync(realRefusal, '{"reason":"wrong_turn_kind"}\n');
  const d2 = makeRunDir({ 'refusal.json': `<symlink:${realRefusal}>` });
  assert.equal((await status(['--state-dir', d2])).stdout, 'unknown\n');
});

test('a refusal reason must be an identifier-shaped token, not prose or garbage', async () => {
  const cases = ['not json\n', '{}\n', '{"reason":42}\n', '{"reason":"Refused Because Reasons"}\n',
    '{"reason":"/etc/passwd"}\n', `{"reason":"${'x'.repeat(41)}"}\n`];
  for (const content of cases) {
    const r = await status(['--state-dir', makeRunDir({ 'refusal.json': content })]);
    assert.equal(r.stdout, 'unknown\n', `must not trust ${JSON.stringify(content)}`);
  }
  // A reason the collector does not emit today still reads back — identifier-shaped, not allowlisted.
  const future = await status(['--state-dir', makeRunDir({ 'refusal.json': '{"reason":"some_future_reason"}\n' })]);
  assert.equal(future.stdout, 'refused: some_future_reason\n');
});

test('when both records exist, attested wins (the collector writes exactly one)', async () => {
  const d = makeRunDir({
    'attestation.json': validRecord(),
    'refusal.json': '{"reason":"wrong_turn_kind"}\n',
  });
  assert.equal((await status(['--state-dir', d])).stdout, 'attested\n');
});

test('usage: --help succeeds; a missing --state-dir and unknown flags are exit 1', async () => {
  const help = await status(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /gate-attest-status\.mjs --state-dir/);

  for (const argv of [[], ['--state-dir'], ['--bogus', 'x'], ['--state-dir', makeRunDir(), 'stray']]) {
    const r = await status(argv);
    assert.equal(r.code, 1, `expected usage failure for ${argv.join(' ')}`);
    assert.equal(r.stdout, '', 'usage errors print no outcome line');
  }
});
