import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Daemon, REVIEW_PROFILE } from '../lib/daemon.mjs';
import { sendCommand } from '../lib/client.mjs';
import { CLIENT_INFO } from '../lib/protocol.mjs';
import { rmDir } from './fixtures/helpers.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/mock-appserver.mjs', import.meta.url));
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function session(t, { sessionModel, configModel, ...options } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-model-'));
  const requestsPath = join(dir, 'requests.jsonl');
  if (configModel) writeFileSync(join(dir, 'config.toml'), `model = "${configModel}"\n`);
  const args = [FIXTURE, '--requests-file', requestsPath];
  if (sessionModel !== undefined) args.push('--session-model', sessionModel);
  const daemon = new Daemon({
    socketPath: join(dir, 't.sock'), clientInfo: CLIENT_INFO,
    appServerOpts: { command: process.execPath, args }, codexHome: dir, ...options,
  });
  t.after(async () => { await daemon.stop(); rmDir(dir); });
  const started = await daemon.start();
  const call = (cmd) => sendCommand(daemon.socketPath, cmd, { timeoutMs: 5000 });
  const requests = (method) => readFileSync(requestsPath, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line)).filter((req) => req.method === method).map((req) => req.params);
  const turn = async (cmd) => {
    assert.deepEqual(await call(cmd), { ok: true, status: 'running' });
    assert.equal((await call({ cmd: 'wait' })).status, 'completed');
    return requests('turn/start').at(-1);
  };
  return { daemon, started, call, requests, turn };
}

function modelStatus(value) {
  return {
    requestedModel: value.requestedModel,
    sessionModel: value.sessionModel,
    sessionModelSource: value.sessionModelSource,
  };
}

function settings(daemon, model, extra = {}) {
  daemon._onNotification('thread/settings/updated', {
    threadId: daemon.threadId, threadSettings: { model }, ...extra,
  });
}

test('fresh sessions forward an explicit model with and without the review profile', async (t) => {
  for (const profile of [null, REVIEW_PROFILE]) {
    const s = await session(t, { model: 'requested-model', profile, sessionModel: 'server-model' });
    assert.deepEqual(s.requests('thread/start'), [{ ...(profile || {}), cwd: s.daemon.cwd, model: 'requested-model' }]);
    assert.deepEqual(modelStatus(await s.call({ cmd: 'status' })), {
      requestedModel: 'requested-model', sessionModel: 'server-model', sessionModelSource: 'thread/start',
    });
    const params = await s.turn({ cmd: 'send', prompt: 'say OK', effort: 'ultra' });
    assert.equal(params.model, 'requested-model');
    assert.equal(params.effort, 'ultra');
    assert.equal(params.collaborationMode, undefined);
    // An accepted override changes the thread, but success alone cannot confirm its effective model.
    assert.deepEqual(modelStatus(await s.call({ cmd: 'status' })), {
      requestedModel: 'requested-model', sessionModel: null, sessionModelSource: null,
    });
  }
});

test('no explicit model leaves fresh-thread and plain-turn defaults to the server', async (t) => {
  const s = await session(t, { sessionModel: 'server-default', configModel: 'local-config' });
  assert.deepEqual(s.requests('thread/start'), [{ cwd: s.daemon.cwd }]);
  const params = await s.turn({ cmd: 'send', prompt: 'say OK', effort: 'high' });
  assert.equal(params.model, undefined);
  assert.equal(params.collaborationMode, undefined);
  assert.deepEqual(modelStatus(await s.call({ cmd: 'status' })), {
    requestedModel: null, sessionModel: 'server-default', sessionModelSource: 'thread/start',
  });
});

test('missing server metadata stays unknown even when an explicit requested model exists', async (t) => {
  const s = await session(t, { model: 'requested-model' });
  assert.deepEqual(modelStatus(await s.call({ cmd: 'status' })), {
    requestedModel: 'requested-model', sessionModel: null, sessionModelSource: null,
  });
  const params = await s.turn({ cmd: 'send', prompt: 'say OK' });
  assert.equal(params.model, 'requested-model');
  assert.equal((await s.call({ cmd: 'status' })).sessionModel, null);
});

test('plan and explicit default prefer requested model, then server model, then old config fallback', async (t) => {
  const cases = [
    { model: 'requested', sessionModel: 'server', configModel: 'configured', expected: 'requested' },
    { sessionModel: 'server', configModel: 'configured', expected: 'server' },
    { configModel: 'configured', expected: 'configured' },
  ];
  for (const { expected, ...options } of cases) {
    const s = await session(t, options);
    for (const mode of ['plan', 'default']) {
      const params = await s.turn({ cmd: 'send', mode, prompt: 'say OK', effort: 'high' });
      assert.deepEqual(params.collaborationMode, { mode, settings: { model: expected, reasoning_effort: 'high' } });
      assert.equal(params.model, undefined);
      assert.equal(params.effort, undefined);
    }
  }
});

test('explicit model survives plan, plain send, default, and another plain send', async (t) => {
  const s = await session(t, { model: 'requested-model', sessionModel: 'requested-model' });
  for (const mode of ['plan', undefined, 'default', undefined]) {
    const params = await s.turn({ cmd: 'send', mode, prompt: 'say OK' });
    assert.equal(params.threadId, s.started.threadId);
    if (mode) {
      assert.deepEqual(params.collaborationMode, { mode, settings: { model: 'requested-model' } });
      assert.equal(params.model, undefined);
    } else {
      assert.equal(params.model, 'requested-model');
      assert.equal(params.collaborationMode, undefined);
    }
  }
  assert.equal(s.requests('thread/start').length, 1);
  assert.equal(s.requests('thread/resume').length, 0);
});

test('start and resume preserve coalesced settings updates and filter foreign startup traffic', async (t) => {
  for (const resume of [null, 'saved-thread']) {
    for (const ownModel of [null, 'newer-model']) {
      const dir = mkdtempSync(join(tmpdir(), 'cdx-model-burst-'));
      const requests = [];
      const threadId = resume || 'new-thread';
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.kill = () => { child.killed = true; child.stdout.destroy(); };
      const updated = (id, model) => ({
        method: 'thread/settings/updated', params: { threadId: id, threadSettings: { model } },
      });
      child.stdin = { write(line) {
        const req = JSON.parse(line);
        requests.push(req);
        if (req.id === undefined) return;
        let messages = [{ id: req.id, result: {} }];
        if (req.method === 'thread/start' || req.method === 'thread/resume') {
          messages = [
            { id: req.id, result: { thread: { id: threadId }, model: 'initial-model' } },
            updated('foreign-thread', 'foreign-before'),
            ...(ownModel ? [updated(threadId, ownModel)] : []),
            updated(undefined, 'unattributed-model'),
            updated('foreign-thread', 'foreign-after'),
          ];
        } else if (req.method === 'turn/start') {
          messages = [
            { id: req.id, result: { turn: { id: 'turn-1' } } },
            { method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed' } } },
          ];
        }
        // The whole chunk is drained before start()'s response await resumes and sets threadId.
        queueMicrotask(() => child.stdout.write(messages.map((m) => JSON.stringify(m)).join('\n') + '\n'));
      } };
      const daemon = new Daemon({
        socketPath: join(dir, 't.sock'), clientInfo: CLIENT_INFO, resume,
        appServerOpts: { spawnFn: () => child }, codexHome: dir,
      });
      t.after(async () => { await daemon.stop(); rmDir(dir); });
      const call = (cmd) => sendCommand(daemon.socketPath, cmd, { timeoutMs: 5000 });
      const expected = {
        requestedModel: null, sessionModel: ownModel || 'initial-model',
        sessionModelSource: ownModel ? 'thread/settings/updated' : resume ? 'thread/resume' : 'thread/start',
      };
      assert.deepEqual(modelStatus(await daemon.start()), expected);
      assert.deepEqual(modelStatus(await call({ cmd: 'status' })), expected);
      assert.deepEqual(await call({ cmd: 'plan', prompt: 'say OK' }), { ok: true, status: 'running' });
      assert.equal((await call({ cmd: 'wait' })).status, 'completed');
      assert.equal(requests.find((r) => r.method === 'turn/start').params.collaborationMode.settings.model,
        expected.sessionModel);
    }
  }
});

test('older responses with no metadata preserve plain send and explicit-mode missing-model error', async (t) => {
  const s = await session(t);
  assert.deepEqual(modelStatus(await s.call({ cmd: 'status' })), {
    requestedModel: null, sessionModel: null, sessionModelSource: null,
  });
  assert.equal((await s.turn({ cmd: 'send', prompt: 'say OK' })).model, undefined);
  assert.deepEqual(await s.call({ cmd: 'plan', prompt: 'say OK' }), { error: 'no_model_for_mode' });
});

test('resume sends only threadId; explicit model applies to subsequent turns', async (t) => {
  for (const model of [undefined, 'requested-model']) {
    const s = await session(t, { resume: 'saved-thread', model, sessionModel: 'resumed-model', configModel: 'configured' });
    assert.deepEqual(s.requests('thread/resume'), [{ threadId: 'saved-thread' }]);
    assert.deepEqual(s.requests('thread/start'), []);
    assert.deepEqual(modelStatus(await s.call({ cmd: 'status' })), {
      requestedModel: model || null, sessionModel: 'resumed-model', sessionModelSource: 'thread/resume',
    });
    const params = await s.turn({ cmd: 'send', prompt: 'say OK' });
    assert.equal(params.model, model);
    assert.equal(params.collaborationMode, undefined);
    const plan = await s.turn({ cmd: 'plan', prompt: 'say OK' });
    assert.equal(plan.collaborationMode.settings.model, model || 'resumed-model');
    assert.equal((await s.call({ cmd: 'review' })).error, 'wrong_thread_profile');
  }
});

test('a review gate carries its model on a plain send and remains a turn gate', async (t) => {
  const prompt = 'REVIEWPLAN judge this';
  const hash = createHash('sha256').update(prompt).digest('hex');
  const s = await session(t, {
    model: 'review-model', privateSession: true,
    gatePromptPolicy: { allowed: [hash], gate: 'review' },
  });
  const params = await s.turn({ cmd: 'send', prompt, effort: 'ultra' });
  assert.equal(params.model, 'review-model');
  assert.equal(params.collaborationMode, undefined);
  assert.equal((await s.call({ cmd: 'gate_snapshot' })).kind, 'turn');
  assert.deepEqual(await s.call({ cmd: 'plan', prompt }), { error: 'wrong_gate_turn_kind', expected: 'send' });
});

test('own-thread settings update metadata while idle and completed; foreign or malformed updates do not', async (t) => {
  const s = await session(t, { sessionModel: 'initial' });
  settings(s.daemon, 'idle-model');
  assert.deepEqual(modelStatus(await s.call({ cmd: 'status' })), {
    requestedModel: null, sessionModel: 'idle-model', sessionModelSource: 'thread/settings/updated',
  });
  await s.turn({ cmd: 'send', prompt: 'say OK' });
  // Settings are session-scoped; a turn id that is no longer active must not suppress them.
  settings(s.daemon, 'completed-model', { turnId: 'old-turn' });
  for (const params of [
    { threadId: 'foreign', threadSettings: { model: 'foreign-model' } },
    { threadSettings: { model: 'missing-thread' } },
    { threadId: s.daemon.threadId, threadSettings: { model: '' } },
    { threadId: s.daemon.threadId, threadSettings: { model: '   ' } },
    { threadId: s.daemon.threadId, threadSettings: { model: null } },
    { threadId: s.daemon.threadId, model: 'wrong-shape' },
  ]) s.daemon._onNotification('thread/settings/updated', params);
  assert.deepEqual(modelStatus(await s.call({ cmd: 'status' })), {
    requestedModel: null, sessionModel: 'completed-model', sessionModelSource: 'thread/settings/updated',
  });
  assert.equal((await s.call({ cmd: 'status' })).turnStatus, 'completed');
});

function pendingTurn(t, { requested = 'requested-model', confirmed = 'previous-model' } = {}) {
  const daemon = new Daemon({ socketPath: '/tmp/cdx-model-unit.sock', clientInfo: CLIENT_INFO, model: requested });
  daemon.threadId = 'unit-thread';
  settings(daemon, confirmed);
  let resolve, reject;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  daemon.app = { request: () => pending };
  t.after(() => daemon._clearBackstop?.());
  assert.deepEqual(daemon._startTurn('say OK'), { ok: true, status: 'running' });
  const status = () => daemon._handleCommand({ cmd: 'status' });
  return { daemon, resolve, reject, status };
}

test('pending and rejected model overrides preserve the last confirmed session metadata', async (t) => {
  const s = pendingTurn(t);
  assert.equal((await s.status()).sessionModel, 'previous-model');
  s.reject(new Error('server rejected model'));
  await tick();
  assert.equal((await s.status()).turnStatus, 'failed');
  assert.equal((await s.status()).sessionModel, 'previous-model');
  assert.equal((await s.status()).sessionModelSource, 'thread/settings/updated');
});

test('accepted changed overrides invalidate stale metadata, but the same confirmed model stays known', async (t) => {
  for (const confirmed of ['previous-model', 'requested-model']) {
    const s = pendingTurn(t, { confirmed });
    s.resolve({ turn: { id: 'accepted-turn' } });
    await tick();
    const st = await s.status();
    assert.equal(st.sessionModel, confirmed === 'requested-model' ? 'requested-model' : null);
    assert.equal(st.sessionModelSource, confirmed === 'requested-model' ? 'thread/settings/updated' : null);
  }
});

test('new own-thread settings arriving before turn/start response survive its acceptance', async (t) => {
  const s = pendingTurn(t);
  settings(s.daemon, 'server-canonical-model');
  s.resolve({ turn: { id: 'accepted-turn' } });
  await tick();
  assert.deepEqual(modelStatus(await s.status()), {
    requestedModel: 'requested-model', sessionModel: 'server-canonical-model', sessionModelSource: 'thread/settings/updated',
  });
});

test('a foreign settings event does not prevent invalidation of an accepted changed override', async (t) => {
  const s = pendingTurn(t);
  settings(s.daemon, 'foreign-model', { threadId: 'foreign-thread' });
  s.resolve({ turn: { id: 'accepted-turn' } });
  await tick();
  assert.equal((await s.status()).sessionModel, null);
});
