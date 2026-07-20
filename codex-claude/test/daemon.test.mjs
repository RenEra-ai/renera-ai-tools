import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Daemon } from '../lib/daemon.mjs';
import { rmDir } from './fixtures/helpers.mjs';

// Sweep every daemon + temp dir this suite creates: the per-test teardown is skipped by a failed
// assertion, which otherwise leaves a live daemon and leaks cdx-d-/cdx-home- dirs on every run.
const CREATED = [];
after(async () => {
  for (const r of CREATED) {
    try { await r.daemon?.stop(); } catch { /* best effort */ }
    rmDir(r.dir);
  }
  CREATED.length = 0;
});

const FIXTURE = fileURLToPath(new URL('./fixtures/mock-appserver.mjs', import.meta.url));

function rpcCall(socketPath, cmdObj) {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(cmdObj) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) { sock.end(); resolve(JSON.parse(buf.slice(0, i))); }
    });
    sock.on('error', reject);
  });
}

async function startDaemon(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-d-'));
  const socketPath = join(dir, 't.sock');
  const daemon = new Daemon({
    socketPath,
    appServerOpts: { command: process.execPath, args: [FIXTURE] },
    clientInfo: { name: 'codex-drive', version: '0.1.0' },
    ...extra,
  });
  CREATED.push({ daemon, dir });   // before start(): a boot that throws still leaves the dir behind
  await daemon.start();
  return { daemon, socketPath, dir };
}

test('REGRESSION: a same-burst response+completion on a PLAIN send is still honest', async () => {
  // The race was never review-only: plan/send share _startTurn, which reset turn.id to null, ignored
  // the response, and accepted any notification while the id was unknown. The fixture's old 20ms
  // delay let the response always win and hid it. BURSTTURN emits response+notifications in ONE
  // write, so feed() drains them synchronously before the response promise's continuation runs.
  const { daemon, socketPath } = await startDaemon();
  await rpcCall(socketPath, { cmd: 'send', prompt: 'BURSTTURN now' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'completed');
  assert.equal(res.message, 'BURSTOK');
  assert.equal(daemon.turn.status, 'completed', 'reported status must match daemon truth');
  await daemon.stop();
});

test('send → wait returns the completed message', async () => {
  const { daemon, socketPath } = await startDaemon();
  await rpcCall(socketPath, { cmd: 'send', prompt: 'say OK' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'completed');
  assert.equal(res.message, 'OK');
  await daemon.stop();
});

test('a question parks the turn; wait surfaces it; answer lets it complete', async () => {
  const { daemon, socketPath } = await startDaemon();
  await rpcCall(socketPath, { cmd: 'send', prompt: 'ASK please' });
  const q = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(q.status, 'question');
  assert.equal(q.question.questions[0].id, 'q1');
  await rpcCall(socketPath, { cmd: 'answer', id: 'q1', answers: ['B'] });
  const done = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(done.status, 'completed');
  assert.match(done.message, /chose/);
  await daemon.stop();
});

test('a second concurrent turn is rejected while one is in flight', async () => {
  // Uses ASK, which PARKS the turn, so it is deterministically still in flight when the second send
  // arrives. The old version sent a fast-completing prompt and relied on the fixture's 20ms sleep to
  // still be running — i.e. it tested the sleep, not the busy guard, and went flaky the moment the
  // sleep went away.
  const { daemon, socketPath } = await startDaemon();
  await rpcCall(socketPath, { cmd: 'send', prompt: 'ASK please' });
  await rpcCall(socketPath, { cmd: 'wait' });                       // parked on the question
  const busy = await rpcCall(socketPath, { cmd: 'send', prompt: 'again' });
  assert.equal(busy.error, 'busy');
  await rpcCall(socketPath, { cmd: 'answer', id: 'q1', answers: ['A'] });
  await rpcCall(socketPath, { cmd: 'wait' });
  await daemon.stop();
});

test('status reports the completed turn after it finishes', async () => {
  const { daemon, socketPath } = await startDaemon();
  await rpcCall(socketPath, { cmd: 'send', prompt: 'say OK' });
  await rpcCall(socketPath, { cmd: 'wait' });
  const st = await rpcCall(socketPath, { cmd: 'status' });
  assert.equal(st.turnStatus, 'completed');
  await daemon.stop();
});

test('answer --option resolves the 1-based option label', async () => {
  const { daemon, socketPath } = await startDaemon();
  await rpcCall(socketPath, { cmd: 'send', prompt: 'ASK now' });
  await rpcCall(socketPath, { cmd: 'wait' });
  await rpcCall(socketPath, { cmd: 'answer', id: 'q1', answers: ['__option:2'] });
  const done = await rpcCall(socketPath, { cmd: 'wait' });
  assert.match(done.message, /"B"/); // fixture echoes the chosen answer; option 2 = 'B'
  await daemon.stop();
});

test('plan turn with a resolved model builds valid settings and completes', async () => {
  const { daemon, socketPath } = await startDaemon({ model: 'mock-model' });
  await rpcCall(socketPath, { cmd: 'plan', prompt: 'say OK' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'completed');
  assert.equal(res.message, 'OK');
  await daemon.stop();
});

test('plan turn prefers plan stream/final plan item over agent-message preamble', async () => {
  const { daemon, socketPath } = await startDaemon({ model: 'mock-model' });
  await rpcCall(socketPath, { cmd: 'plan', prompt: 'PLANSTREAM now' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'completed');
  assert.equal(res.message, 'src/app.js\n- Add GET /healthz.\n- Add a request test.');
  await daemon.stop();
});

test('plan turn accepts completed plan item text when no plan delta streamed', async () => {
  const { daemon, socketPath } = await startDaemon({ model: 'mock-model' });
  await rpcCall(socketPath, { cmd: 'plan', prompt: 'PLANITEM now' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'completed');
  assert.equal(res.message, 'app.js\n- Add GET /healthz.');
  await daemon.stop();
});

test('plain review send ignores incidental plan deltas and keeps review verdict text', async () => {
  const { daemon, socketPath } = await startDaemon({ model: 'mock-model' });
  await rpcCall(socketPath, { cmd: 'send', prompt: 'REVIEWPLAN now' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'completed');
  assert.equal(res.message, 'Reviewed src/app.js.\nVERDICT: NO ISSUES');
  await daemon.stop();
});

test('send --mode default sets collaborationMode default (exit plan mode) and completes', async () => {
  const { daemon, socketPath } = await startDaemon({ model: 'mock-model' });
  // plain plan turn first (enters plan mode), then exit via send --mode default
  await rpcCall(socketPath, { cmd: 'plan', prompt: 'say OK' });
  await rpcCall(socketPath, { cmd: 'wait' });
  const res = await rpcCall(socketPath, { cmd: 'send', mode: 'default', prompt: 'say OK' });
  assert.equal(res.ok, true);
  const done = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(done.status, 'completed');
  assert.equal(done.message, 'OK'); // mock accepted the default-mode collaborationMode (valid model string)
  await daemon.stop();
});

test('plan turn with no resolvable model errors instead of sending model:null', async () => {
  // codexHome points at an empty temp dir (no config.toml) and no --model → unresolvable.
  const emptyHome = mkdtempSync(join(tmpdir(), 'cdx-home-'));
  CREATED.push({ dir: emptyHome });
  const { daemon, socketPath } = await startDaemon({ model: null, codexHome: emptyHome });
  const res = await rpcCall(socketPath, { cmd: 'plan', prompt: 'say OK' });
  assert.equal(res.error, 'no_model_for_mode');
  await daemon.stop();
});

test('a rejected turn/start surfaces as failed and does NOT hang', { timeout: 5000 }, async () => {
  // Regression guard for the live hang: turn/start rejection must resolve `wait`, not swallow.
  const { daemon, socketPath } = await startDaemon();
  await rpcCall(socketPath, { cmd: 'send', prompt: 'BADTURN now' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /turn\/start failed/);
  await daemon.stop();
});

test('approve maps allow to the v2 accept decision on a parked command approval', { timeout: 5000 }, async () => {
  const { daemon, socketPath } = await startDaemon();
  await rpcCall(socketPath, { cmd: 'send', prompt: 'APPROVE this' });
  const parked = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(parked.status, 'approval');
  assert.equal(parked.request.method, 'item/commandExecution/requestApproval');
  await rpcCall(socketPath, { cmd: 'approve', decision: 'allow' });
  const done = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(done.status, 'completed');
  // fixture echoes the decision it received; the daemon must have sent {decision:"accept"}.
  assert.match(done.message, /"decision":"accept"/);
  await daemon.stop();
});

test('stop over the socket responds and does NOT deadlock', { timeout: 5000 }, async () => {
  const { socketPath } = await startDaemon();
  const res = await rpcCall(socketPath, { cmd: 'stop' });
  assert.equal(res.ok, true); // teardown happens after this response; must not hang
});

test('a throwing command handler returns an error and the daemon stays alive', { timeout: 5000 }, async () => {
  const { daemon, socketPath } = await startDaemon();
  await rpcCall(socketPath, { cmd: 'send', prompt: 'ASK please' });
  await rpcCall(socketPath, { cmd: 'wait' });
  const res = await rpcCall(socketPath, { cmd: 'answer', id: 'q1', answers: ['__option:99'] }); // out of range
  assert.match(res.error, /out of range/);
  const st = await rpcCall(socketPath, { cmd: 'status' }); // still responsive, still parked
  assert.equal(st.turnStatus, 'awaiting_input');
  await daemon.stop();
});

test('app-server exit fails the active turn instead of hanging', { timeout: 5000 }, async () => {
  const { daemon, socketPath } = await startDaemon();
  await rpcCall(socketPath, { cmd: 'send', prompt: 'ASK please' });
  await rpcCall(socketPath, { cmd: 'wait' }); // parked on a question
  daemon.app.child.kill(); // simulate codex app-server death mid-turn
  await new Promise((r) => setTimeout(r, 200)); // let the exit event propagate
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /exited/);
  await daemon.stop();
});

test('_onNotification ignores deltas/completion from a stale (non-active) turn', () => {
  const d = new Daemon({ socketPath: '/tmp/cdx-unit-none.sock', clientInfo: {} });
  d.turn = { id: 'T1', status: 'running', buffer: '', parked: null, message: null };
  d._onNotification('item/agentMessage/delta', { turnId: 'T2', delta: 'STALE' });
  d._onNotification('item/agentMessage/delta', { turnId: 'T1', delta: 'OK' });
  assert.equal(d.turn.buffer, 'OK');
  d._onNotification('turn/completed', { turn: { id: 'T2', status: 'completed' } }); // stale → ignored
  assert.equal(d.turn.status, 'running');
  d._onNotification('turn/completed', { turn: { id: 'T1', status: 'completed' } });
  assert.equal(d.turn.status, 'completed');
  assert.equal(d.turn.message, 'OK');
});

test('an empty completed turn is flagged empty:true on wait and read', async () => {
  const { daemon, socketPath } = await startDaemon();
  await rpcCall(socketPath, { cmd: 'send', prompt: 'EMPTY now' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'completed');
  assert.equal(res.empty, true);            // malformed-turn signal for the orchestrator
  assert.ok(!res.message || !res.message.trim());
  const r = await rpcCall(socketPath, { cmd: 'read' });
  assert.equal(r.empty, true);              // read carries the same flag
  await daemon.stop();
});

test('_completedResult flags only blank completed turns (not non-empty, not non-completed)', () => {
  const d = new Daemon({ socketPath: '/tmp/cdx-unit-none.sock', clientInfo: {} });
  d.turn = { id: 'T', status: 'completed', buffer: '', parked: null, message: '   \n ' };
  assert.equal(d._completedResult().empty, true);                 // whitespace-only → empty
  d.turn.message = 'real plan';
  assert.equal(d._completedResult().empty, undefined);            // has content → no flag
  d.turn.status = 'failed'; d.turn.message = '';
  assert.equal(d._completedResult().empty, undefined);            // not completed → no flag
});

test('a parked elicitation is surfaced as unsupported and cannot be answered', async () => {
  const d = new Daemon({ socketPath: '/tmp/cdx-unit-none.sock', clientInfo: {} });
  d.turn = { id: 'T1', status: 'awaiting_input', buffer: '', message: null,
    parked: { id: 5, kind: 'elicitation', method: 'mcpServer/elicitation/request', params: {} } };
  assert.equal(d._parkedResult().status, 'unsupported');
  const r = await d._answer('q', ['x']);
  assert.equal(r.error, 'no_pending_question');
});

// _wait's finish/onClose pairing. An EventEmitter is the fake socket: _wait only needs
// once/off, and listenerCount observes whether resolution really detached its listener.
const runningDaemon = () => {
  const d = new Daemon({ socketPath: '/tmp/cdx-unit-none.sock', clientInfo: {} });
  d.turn.status = 'running';
  return d;
};

test('wait resolution removes its own close listener (terminal, parked, and failed endings)', async () => {
  const endings = [
    (d) => { d.turn.status = 'completed'; d.turn.message = 'done'; d._resolveWaiters(); },
    (d) => { d.turn.status = 'awaiting_input'; d.turn.parked = { kind: 'question', params: {} }; d._resolveWaiters(); },
    (d) => { d._finalizeTurn('boom'); },
  ];
  for (const end of endings) {
    const d = runningDaemon();
    const sock = new EventEmitter();
    const p = d._wait(sock);
    assert.equal(sock.listenerCount('close'), 1);
    end(d);
    await p;
    assert.equal(sock.listenerCount('close'), 0, 'resolution must detach its own close listener');
    assert.equal(d._waiters.length, 0);
  }
});

test('a disconnect removes only its own waiter', async () => {
  const d = runningDaemon();
  const sockA = new EventEmitter();
  const sockB = new EventEmitter();
  d._wait(sockA);                       // abandoned below; its promise never resolves by design
  const pB = d._wait(sockB);
  sockA.emit('close');
  assert.equal(d._waiters.length, 1, 'the disconnect must drop exactly one waiter');
  d.turn.status = 'completed'; d.turn.message = 'done';
  d._resolveWaiters();
  assert.equal((await pB).status, 'completed', 'the surviving waiter must still resolve');
  assert.equal(sockB.listenerCount('close'), 0);
});

test("an older socket's close cannot remove a later socket's waiter", async () => {
  const d = runningDaemon();
  const sockA = new EventEmitter();
  const pA = d._wait(sockA);
  d.turn.status = 'completed'; d.turn.message = 'first';
  d._resolveWaiters();
  await pA;
  d.turn.status = 'running';
  const sockB = new EventEmitter();
  const pB = d._wait(sockB);
  sockA.emit('close');                  // late close of the RESOLVED wait's socket
  assert.equal(d._waiters.length, 1, "an old socket's close must not touch the new waiter");
  d.turn.status = 'completed'; d.turn.message = 'second';
  d._resolveWaiters();
  assert.equal((await pB).message, 'second');
});

test('a resolved waiter is settled exactly once; a later close is a no-op', async () => {
  const d = runningDaemon();
  const sock = new EventEmitter();
  const p = d._wait(sock);
  d.turn.status = 'completed'; d.turn.message = 'once';
  d._resolveWaiters();
  assert.equal((await p).message, 'once');
  assert.equal(sock.listenerCount('close'), 0);
  sock.emit('close');                   // must not throw, must not splice anything
  assert.equal(d._waiters.length, 0);
});

test('repeated fresh-socket disconnects leave _waiters empty', () => {
  const d = runningDaemon();
  for (let i = 0; i < 12; i++) {
    const sock = new EventEmitter();
    d._wait(sock);
    sock.emit('close');
    assert.equal(d._waiters.length, 0, `iteration ${i}: the dead resolver must be dropped`);
  }
});

// ---- turn activity signal (lastEventAgoMs / eventCount) ----

test('a hung turn shows the STUCK signature: ago grows while the count stands still', async () => {
  const { daemon, socketPath } = await startDaemon();
  await rpcCall(socketPath, { cmd: 'send', prompt: 'HANGTURN now' });
  await new Promise((r) => setTimeout(r, 100));           // let turn/started land
  const a = await rpcCall(socketPath, { cmd: 'status' });
  assert.equal(a.turnStatus, 'running');
  assert.equal(typeof a.lastEventAgoMs, 'number');
  assert.ok(a.eventCount >= 1, `turn/started must count: ${a.eventCount}`);
  await new Promise((r) => setTimeout(r, 300));
  const b = await rpcCall(socketPath, { cmd: 'status' });
  assert.ok(b.lastEventAgoMs > a.lastEventAgoMs, 'silence must age the last event');
  assert.equal(b.eventCount, a.eventCount, 'silence must not add events');
  await daemon.stop();
});

test('a streaming turn shows the WORKING signature: count rises, ago stays small', async () => {
  const { daemon, socketPath } = await startDaemon();
  await rpcCall(socketPath, { cmd: 'send', prompt: 'TICKS now' });
  await new Promise((r) => setTimeout(r, 250));
  const a = await rpcCall(socketPath, { cmd: 'status' });
  await new Promise((r) => setTimeout(r, 400));
  const b = await rpcCall(socketPath, { cmd: 'status' });
  assert.ok(b.eventCount > a.eventCount, `deltas must keep counting (${a.eventCount} -> ${b.eventCount})`);
  assert.ok(b.lastEventAgoMs < 500, `a streaming turn must read as recent: ${b.lastEventAgoMs}`);
  const done = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(done.status, 'completed');
  await daemon.stop();
});

test('activity counters reset per turn, not cumulative across turns', async () => {
  const { daemon, socketPath } = await startDaemon();
  await rpcCall(socketPath, { cmd: 'send', prompt: 'say OK' });
  await rpcCall(socketPath, { cmd: 'wait' });
  const first = await rpcCall(socketPath, { cmd: 'status' });
  await rpcCall(socketPath, { cmd: 'send', prompt: 'say OK' });
  await rpcCall(socketPath, { cmd: 'wait' });
  const second = await rpcCall(socketPath, { cmd: 'status' });
  assert.ok(first.eventCount >= 3, `started+delta+completed: ${first.eventCount}`);
  assert.equal(second.eventCount, first.eventCount, 'the second turn must start its own count');
  await daemon.stop();
});

test('REGRESSION: buffered-then-replayed notifications stamp activity exactly once', async () => {
  // BURSTTURN delivers the response + every notification in ONE chunk, so all three notifications
  // (started, delta, completed) are buffered and then replayed. A stamp in _onNotification would
  // fire twice per buffered event (6); the dispatch-side stamp counts each exactly once.
  const { daemon, socketPath } = await startDaemon();
  await rpcCall(socketPath, { cmd: 'send', prompt: 'BURSTTURN now' });
  await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(daemon.turn.eventCount, 3, 'each buffered event must count exactly once');
  await daemon.stop();
});

test('a parked question counts as activity', async () => {
  const { daemon, socketPath } = await startDaemon();
  await rpcCall(socketPath, { cmd: 'send', prompt: 'ASK please' });
  const q = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(q.status, 'question');
  const st = await rpcCall(socketPath, { cmd: 'status' });
  assert.ok(st.eventCount >= 2, `turn/started + the question must both count: ${st.eventCount}`);
  await rpcCall(socketPath, { cmd: 'answer', id: 'q1', answers: ['A'] });
  await rpcCall(socketPath, { cmd: 'wait' });
  await daemon.stop();
});

test('foreign-thread traffic (ultra delegated subagents) stamps activity but nothing else', () => {
  const d = new Daemon({ socketPath: '/tmp/cdx-unit-none.sock', clientInfo: {} });
  d.threadId = 'T-mine';
  d.turn = { id: 'T1', status: 'running', buffer: '', parked: null, message: null, finalized: false };
  d._onNotification('item/agentMessage/delta', { threadId: 'T-other', turnId: 'X', delta: 'FOREIGN' });
  assert.equal(d.turn.buffer, '', 'a foreign delta must not touch the buffer');
  assert.equal(d.turn.eventCount, 1, 'but it must stamp activity — a delegating ultra turn is not stuck');
  assert.equal(typeof d.turn.lastEventAt, 'number');
});

test('12 resolved waits on ONE persistent socket leave zero armed close listeners', async () => {
  // The protocol-surface pin: _onClient accepts many commands per connection, so a pipelining
  // client's socket must not accumulate one armed close-listener per already-resolved wait.
  const d = runningDaemon();
  const sock = new EventEmitter();
  for (let i = 0; i < 12; i++) {
    d.turn.status = 'running';
    const p = d._wait(sock);
    d.turn.status = 'completed'; d.turn.message = 'ok';
    d._resolveWaiters();
    await p;
  }
  assert.equal(sock.listenerCount('close'), 0, 'resolved waits must detach their close listeners');
});
