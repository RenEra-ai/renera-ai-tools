import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, toCommand, parseStartProfile, assertKnownFlags } from '../lib/verbs.mjs';

test('review maps --base / --scope, and omits what was not given', () => {
  assert.deepEqual(toCommand({ verb: 'review', flags: { base: 'abc123' } }), { cmd: 'review', base: 'abc123' });
  assert.deepEqual(toCommand({ verb: 'review', flags: { scope: 'working-tree' } }), { cmd: 'review', scope: 'working-tree' });
  // Nothing given -> a bare command. This is what lets the daemon tell "no base" from a bad base.
  assert.deepEqual(toCommand({ verb: 'review', flags: {} }), { cmd: 'review' });
  // A valueless --base is passed through as boolean true for the daemon to reject — NOT dropped,
  // which would silently downgrade the request to auto scope.
  assert.deepEqual(toCommand({ verb: 'review', flags: { base: true } }), { cmd: 'review', base: true });
});

test('--flag=value is a LOUD error, never a silent auto-scope downgrade', () => {
  // `--base=<sha>` would otherwise parse as flags['base=<sha>']=true with flags.base undefined,
  // which compact() drops — producing a bare {cmd:'review'} indistinguishable from "review whatever
  // you like". No downstream validator can recover the intent, so it must die here.
  assert.throws(() => parseArgs(['review', '--base=abc123']), /--base=value is not supported/);
  assert.throws(() => parseArgs(['review', '--scope=branch']), /--scope=value is not supported/);
  assert.throws(() => parseArgs(['read', '--out=/tmp/x']), /--out=value is not supported/);
  assert.throws(() => parseArgs(['wait', '--socket=/tmp/s.sock']), /--socket=value is not supported/);
});

test('parseStartProfile accepts the review profile and rejects bad literals', () => {
  assert.deepEqual(parseStartProfile({ sandbox: 'read-only', 'approval-policy': 'never', ephemeral: true }),
    { sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true });
  assert.equal(parseStartProfile({}), null);                       // a plain thread
  assert.throws(() => parseStartProfile({ sandbox: 'bogus' }), /invalid --sandbox/);
  assert.throws(() => parseStartProfile({ 'approval-policy': 'bogus' }), /invalid --approval-policy/);
});

test('parseStartProfile rejects valueless flags (which the parser turns into boolean true)', () => {
  assert.throws(() => parseStartProfile({ sandbox: true }), /--sandbox requires a value/);
  assert.throws(() => parseStartProfile({ 'approval-policy': true }), /--approval-policy requires a value/);
  assert.throws(() => parseStartProfile({ ephemeral: 'yes' }), /--ephemeral is a boolean flag/);
  // Same family, in the flags start sits next to: resolve(true) would throw a raw Node TypeError.
  assert.throws(() => parseStartProfile({ cwd: true }), /--cwd requires a value/);
  assert.throws(() => parseStartProfile({ model: true }), /--model requires a value/);
  assert.throws(() => parseStartProfile({ resume: true }), /--resume requires a value/);
});

test('parseStartProfile rejects --ephemeral and profile flags on a resume', () => {
  // Resuming an ephemeral thread is contradictory, and the daemon would silently prefer resume.
  assert.throws(() => parseStartProfile({ ephemeral: true, resume: 'abc' }), /cannot be combined with --resume/);
  assert.throws(() => parseStartProfile({ ephemeral: true, 'resume-latest': true }), /cannot be combined with --resume/);
  // A resumed thread keeps its original profile; the protocol offers no re-profiling.
  assert.throws(() => parseStartProfile({ sandbox: 'read-only', 'resume-latest': true }), /keeps its original profile/);
  assert.throws(() => parseStartProfile({ 'approval-policy': 'never', resume: 'abc' }), /keeps its original profile/);
  // …but a plain --resume-latest (no profile flags) is still fine: /codex-issue relies on it.
  assert.equal(parseStartProfile({ 'resume-latest': true }), null);
});

test('parseArgs extracts verb, positional prompt, and flags', () => {
  assert.deepEqual(parseArgs(['plan', 'do the thing', '--effort', 'xhigh']),
    { verb: 'plan', positional: 'do the thing', flags: { effort: 'xhigh' } });
  assert.deepEqual(parseArgs(['answer', '--id', 'q1', '--text', 'Option B']),
    { verb: 'answer', positional: undefined, flags: { id: 'q1', text: 'Option B' } });
  assert.deepEqual(parseArgs(['start', '--resume-latest']),
    { verb: 'start', positional: undefined, flags: { 'resume-latest': true } });
});

test('parseArgs captures --timeout-ms (transport flag for wait)', () => {
  assert.deepEqual(parseArgs(['wait', '--timeout-ms', '5000']),
    { verb: 'wait', positional: undefined, flags: { 'timeout-ms': '5000' } });
});

test('send --mode default maps to a default-collaborationMode command (exit plan mode)', () => {
  assert.deepEqual(toCommand({ verb: 'send', positional: 'save the plan', flags: { mode: 'default' } }),
    { cmd: 'send', prompt: 'save the plan', mode: 'default' });
  // plain send carries no mode
  assert.deepEqual(toCommand({ verb: 'send', positional: 'hi', flags: {} }),
    { cmd: 'send', prompt: 'hi' });
});

test('toCommand maps a parsed plan verb to a daemon command', () => {
  assert.deepEqual(toCommand({ verb: 'plan', positional: 'go', flags: { effort: 'xhigh' } }),
    { cmd: 'plan', prompt: 'go', effort: 'xhigh' });
});

test('toCommand maps answer --option to answers array and --text to answers array', () => {
  assert.deepEqual(toCommand({ verb: 'answer', flags: { id: 'q1', option: '2' } }),
    { cmd: 'answer', id: 'q1', answers: ['__option:2'] });
  assert.deepEqual(toCommand({ verb: 'answer', flags: { id: 'q1', text: 'B' } }),
    { cmd: 'answer', id: 'q1', answers: ['B'] });
});

test('answer rejects every shape that would send garbage to a live Codex question', () => {
  // The daemon only recognises /^__option:(\d+)$/ and passes anything else through VERBATIM as the
  // answer text. So each of these used to be answered with a literal nonsense string while the
  // caller believed their choice had been applied.
  const bad = [
    [{ id: 'q1', option: true }, /--option requires a value/],        // valueless --option -> '__option:true'
    [{ id: 'q1', option: 'abc' }, /positive integer/],
    [{ id: 'q1', option: '0' }, /positive integer/],                  // options are 1-based
    [{ id: 'q1', option: '-1' }, /positive integer/],
    [{ id: 'q1', text: true }, /--text requires a value/],            // valueless --text -> answer "true"
    [{ id: 'q1' }, /exactly one of --text or --option/],              // neither -> '__option:undefined'
    [{ id: 'q1', text: 'B', option: '2' }, /exactly one of --text or --option/],
    [{ option: '1' }, /--id requires a value/],
    [{ id: true, option: '1' }, /--id requires a value/],
  ];
  for (const [flags, re] of bad) {
    assert.throws(() => toCommand({ verb: 'answer', flags }), re, `expected ${JSON.stringify(flags)} to throw ${re}`);
  }
});

test('read --full is a loud unknown flag (nothing in lib ever read cmd.full)', () => {
  // It was accepted, sent over the wire and ignored: the caller asked for the full transcript and
  // silently got only the last message — the exact class the allowlist exists to stop.
  assert.throws(() => toCommand({ verb: 'read', flags: { full: true } }), /unknown flag --full/);
});

test('start/doctor reject unknown flags, positional-shaped typos and valued booleans', () => {
  // Neither verb reaches toCommand in bin, so these are asserted through the exported allowlist.
  assert.throws(() => assertKnownFlags('start', { help: true }), /unknown flag --help for verb 'start'/);
  assert.throws(() => assertKnownFlags('start', { sandbxo: 'read-only' }), /unknown flag --sandbxo/);
  assert.throws(() => assertKnownFlags('doctor', { bogus: 'x' }), /unknown flag --bogus for verb 'doctor'/);
  // Legitimate start flags still pass.
  assertKnownFlags('start', { cwd: '/r', sandbox: 'read-only', 'approval-policy': 'never', ephemeral: true, private: true });
  assertKnownFlags('doctor', {});
  // Transport flags are NOT silently accepted here — neither verb talks to an existing daemon.
  assert.throws(() => assertKnownFlags('start', { socket: '/tmp/s' }), /unknown flag --socket/);
  assert.throws(() => assertKnownFlags('doctor', { 'timeout-ms': '5' }), /unknown flag --timeout-ms/);
});

test('boolean-only start flags reject a value (--force no used to force-stop a live session)', () => {
  // 'no' is a truthy string: `start --force no` stopped the very session the caller was protecting,
  // and `start --private no` wrote the global state it looked like it was avoiding.
  for (const b of ['ephemeral', 'force', 'private', 'resume-latest']) {
    assert.throws(() => parseStartProfile({ [b]: 'no' }), new RegExp(`--${b} is a boolean flag`));
  }
  assert.doesNotThrow(() => parseStartProfile({ force: true, private: true }));
});

test('toCommand maps approve', () => {
  assert.deepEqual(toCommand({ verb: 'approve', flags: { decision: 'allow' } }),
    { cmd: 'approve', decision: 'allow' });
});

test('approve rejects the vestigial --id instead of silently ignoring it', () => {
  // This used to be tolerated-and-dropped. `--id` only ever existed in the superseded 2026-05-31
  // design doc; the shipped contract (README/SKILL: `approve --decision allow|deny`) has no id — the
  // daemon answers whichever request is parked. Accepting it told a confused caller they were being
  // heard when they weren't, which is the same silent-discard class as `review --bsae`.
  assert.throws(() => toCommand({ verb: 'approve', flags: { id: 'r1', decision: 'allow' } }),
    /unknown flag --id for verb 'approve'/);
});

test('an unknown flag is a loud error, never silently dropped into a different request', () => {
  // The dangerous case: `review --bsae abc` would otherwise become a bare {cmd:'review'} — a full
  // UNSCOPED review of the cwd, when the caller asked for a specific commit range.
  assert.throws(() => toCommand({ verb: 'review', flags: { bsae: 'abc' } }), /unknown flag --bsae/);
  assert.throws(() => toCommand({ verb: 'review', flags: { help: true } }), /unknown flag --help/);
  assert.throws(() => toCommand({ verb: 'wait', flags: { bogus: 'x' } }), /unknown flag --bogus/);
  // Transport flags that bin consumes must still pass through every verb, or real calls break.
  assert.deepEqual(toCommand({ verb: 'wait', flags: { 'timeout-ms': '5000', socket: '/tmp/s' } }), { cmd: 'wait' });
  assert.deepEqual(toCommand({ verb: 'read', flags: { out: '/tmp/x', socket: '/tmp/s' } }), { cmd: 'read' });
  assert.deepEqual(toCommand({ verb: 'review', flags: { base: 'abc', socket: '/tmp/s' } }), { cmd: 'review', base: 'abc' });
});

test('a positional on a verb that takes none is an error (a forgotten flag name)', () => {
  assert.throws(() => toCommand({ verb: 'review', positional: 'abc123', flags: {} }), /takes no positional/);
  assert.throws(() => toCommand({ verb: 'stop', positional: 'now', flags: {} }), /takes no positional/);
  // plan/send legitimately take one.
  assert.equal(toCommand({ verb: 'send', positional: 'hello', flags: {} }).prompt, 'hello');
});
