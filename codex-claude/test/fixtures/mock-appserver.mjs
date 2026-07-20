// Scripted JSON-RPC app-server stand-in for offline tests.
// Reads newline-delimited JSON-RPC on stdin, writes responses/notifications on stdout.
// Turn behaviour keys off the user text:
//   "say OK"      -> emits delta "OK" then turn/completed
//   "ASK"         -> emits a server-request item/tool/requestUserInput, waits for the
//                    client's response, then emits delta + turn/completed
//   "BADTURN"     -> rejects turn/start with a JSON-RPC error (models a server-side rejection)
//   "TICKS"       -> streams a delta every 150ms (x8) before completing: the "working, not stuck"
//                    activity signature (eventCount climbs while lastEventAgoMs stays small)
//   "PLANSTREAM"  -> emits preamble chat plus Plan-mode item/plan/delta and completed plan text
//   "PLANITEM"    -> emits preamble chat plus only completed plan item text
//   "REVIEWPLAN"  -> emits incidental item/plan/delta plus agent-message verdict text
//   anything else -> emits delta "done" then turn/completed
// turn/start validation mirrors the real app-server: if collaborationMode is present, its
// settings.model MUST be a non-empty string, else the request is rejected with -32600
// (this reproduces the live "invalid type: null, expected a string" Plan-mode rejection).
//
// REVIEW MODES (`--review-mode <m>`, review/start only). A review carries no user text, so unlike
// turn/start its behaviour cannot key off the prompt. The value is ALLOWLISTED: an unknown mode is a
// loud exit, never a silent fall back to the happy path (which would let a typo'd test pass green).
//   ok            -> enteredReviewMode, exitedReviewMode(text), turn/completed
//   burst         -> the SAME as ok, but response + every notification in ONE stdout write, so the
//                    daemon's JsonRpc.feed() drains them synchronously before the response promise's
//                    microtask runs. This is the race that made `wait` report a completed review on a
//                    turn whose true status was failed.
//   reject        -> review/start rejected with a JSON-RPC error
//   wrongthread   -> response carries a foreign reviewThreadId
//   blank         -> exitedReviewMode with empty review text
//   statusinbody  -> review text that itself contains a line reading "STATUS: failed"
//   noresponse    -> notifications + turn/completed but NO response, ever (arms the daemon backstop)
//   ask/approve   -> parks a question / an approval mid-review
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';

//   permissions   -> parks a permissions-shaped approval (the one protocol.mjs refuses to fake)
//   failbeforeresponse -> notifications ending in turn/completed{status:'failed'}, response never sent
//   ticks         -> response + entered/started, then a heartbeat every TICK_MS for TICK_COUNT
//                    beats, then real review text + completion. The "slow but HEALTHY" signature
//                    (eventCount climbs, lastEventAgoMs stays small) that must survive REPEATED
//                    client-side wait expiries — a poller treating `timeout` as `dead` fails here.
//   hang          -> response + entered/started, then SILENCE forever. The "stuck" signature
//                    (eventCount frozen, lastEventAgoMs grows without bound) — the only one that
//                    justifies interrupting a running turn. NOT interchangeable with `noresponse`,
//                    which streams every notification and withholds only the JSON-RPC response, so
//                    it exercises the daemon's completion backstop rather than liveness.
const REVIEW_MODES = new Set(['ok', 'burst', 'reject', 'wrongthread', 'blank', 'statusinbody', 'noresponse', 'ask', 'approve', 'permissions', 'failbeforeresponse', 'ticks', 'hang', 'huge']);

// The heartbeat uses `item/reasoning/delta`, which is deliberately NOT in protocol.mjs's NOTIFY map:
// _dispatchNotification stamps activity for EVERY method before its per-method branches, so an
// unhandled method is pure liveness with no side effects. An agentMessage delta would also stamp,
// but it feeds the message buffer and could contaminate the review body this fixture asserts on.
const TICK_MS = 120;
const TICK_COUNT = 25;   // ~3s of activity: several expiries at the sub-second caps tests use

// --record <path>: on thread/start, persist the params we were sent AND our own cwd. Lets a test
// observe two of the three cwd legs (spawn cwd + thread/start cwd) that the spec requires to agree,
// and doubles as a "was the app-server ever spawned?" sentinel for no-boot assertions.
const recIdx = process.argv.indexOf('--record');
const RECORD_PATH = recIdx >= 0 ? process.argv[recIdx + 1] : null;
const rmIdx = process.argv.indexOf('--review-mode');
// Guard the indexOf: argv[-1 + 1] is argv[0], so an unguarded read silently turns the first
// unrelated argument into the mode.
const REVIEW_MODE = rmIdx >= 0 ? process.argv[rmIdx + 1] : 'ok';
if (!REVIEW_MODES.has(REVIEW_MODE)) {
  process.stderr.write(`mock-appserver: unknown --review-mode '${REVIEW_MODE}'\n`);
  process.exit(2);
}

// --lifecycle-file <path>: OPT-IN observability seam. Synchronously persist our PID at boot and
// hold the event loop open with a REFERENCED keepalive. Without the keepalive this mock exits
// naturally on stdin EOF, so a daemon that died WITHOUT killing its child would leave no
// observable orphan — and a deleted daemon.stop() would stay green in the SIGTERM tests. Only an
// actual kill(), not a dropped pipe, may end a lifecycle-tracked mock. Default behaviour (no
// flag) is unchanged.
const lfIdx = process.argv.indexOf('--lifecycle-file');
const LIFECYCLE_PATH = lfIdx >= 0 ? process.argv[lfIdx + 1] : null;
if (LIFECYCLE_PATH) {
  writeFileSync(LIFECYCLE_PATH, String(process.pid));
  setInterval(() => {}, 1 << 30);   // referenced on purpose — never unref this
}

let threadSeq = 0;
let turnSeq = 0;
let serverReqSeq = 1000;
const pendingServerReq = new Map(); // id -> resolve

function write(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function notify(method, params) { write({ jsonrpc: '2.0', method, params }); }
function result(id, res) { write({ jsonrpc: '2.0', id, result: res }); }
// One syscall for several messages, so the client receives them in a single coalesced chunk.
function writeBurst(objs) { process.stdout.write(objs.map((o) => JSON.stringify(o)).join('\n') + '\n'); }

async function runTurn(threadId, text, turnId) {
  // NO artificial delay. The old 20ms sleep here let the turn/start response win every race and so
  // MASKED the plan/send ordering bug entirely: a real server can coalesce the response and its
  // notifications into one stdout chunk, which JsonRpc.feed() drains synchronously while the
  // response promise resolves on a later microtask. Yielding a single macrotask keeps the mock
  // realistic (the write is still a separate chunk) without papering over the race.
  await new Promise((r) => setImmediate(r));
  // Live shape is {threadId, turn:{id}} — NOT {threadId, turnId}. The daemon reads both, but the
  // fixture should send what the server actually sends.
  notify('turn/started', { threadId, turn: { id: turnId } });
  if (text.includes('read-only review session')) {
    // review-round's STATIC RE-ASK, verbatim-matched. Without a branch here the re-ask fell through
    // to the generic 'done' reply, so the driver's second turn produced no verdict and its test
    // passed on PARSED_VERDICT: UNCLEAR — green while proving nothing.
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'i2', delta: 'Static-only review.\nVERDICT: NO ISSUES' });
  } else if (text.includes('read-only planning session')) {
    // plan-round's static re-ask: it must yield a REAL plan item, since the whole point of the
    // re-ask is recovering a plan after a denied command left only a preamble.
    notify('item/completed', { threadId, turnId, item: { type: 'plan', id: 'p1', text: 'app.js\n- Add GET /healthz after the static re-ask.' } });
  } else if (text.includes('APPROVESAFE')) {
    // The ALLOW arm. `pytest -q` is the one family lib/safe-command.mjs auto-approves; the existing
    // APPROVE branch's `echo hi` is correctly DENIED, so the two together cover both decisions.
    const rid = ++serverReqSeq;
    const answered = new Promise((res) => pendingServerReq.set(rid, res));
    write({
      jsonrpc: '2.0', id: rid, method: 'item/commandExecution/requestApproval',
      params: { threadId, turnId, itemId: 'i1', command: 'pytest -q',
        availableDecisions: ['accept', 'decline', 'cancel'] },
    });
    const answer = await answered;
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'i2', delta: `safe-decision=${JSON.stringify(answer)}` });
  } else if (text.includes('SLOWTURN')) {
    // Completes only after several seconds, so a short CODEX_DRIVE_TEST_WAIT_MS cap expires MID-turn.
    // Under the old interrupt-on-expiry behaviour this turn was killed; under rewait it completes.
    await new Promise((r) => setTimeout(r, 1500));
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'i2', delta: 'slow but finished\nVERDICT: NO ISSUES' });
  } else if (text.includes('ASK')) {
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
  } else if (text.includes('HANGTURN')) {
    // Responds to turn/start, then never completes. The turn-level counterpart of the `noresponse`
    // review mode: without it there is no way to observe a driver being killed MID-turn, which is
    // exactly when an app-server gets orphaned.
    return;
  } else if (text.includes('TICKS')) {
    // Steady heartbeat of deltas: lets a test observe the WORKING signature across two status
    // polls (count rises, ago stays small) — no existing mode streams periodically.
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 150));
      notify('item/agentMessage/delta', { threadId, turnId, itemId: 'i2', delta: `tick${i} ` });
    }
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

const REVIEW_TEXT = 'Reviewed 1 file.\n- [P2] something to fix — a.txt:1';

// A review far larger than one 64 KiB pipe buffer. Real reviews of a big delta reach this size, and
// a consumer that writes to a pipe and exits immediately loses everything past the first buffer —
// including the trailers the enforcement hook keys on. Numbered lines so a truncation shows up as a
// missing TAIL rather than as an unreadable blob.
const HUGE_LINES = 20000;                     // ~1 MiB total
const HUGE_TEXT = `Reviewed a very large delta.\n${
  Array.from({ length: HUGE_LINES }, (_, i) => `- [P2] finding ${i + 1} — a.txt:${i + 1}`).join('\n')
}\nEND-OF-HUGE-REVIEW`;

// Live-faithful review turn (probed against codex-cli 0.144.5).
//
// THE CRITICAL FIDELITY POINT: turn/started announces an id that DIFFERS from the review/start
// response's turn.id, while turn/completed and every item/completed carry the RESPONSE's id. A mock
// that reuses one id everywhere would hide the bug this fixture exists to pin — a daemon that adopts
// turn/started's id drops the review's own completion and hangs `wait` forever.
async function runReview(threadId, reqId) {
  const turnId = `turn-${++turnSeq}`;          // the response's id: what completion/items carry
  const startedId = `started-${turnSeq}`;      // turn/started's DIFFERENT id — live reality
  const reviewThreadId = REVIEW_MODE === 'wrongthread' ? 'thread-SOMEONE-ELSE' : threadId;
  const response = { jsonrpc: '2.0', id: reqId, result: { turn: { id: turnId, status: 'inProgress' }, reviewThreadId } };
  const text = REVIEW_MODE === 'blank' ? ''
    : REVIEW_MODE === 'statusinbody' ? `Findings:\nSTATUS: failed\n- [P1] a trap for naive trailer parsing`
      : REVIEW_MODE === 'huge' ? HUGE_TEXT
        : REVIEW_TEXT;
  const enter = { jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId, item: { type: 'enteredReviewMode', id: 'r0' } } };
  const started = { jsonrpc: '2.0', method: 'turn/started', params: { threadId, turn: { id: startedId } } };
  const exit = { jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId, item: { type: 'exitedReviewMode', id: 'r1', review: text } } };
  const done = { jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [] } } };

  if (REVIEW_MODE === 'reject') {
    write({ jsonrpc: '2.0', id: reqId, error: { code: -32603, message: 'simulated review failure' } });
    return;
  }
  if (REVIEW_MODE === 'burst') {
    // Response AND every notification in ONE write: feed() drains the whole chunk synchronously,
    // so turn/completed is processed before the response promise's continuation runs.
    writeBurst([response, enter, started, exit, done]);
    return;
  }
  if (REVIEW_MODE === 'noresponse') {
    // Turn completes, response never comes. Only the daemon's own backstop can end this.
    writeBurst([enter, started, exit, done]);
    return;
  }
  if (REVIEW_MODE === 'failbeforeresponse') {
    // The turn ends FAILED while the start response is still outstanding. Nothing here is worth
    // validating, so the daemon must finalise it immediately instead of buffering it forever
    // (the successful-completion backstop deliberately does not arm for this status).
    writeBurst([enter, started, { jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'failed', items: [] } } }]);
    return;
  }
  if (REVIEW_MODE === 'ticks' || REVIEW_MODE === 'hang') {
    write(response);
    await new Promise((r) => setTimeout(r, 10));
    write(enter); write(started);
    // `hang` stops here: the turn is legitimately running and will never end. The mock stays alive
    // because readline holds stdin open, so the daemon keeps a live app-server with a frozen turn.
    if (REVIEW_MODE === 'hang') return;
    for (let i = 0; i < TICK_COUNT; i++) {
      await new Promise((r) => setTimeout(r, TICK_MS));
      notify('item/reasoning/delta', { threadId, turnId, itemId: 'rt', delta: '.' });
    }
    write(exit); write(done);
    return;
  }
  write(response);
  await new Promise((r) => setTimeout(r, 10));
  write(enter); write(started);
  if (REVIEW_MODE === 'ask' || REVIEW_MODE === 'approve' || REVIEW_MODE === 'permissions') {
    const rid = ++serverReqSeq;
    const answered = new Promise((res) => pendingServerReq.set(rid, res));
    if (REVIEW_MODE === 'permissions') {
      // The shape protocol.mjs deliberately refuses to fake a response for ({permissions, scope,
      // strictAutoReview}), so a driver must interrupt rather than answer it. Resolves on ANY
      // response — including the error response the decline path sends.
      write({ jsonrpc: '2.0', id: rid, method: 'item/permissions/requestApproval',
        params: { threadId, turnId, itemId: 'i1', permissions: ['read'], scope: 'session', strictAutoReview: false } });
    } else if (REVIEW_MODE === 'ask') {
      write({ jsonrpc: '2.0', id: rid, method: 'item/tool/requestUserInput',
        params: { threadId, turnId, itemId: 'i1',
          questions: [{ id: 'q1', header: 'Pick', question: 'Which?', isOther: false, isSecret: false,
            options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }] }] } });
    } else {
      write({ jsonrpc: '2.0', id: rid, method: 'item/commandExecution/requestApproval',
        params: { threadId, turnId, itemId: 'i1', command: '/bin/zsh -lc "git diff"', availableDecisions: ['accept', 'decline'] } });
    }
    await answered;
  }
  write(exit); write(done);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  // Client response to one of our server-requests. An ERROR response is a FINAL answer too — the
  // real server treats it as one. Accepting only `result` meant the daemon's respondError decline
  // path never resolved this promise, so any test driving it hung at `await answered` instead of
  // reproducing live behaviour.
  if (msg.id !== undefined && pendingServerReq.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
    pendingServerReq.get(msg.id)(msg.result !== undefined ? msg.result : { error: msg.error });
    pendingServerReq.delete(msg.id);
    return;
  }
  if (msg.method === 'initialize') {
    result(msg.id, { userAgent: 'mock/0', codexHome: '/tmp', platform: 'test' });
  } else if (msg.method === 'initialized') {
    // notification, no reply
  } else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    const id = msg.params?.threadId || `thread-${++threadSeq}`;
    if (RECORD_PATH) {
      try { writeFileSync(RECORD_PATH, JSON.stringify({ method: msg.method, params: msg.params || null, cwd: process.cwd() })); } catch { /* best effort */ }
    }
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
    // The response's turn.id is authoritative and MUST be the id the notifications then carry — the
    // old 'turn-pending' placeholder was a shape the server never sends. (Live turn/start responses
    // are {turn:{id,…}}: the response id, turn/started, turn/completed and items all agree.)
    const turnId = `turn-${++turnSeq}`;
    // BURSTTURN: response + every notification in ONE stdout write, so the daemon's feed() drains
    // them synchronously BEFORE the response promise's continuation runs. This is the plan/send
    // counterpart of the `burst` review mode — rev 5 requires the ordering hold for every turn kind,
    // not just reviews, and the shared _startTurn path is where the race actually lived.
    if (text.includes('BURSTTURN')) {
      writeBurst([
        { jsonrpc: '2.0', id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } },
        { jsonrpc: '2.0', method: 'turn/started', params: { threadId: msg.params.threadId, turn: { id: turnId } } },
        { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: msg.params.threadId, turnId, itemId: 'i2', delta: 'BURSTOK' } },
        { jsonrpc: '2.0', method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: turnId, status: 'completed', items: [] } } },
      ]);
      return;
    }
    result(msg.id, { turn: { id: turnId, status: 'inProgress' } });
    runTurn(msg.params.threadId, text, turnId);
  } else if (msg.method === 'review/start') {
    runReview(msg.params.threadId, msg.id);
  } else if (msg.method === 'turn/interrupt') {
    result(msg.id, {});
    notify('turn/completed', { threadId: msg.params.threadId, turn: { id: msg.params.turnId, status: 'interrupted', items: [] } });
  } else if (msg.method === 'thread/unsubscribe') {
    result(msg.id, {});
  } else if (msg.id !== undefined && msg.method !== undefined) {
    // Catch-all for unknown REQUESTS only. It used to fire on any message carrying an id, which
    // meant a RESPONSE to an id we no longer track got a bogus {result:{}} echoed back at it —
    // traffic no real server ever emits, and enough to mask an id-collision bug in response matching.
    result(msg.id, {});
  }
});
