import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Daemon } from '../lib/daemon.mjs';

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
  await daemon.start();
  return { daemon, socketPath, dir };
}

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

test('status reports idle after completion and rejects a second concurrent turn', async () => {
  const { daemon, socketPath } = await startDaemon();
  await rpcCall(socketPath, { cmd: 'send', prompt: 'say OK' });
  const busy = await rpcCall(socketPath, { cmd: 'send', prompt: 'again' });
  assert.equal(busy.error, 'busy');
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

test('a parked elicitation is surfaced as unsupported and cannot be answered', async () => {
  const d = new Daemon({ socketPath: '/tmp/cdx-unit-none.sock', clientInfo: {} });
  d.turn = { id: 'T1', status: 'awaiting_input', buffer: '', message: null,
    parked: { id: 5, kind: 'elicitation', method: 'mcpServer/elicitation/request', params: {} } };
  assert.equal(d._parkedResult().status, 'unsupported');
  const r = await d._answer('q', ['x']);
  assert.equal(r.error, 'no_pending_question');
});
