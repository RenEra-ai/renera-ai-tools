import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, toCommand } from '../lib/verbs.mjs';

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
