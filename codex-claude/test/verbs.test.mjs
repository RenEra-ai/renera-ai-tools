import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, toCommand, parseStartProfile } from '../lib/verbs.mjs';

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

test('toCommand maps approve', () => {
  assert.deepEqual(toCommand({ verb: 'approve', flags: { id: 'r1', decision: 'allow' } }),
    { cmd: 'approve', decision: 'allow' });
});
