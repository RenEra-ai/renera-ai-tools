# codex-drive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Node CLI + session daemon that drives a headless `codex app-server` over JSON-RPC 2.0, exposing the primitives (plan/send/wait/answer/approve/read/interrupt) for a Claude-orchestrated Codex architect→review dev-loop.

**Architecture:** A background daemon owns one `codex app-server` child process and one thread; it keeps the JSON-RPC connection open so mid-turn question/approval requests can be answered on the live connection. Thin CLI verbs talk to the daemon over a unix domain socket. Zero runtime dependencies (Node stdlib only); tests use `node --test` and a scripted mock app-server fixture so the whole thing is testable offline.

**Tech Stack:** Node.js (ESM `.mjs`), `node:child_process`, `node:net`, `node:test`, `node:assert`. No third-party packages.

---

## File structure

```
codex-drive/
  package.json                       # name, type:module, bin, test scripts
  bin/codex-drive.mjs                # CLI entry: argv parse, dispatch; `start` spawns daemon, other verbs use client
  lib/
    jsonrpc.mjs                      # newline-delimited JSON-RPC 2.0 framing + request/response matching + dispatch
    protocol.mjs                     # method-name constants, ModeKind/effort, turn-param builder, server-request classifier + response builders
    appserver.mjs                    # spawn `codex app-server`, handshake, generic request/respond, notification+serverRequest events
    state.mjs                        # ~/.codex-drive paths + state.json read/write
    daemon.mjs                       # session daemon: appserver + thread, unix socket server, turn state machine, parked requests, wait
    client.mjs                       # connect to daemon socket, send a command line, await one JSON response line
    verbs.mjs                        # pure arg→command mapping + output formatting for each verb
  test/
    fixtures/mock-appserver.mjs      # scripted JSON-RPC app-server stand-in (stdin/stdout) for offline tests
    jsonrpc.test.mjs
    protocol.test.mjs
    appserver.test.mjs
    state.test.mjs
    daemon.test.mjs
    verbs.test.mjs
    integration.live.test.mjs        # gated by CODEX_DRIVE_LIVE=1; real `codex app-server`
  README.md
  docs/specs/2026-05-31-codex-drive-design.md   # (exists)
  docs/plans/2026-05-31-codex-drive.md          # (this file)
```

**Shared naming contract (used across all tasks — keep identical):**
- `JsonRpc` (class) with: `request(method, params) → Promise`, `notify(method, params)`, `respond(id, result)`, `respondError(id, code, message)`, `feed(chunkString)`, and assignable handlers `onNotification(method, params)` and `onServerRequest(id, method, params)`.
- `AppServer` (class, extends `EventEmitter`) with: `start()`, `initialize(clientInfo)`, `request(method, params)`, `respond(id, result)`, `stop()`; emits `'notification' (method, params)` and `'serverRequest' ({id, method, params})`.
- `protocol.METHODS`, `protocol.MODE`, `protocol.EFFORTS`, `protocol.buildTurnStart(opts)`, `protocol.classifyServerRequest(method, params)`, `protocol.buildQuestionAnswer(question, answers)`, `protocol.buildApprovalResponse(decision)`.
- Daemon command names (socket protocol): `plan`, `send`, `wait`, `answer`, `approve`, `read`, `interrupt`, `status`, `stop`.
- Turn status values: `idle | running | awaiting_input | completed | interrupted | failed`.

---

## Task 1: Project scaffold + protocol pins

**Files:**
- Create: `package.json`
- Create: `lib/protocol.mjs` (constants only in this task; builders added in Task 3)
- Create: `test/protocol.test.mjs`
- Create: `.gitignore`

- [ ] **Step 1: Create `.gitignore`**

```
node_modules/
*.log
.DS_Store
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "codex-drive",
  "version": "0.1.0",
  "description": "Drive a headless codex app-server over JSON-RPC for a Claude-orchestrated Codex dev-loop",
  "type": "module",
  "bin": { "codex-drive": "bin/codex-drive.mjs" },
  "scripts": {
    "test": "node --test test/*.test.mjs",
    "test:live": "CODEX_DRIVE_LIVE=1 node --test test/integration.live.test.mjs"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 3: Pin protocol method names/enums from the installed Codex (record evidence)**

Run (informational — confirms the constants below match the installed version):
```bash
codex app-server generate-json-schema --out /tmp/cdx_schema --experimental
jq -r '.oneOf[].properties.method.enum[0]' /tmp/cdx_schema/ClientRequest.json | sort | grep -E '^(initialize|thread/|turn/|collaborationMode/)'
jq '.definitions.ModeKind.enum, .definitions.ReasoningEffort.enum' /tmp/cdx_schema/ClientRequest.json
jq -r '.oneOf[].properties.method.enum[0]' /tmp/cdx_schema/ServerRequest.json | sort
```
Expected: `ModeKind` = `["plan","default"]`; `ReasoningEffort` = `["none","minimal","low","medium","high","xhigh"]`; ServerRequest methods include `item/tool/requestUserInput`, `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `execCommandApproval`, `applyPatchApproval`, `mcpServer/elicitation/request`. If any differ, update the constants in Step 5 to match the output.

- [ ] **Step 4: Write the failing test** (`test/protocol.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METHODS, MODE, EFFORTS, SERVER_REQUEST } from '../lib/protocol.mjs';

test('core client method names are pinned', () => {
  assert.equal(METHODS.INITIALIZE, 'initialize');
  assert.equal(METHODS.THREAD_START, 'thread/start');
  assert.equal(METHODS.THREAD_RESUME, 'thread/resume');
  assert.equal(METHODS.TURN_START, 'turn/start');
  assert.equal(METHODS.TURN_INTERRUPT, 'turn/interrupt');
});

test('mode and effort enums match the protocol', () => {
  assert.deepEqual(MODE, { PLAN: 'plan', DEFAULT: 'default' });
  assert.deepEqual(EFFORTS, ['none', 'minimal', 'low', 'high', 'medium', 'xhigh'].sort());
});

test('server-request method names are classified', () => {
  assert.ok(SERVER_REQUEST.QUESTION.includes('item/tool/requestUserInput'));
  assert.ok(SERVER_REQUEST.APPROVAL.includes('item/commandExecution/requestApproval'));
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/protocol.mjs'`.

- [ ] **Step 6: Create `lib/protocol.mjs` (constants)**

```js
// Method/enum constants pinned to the installed Codex app-server protocol.
// Verified via `codex app-server generate-json-schema` (see plan Task 1, Step 3).

export const METHODS = {
  INITIALIZE: 'initialize',
  INITIALIZED: 'initialized',
  THREAD_START: 'thread/start',
  THREAD_RESUME: 'thread/resume',
  THREAD_READ: 'thread/read',
  THREAD_UNSUBSCRIBE: 'thread/unsubscribe',
  TURN_START: 'turn/start',
  TURN_INTERRUPT: 'turn/interrupt',
  COLLAB_MODE_LIST: 'collaborationMode/list',
};

export const NOTIFY = {
  THREAD_STARTED: 'thread/started',
  TURN_STARTED: 'turn/started',
  TURN_COMPLETED: 'turn/completed',
  AGENT_MESSAGE_DELTA: 'item/agentMessage/delta',
  ITEM_COMPLETED: 'item/completed',
  ERROR: 'error',
};

export const MODE = { PLAN: 'plan', DEFAULT: 'default' };

export const EFFORTS = ['high', 'low', 'medium', 'minimal', 'none', 'xhigh']; // sorted; valid ReasoningEffort values

export const SERVER_REQUEST = {
  QUESTION: ['item/tool/requestUserInput'],
  APPROVAL: [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'execCommandApproval',
    'applyPatchApproval',
  ],
  ELICITATION: ['mcpServer/elicitation/request'],
};
```

> Note: `EFFORTS` is stored sorted so the test's `.sort()` comparison is order-independent.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
cd /Users/gleb/Documents/Projects/codex-drive
git add package.json .gitignore lib/protocol.mjs test/protocol.test.mjs
git commit -m "scaffold + protocol constants"
```

---

## Task 2: JSON-RPC framing (`lib/jsonrpc.mjs`)

**Files:**
- Create: `lib/jsonrpc.mjs`
- Test: `test/jsonrpc.test.mjs`

- [ ] **Step 1: Write the failing test** (`test/jsonrpc.test.mjs`)

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/jsonrpc.test.mjs`
Expected: FAIL — `Cannot find module '../lib/jsonrpc.mjs'`.

- [ ] **Step 3: Create `lib/jsonrpc.mjs`**

```js
// Minimal newline-delimited JSON-RPC 2.0 endpoint.
// `send(line)` writes one framed line (already includes trailing newline).
// Feed inbound bytes via `feed(chunkString)`.

export class JsonRpc {
  constructor(send) {
    this.send = send;
    this._id = 0;
    this._pending = new Map();
    this._buf = '';
    this.onNotification = null;   // (method, params) => void
    this.onServerRequest = null;  // (id, method, params) => void
  }

  request(method, params) {
    const id = ++this._id;
    const promise = new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
    });
    this.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return promise;
  }

  notify(method, params) {
    this.send(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  respond(id, result) {
    this.send(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  respondError(id, code, message) {
    this.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
  }

  feed(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      if (line.trim()) this._handle(line);
    }
  }

  _handle(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore non-JSON lines (e.g. stray logging)
    }
    const isResponse = msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined);
    if (isResponse) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      this._pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || `JSON-RPC error ${msg.error.code}`));
      else pending.resolve(msg.result);
    } else if (msg.id !== undefined && msg.method) {
      if (this.onServerRequest) this.onServerRequest(msg.id, msg.method, msg.params);
    } else if (msg.method) {
      if (this.onNotification) this.onNotification(msg.method, msg.params);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/jsonrpc.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/jsonrpc.mjs test/jsonrpc.test.mjs
git commit -m "json-rpc framing"
```

---

## Task 3: Protocol builders (`lib/protocol.mjs`)

**Files:**
- Modify: `lib/protocol.mjs` (add builder functions)
- Test: `test/protocol.test.mjs` (add cases)

- [ ] **Step 1: Add failing tests** (append to `test/protocol.test.mjs`)

```js
import { buildTurnStart, classifyServerRequest, buildQuestionAnswer, buildApprovalResponse } from '../lib/protocol.mjs';

test('buildTurnStart default mode sends only threadId+input', () => {
  const p = buildTurnStart({ threadId: 't1', text: 'hi' });
  assert.deepEqual(p, { threadId: 't1', input: [{ type: 'text', text: 'hi' }] });
});

test('buildTurnStart plan mode adds collaborationMode and effort', () => {
  const p = buildTurnStart({ threadId: 't1', text: 'go', mode: 'plan', effort: 'xhigh', model: 'gpt-5.5' });
  assert.deepEqual(p.collaborationMode, {
    mode: 'plan',
    settings: { model: 'gpt-5.5', reasoning_effort: 'xhigh', developer_instructions: null },
  });
  assert.equal(p.effort, 'xhigh');
});

test('buildTurnStart rejects an invalid effort', () => {
  assert.throws(() => buildTurnStart({ threadId: 't', text: 'x', effort: 'turbo' }), /effort/);
});

test('classifyServerRequest tags question vs approval vs elicitation vs unknown', () => {
  assert.equal(classifyServerRequest('item/tool/requestUserInput', {}).kind, 'question');
  assert.equal(classifyServerRequest('execCommandApproval', {}).kind, 'approval');
  assert.equal(classifyServerRequest('mcpServer/elicitation/request', {}).kind, 'elicitation');
  assert.equal(classifyServerRequest('something/else', {}).kind, 'unknown');
});

test('buildQuestionAnswer maps a free-text or option answer to the response shape', () => {
  const r = buildQuestionAnswer('q1', ['Option B']);
  assert.deepEqual(r, { answers: { q1: { answers: ['Option B'] } } });
});

test('buildApprovalResponse maps allow/deny to the protocol decision', () => {
  assert.deepEqual(buildApprovalResponse('allow'), { decision: 'approved' });
  assert.deepEqual(buildApprovalResponse('deny'), { decision: 'denied' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/protocol.test.mjs`
Expected: FAIL — `buildTurnStart` (and the other builders) are not exported.

- [ ] **Step 3: Append builders to `lib/protocol.mjs`**

```js
export function buildTurnStart({ threadId, text, mode, effort, model }) {
  if (effort && !EFFORTS.includes(effort)) {
    throw new Error(`invalid effort '${effort}'; expected one of ${EFFORTS.join(', ')}`);
  }
  const params = { threadId, input: [{ type: 'text', text }] };
  if (mode === MODE.PLAN) {
    params.collaborationMode = {
      mode: MODE.PLAN,
      settings: { model: model ?? null, reasoning_effort: effort ?? null, developer_instructions: null },
    };
  }
  if (effort) params.effort = effort;
  return params;
}

export function classifyServerRequest(method, params) {
  let kind = 'unknown';
  if (SERVER_REQUEST.QUESTION.includes(method)) kind = 'question';
  else if (SERVER_REQUEST.APPROVAL.includes(method)) kind = 'approval';
  else if (SERVER_REQUEST.ELICITATION.includes(method)) kind = 'elicitation';
  return { kind, method, params };
}

// requestUserInput response: { answers: { <questionId>: { answers: string[] } } }
export function buildQuestionAnswer(questionId, answers) {
  return { answers: { [questionId]: { answers } } };
}

// Approval decision enum from the generated schema (ReviewDecision). Confirm exact
// values with `codex app-server generate-json-schema` (Task 10 doctor verifies live).
const DECISION = { allow: 'approved', deny: 'denied' };
export function buildApprovalResponse(decision) {
  const mapped = DECISION[decision];
  if (!mapped) throw new Error(`invalid decision '${decision}'; expected allow|deny`);
  return { decision: mapped };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/protocol.test.mjs`
Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
git add lib/protocol.mjs test/protocol.test.mjs
git commit -m "protocol builders"
```

---

## Task 4: Mock app-server fixture (`test/fixtures/mock-appserver.mjs`)

A scripted JSON-RPC server over stdin/stdout, used by later offline tests. Behaviour is driven by the text of the user turn so tests can request specific flows.

**Files:**
- Create: `test/fixtures/mock-appserver.mjs`
- Test: `test/appserver.test.mjs` (Task 5 exercises the fixture; this task adds a direct smoke test)

- [ ] **Step 1: Write the failing smoke test** (`test/appserver.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { JsonRpc } from '../lib/jsonrpc.mjs';
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/appserver.test.mjs`
Expected: FAIL — fixture file does not exist (spawn error / no notifications).

- [ ] **Step 3: Create `test/fixtures/mock-appserver.mjs`**

```js
// Scripted JSON-RPC app-server stand-in for offline tests.
// Reads newline-delimited JSON-RPC on stdin, writes responses/notifications on stdout.
// Turn behaviour keys off the user text:
//   "say OK"      -> emits delta "OK" then turn/completed
//   "ASK"         -> emits a server-request item/tool/requestUserInput, waits for the
//                    client's response, then emits delta + turn/completed
//   anything else -> emits delta "done" then turn/completed
import readline from 'node:readline';

let threadSeq = 0;
let turnSeq = 0;
let serverReqSeq = 1000;
const pendingServerReq = new Map(); // id -> resolve

function write(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function notify(method, params) { write({ jsonrpc: '2.0', method, params }); }
function result(id, res) { write({ jsonrpc: '2.0', id, result: res }); }

async function runTurn(threadId, text) {
  const turnId = `turn-${++turnSeq}`;
  notify('turn/started', { threadId, turnId });
  if (text.includes('ASK')) {
    const reqId = ++serverReqSeq;
    const answered = new Promise((res) => pendingServerReq.set(reqId, res));
    write({
      jsonrpc: '2.0', id: reqId, method: 'item/tool/requestUserInput',
      params: { threadId, turnId, itemId: 'i1',
        questions: [{ id: 'q1', header: 'Pick', question: 'Which option?', options: ['A', 'B'] }] },
    });
    const answer = await answered;
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'i2', delta: `chose ${JSON.stringify(answer)}` });
  } else if (text.includes('say OK')) {
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'i2', delta: 'OK' });
  } else {
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'i2', delta: 'done' });
  }
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  // Client response to one of our server-requests:
  if (msg.id !== undefined && msg.result !== undefined && pendingServerReq.has(msg.id)) {
    pendingServerReq.get(msg.id)(msg.result);
    pendingServerReq.delete(msg.id);
    return;
  }
  if (msg.method === 'initialize') {
    result(msg.id, { userAgent: 'mock/0', codexHome: '/tmp', platform: 'test' });
  } else if (msg.method === 'initialized') {
    // notification, no reply
  } else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    const id = msg.params?.threadId || `thread-${++threadSeq}`;
    result(msg.id, { thread: { id } });
    notify('thread/started', { thread: { id } });
  } else if (msg.method === 'turn/start') {
    result(msg.id, { turn: { id: `turn-pending` } });
    const text = (msg.params.input || []).map((i) => i.text || '').join(' ');
    runTurn(msg.params.threadId, text);
  } else if (msg.method === 'turn/interrupt') {
    result(msg.id, {});
    notify('turn/completed', { threadId: msg.params.threadId, turn: { id: msg.params.turnId, status: 'interrupted', items: [] } });
  } else if (msg.method === 'thread/unsubscribe') {
    result(msg.id, {});
  } else if (msg.id !== undefined) {
    result(msg.id, {});
  }
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/appserver.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/mock-appserver.mjs test/appserver.test.mjs
git commit -m "mock app-server fixture"
```

---

## Task 5: AppServer client (`lib/appserver.mjs`)

**Files:**
- Create: `lib/appserver.mjs`
- Test: `test/appserver.test.mjs` (add cases that use the real class)

- [ ] **Step 1: Add failing tests** (append to `test/appserver.test.mjs`)

```js
import { AppServer } from '../lib/appserver.mjs';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/appserver.test.mjs`
Expected: FAIL — `Cannot find module '../lib/appserver.mjs'`.

- [ ] **Step 3: Create `lib/appserver.mjs`**

```js
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { JsonRpc } from './jsonrpc.mjs';
import { METHODS } from './protocol.mjs';

export class AppServer extends EventEmitter {
  constructor({ command = 'codex', args = ['app-server'], spawnFn = spawn } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.spawnFn = spawnFn;
    this.child = null;
    this.rpc = null;
  }

  async start() {
    this.child = this.spawnFn(this.command, this.args, { stdio: ['pipe', 'pipe', 'inherit'] });
    this.rpc = new JsonRpc((line) => this.child.stdin.write(line));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this.rpc.feed(d));
    this.rpc.onNotification = (method, params) => this.emit('notification', method, params);
    this.rpc.onServerRequest = (id, method, params) => this.emit('serverRequest', { id, method, params });
    this.child.on('exit', (code, signal) => this.emit('exit', { code, signal }));
  }

  async initialize(clientInfo) {
    const res = await this.rpc.request(METHODS.INITIALIZE, {
      clientInfo,
      capabilities: { experimentalApi: true },
    });
    this.rpc.notify(METHODS.INITIALIZED, {});
    return res;
  }

  request(method, params) { return this.rpc.request(method, params); }
  respond(id, result) { this.rpc.respond(id, result); }

  async stop() {
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/appserver.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/appserver.mjs test/appserver.test.mjs
git commit -m "app-server client"
```

---

## Task 6: State store (`lib/state.mjs`)

**Files:**
- Create: `lib/state.mjs`
- Test: `test/state.test.mjs`

- [ ] **Step 1: Write the failing test** (`test/state.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../lib/state.mjs';

test('writeState then readState round-trips; socketPathFor is deterministic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-'));
  const store = new StateStore(dir);
  assert.equal(store.readState(), null);
  const rec = { threadId: 'abc', pid: 123, cwd: '/x', model: 'gpt-5.5' };
  store.writeState(rec);
  assert.deepEqual(store.readState(), rec);
  assert.equal(store.socketPathFor('abc'), join(dir, 'abc.sock'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/state.test.mjs`
Expected: FAIL — `Cannot find module '../lib/state.mjs'`.

- [ ] **Step 3: Create `lib/state.mjs`**

```js
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export class StateStore {
  constructor(baseDir = join(homedir(), '.codex-drive')) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
    this.statePath = join(this.baseDir, 'state.json');
  }

  readState() {
    if (!existsSync(this.statePath)) return null;
    try { return JSON.parse(readFileSync(this.statePath, 'utf8')); }
    catch { return null; }
  }

  writeState(rec) {
    writeFileSync(this.statePath, JSON.stringify(rec, null, 2));
  }

  socketPathFor(threadId) {
    return join(this.baseDir, `${threadId}.sock`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/state.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add lib/state.mjs test/state.test.mjs
git commit -m "state store"
```

---

## Task 7: Session daemon (`lib/daemon.mjs`)

The daemon owns one `AppServer` + one thread, listens on a unix socket, runs a turn state machine, buffers deltas, parks server-requests, and resolves `wait`.

**Files:**
- Create: `lib/daemon.mjs`
- Test: `test/daemon.test.mjs`

- [ ] **Step 1: Write the failing test** (`test/daemon.test.mjs`)

```js
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

async function startDaemon() {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-d-'));
  const socketPath = join(dir, 't.sock');
  const daemon = new Daemon({
    socketPath,
    appServerOpts: { command: process.execPath, args: [FIXTURE] },
    clientInfo: { name: 'codex-drive', version: '0.1.0' },
  });
  await daemon.start();
  return { daemon, socketPath };
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/daemon.test.mjs`
Expected: FAIL — `Cannot find module '../lib/daemon.mjs'`.

- [ ] **Step 3: Create `lib/daemon.mjs`**

```js
import { createServer } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import { AppServer } from './appserver.mjs';
import { METHODS, NOTIFY, buildTurnStart, classifyServerRequest, buildQuestionAnswer, buildApprovalResponse } from './protocol.mjs';

export class Daemon {
  constructor({ socketPath, appServerOpts = {}, clientInfo, resume = null, model = null }) {
    this.socketPath = socketPath;
    this.appServerOpts = appServerOpts;
    this.clientInfo = clientInfo;
    this.resume = resume;
    this.model = model;
    this.app = null;
    this.server = null;
    this.threadId = null;
    this.turn = { id: null, status: 'idle', buffer: '', parked: null, message: null };
    this._waiters = []; // resolve fns awaiting a terminal/awaiting state
  }

  async start() {
    this.app = new AppServer(this.appServerOpts);
    await this.app.start();
    this.app.on('notification', (m, p) => this._onNotification(m, p));
    this.app.on('serverRequest', (req) => this._onServerRequest(req));
    await this.app.initialize(this.clientInfo);
    const params = this.resume ? { threadId: this.resume } : {};
    const started = await this.app.request(this.resume ? METHODS.THREAD_RESUME : METHODS.THREAD_START, params);
    this.threadId = started.thread.id;
    await this._listen();
    return { threadId: this.threadId, socketPath: this.socketPath };
  }

  _listen() {
    if (existsSync(this.socketPath)) { try { unlinkSync(this.socketPath); } catch {} }
    return new Promise((resolve) => {
      this.server = createServer((sock) => this._onClient(sock));
      this.server.listen(this.socketPath, resolve);
    });
  }

  _onClient(sock) {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', async (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let cmd;
        try { cmd = JSON.parse(line); } catch { sock.write(JSON.stringify({ error: 'bad_json' }) + '\n'); continue; }
        const res = await this._handleCommand(cmd);
        sock.write(JSON.stringify(res) + '\n');
      }
    });
    sock.on('error', () => {});
  }

  async _handleCommand(cmd) {
    switch (cmd.cmd) {
      case 'plan': return this._startTurn(cmd.prompt, 'plan', cmd.effort);
      case 'send': return this._startTurn(cmd.prompt, 'default', cmd.effort);
      case 'wait': return this._wait();
      case 'answer': return this._answer(cmd.id, cmd.answers);
      case 'approve': return this._approve(cmd.decision);
      case 'read': return { status: this.turn.status, message: this.turn.message };
      case 'interrupt': return this._interrupt();
      case 'status': return { threadId: this.threadId, turnStatus: this.turn.status, parked: this.turn.parked ? this.turn.parked.kind : null };
      case 'stop': await this.stop(); return { ok: true };
      default: return { error: 'unknown_cmd' };
    }
  }

  async _startTurn(prompt, mode, effort) {
    if (this.turn.status === 'running' || this.turn.status === 'awaiting_input') return { error: 'busy' };
    this.turn = { id: null, status: 'running', buffer: '', parked: null, message: null };
    const params = buildTurnStart({ threadId: this.threadId, text: prompt, mode: mode === 'plan' ? 'plan' : undefined, effort, model: this.model });
    await this.app.request(METHODS.TURN_START, params);
    return { ok: true, status: 'running' };
  }

  _wait() {
    if (this.turn.status === 'awaiting_input') return Promise.resolve(this._parkedResult());
    if (['completed', 'interrupted', 'failed', 'idle'].includes(this.turn.status)) {
      return Promise.resolve(this._terminalResult());
    }
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  _terminalResult() { return { status: this.turn.status, message: this.turn.message }; }
  _parkedResult() {
    const p = this.turn.parked;
    return p.kind === 'question' || p.kind === 'elicitation'
      ? { status: 'question', question: p.params }
      : { status: 'approval', request: { method: p.method, params: p.params } };
  }

  _resolveWaiters() {
    const result = this.turn.status === 'awaiting_input' ? this._parkedResult() : this._terminalResult();
    const ws = this._waiters; this._waiters = [];
    ws.forEach((r) => r(result));
  }

  async _answer(questionId, answers) {
    if (this.turn.status !== 'awaiting_input' || !this.turn.parked) return { error: 'no_pending_question' };
    const p = this.turn.parked;
    this.app.respond(p.id, buildQuestionAnswer(questionId, answers));
    this.turn.parked = null;
    this.turn.status = 'running';
    return { ok: true };
  }

  async _approve(decision) {
    if (this.turn.status !== 'awaiting_input' || !this.turn.parked) return { error: 'no_pending_approval' };
    const p = this.turn.parked;
    this.app.respond(p.id, buildApprovalResponse(decision));
    this.turn.parked = null;
    this.turn.status = 'running';
    return { ok: true };
  }

  async _interrupt() {
    if (!this.turn.id) return { error: 'no_active_turn' };
    await this.app.request(METHODS.TURN_INTERRUPT, { threadId: this.threadId, turnId: this.turn.id });
    return { ok: true };
  }

  _onNotification(method, params) {
    if (method === NOTIFY.TURN_STARTED) {
      this.turn.id = params.turnId || (params.turn && params.turn.id) || this.turn.id;
    } else if (method === NOTIFY.AGENT_MESSAGE_DELTA) {
      if (typeof params.delta === 'string') this.turn.buffer += params.delta;
    } else if (method === NOTIFY.TURN_COMPLETED) {
      const status = params.turn ? params.turn.status : 'completed';
      this.turn.status = status === 'completed' ? 'completed' : status;
      this.turn.message = this.turn.buffer;
      this._resolveWaiters();
    }
  }

  _onServerRequest(req) {
    const c = classifyServerRequest(req.method, req.params);
    this.turn.parked = { id: req.id, kind: c.kind, method: req.method, params: req.params };
    this.turn.status = 'awaiting_input';
    this._resolveWaiters();
  }

  async stop() {
    if (this.threadId && this.app) { try { await this.app.request(METHODS.THREAD_UNSUBSCRIBE, { threadId: this.threadId }); } catch {} }
    if (this.app) await this.app.stop();
    if (this.server) await new Promise((r) => this.server.close(r));
    if (existsSync(this.socketPath)) { try { unlinkSync(this.socketPath); } catch {} }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/daemon.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/daemon.mjs test/daemon.test.mjs
git commit -m "session daemon"
```

---

## Task 8: Client transport (`lib/client.mjs`)

**Files:**
- Create: `lib/client.mjs`
- Test: covered via `test/verbs.test.mjs` in Task 9 (this task adds a focused round-trip test reusing the daemon test harness)

- [ ] **Step 1: Write the failing test** (`test/client.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Daemon } from '../lib/daemon.mjs';
import { sendCommand } from '../lib/client.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/mock-appserver.mjs', import.meta.url));

test('sendCommand round-trips a command to the daemon', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-c-'));
  const socketPath = join(dir, 't.sock');
  const daemon = new Daemon({ socketPath, appServerOpts: { command: process.execPath, args: [FIXTURE] }, clientInfo: { name: 'c', version: '0' } });
  await daemon.start();
  await sendCommand(socketPath, { cmd: 'send', prompt: 'say OK' });
  const res = await sendCommand(socketPath, { cmd: 'wait' });
  assert.equal(res.message, 'OK');
  await daemon.stop();
});

test('sendCommand rejects clearly when no daemon is listening', async () => {
  await assert.rejects(sendCommand('/tmp/does-not-exist-codex-drive.sock', { cmd: 'status' }), /no daemon|ENOENT|ECONNREFUSED/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/client.test.mjs`
Expected: FAIL — `Cannot find module '../lib/client.mjs'`.

- [ ] **Step 3: Create `lib/client.mjs`**

```js
import { connect } from 'node:net';

export function sendCommand(socketPath, cmdObj, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = '';
    let timer = null;
    if (timeoutMs > 0) timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(cmdObj) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) {
        if (timer) clearTimeout(timer);
        sock.end();
        try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
      }
    });
    sock.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? `no daemon at ${socketPath}` : e.message));
    });
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/client.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/client.mjs test/client.test.mjs
git commit -m "daemon client transport"
```

---

## Task 9: CLI verbs + entry (`lib/verbs.mjs`, `bin/codex-drive.mjs`)

**Files:**
- Create: `lib/verbs.mjs`
- Create: `bin/codex-drive.mjs`
- Test: `test/verbs.test.mjs`

- [ ] **Step 1: Write the failing test** (`test/verbs.test.mjs`)

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/verbs.test.mjs`
Expected: FAIL — `Cannot find module '../lib/verbs.mjs'`.

- [ ] **Step 3: Create `lib/verbs.mjs`**

```js
// Pure argv parsing + mapping to daemon commands (no I/O), so it is unit-testable.

export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const flags = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) { flags[key] = true; }
      else { flags[key] = next; i++; }
    } else {
      positionals.push(tok);
    }
  }
  return { verb, positional: positionals.length ? positionals.join(' ') : undefined, flags };
}

export function toCommand({ verb, positional, flags = {} }) {
  switch (verb) {
    case 'plan': return { cmd: 'plan', prompt: positional, effort: flags.effort };
    case 'send': return { cmd: 'send', prompt: positional, effort: flags.effort };
    case 'wait': return { cmd: 'wait' };
    case 'answer': {
      const answers = flags.text !== undefined ? [String(flags.text)] : [`__option:${flags.option}`];
      return { cmd: 'answer', id: flags.id, answers };
    }
    case 'approve': return { cmd: 'approve', decision: flags.decision };
    case 'read': return { cmd: 'read', full: !!flags.full };
    case 'interrupt': return { cmd: 'interrupt' };
    case 'status': return { cmd: 'status' };
    case 'stop': return { cmd: 'stop' };
    default: throw new Error(`unknown verb '${verb}'`);
  }
}
```

> Note on `--option`: the daemon resolves a `__option:N` answer against the parked question's `options[]` before replying. Add that resolution to `Daemon._answer` in this task (Step 4).

- [ ] **Step 4: Resolve `__option:N` in the daemon** — modify `lib/daemon.mjs` `_answer`

Replace the body of `_answer(questionId, answers)` with:

```js
  async _answer(questionId, answers) {
    if (this.turn.status !== 'awaiting_input' || !this.turn.parked) return { error: 'no_pending_question' };
    const p = this.turn.parked;
    const resolved = answers.map((a) => {
      const m = /^__option:(\d+)$/.exec(String(a));
      if (!m) return a;
      const idx = Number(m[1]) - 1; // 1-based option index from CLI
      const q = (p.params.questions || []).find((qq) => qq.id === questionId) || (p.params.questions || [])[0];
      const opt = q && q.options ? q.options[idx] : undefined;
      if (opt === undefined) throw new Error(`option ${m[1]} out of range`);
      return typeof opt === 'string' ? opt : (opt.label ?? opt.value ?? String(opt));
    });
    this.app.respond(p.id, buildQuestionAnswer(questionId, resolved));
    this.turn.parked = null;
    this.turn.status = 'running';
    return { ok: true };
  }
```

Add a daemon test for option resolution (append to `test/daemon.test.mjs`):

```js
test('answer --option resolves the 1-based option label', async () => {
  const { daemon, socketPath } = await startDaemon();
  await rpcCall(socketPath, { cmd: 'send', prompt: 'ASK now' });
  await rpcCall(socketPath, { cmd: 'wait' });
  await rpcCall(socketPath, { cmd: 'answer', id: 'q1', answers: ['__option:2'] });
  const done = await rpcCall(socketPath, { cmd: 'wait' });
  assert.match(done.message, /"B"/); // fixture echoes the chosen answer; option 2 = 'B'
  await daemon.stop();
});
```

- [ ] **Step 5: Create `bin/codex-drive.mjs`**

```js
#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { parseArgs, toCommand } from '../lib/verbs.mjs';
import { sendCommand } from '../lib/client.mjs';
import { StateStore } from '../lib/state.mjs';
import { Daemon } from '../lib/daemon.mjs';

const CLIENT_INFO = { name: 'codex-drive', version: '0.1.0' };

async function main() {
  const argv = process.argv.slice(2);

  // Internal: detached daemon process entrypoint.
  if (argv[0] === '__daemon') {
    const opts = JSON.parse(argv[1]);
    const daemon = new Daemon({
      socketPath: opts.socketPath,
      clientInfo: CLIENT_INFO,
      resume: opts.resume,
      model: opts.model,
    });
    await daemon.start();
    process.on('SIGTERM', () => daemon.stop().then(() => process.exit(0)));
    return; // keep process alive via the listening socket
  }

  const parsed = parseArgs(argv);
  const store = new StateStore();

  if (parsed.verb === 'start') {
    return startDaemon(parsed, store);
  }

  const state = store.readState();
  if (!state) { fail('no active session; run `codex-drive start` first'); }
  const cmd = toCommand(parsed);
  const res = await sendCommand(store.socketPathFor(state.threadId), cmd);
  process.stdout.write(JSON.stringify(res) + '\n');
  if (res.error) process.exit(2);
}

async function startDaemon(parsed, store) {
  const cwd = parsed.flags.cwd || process.cwd();
  // Resolve thread id by spinning the daemon up in-process briefly to learn it,
  // OR spawn detached and discover via state. We spawn detached and poll the socket.
  // First, ask for resume target if requested.
  const resume = parsed.flags.resume || (parsed.flags['resume-latest'] ? '--latest' : null);
  // Pre-compute a provisional socket: start in-process to obtain threadId, then hand off.
  const probe = new Daemon({ socketPath: store.socketPathFor('__probe'), clientInfo: CLIENT_INFO, resume: resume === '--latest' ? null : resume, model: parsed.flags.model });
  await probe.start();
  const threadId = probe.threadId;
  await probe.stop();

  const socketPath = store.socketPathFor(threadId);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__daemon', JSON.stringify({ socketPath, resume: resume === '--latest' ? null : resume, model: parsed.flags.model })], {
    detached: true, stdio: 'ignore', cwd,
  });
  child.unref();

  for (let i = 0; i < 50 && !existsSync(socketPath); i++) await delay(100);
  if (!existsSync(socketPath)) fail('daemon did not come up');

  store.writeState({ threadId, pid: child.pid, socket: socketPath, cwd, model: parsed.flags.model || null });
  process.stdout.write(JSON.stringify({ ok: true, threadId, socket: socketPath, pid: child.pid }) + '\n');
}

function fail(msg) { process.stderr.write(`codex-drive: ${msg}\n`); process.exit(1); }

main().catch((e) => fail(e.message));
```

> Note: the `start` flow uses a short-lived in-process `probe` daemon only to learn the `threadId` from `thread/start`/`thread/resume`, then immediately stops it and hands off to a detached long-lived daemon on the real per-thread socket. `--resume-latest` is wired in Task 10's `doctor`/resume-discovery (it resolves to the newest thread UUID); until then `--resume <uuid>` is the supported form.

- [ ] **Step 6: Make the entry executable + run all tests**

Run:
```bash
chmod +x bin/codex-drive.mjs
node --test test/*.test.mjs
```
Expected: all tests PASS (protocol, jsonrpc, appserver, state, daemon incl. option-resolution, client, verbs).

- [ ] **Step 7: Manual smoke against the mock (no live Codex needed)**

Run:
```bash
# Point the daemon at the mock app-server for a dry run:
CODEX_DRIVE_APPSERVER="$(node -e "process.stdout.write(process.execPath)") test/fixtures/mock-appserver.mjs" \
  node -e "import('./lib/daemon.mjs').then(async ({Daemon})=>{const d=new Daemon({socketPath:'/tmp/cdx-smoke.sock',appServerOpts:{command:process.execPath,args:['test/fixtures/mock-appserver.mjs']},clientInfo:{name:'x',version:'0'}});await d.start();const {sendCommand}=await import('./lib/client.mjs');await sendCommand('/tmp/cdx-smoke.sock',{cmd:'send',prompt:'say OK'});console.log(await sendCommand('/tmp/cdx-smoke.sock',{cmd:'wait'}));await d.stop();})"
```
Expected: prints `{ status: 'completed', message: 'OK' }`.

- [ ] **Step 8: Commit**

```bash
git add lib/verbs.mjs bin/codex-drive.mjs test/verbs.test.mjs lib/daemon.mjs test/daemon.test.mjs
git commit -m "cli verbs + entry"
```

---

## Task 10: `doctor` verb + resume-latest discovery

**Files:**
- Create: `lib/doctor.mjs`
- Modify: `bin/codex-drive.mjs` (dispatch `doctor`; resolve `--resume-latest`)
- Test: `test/doctor.test.mjs`

- [ ] **Step 1: Write the failing test** (`test/doctor.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, latestThreadIdFromIndex } from '../lib/doctor.mjs';

test('parseVersion extracts a semver from `codex --version` output', () => {
  assert.equal(parseVersion('codex-cli 0.130.0'), '0.130.0');
  assert.equal(parseVersion('codex 1.2.3\n'), '1.2.3');
});

test('latestThreadIdFromIndex picks the newest non-archived thread for a cwd', () => {
  const rows = [
    { id: 'old', cwd: '/repo', archived: 0, updated_at_ms: 100 },
    { id: 'new', cwd: '/repo', archived: 0, updated_at_ms: 300 },
    { id: 'newer-archived', cwd: '/repo', archived: 1, updated_at_ms: 400 },
    { id: 'other', cwd: '/elsewhere', archived: 0, updated_at_ms: 500 },
  ];
  assert.equal(latestThreadIdFromIndex(rows, '/repo'), 'new');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/doctor.test.mjs`
Expected: FAIL — `Cannot find module '../lib/doctor.mjs'`.

- [ ] **Step 3: Create `lib/doctor.mjs`**

```js
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function parseVersion(text) {
  const m = /(\d+\.\d+\.\d+)/.exec(text);
  return m ? m[1] : null;
}

// rows: [{id, cwd, archived, updated_at_ms}]
export function latestThreadIdFromIndex(rows, cwd) {
  const candidates = rows
    .filter((r) => !r.archived && (!cwd || r.cwd === cwd))
    .sort((a, b) => b.updated_at_ms - a.updated_at_ms);
  return candidates.length ? candidates[0].id : null;
}

export function checkAuth() {
  return existsSync(join(homedir(), '.codex', 'auth.json'));
}

export function codexVersion() {
  try { return parseVersion(execFileSync('codex', ['--version'], { encoding: 'utf8' })); }
  catch { return null; }
}

// Reads the threads table read-only via the `sqlite3` CLI if available; returns [] otherwise.
export function readThreadRows() {
  const db = join(homedir(), '.codex', 'state_5.sqlite');
  if (!existsSync(db)) return [];
  try {
    const out = execFileSync('sqlite3', ['-readonly', '-json', db,
      'SELECT id, cwd, archived, updated_at_ms FROM threads'], { encoding: 'utf8' });
    return JSON.parse(out || '[]');
  } catch { return []; }
}

export function doctorReport() {
  return {
    codexVersion: codexVersion(),
    authPresent: checkAuth(),
    threads: readThreadRows().length,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/doctor.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire `doctor` + `--resume-latest` into `bin/codex-drive.mjs`**

Add to `main()` before the `parsed.verb === 'start'` branch:

```js
  if (parsed.verb === 'doctor') {
    const { doctorReport } = await import('../lib/doctor.mjs');
    process.stdout.write(JSON.stringify(doctorReport(), null, 2) + '\n');
    return;
  }
```

In `startDaemon`, replace the `resume === '--latest'` handling to resolve the newest thread for the cwd:

```js
  let resumeId = parsed.flags.resume || null;
  if (parsed.flags['resume-latest']) {
    const { readThreadRows, latestThreadIdFromIndex } = await import('../lib/doctor.mjs');
    resumeId = latestThreadIdFromIndex(readThreadRows(), cwd);
    if (!resumeId) fail('no resumable thread found for this cwd');
  }
```
and pass `resume: resumeId` to both the `probe` Daemon and the detached `__daemon` payload (replace the earlier `resume` variable usage accordingly).

- [ ] **Step 6: Run all tests**

Run: `node --test test/*.test.mjs`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/doctor.mjs bin/codex-drive.mjs test/doctor.test.mjs
git commit -m "doctor + resume-latest"
```

---

## Task 11: Live integration tests (gated)

**Files:**
- Create: `test/integration.live.test.mjs`

- [ ] **Step 1: Write the gated live test** (`test/integration.live.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daemon } from '../lib/daemon.mjs';
import { sendCommand } from '../lib/client.mjs';

const LIVE = process.env.CODEX_DRIVE_LIVE === '1';

test('live: send a trivial turn and read the reply', { skip: !LIVE }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-live-'));
  const socketPath = join(dir, 't.sock');
  const daemon = new Daemon({ socketPath, clientInfo: { name: 'codex-drive', version: '0.1.0' } });
  await daemon.start();
  await sendCommand(socketPath, { cmd: 'send', prompt: 'Reply with exactly: OK' });
  const res = await sendCommand(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'completed');
  assert.match(res.message, /OK/);
  await daemon.stop();
});

test('live: plan mode produces a plan', { skip: !LIVE }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-live2-'));
  const socketPath = join(dir, 't.sock');
  const daemon = new Daemon({ socketPath, clientInfo: { name: 'codex-drive', version: '0.1.0' } });
  await daemon.start();
  await sendCommand(socketPath, { cmd: 'plan', prompt: 'Plan how to add a /healthz endpoint to a small Express app. Do not write code.', effort: 'medium' });
  let res = await sendCommand(socketPath, { cmd: 'wait' });
  // If Codex asks a clarifying question, answer the first option and continue.
  while (res.status === 'question') {
    const q = res.question.questions[0];
    await sendCommand(socketPath, { cmd: 'answer', id: q.id, answers: [q.options ? q.options[0] : 'proceed'] });
    res = await sendCommand(socketPath, { cmd: 'wait' });
  }
  assert.equal(res.status, 'completed');
  assert.ok(res.message.length > 0);
  await daemon.stop();
});
```

- [ ] **Step 2: Verify it skips without the flag**

Run: `node --test test/integration.live.test.mjs`
Expected: tests reported as skipped (no live Codex contacted).

- [ ] **Step 3: Run live (manual, requires logged-in `codex`)**

Run: `npm run test:live`
Expected: both live tests PASS; `message` contains `OK` for the first, a non-empty plan for the second. If `plan` errors with an experimental-gate message, confirm `experimentalApi:true` is sent (it is, in `AppServer.initialize`) and that the installed `codex` supports `collaborationMode` (`codex app-server generate-json-schema | jq '.definitions.ModeKind'`).

- [ ] **Step 4: Commit**

```bash
git add test/integration.live.test.mjs
git commit -m "live integration tests"
```

---

## Task 12: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

````markdown
# codex-drive

Drive a headless `codex app-server` over JSON-RPC so an orchestrator (e.g. Claude Code) can run a
Codex architect → implement → review dev-loop natively — no GUI automation.

## Requirements
- Node >= 20
- A logged-in Codex CLI (`codex login status` → "Logged in using ChatGPT"). Auth is reused from `~/.codex/auth.json`.

## Install
```bash
npm link   # exposes `codex-drive` on PATH
```

## Usage
```bash
codex-drive start --cwd /path/to/repo        # boot the session daemon
codex-drive plan "Architect a fix for <bug>" # Plan-mode turn
codex-drive wait                             # -> {status:"completed",message} | {status:"question",question} | {status:"approval",request}
codex-drive answer --id q1 --option 2        # answer a question (1-based option) ...
codex-drive answer --id q1 --text "free text"# ... or free text
codex-drive approve --id r1 --decision allow # approve/deny an exec/patch request
codex-drive read --last                      # last assistant message
codex-drive send "Review the implementation; report issues or 'no issues'."
codex-drive interrupt                        # cancel the in-flight turn
codex-drive status                           # daemon/thread/turn state
codex-drive stop                             # shut down
codex-drive doctor                           # version, auth, thread count
```

All verbs print a single JSON object on stdout.

## Loop sketch (orchestrator)
1. `start` → `plan "..."` → `wait` (answer questions) → read plan
2. implement the plan
3. `send "review ..."` → `wait` → read review
4. issues? fix → back to 3. clean? `stop`.

## Notes / limits
- One in-flight turn per daemon; `plan`/`send` return `{error:"busy"}` otherwise.
- The `collaborationMode` (Plan mode) and `requestUserInput` surfaces are **experimental** in Codex and
  may change across versions; run `codex-drive doctor` after upgrading and regenerate types with
  `codex app-server generate-ts`.
- v1 is human-supervised (no auto-answer). Unattended looping + API-key auth are future work.
- Driving the *exact live desktop window* is out of scope (that needs the experimental control-socket attach).
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "readme"
```

---

## Self-review (completed during planning)

**Spec coverage:** every spec section maps to a task — JSON-RPC client (Task 2), Plan mode via `collaborationMode` (Task 3 builder + Task 7 daemon + Task 11 live), detect-done via `turn/completed` (Task 7), question/approval surface + answer (Tasks 3/7/9), interrupt (Task 7), read/status/stop (Task 7/9), state/continuity + resume (Tasks 6/10), auth reuse (no code; verified in Task 10 doctor), error classes — busy/no-daemon/dead/schema-drift (Tasks 7/8/10), testing unit+gated-live (every task + Task 11), doctor for schema-drift mitigation (Task 10). Out-of-scope items (auto-answer, API-key auth, live-window attach, multi-thread) are intentionally absent.

**Placeholder scan:** no TBD/TODO/"handle edge cases"; every code step shows complete code; `<bug>`/`<files>` appear only inside example prompt strings, not as code placeholders.

**Type consistency:** `JsonRpc` / `AppServer` / `Daemon` / `StateStore` method and property names, daemon command names (`plan|send|wait|answer|approve|read|interrupt|status|stop`), turn-status values, and `buildTurnStart`/`classifyServerRequest`/`buildQuestionAnswer`/`buildApprovalResponse` signatures are identical everywhere they appear. The `__option:N` convention introduced in Task 9 verbs is resolved in the Task 9 daemon edit and covered by an added daemon test.

**One known protocol uncertainty:** the approval `decision` enum (`approved`/`denied`) is the best-evidenced value from recon; Task 11's live run (and `doctor` schema generation) confirms it against the installed version. If it differs, update the `DECISION` map in `lib/protocol.mjs` (Task 3, Step 3).
