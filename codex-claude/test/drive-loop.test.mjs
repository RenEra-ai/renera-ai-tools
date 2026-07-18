// The shared wait/drain engine, against a SCRIPTED daemon socket — no Codex, no real daemon, so
// every branch (including the ones a live run reaches only by accident) is pinned deterministically.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driveTurn, firstOptionAnswer } from '../lib/drive-loop.mjs';
import { rmDir } from './fixtures/helpers.mjs';

const SERVERS = [];
const DIRS = [];
after(async () => {
  for (const s of SERVERS) { try { await new Promise((r) => s.close(r)); } catch { /* ignore */ } }
  for (const d of DIRS) rmDir(d);
});

/**
 * A fake daemon. `script` is consumed one entry per command; each entry is either a response object
 * or a function (cmd) => response. `null` means "never answer" (models a wedged daemon, so the
 * client-side cap is what has to end the wait).
 */
function fakeDaemon(script) {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-dl-'));
  DIRS.push(dir);
  const socketPath = join(dir, 'd.sock');
  const seen = [];
  let i = 0;
  const server = createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      let n;
      while ((n = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, n); buf = buf.slice(n + 1);
        if (!line.trim()) continue;
        const cmd = JSON.parse(line);
        seen.push(cmd);
        const entry = script[Math.min(i++, script.length - 1)];
        const out = typeof entry === 'function' ? entry(cmd) : entry;
        // An entry may return a Promise: a round that takes real time is the only way to exercise a
        // budget spread ACROSS parked rounds (instant answers drain the guard before any clock runs).
        Promise.resolve(out).then((res) => {
          if (res === null || res === undefined) return;   // deliberately silent
          try { sock.write(JSON.stringify(res) + '\n'); } catch { /* closed */ }
        });
      }
    });
    sock.on('error', () => {});
  });
  SERVERS.push(server);
  return new Promise((resolve) => server.listen(socketPath, () => resolve({ socketPath, seen })));
}

const q = (options) => ({ status: 'question', question: { questions: [{ id: 'q1', options }] } });

test('a terminal result passes straight through', async () => {
  const { socketPath } = await fakeDaemon([{ status: 'completed', message: 'done' }]);
  assert.deepEqual(await driveTurn(socketPath, {}), { status: 'completed', message: 'done' });
});

test('first-option extraction handles string, {label}, {value} and empty options', () => {
  assert.equal(firstOptionAnswer({ options: ['A', 'B'] }), 'A');
  assert.equal(firstOptionAnswer({ options: [{ label: 'L' }] }), 'L');
  // {value}-only used to answer the literal string "undefined": the drivers read only `.label`.
  assert.equal(firstOptionAnswer({ options: [{ value: 'V' }] }), 'V');
  assert.equal(firstOptionAnswer({ options: [] }), 'proceed');
  assert.equal(firstOptionAnswer({}), 'proceed');
});

test('a parked question is answered with the first option, then the turn finishes', async () => {
  const { socketPath, seen } = await fakeDaemon([
    q([{ value: 'V' }]),                       // wait #1 -> parked
    { ok: true },                              // answer
    { status: 'completed', message: 'after answer' },
  ]);
  const res = await driveTurn(socketPath, {});
  assert.equal(res.status, 'completed');
  const answer = seen.find((c) => c.cmd === 'answer');
  assert.deepEqual(answer.answers, ['V'], 'must send the {value} option, not "undefined"');
});

test('approval policy allow/deny is forwarded, and fail interrupts instead of answering', async () => {
  for (const decision of ['allow', 'deny']) {
    const { socketPath, seen } = await fakeDaemon([
      { status: 'approval', request: { method: 'item/commandExecution/requestApproval' } },
      { ok: true },
      { status: 'completed', message: 'ok' },
    ]);
    const res = await driveTurn(socketPath, { decideApproval: () => decision });
    assert.equal(res.status, 'completed');
    assert.equal(seen.find((c) => c.cmd === 'approve').decision, decision);
  }
  // 'fail' is the permissions-shaped case: interrupt at once rather than deny-loop 20 times.
  const { socketPath, seen } = await fakeDaemon([
    { status: 'approval', request: { method: 'item/permissions/requestApproval' } },
    { ok: true },
  ]);
  const res = await driveTurn(socketPath, { decideApproval: () => 'fail' });
  assert.equal(res.status, 'failed');
  assert.match(res.reason, /approval policy refuses/);
  assert.equal(seen.filter((c) => c.cmd === 'approve').length, 0, 'must not answer it at all');
  assert.equal(seen.filter((c) => c.cmd === 'interrupt').length, 1);
});

test('an {error} from answer/approve interrupts instead of re-looping to the drain guard', async () => {
  const { socketPath, seen } = await fakeDaemon([
    { status: 'approval', request: { method: 'item/permissions/requestApproval' } },
    { error: 'permissions approval not supported by approve yet' },
    { ok: true },
  ]);
  const res = await driveTurn(socketPath, { decideApproval: () => 'deny' });
  assert.equal(res.status, 'failed');
  assert.match(res.reason, /approve rejected/);
  assert.equal(seen.filter((c) => c.cmd === 'approve').length, 1, 'exactly one attempt, then stop');
});

test('malformed question and unsupported honour their fail/return modes', async () => {
  const bad = { status: 'question', question: { questions: [] } };
  let d = await fakeDaemon([bad, { ok: true }]);
  let res = await driveTurn(d.socketPath, { onMalformedQuestion: 'fail' });
  assert.equal(res.status, 'failed');
  assert.match(res.reason, /malformed question/);

  d = await fakeDaemon([{ status: 'unsupported', request: { method: 'mcpServer/elicitation/request' } }, { ok: true }]);
  res = await driveTurn(d.socketPath, { onUnsupported: 'fail' });
  assert.equal(res.status, 'failed');
  assert.match(res.reason, /unsupported request/);

  d = await fakeDaemon([{ status: 'unsupported', request: { method: 'mcpServer/elicitation/request' } }]);
  res = await driveTurn(d.socketPath, { onUnsupported: 'return' });
  assert.equal(res.status, 'unsupported', 'return mode hands the shape back to the caller');
});

test('the drain guard bounds an endlessly re-parking turn', async () => {
  const { socketPath, seen } = await fakeDaemon([(cmd) => (cmd.cmd === 'wait' ? q(['A']) : { ok: true })]);
  const res = await driveTurn(socketPath, { maxDrains: 3 });
  assert.equal(res.status, 'failed');
  assert.match(res.reason, /drain guard exhausted/);
  assert.equal(seen.filter((c) => c.cmd === 'answer').length, 3);
});

test('a per-wait cap on a silent daemon interrupts and reports timeout', async () => {
  const { socketPath, seen } = await fakeDaemon([null, { ok: true }]);   // never answers `wait`
  const res = await driveTurn(socketPath, { waitTimeoutMs: 150 });
  assert.equal(res.status, 'timeout');
  assert.equal(seen.filter((c) => c.cmd === 'interrupt').length, 1);
});

test('deadlineMs is a TOTAL budget: parked rounds cannot reset it', async () => {
  // The bug this pins: the cap applied per wait, so each parked round started the clock again and
  // the real bound was maxDrains × waitTimeoutMs, not waitTimeoutMs.
  //
  // The turn must PARK repeatedly (never time out a single wait), or the loop exits on the first
  // per-wait cap and the test passes even if deadlineMs is ignored entirely.
  // Each wait takes ~120ms, so the 400ms total budget runs out after a few parked rounds — long
  // before maxDrains, and without any single wait hitting the 5s per-wait cap.
  const slowPark = (cmd) => (cmd.cmd === 'wait'
    ? new Promise((r) => setTimeout(() => r(q(['A'])), 120))
    : { ok: true });
  const { socketPath, seen } = await fakeDaemon([slowPark]);
  const t0 = Date.now();
  const res = await driveTurn(socketPath, { waitTimeoutMs: 5000, deadlineMs: 400, maxDrains: 50 });
  const elapsed = Date.now() - t0;
  assert.equal(res.status, 'timeout');
  assert.match(res.reason, /budget exhausted/, 'must stop on the TOTAL budget, not a per-wait cap');
  assert.ok(elapsed < 3000, `must stop at the total budget, took ${elapsed}ms`);
  // Answered several rounds (so the budget really was being consumed across parks), then stopped
  // well short of maxDrains.
  const answers = seen.filter((c) => c.cmd === 'answer').length;
  assert.ok(answers >= 1 && answers < 50, `expected a few drained rounds, got ${answers}`);
});

test('an ANSWER-side {error} also interrupts (not just approve)', async () => {
  const { socketPath, seen } = await fakeDaemon([
    q(['A']),
    { error: 'no_pending_question' },
    { ok: true },
  ]);
  const res = await driveTurn(socketPath, {});
  assert.equal(res.status, 'failed');
  assert.match(res.reason, /answer rejected/);
  assert.equal(seen.filter((c) => c.cmd === 'answer').length, 1, 'one attempt, then stop');
});

test("onMalformedQuestion:'return' hands the shape back WITHOUT interrupting", async () => {
  // It used to `break`, leaving status 'question' — which the post-loop guard then read as drain
  // exhaustion, so 'return' mode interrupted the turn and reported failed. Both round scripts use
  // this mode, so that was a silent behaviour regression for them.
  const bad = { status: 'question', question: { questions: [] } };
  const { socketPath, seen } = await fakeDaemon([bad, { ok: true }]);
  const res = await driveTurn(socketPath, { onMalformedQuestion: 'return' });
  assert.equal(res.status, 'question', 'the parked shape is returned to the caller');
  assert.equal(seen.filter((c) => c.cmd === 'interrupt').length, 0, 'and the turn is NOT interrupted');
});

test('an already-exhausted budget interrupts immediately instead of waiting forever', async () => {
  // sendCommand treats timeoutMs <= 0 as NO timeout, so a budget that has run out must never be
  // passed through as a cap — that would turn "out of time" into "wait indefinitely".
  const { socketPath, seen } = await fakeDaemon([null, { ok: true }]);
  const res = await driveTurn(socketPath, { waitTimeoutMs: 5000, deadlineMs: 0 });
  assert.equal(res.status, 'timeout');
  assert.match(res.reason, /budget exhausted/);
  assert.equal(seen.filter((c) => c.cmd === 'wait').length, 0, 'must not even attempt a wait');
});

test("onWaitExpiry:'rewait' polls instead of killing a slow-but-healthy turn", async () => {
  // The regression this exists for: a fixed per-wait cap treated "slow" as "dead" and interrupted
  // real work. Two healthy Codex reviews died that way in a single day.
  let waits = 0;
  const { socketPath, seen } = await fakeDaemon([(cmd) => {
    if (cmd.cmd !== 'wait') return { ok: true };
    // Silent for the first two waits (each cap expires), terminal on the third.
    return ++waits <= 2 ? null : { status: 'completed', message: 'finished eventually' };
  }]);
  const res = await driveTurn(socketPath, { waitTimeoutMs: 120, onWaitExpiry: 'rewait' });
  assert.equal(res.status, 'completed', 'the turn must survive its expired caps');
  assert.equal(res.message, 'finished eventually');
  assert.ok(seen.filter((c) => c.cmd === 'wait').length >= 3, 'it must have re-waited');
  assert.equal(seen.filter((c) => c.cmd === 'interrupt').length, 0, 'and never interrupted');
});

test("onWaitExpiry:'rewait' still honours an explicit total deadline", async () => {
  // rewait must never weaken deadlineMs — the one-shot gate depends on that hard bound.
  const { socketPath, seen } = await fakeDaemon([(cmd) => (cmd.cmd === 'wait' ? null : { ok: true })]);
  const res = await driveTurn(socketPath, { waitTimeoutMs: 100, deadlineMs: 350, onWaitExpiry: 'rewait' });
  assert.equal(res.status, 'timeout');
  assert.match(res.reason, /total wait budget exhausted/);
  assert.equal(seen.filter((c) => c.cmd === 'interrupt').length, 1, 'budget exhaustion still interrupts');
});
