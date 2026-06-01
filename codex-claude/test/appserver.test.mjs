import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { JsonRpc } from '../lib/jsonrpc.mjs';
import { AppServer } from '../lib/appserver.mjs';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('./fixtures/mock-appserver.mjs', import.meta.url));

test('mock app-server answers initialize and emits a turn', async () => {
  const child = spawn(process.execPath, [FIXTURE], { stdio: ['pipe', 'pipe', 'inherit'] });
  const rpc = new JsonRpc((line) => child.stdin.write(line));
  child.stdout.setEncoding('utf8');
  const notes = [];
  rpc.onNotification = (m, p) => notes.push([m, p]);
  child.stdout.on('data', (d) => rpc.feed(d));

  const init = await rpc.request('initialize', { clientInfo: { name: 't', version: '0' } });
  assert.ok(init.userAgent);
  rpc.notify('initialized', {});
  const thread = await rpc.request('thread/start', {});
  assert.ok(thread.thread.id);
  await rpc.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'say OK' }] });
  await new Promise((r) => setTimeout(r, 100));
  const methods = notes.map((n) => n[0]);
  assert.ok(methods.includes('turn/started'));
  assert.ok(methods.includes('item/agentMessage/delta'));
  assert.ok(methods.includes('turn/completed'));
  child.kill();
});

test('AppServer.start + initialize handshake, then drives a turn via the fixture', async () => {
  const app = new AppServer({ command: process.execPath, args: [FIXTURE] });
  await app.start();
  const notes = [];
  app.on('notification', (m, p) => notes.push([m, p]));
  const init = await app.initialize({ name: 'codex-drive', version: '0.1.0' });
  assert.ok(init.userAgent);
  const thread = await app.request('thread/start', {});
  await app.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'say OK' }] });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(notes.some(([m, p]) => m === 'item/agentMessage/delta' && p.delta === 'OK'));
  await app.stop();
});

test('AppServer emits serverRequest and can respond', async () => {
  const app = new AppServer({ command: process.execPath, args: [FIXTURE] });
  await app.start();
  await app.initialize({ name: 't', version: '0' });
  const thread = await app.request('thread/start', {});
  const got = [];
  app.on('serverRequest', (req) => {
    got.push(req);
    app.respond(req.id, { answers: { q1: { answers: ['B'] } } });
  });
  app.on('notification', () => {});
  await app.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'ASK' }] });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(got.length, 1);
  assert.equal(got[0].method, 'item/tool/requestUserInput');
  await app.stop();
});
