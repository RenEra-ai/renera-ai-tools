import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Daemon, REVIEW_PROFILE } from '../lib/daemon.mjs';
import { git, makeRepo, rmDir } from './fixtures/helpers.mjs';
import { CLIENT_INFO } from '../lib/protocol.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/mock-appserver.mjs', import.meta.url));

// Every daemon and temp dir this suite creates, cleaned up at the end no matter how tests exit.
// The per-test teardown below runs only on the happy path: one failed assertion used to leave a
// live daemon (holding a mock app-server child) and leak BOTH temp dirs — and the `cdx-ds-` socket
// dir was never removed even when everything passed, so a full run leaked ~19 of them.
const CREATED = [];
after(async () => {
  for (const r of CREATED) {
    try { await r.daemon?.stop(); } catch { /* best effort */ }
    rmDir(r.sockDir);
  }
  CREATED.length = 0;
});

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

// A real repo: git-scope shells out for real, so the daemon needs a genuine dirty tree to resolve.
// TWO commits, deliberately: with only one, `first` IS HEAD, and a --base test would exercise the
// base-is-HEAD rejection rather than a real branch diff.
function repo(opts = {}) {
  const r = makeRepo({ prefix: 'cdx-dr-', ...opts });
  CREATED.push({ sockDir: r.dir });   // swept by the `after` hook even if this test throws
  return r;
}

async function startDaemon({ mode = 'ok', profile = REVIEW_PROFILE, cwd, appServerArgs = [], ...extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-ds-'));
  const socketPath = join(dir, 't.sock');
  const daemon = new Daemon({
    socketPath,
    appServerOpts: { command: process.execPath, args: [FIXTURE, '--review-mode', mode, ...appServerArgs] },
    clientInfo: CLIENT_INFO,
    cwd, profile,
    ...extra,
  });
  // Registered BEFORE start(): a boot that throws part-way still leaves the socket dir (and
  // possibly a spawned child) behind, and the caller never gets a handle to clean up.
  const rec = { daemon, sockDir: dir };
  CREATED.push(rec);
  await daemon.start();
  return { daemon, socketPath };
}

test('review happy path returns the review text', async () => {
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir });
  const started = await rpcCall(socketPath, { cmd: 'review' });
  assert.equal(started.ok, true);
  assert.match(started.scope, /working tree/);          // dirty tree -> auto -> working-tree
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'completed');
  assert.match(res.message, /\[P2\] something to fix/);
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('turn.id comes from the response, NOT from turn/started (which disagrees on a review)', async () => {
  // Live reality on codex-cli 0.144.5: review/start's response.turn.id is the id that turn/completed
  // and every item/completed carry, while turn/started announces an unrelated one. The fixture
  // reproduces that disagreement, so this pins WHICH id we adopt — assert it directly rather than
  // only observing that the turn completed (buffering alone would make that pass either way).
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir });
  await rpcCall(socketPath, { cmd: 'review' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'completed');
  assert.match(daemon.turn.id, /^turn-/, 'adopted the response id');
  assert.ok(!/^started-/.test(daemon.turn.id), 'must NOT have adopted turn/started\'s id');
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('REGRESSION: a same-burst response+completion cannot report a review the daemon never validated', async () => {
  // The reproduced race: JsonRpc.feed() drains a coalesced chunk synchronously while the response
  // promise resolves on a later microtask. Previously `wait` returned completed+text while the
  // turn's true status was failed. Buffering until the response makes wire order irrelevant.
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir, mode: 'burst' });
  await rpcCall(socketPath, { cmd: 'review' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'completed');
  assert.match(res.message, /\[P2\] something to fix/);
  assert.equal(daemon.turn.status, 'completed', 'reported status must match the daemon truth');
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('a rejected review/start surfaces as failed and does not hang', { timeout: 5000 }, async () => {
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir, mode: 'reject' });
  await rpcCall(socketPath, { cmd: 'review' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /review\/start failed/);
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('a foreign reviewThreadId fails the turn instead of attributing someone else\'s review', { timeout: 5000 }, async () => {
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir, mode: 'wrongthread' });
  await rpcCall(socketPath, { cmd: 'review' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /unusable reviewThreadId/);
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('a blank review fails — never completed-with-empty (the gate reads clean as ship-it)', { timeout: 5000 }, async () => {
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir, mode: 'blank' });
  await rpcCall(socketPath, { cmd: 'review' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /without any review text/);
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('a completed turn whose start response never arrives fails via the daemon backstop', { timeout: 15000 }, async () => {
  // There is no daemon-side wait cap (_wait parks a bare resolver), so without this backstop the
  // buffered completion would sit forever, the busy guard would block every later turn, and `wait`
  // would hang. The buffered review must NEVER be released as completed.
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir, mode: 'noresponse' });
  await rpcCall(socketPath, { cmd: 'review' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /never arrived/);
  assert.ok(!/\[P2\]/.test(res.message || ''), 'the unvalidated review text must not leak out');
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('review is refused on a session without the review thread profile', async () => {
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir, profile: null });
  const res = await rpcCall(socketPath, { cmd: 'review' });
  assert.equal(res.error, 'wrong_thread_profile');
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('review is refused on a writable sandbox and on a resumed thread', async () => {
  const { dir } = repo();
  const a = await startDaemon({ cwd: dir, profile: { ...REVIEW_PROFILE, sandbox: 'workspace-write' } });
  assert.equal((await rpcCall(a.socketPath, { cmd: 'review' })).error, 'wrong_thread_profile');
  await a.daemon.stop();
  // A resumed thread keeps whatever profile it was born with; we cannot re-profile it, so it is
  // never eligible however the flags look.
  const b = await startDaemon({ cwd: dir, resume: 'thread-1' });
  assert.equal((await rpcCall(b.socketPath, { cmd: 'review' })).error, 'wrong_thread_profile');
  await b.daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('review refuses a second concurrent turn (busy guard) and validates scope synchronously', async () => {
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir });
  await rpcCall(socketPath, { cmd: 'review' });
  assert.equal((await rpcCall(socketPath, { cmd: 'review' })).error, 'busy');
  await rpcCall(socketPath, { cmd: 'wait' });
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('a bad scope is a synchronous error that leaves the turn state untouched', async () => {
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir });
  assert.match((await rpcCall(socketPath, { cmd: 'review', scope: 'bogus' })).error, /invalid --scope/);
  assert.match((await rpcCall(socketPath, { cmd: 'review', base: true })).error, /non-blank/);
  assert.match((await rpcCall(socketPath, { cmd: 'review', base: 'x', scope: 'branch' })).error, /mutually exclusive/);
  assert.match((await rpcCall(socketPath, { cmd: 'review', base: 'nosuchref' })).error, /does not resolve/);
  const st = await rpcCall(socketPath, { cmd: 'status' });
  assert.equal(st.turnStatus, 'idle');    // no turn was ever started
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('review --base resolves against the DAEMON cwd, not the caller cwd', async () => {
  // The daemon's cwd is the single anchor for git-scope, the app-server spawn and thread/start.
  // Here the test process's cwd is deliberately somewhere else entirely.
  const { dir, first } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir });
  const res = await rpcCall(socketPath, { cmd: 'review', base: first.slice(0, 7) });
  assert.equal(res.ok, true);
  assert.match(res.scope, /branch diff against/);
  assert.notEqual(daemon.cwd, process.cwd());
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('status and read report the daemon cwd (so a --socket caller can resolve a relative --out)', async () => {
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir });
  assert.equal((await rpcCall(socketPath, { cmd: 'status' })).cwd, daemon.cwd);
  assert.equal((await rpcCall(socketPath, { cmd: 'read' })).cwd, daemon.cwd);
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('a parked question during a review is surfaced and answering lets it finish', { timeout: 8000 }, async () => {
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir, mode: 'ask' });
  await rpcCall(socketPath, { cmd: 'review' });
  const q = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(q.status, 'question');
  await rpcCall(socketPath, { cmd: 'answer', id: 'q1', answers: ['A'] });
  const done = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(done.status, 'completed');
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('a parked approval during a review can be denied and the review still finishes', { timeout: 8000 }, async () => {
  // Live reviews never prompt under approvalPolicy:'never' — this path is belt-and-braces.
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir, mode: 'approve' });
  await rpcCall(socketPath, { cmd: 'review' });
  const p = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(p.status, 'approval');
  await rpcCall(socketPath, { cmd: 'approve', decision: 'deny' });
  const done = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(done.status, 'completed');
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('REGRESSION: a FAILED turn can never be resurrected by the server\'s later notifications', () => {
  // Found by review, reproduced by probe: _failTurn left turn.id null, so _isStaleTurn (which needs a
  // truthy turn.id) filtered nothing — the server keeps streaming after we reject a turn, and the
  // failed turn walked back to `completed` carrying the very review text we refused.
  const d = new Daemon({ socketPath: '/tmp/cdx-unit-none.sock', clientInfo: {}, cwd: process.cwd() });
  d.threadId = 'T-mine';
  d.app = { respond() {}, respondError() {} };
  d._gen = 2;
  d.turn = d._freshTurn({ status: 'running', awaitingResponse: true, isReview: true, gen: 2 });
  d._onStartResponse(2, { turn: { id: 'turn-2' }, reviewThreadId: 'T-SOMEONE-ELSE' }, 'review/start');
  assert.equal(d.turn.status, 'failed');
  d._onNotification('item/completed', { threadId: 'T-mine', turnId: 'turn-2', item: { type: 'exitedReviewMode', review: 'LEAKED REVIEW TEXT' } });
  d._onNotification('turn/completed', { threadId: 'T-mine', turn: { id: 'turn-2', status: 'completed' } });
  assert.equal(d.turn.status, 'failed', 'a failed turn must STAY failed');
  assert.ok(!/LEAKED/.test(d.turn.message || ''), 'the rejected review text must never surface');
});

test('REGRESSION: a missing/blank reviewThreadId fails the turn (truthiness is not validation)', () => {
  const d = new Daemon({ socketPath: '/tmp/cdx-unit-none.sock', clientInfo: {}, cwd: process.cwd() });
  d.threadId = 'T-mine';
  d.app = { respond() {}, respondError() {} };
  for (const bad of [undefined, '', null]) {
    d._gen += 1;
    const gen = d._gen;
    d.turn = d._freshTurn({ status: 'running', awaitingResponse: true, isReview: true, gen });
    d._onStartResponse(gen, { turn: { id: 't' }, reviewThreadId: bad }, 'review/start');
    assert.equal(d.turn.status, 'failed', `reviewThreadId ${JSON.stringify(bad)} must fail, not be waved through`);
  }
});

test('REGRESSION: a foreign thread\'s completion cannot arm the backstop and kill our turn', () => {
  const d = new Daemon({ socketPath: '/tmp/cdx-unit-none.sock', clientInfo: {}, cwd: process.cwd() });
  d.threadId = 'T-mine';
  d._gen = 1;
  d.turn = d._freshTurn({ status: 'running', awaitingResponse: true, gen: 1 });
  d._onNotification('turn/completed', { threadId: 'T-OTHER', turn: { id: 'x', status: 'completed' } });
  assert.equal(d.turn.backstop, null, 'a foreign completion must not arm our backstop');
  assert.equal(d.turn.buffered.length, 0, 'a foreign notification must not even be buffered');
  // ...nor may a non-successful completion: interrupted/failed are already fail-closed.
  d._onNotification('turn/completed', { threadId: 'T-mine', turn: { id: 'x', status: 'interrupted' } });
  assert.equal(d.turn.backstop, null, 'only a SUCCESSFUL completion needs the response');
  d._clearBackstop();
});

test('REGRESSION: a stale same-thread server request cannot park a turn whose id is not yet known', () => {
  // While awaitingResponse, turn.id is null, so _isStaleTurn cannot judge — the request must be
  // buffered with the notifications, not parked. Reproduced by review with a request for turn-OLD.
  const responded = [];
  const d = new Daemon({ socketPath: '/tmp/cdx-unit-none.sock', clientInfo: {}, cwd: process.cwd() });
  d.threadId = 'T-mine';
  d.app = { respond: (id, r) => responded.push({ id, r }), respondError: (id, c, m) => responded.push({ id, c, m }) };
  d._gen = 1;
  d.turn = d._freshTurn({ status: 'running', awaitingResponse: true, gen: 1 });
  d._onServerRequest({ id: 9, method: 'item/tool/requestUserInput', params: { threadId: 'T-mine', turnId: 'turn-OLD' } });
  assert.equal(d.turn.parked, null, 'must not park before the response makes turn.id authoritative');
  assert.equal(d.turn.status, 'running');
  // Once the response lands, the replay judges it: stale -> declined AND answered, still not parked.
  d._onStartResponse(1, { turn: { id: 'turn-NEW' } }, 'turn/start');
  assert.equal(d.turn.parked, null, 'the stale request must be declined on replay, never parked');
  assert.equal(responded.length, 1, 'and it must still get a response — an unanswered request wedges the server turn');
});

test('a server request from a foreign thread is never parked, and is still answered', () => {
  const responded = [];
  const d = new Daemon({ socketPath: '/tmp/cdx-unit-none.sock', clientInfo: {}, cwd: process.cwd() });
  d.threadId = 'T-mine';
  d.turn = { ...d.turn, id: 'turn-1', status: 'running' };
  d.app = {
    respond: (id, result) => responded.push({ id, result }),
    respondError: (id, code, message) => responded.push({ id, code, message }),
  };
  // Foreign thread, approval shape -> declined in its own shape, not parked.
  d._onServerRequest({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'T-other', turnId: 'x' } });
  assert.equal(d.turn.parked, null, 'a foreign request must not park our turn');
  assert.deepEqual(responded[0], { id: 1, result: { decision: 'decline' } });
  // Foreign thread, unknown shape -> a JSON-RPC error, never left unanswered (that wedges the turn).
  d._onServerRequest({ id: 2, method: 'some/unknown/request', params: { threadId: 'T-other' } });
  assert.equal(d.turn.parked, null);
  assert.equal(responded[1].id, 2);
  assert.equal(responded[1].code, -32600);
  // Stale turn on OUR thread -> also filtered.
  d._onServerRequest({ id: 3, method: 'item/tool/requestUserInput', params: { threadId: 'T-mine', turnId: 'turn-STALE' } });
  assert.equal(d.turn.parked, null);
  assert.equal(responded[2].id, 3);
  // A legitimate request for our current turn still parks.
  d._onServerRequest({ id: 4, method: 'item/tool/requestUserInput', params: { threadId: 'T-mine', turnId: 'turn-1' } });
  assert.equal(d.turn.parked.id, 4);
});

test('foreign-thread notifications never touch the active turn', () => {
  const d = new Daemon({ socketPath: '/tmp/cdx-unit-none.sock', clientInfo: {}, cwd: process.cwd() });
  d.threadId = 'T-mine';
  d.turn = { ...d.turn, id: 'turn-1', status: 'running', awaitingResponse: false, buffer: '' };
  d._onNotification('item/agentMessage/delta', { threadId: 'T-other', turnId: 'turn-1', delta: 'FOREIGN' });
  assert.equal(d.turn.buffer, '');
  d._onNotification('item/agentMessage/delta', { threadId: 'T-mine', turnId: 'turn-1', delta: 'MINE' });
  assert.equal(d.turn.buffer, 'MINE');
  // A foreign thread's completion must not finish our turn.
  d._onNotification('turn/completed', { threadId: 'T-other', turn: { id: 'turn-1', status: 'completed' } });
  assert.equal(d.turn.status, 'running');
});

// --- Phase 2: turn finalization, request settlement, cancellation ---

// A stub app that RECORDS every response, so tests can assert not just that a server request was
// settled but in what ORDER relative to the interrupt.
function stubApp(log = []) {
  return {
    log,
    respond(id) { log.push(`respond:${id}`); },
    respondError(id) { log.push(`respondError:${id}`); },
    request(method) { log.push(method); return Promise.resolve({}); },
  };
}

function unitDaemon({ log = [], threadId = 'T-mine' } = {}) {
  const d = new Daemon({ socketPath: '/tmp/cdx-unit-none.sock', clientInfo: {}, cwd: process.cwd() });
  d.threadId = threadId;
  d.app = stubApp(log);
  return d;
}

test('a REJECTED turn/start is finalized (no resurrection) and does NOT quarantine the session', async () => {
  // The rejection arm used to set status='failed' without `finalized`, so the server's later
  // notifications walked it back to completed. And the quarantine must NOT fire here: an error
  // RESPONSE means no server turn was ever created, so a routine bad parameter must stay recoverable.
  const d = unitDaemon();
  // Drive the REAL rejection arm: stub the RPC to reject and call _sendStart, rather than calling
  // _finalizeTurn by hand — otherwise reverting the fix in _sendStart leaves this test green.
  d.app.request = () => Promise.reject(new Error('simulated'));
  d._beginTurn({ isReview: true });
  d._sendStart('review/start', {}, 'review/start');
  await new Promise((r) => setImmediate(r));               // let the rejection handler run
  assert.equal(d.turn.status, 'failed');
  assert.equal(d.turn.finalized, true, 'the rejection arm must FINALIZE, not just set status');
  assert.equal(d.turn.finalized, true);
  d._onNotification('item/completed', { threadId: 'T-mine', turnId: 'x', item: { type: 'exitedReviewMode', review: 'LEAKED' } });
  d._onNotification('turn/completed', { threadId: 'T-mine', turn: { id: 'x', status: 'completed' } });
  assert.equal(d.turn.status, 'failed', 'a finalized turn must stay finalized');
  assert.ok(!/LEAKED/.test(d.turn.message || ''));
  assert.equal(d.restartRequired, false, 'a rejected start must not demand a restart');
});

test('a foreign reviewThreadId fails the turn WITHOUT quarantining (the id was known)', () => {
  // The response carried an authoritative turn id, so _isStaleTurn can keep the session honest.
  // Quarantining here would brick a session that has everything it needs.
  const d = unitDaemon();
  d._gen = 1;
  d.turn = d._freshTurn({ status: 'running', awaitingResponse: true, isReview: true, gen: 1 });
  d._onStartResponse(1, { turn: { id: 'turn-9' }, reviewThreadId: 'T-SOMEONE-ELSE' }, 'review/start');
  assert.equal(d.turn.status, 'failed');
  assert.equal(d.turn.id, 'turn-9', 'the id must be adopted before the validation that rejects it');
  assert.equal(d.restartRequired, false, 'a known id means no quarantine is needed');
});

test('failing a turn ANSWERS every server request the server is still blocked on', () => {
  const log = [];
  const d = unitDaemon({ log });
  d._gen = 1;
  d.turn = d._freshTurn({ status: 'running', awaitingResponse: true, gen: 1 });
  // One parked, one buffered behind the outstanding start response.
  d.turn.parked = { id: 5, kind: 'approval', method: 'item/commandExecution/requestApproval', params: {} };
  d.turn.buffered.push(['__serverRequest', { id: 6, method: 'item/tool/requestUserInput', params: {} }]);
  d._finalizeTurn('boom');
  assert.deepEqual(log, ['respond:5', 'respondError:6'], 'both must be answered exactly once');
  assert.equal(d.turn.parked, null);
  // Idempotent: settling again must not double-answer a JSON-RPC id.
  d._settleOutstandingRequests();
  assert.deepEqual(log, ['respond:5', 'respondError:6']);
});

test('interrupt answers the parked request BEFORE it awaits turn/interrupt', async () => {
  // Ordering, not eventual settlement: the server can withhold turn/completed while its own request
  // is unanswered, so interrupting with one parked could block on a turn blocked on us.
  const log = [];
  const d = unitDaemon({ log });
  d._gen = 1;
  d.turn = d._freshTurn({ status: 'awaiting_input', gen: 1, id: 'turn-1' });
  d.turn.parked = { id: 5, kind: 'approval', method: 'item/commandExecution/requestApproval', params: {} };
  const res = await d._interrupt();
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(log, ['respond:5', 'turn/interrupt'], 'the response must precede the interrupt RPC');
  assert.equal(d.turn.parked, null, 'the parked slot must be cleared, not just answered');
  assert.notEqual(d.turn.status, 'awaiting_input', 'status must leave awaiting_input or _wait derefs null parked');
  assert.equal(d.turn.cancelRequested, true, 'the cancel marker gates the late-response interrupt');
});

test('interrupt works on a turn whose start response never arrived, then quarantines the session', async () => {
  // It used to answer {error:'no_active_turn'} for exactly the case the documented recovery exists
  // for, leaving the turn running forever and every later command answering `busy`.
  const d = unitDaemon();
  d._gen = 1;
  d.turn = d._freshTurn({ status: 'running', awaitingResponse: true, gen: 1 });   // id still null
  assert.deepEqual(await d._interrupt(), { ok: true });
  assert.equal(d.turn.status, 'interrupted');
  assert.equal(d.turn.finalized, true);
  assert.equal(d.restartRequired, true, 'an unidentifiable orphan turn must quarantine the session');
  // The session refuses new turns honestly rather than risking the orphan's traffic being adopted.
  assert.equal((d._startTurn('hi', undefined)).error, 'restart_required');
  // ...and an idle session reports no active turn, as before.
  d.turn = d._freshTurn();
  assert.deepEqual(await d._interrupt(), { error: 'no_active_turn' });
});

test('a late start response cancels server-side ONLY when a cancel was requested', () => {
  for (const cancelRequested of [true, false]) {
    const log = [];
    const d = unitDaemon({ log });
    d._gen = 1;
    d.turn = d._freshTurn({ status: 'interrupted', gen: 1, finalized: true, cancelRequested });
    d._onStartResponse(1, { turn: { id: 'turn-LATE' } }, 'review/start');
    assert.equal(d._lastTurnId, 'turn-LATE', 'the late id is always recorded for stale filtering');
    assert.deepEqual(log, cancelRequested ? ['turn/interrupt'] : [],
      `cancelRequested=${cancelRequested} must ${cancelRequested ? '' : 'NOT '}interrupt`);
    assert.equal(d.turn.status, 'interrupted', 'a late response must not mutate a finalized turn');
  }
});

test('a failed/interrupted completion arriving pre-response finalizes AT ONCE (no wedge)', () => {
  for (const st of ['failed', 'interrupted']) {
    const d = unitDaemon();
    d._gen = 1;
    d.turn = d._freshTurn({ status: 'running', awaitingResponse: true, gen: 1 });
    d._onNotification('turn/completed', { threadId: 'T-mine', turn: { id: 'turn-1', status: st } });
    assert.equal(d.turn.status, st, `${st} must finalize immediately, not sit buffered forever`);
    assert.equal(d.turn.finalized, true);
    assert.equal(d.turn.backstop, null);
  }
});

test('a STALE completion for the PREVIOUS turn cannot finalize the new one', () => {
  // The pre-response window has no _isStaleTurn to lean on (it needs a truthy turn.id), and one
  // review legitimately spans several ids — so without the last-known-id filter a straggler from
  // turn 1 would kill a healthy turn 2 AND quarantine the session.
  const d = unitDaemon();
  d._gen = 1;
  d.turn = d._freshTurn({ status: 'running', awaitingResponse: true, gen: 1 });
  d._onStartResponse(1, { turn: { id: 'turn-1' } }, 'turn/start');
  d._beginTurn({});                                   // turn 2 opens; turn-1 becomes the last known id
  assert.equal(d._lastTurnId, 'turn-1');
  d._onNotification('turn/completed', { threadId: 'T-mine', turn: { id: 'turn-1', status: 'interrupted' } });
  assert.equal(d.turn.status, 'running', 'turn 2 must survive turn 1\'s straggler');
  assert.equal(d.restartRequired, false, 'and it must not quarantine the session');
});

test('a late server request cannot re-open a finalized turn', () => {
  for (const status of ['completed', 'failed']) {
    const log = [];
    const d = unitDaemon({ log });
    d._gen = 1;
    d.turn = d._freshTurn({ status, gen: 1, finalized: true, message: 'the real result', id: status === 'completed' ? 'turn-1' : null });
    d._onServerRequest({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'T-mine', turnId: 'turn-1' } });
    assert.equal(d.turn.parked, null, 'a terminal turn must never park');
    assert.equal(d.turn.status, status, 'and must not walk back to awaiting_input');
    assert.equal(d.turn.message, 'the real result', 'the finished result must survive');
    assert.equal(log.length, 1, 'the request must still be answered exactly once');
  }
});

test('a notification with no params is dropped instead of killing the daemon', () => {
  const d = unitDaemon();
  d._gen = 1;
  d.turn = d._freshTurn({ status: 'running', gen: 1, id: 'turn-1' });
  // Reached _dispatchNotification and threw a TypeError inside the child's stdout data handler,
  // taking the whole daemon down mid-turn.
  assert.doesNotThrow(() => d._onNotification('item/agentMessage/delta'));
  assert.doesNotThrow(() => d._onNotification('turn/completed', undefined));
  assert.doesNotThrow(() => d._onNotification('item/agentMessage/delta', null));
  assert.equal(d.turn.status, 'running', 'state must be untouched');
});

test('replayed buffer entries go through the SAME guards as live traffic, in arrival order', () => {
  const d = unitDaemon();
  d._gen = 1;
  d.turn = d._freshTurn({ status: 'running', awaitingResponse: true, gen: 1 });
  // Inject DIRECTLY into the buffer: routing these through _onNotification would drop the foreign
  // and malformed ones at the door, so the replay path would never see them and the test would pass
  // even if replay bypassed those guards entirely (which is exactly what it used to do).
  d.turn.buffered.push(['item/agentMessage/delta', { threadId: 'T-OTHER', turnId: 'x', delta: 'FOREIGN' }]);
  d.turn.buffered.push(['item/agentMessage/delta', undefined]);
  d.turn.buffered.push(['item/agentMessage/delta', { threadId: 'T-mine', turnId: 'turn-1', delta: 'one ' }]);
  d.turn.buffered.push(['item/agentMessage/delta', { threadId: 'T-mine', turnId: 'turn-1', delta: 'two' }]);
  d._onStartResponse(1, { turn: { id: 'turn-1' } }, 'turn/start');   // triggers the replay
  assert.equal(d.turn.buffer, 'one two', 'order preserved, foreign + malformed dropped');
});

test('the generation token drops a superseded response on BOTH arms', async () => {
  // Without it a late response from a turn that has been superseded overwrites the live turn's id
  // and state — cross-turn corruption the whole buffering scheme exists to prevent.
  const d = unitDaemon();
  d._gen = 1;
  d.turn = d._freshTurn({ status: 'running', awaitingResponse: true, gen: 1 });
  d._beginTurn({});                                   // now gen 2; gen-1's response is superseded
  d._onStartResponse(1, { turn: { id: 'turn-OLD' } }, 'turn/start');
  assert.equal(d.turn.id, null, 'a superseded response must not set the live turn\'s id');
  assert.equal(d.turn.status, 'running');
  // ARM 2 — the REJECTION path. Start a turn whose RPC rejects, supersede it before the rejection
  // lands, and assert the late rejection cannot finalize the new turn. Mutating turn.gen by hand
  // (as this used to) never invoked the handler at all.
  const d2 = unitDaemon();
  let rejectStart;
  d2.app.request = () => new Promise((_, rej) => { rejectStart = rej; });
  d2._beginTurn({});
  d2._sendStart('turn/start', {}, 'turn/start');
  d2._beginTurn({});                                  // supersede BEFORE the rejection resolves
  rejectStart(new Error('late rejection'));
  await new Promise((r) => setImmediate(r));
  assert.equal(d2.turn.status, 'running', 'a superseded rejection must not finalize the live turn');
  assert.equal(d2.turn.finalized, false);
});

test('END-TO-END: a turn that fails before its response no longer wedges the daemon', { timeout: 15000 }, async () => {
  // The wedge: only a SUCCESSFUL completion armed the backstop, so a failed one whose response never
  // arrived was buffered forever — `wait` hung, every later command answered `busy`, and `interrupt`
  // said there was no active turn. This must resolve promptly and WITHOUT the 5s backstop.
  const { dir } = repo();
  const { socketPath } = await startDaemon({ cwd: dir, mode: 'failbeforeresponse' });
  await rpcCall(socketPath, { cmd: 'review' });
  const t0 = Date.now();
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'failed');
  assert.ok(Date.now() - t0 < 4000, 'must finalize at once, not wait out the backstop');
  const st = await rpcCall(socketPath, { cmd: 'status' });
  assert.equal(st.turnStatus, 'failed');
  // The session is quarantined (that turn's id never reached us), and it says so honestly rather
  // than silently risking the orphan's traffic being adopted by a later turn.
  assert.equal(st.restartRequired, true);
  assert.match((await rpcCall(socketPath, { cmd: 'review' })).error, /restart_required/);
});

test('END-TO-END: git scope, app-server spawn cwd and thread/start cwd are ONE cwd', { timeout: 15000 }, async () => {
  // The spec's P1 rule. Only the git-scope leg was covered before: the mock discarded thread/start's
  // params and nothing observed the child's cwd, so dropping either would have shipped undetected —
  // live Codex resolving the review against the caller's directory while git-scope read another.
  const { dir } = repo();
  const recDir = mkdtempSync(join(tmpdir(), 'cdx-rec-'));
  CREATED.push({ sockDir: recDir });                  // swept by the suite hook; it leaked per run
  const record = join(recDir, 'thread-start.json');
  const { socketPath } = await startDaemon({ cwd: dir, appServerArgs: ['--record', record] });
  const started = await rpcCall(socketPath, { cmd: 'review' });
  assert.equal(started.ok, true, 'the git-scope leg resolved against the review repo');
  const rec = JSON.parse(readFileSync(record, 'utf8'));
  // realpath: macOS resolves /var -> /private/var, so the raw strings differ while the dirs match.
  assert.equal(realpathSync(rec.params.cwd), realpathSync(dir), 'thread/start cwd must be the review cwd');
  assert.equal(realpathSync(rec.cwd), realpathSync(dir), 'the app-server child must be spawned there too');
});

test('a NORMAL completion also answers a still-parked server request', () => {
  // The happy path owes the same debt as the failure paths: if a request parks just before the turn
  // completes, nothing else will ever answer it once the turn is finalized, and the app-server can
  // sit blocked on it forever. The completion branch used to finalize inline without settling.
  const log = [];
  const d = unitDaemon({ log });
  d._gen = 1;
  d.turn = d._freshTurn({ status: 'awaiting_input', gen: 1, id: 'turn-1' });
  d.turn.parked = { id: 9, kind: 'approval', method: 'item/commandExecution/requestApproval', params: {} };
  d._onNotification('item/completed', { threadId: 'T-mine', turnId: 'turn-1', item: { type: 'exitedReviewMode', review: 'the review' } });
  d.turn.isReview = true;
  d._onNotification('turn/completed', { threadId: 'T-mine', turn: { id: 'turn-1', status: 'completed' } });
  assert.equal(d.turn.status, 'completed');
  assert.equal(d.turn.parked, null, 'the parked slot must be cleared by the completion');
  assert.deepEqual(log, ['respond:9'], 'the parked request must be answered exactly once');
});

test('a SECOND concurrent server request is declined, never silently overwritten', () => {
  // `parked` is a single slot and answer/approve address it implicitly, so a second request used to
  // overwrite the first: its id became unreachable and got no response at all, while the client's
  // next answer was applied to the wrong request.
  const log = [];
  const d = unitDaemon({ log });
  d._gen = 1;
  d.turn = d._freshTurn({ status: 'running', gen: 1, id: 'turn-1' });
  const mk = (id) => ({ id, method: 'item/tool/requestUserInput', params: { threadId: 'T-mine', turnId: 'turn-1' } });
  d._onServerRequest(mk(1));
  assert.equal(d.turn.parked.id, 1, 'the first request parks');
  d._onServerRequest(mk(2));
  assert.equal(d.turn.parked.id, 1, 'the first must STILL be the parked one');
  assert.equal(log.length, 1, 'the second must be answered immediately');
});
