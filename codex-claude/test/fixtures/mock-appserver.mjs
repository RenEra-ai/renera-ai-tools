// Scripted JSON-RPC app-server stand-in for offline tests.
// Reads newline-delimited JSON-RPC on stdin, writes responses/notifications on stdout.
// Turn behaviour keys off the user text:
//   "say OK"      -> emits delta "OK" then turn/completed
//   "ASK"         -> emits a server-request item/tool/requestUserInput, waits for the
//                    client's response, then emits delta + turn/completed
//   "BADTURN"     -> rejects turn/start with a JSON-RPC error (models a server-side rejection)
//   "PLANSTREAM"  -> emits preamble chat plus Plan-mode item/plan/delta and completed plan text
//   "PLANITEM"    -> emits preamble chat plus only completed plan item text
//   "REVIEWPLAN"  -> emits incidental item/plan/delta plus agent-message verdict text
//   anything else -> emits delta "done" then turn/completed
// turn/start validation mirrors the real app-server: if collaborationMode is present, its
// settings.model MUST be a non-empty string, else the request is rejected with -32600
// (this reproduces the live "invalid type: null, expected a string" Plan-mode rejection).
import readline from 'node:readline';

let threadSeq = 0;
let turnSeq = 0;
let serverReqSeq = 1000;
const pendingServerReq = new Map(); // id -> resolve

function write(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function notify(method, params) { write({ jsonrpc: '2.0', method, params }); }
function result(id, res) { write({ jsonrpc: '2.0', id, result: res }); }

async function runTurn(threadId, text) {
  // Small delay so the turn/start response reaches the daemon before notifications.
  await new Promise((r) => setTimeout(r, 20));
  const turnId = `turn-${++turnSeq}`;
  notify('turn/started', { threadId, turnId });
  if (text.includes('ASK')) {
    const reqId = ++serverReqSeq;
    const answered = new Promise((res) => pendingServerReq.set(reqId, res));
    write({
      jsonrpc: '2.0', id: reqId, method: 'item/tool/requestUserInput',
      params: { threadId, turnId, itemId: 'i1',
        questions: [{ id: 'q1', header: 'Pick', question: 'Which option?', isOther: false, isSecret: false,
          options: [{ label: 'A', description: 'Option A' }, { label: 'B', description: 'Option B' }] }] },
    });
    const answer = await answered;
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'i2', delta: `chose ${JSON.stringify(answer)}` });
  } else if (text.includes('APPROVE')) {
    const reqId = ++serverReqSeq;
    const answered = new Promise((res) => pendingServerReq.set(reqId, res));
    write({
      jsonrpc: '2.0', id: reqId, method: 'item/commandExecution/requestApproval',
      params: { threadId, turnId, itemId: 'i1', command: '/bin/zsh -lc "echo hi"',
        availableDecisions: ['accept', 'decline', 'cancel'] },
    });
    const answer = await answered;
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'i2', delta: `decision=${JSON.stringify(answer)}` });
  } else if (text.includes('EMPTY')) {
    // Emit NO agent-message delta: models the gpt-5.5 build quirk where a turn ends
    // `completed` with an empty final message (no plan/verdict content).
  } else if (text.includes('PLANSTREAM')) {
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'i2', delta: "I'll inspect the repo before planning." });
    notify('item/plan/delta', { threadId, turnId, itemId: 'p1', delta: 'src/app.js\n- Add GET /healthz.\n' });
    notify('item/completed', { threadId, turnId, item: { type: 'plan', id: 'p1', text: 'src/app.js\n- Add GET /healthz.\n- Add a request test.' } });
  } else if (text.includes('PLANITEM')) {
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'i2', delta: "I'll inspect the repo before planning." });
    notify('item/completed', { threadId, turnId, item: { type: 'plan', id: 'p1', text: 'app.js\n- Add GET /healthz.' } });
  } else if (text.includes('REVIEWPLAN')) {
    notify('item/plan/delta', { threadId, turnId, itemId: 'p1', delta: 'internal checklist, not final review' });
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'i2', delta: 'Reviewed src/app.js.\nVERDICT: NO ISSUES' });
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
    const cm = msg.params.collaborationMode;
    if (cm && (typeof cm.settings?.model !== 'string' || cm.settings.model.length === 0)) {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Invalid request: invalid type: null, expected a string' } });
      return;
    }
    const text = (msg.params.input || []).map((i) => i.text || '').join(' ');
    if (text.includes('BADTURN')) {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'simulated turn failure' } });
      return;
    }
    result(msg.id, { turn: { id: `turn-pending` } });
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
