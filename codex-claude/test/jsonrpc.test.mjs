import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpc } from '../lib/jsonrpc.mjs';

function makeRpc() {
  const sent = [];
  const rpc = new JsonRpc((line) => sent.push(line));
  return { rpc, sent };
}

test('request serializes a JSON-RPC envelope and resolves on matching response', async () => {
  const { rpc, sent } = makeRpc();
  const p = rpc.request('turn/start', { threadId: 't1' });
  const msg = JSON.parse(sent[0]);
  assert.equal(msg.jsonrpc, '2.0');
  assert.equal(msg.method, 'turn/start');
  assert.deepEqual(msg.params, { threadId: 't1' });
  assert.equal(typeof msg.id, 'number');
  rpc.feed(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) + '\n');
  assert.deepEqual(await p, { ok: true });
});

test('request rejects on error response', async () => {
  const { rpc, sent } = makeRpc();
  const p = rpc.request('x', {});
  const id = JSON.parse(sent[0]).id;
  rpc.feed(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'nope' } }) + '\n');
  await assert.rejects(p, /nope/);
});

test('feed handles split and coalesced lines', () => {
  const { rpc } = makeRpc();
  const got = [];
  rpc.onNotification = (m, p) => got.push([m, p]);
  rpc.feed('{"jsonrpc":"2.0","method":"a","par');
  rpc.feed('ams":1}\n{"jsonrpc":"2.0","method":"b","params":2}\n');
  assert.deepEqual(got, [['a', 1], ['b', 2]]);
});

test('server-initiated request is dispatched to onServerRequest', () => {
  const { rpc } = makeRpc();
  const got = [];
  rpc.onServerRequest = (id, method, params) => got.push([id, method, params]);
  rpc.feed(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'item/tool/requestUserInput', params: { q: 1 } }) + '\n');
  assert.deepEqual(got, [[9, 'item/tool/requestUserInput', { q: 1 }]]);
});

test('respond and respondError serialize correctly', () => {
  const { rpc, sent } = makeRpc();
  rpc.respond(9, { answers: {} });
  rpc.respondError(10, -32601, 'no');
  assert.deepEqual(JSON.parse(sent[0]), { jsonrpc: '2.0', id: 9, result: { answers: {} } });
  assert.deepEqual(JSON.parse(sent[1]), { jsonrpc: '2.0', id: 10, error: { code: -32601, message: 'no' } });
});
