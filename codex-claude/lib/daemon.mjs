import { createServer } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { AppServer } from './appserver.mjs';
import { METHODS, NOTIFY, REVIEW_ITEM, buildTurnStart, buildReviewStart, classifyServerRequest, buildQuestionAnswer, buildApprovalResponse } from './protocol.mjs';
import { readConfiguredModel } from './config.mjs';
import { resolveReviewTarget, buildNativeReviewTarget } from './git-scope.mjs';

// Liveness backstop for the one case buffering cannot resolve on its own: the turn COMPLETED but the
// response that authorises us to interpret it never arrived. Not a review timeout — reviews take
// minutes and are bounded client-side. This only ever fires on a protocol violation, so it is short.
const RESPONSE_BACKSTOP_MS = 5000;

// A review session must be exactly the profile the companion uses. `review` refuses on anything else
// rather than quietly reviewing under a writable sandbox or on a resumed general-purpose thread.
const REVIEW_PROFILE = { sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true };

export class Daemon {
  constructor({ socketPath, appServerOpts = {}, clientInfo, resume = null, model = null, codexHome = null, cwd = null, profile = null }) {
    this.socketPath = socketPath;
    this.appServerOpts = appServerOpts;
    this.clientInfo = clientInfo;
    this.resume = resume;
    this.model = model;
    this.codexHome = codexHome;
    // ONE absolute cwd, used for all three of: the app-server child spawn, thread/start params, and
    // git-scope's subprocess calls. Split-brain here means resolving the scope against one repo while
    // Codex reads another.
    this.cwd = resolvePath(cwd || process.cwd());
    // Thread profile recorded at start (sandbox/approvalPolicy/ephemeral). null = a plain thread.
    this.profile = profile;
    this.app = null;
    this.server = null;
    this.threadId = null;
    this.turn = this._freshTurn();
    this._gen = 0;
    this._waiters = []; // resolve fns awaiting a terminal/awaiting state
    this._sockets = new Set(); // open client connections (so stop() can tear them down)
    this._stopped = false;
    this._appExited = false;
  }

  _freshTurn(extra = {}) {
    return {
      id: null, status: 'idle', buffer: '', planBuffer: '', planText: null, parked: null,
      message: null, isPlan: false, isReview: false, reviewText: null,
      gen: this._gen, awaitingResponse: false, buffered: [], backstop: null, finalized: false,
      ...extra,
    };
  }

  async start() {
    // cwd LAST and unconditional: the daemon's normalized cwd is the single anchor, and an injected
    // appServerOpts.cwd (the test seam) must not be able to split it away from git-scope/thread-start.
    this.app = new AppServer({ ...this.appServerOpts, cwd: this.cwd });
    await this.app.start();
    this.app.on('notification', (m, p) => this._onNotification(m, p));
    this.app.on('serverRequest', (req) => this._onServerRequest(req));
    this.app.on('exit', (info) => this._onAppExit(info));
    await this.app.initialize(this.clientInfo);
    // thread/resume stays {threadId}-only: a resumed thread keeps the identity and profile it was
    // created with, and re-profiling it is not a thing the protocol offers. Review sessions are
    // start-only by the profile rule, so no resume-side cwd matching is needed.
    // Same rule on the wire: profile flags may set sandbox/approvalPolicy/ephemeral, never cwd.
    const params = this.resume
      ? { threadId: this.resume }
      : { ...(this.profile || {}), cwd: this.cwd };
    const started = await this.app.request(this.resume ? METHODS.THREAD_RESUME : METHODS.THREAD_START, params);
    this.threadId = started.thread.id;
    await this._listen();
    return { threadId: this.threadId, socketPath: this.socketPath };
  }

  _listen() {
    if (existsSync(this.socketPath)) { try { unlinkSync(this.socketPath); } catch {} }
    return new Promise((resolve, reject) => {
      this.server = createServer((sock) => this._onClient(sock));
      // A bind failure (EADDRINUSE, EACCES, EPERM in a sandbox) would otherwise surface as an
      // unhandled 'error' event while start() stayed pending forever — so the one-shot's try/finally
      // never runs and its app-server is orphaned.
      this.server.once('error', (err) => reject(new Error(`socket listen failed (${this.socketPath}): ${err.message}`)));
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  _onClient(sock) {
    this._sockets.add(sock);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('close', () => this._sockets.delete(sock));
    sock.on('data', async (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let cmd;
        try { cmd = JSON.parse(line); } catch { sock.write(JSON.stringify({ error: 'bad_json' }) + '\n'); continue; }
        let res;
        try { res = await this._handleCommand(cmd); } // never let a handler throw escape the socket
        catch (e) { res = { error: e.message }; }
        sock.write(JSON.stringify(res) + '\n');
        // Tear down AFTER the response is flushed — doing it inside _handleCommand would await
        // server.close() while this very connection is still open, deadlocking `stop`.
        if (cmd.cmd === 'stop') { sock.end(); await this.stop(); }
      }
    });
    sock.on('error', () => {});
  }

  async _handleCommand(cmd) {
    switch (cmd.cmd) {
      case 'plan': return this._startTurn(cmd.prompt, 'plan', cmd.effort, cmd.approvalPolicy);
      // `send` is plain (no collaborationMode) unless --mode is given; `send --mode default` exits plan mode.
      case 'send': return this._startTurn(cmd.prompt, cmd.mode, cmd.effort, cmd.approvalPolicy);
      case 'review': return this._startReview(cmd.base, cmd.scope);
      case 'wait': return this._wait();
      case 'answer': return this._answer(cmd.id, cmd.answers);
      case 'approve': return this._approve(cmd.decision);
      // `cwd` rides along on read/status so a --socket caller (which deliberately bypasses
      // ~/.codex-drive/state.json, and therefore state.cwd) can still resolve a relative --out
      // against the repo this daemon actually runs in.
      case 'read': return { ...this._completedResult(), cwd: this.cwd };
      case 'interrupt': return this._interrupt();
      case 'status': return { threadId: this.threadId, turnStatus: this.turn.status, parked: this.turn.parked ? this.turn.parked.kind : null, cwd: this.cwd };
      case 'stop': return { ok: true }; // actual teardown happens in _onClient after this response
      default: return { error: 'unknown_cmd' };
    }
  }

  _resolveModel() {
    // Plan mode needs a concrete model string (the protocol rejects null). Prefer an explicit
    // --model, else the user's configured default from ~/.codex/config.toml.
    return this.model || readConfiguredModel(this.codexHome || undefined);
  }

  _startTurn(prompt, mode, effort, approvalPolicy) {
    if (this.turn.status === 'running' || this.turn.status === 'awaiting_input') return { error: 'busy' };
    // mode: 'plan' | 'default' | undefined. plan & default set collaborationMode (model required);
    // undefined = plain send (no collaborationMode; inherits the thread's current mode).
    const explicitMode = mode === 'plan' || mode === 'default' ? mode : undefined;
    let model;
    if (explicitMode) {
      model = this._resolveModel();
      if (!model) return { error: 'no_model_for_mode' };
    }
    let params;
    try {
      params = buildTurnStart({ threadId: this.threadId, text: prompt, mode: explicitMode, effort, model, approvalPolicy });
    } catch (e) {
      return { error: e.message };
    }
    // isPlan marks THIS turn as plan-producing (explicit `mode:'plan'`). The plan stream is preferred at
    // turn end ONLY for such turns — a plain `send` (a review, or a send in a thread that earlier ran a
    // plan) is NOT plan-producing, so a review's internal-checklist item/plan/delta can't shadow its
    // agentMessage/VERDICT. (plan-round's static re-ask therefore issues an explicit `plan` turn, not a
    // bare `send`.) Per-turn, so a rejected start can never desync it from the server thread.
    this._beginTurn({ isPlan: explicitMode === 'plan' });
    this._sendStart(METHODS.TURN_START, params, 'turn/start');
    return { ok: true, status: 'running' };
  }

  // Native git-scoped review. Mirrors _startTurn's lifecycle; the scope is resolved and validated
  // SYNCHRONOUSLY so a bad --base is a plain command error with the turn state untouched, rather than
  // a daemon boot plus a full Codex turn that ends in an unexplained blank review.
  _startReview(base, scope) {
    if (this.turn.status === 'running' || this.turn.status === 'awaiting_input') return { error: 'busy' };
    if (!this._hasReviewProfile()) return { error: 'wrong_thread_profile' };
    let resolved, params;
    try {
      resolved = resolveReviewTarget(this.cwd, { base, scope });
      params = buildReviewStart({ threadId: this.threadId, target: buildNativeReviewTarget(resolved) });
    } catch (e) {
      return { error: e.message };
    }
    this._beginTurn({ isReview: true });
    this._sendStart(METHODS.REVIEW_START, params, 'review/start', resolved);
    return { ok: true, status: 'running', scope: resolved.label };
  }

  // A review may only run on a thread we STARTED with the review profile. A resumed thread carries
  // whatever profile it was born with and we cannot re-profile it, so resume is never eligible.
  _hasReviewProfile() {
    if (this.resume || !this.profile) return false;
    return REVIEW_PROFILE.sandbox === this.profile.sandbox
      && REVIEW_PROFILE.approvalPolicy === this.profile.approvalPolicy
      && this.profile.ephemeral === true;
  }

  _beginTurn(extra) {
    this._clearBackstop();
    this._gen += 1;
    // awaitingResponse gates the notification path: everything that arrives before the response is
    // buffered, so nothing can be attributed to (or finalise) a turn whose id we don't yet know.
    this.turn = this._freshTurn({ status: 'running', awaitingResponse: true, ...extra });
  }

  // Send a turn-starting RPC and wire up its response WITHOUT awaiting it.
  //
  // Awaiting would be worse than useless: JsonRpc.feed() drains a whole stdout chunk SYNCHRONOUSLY
  // while a resolved response only schedules a microtask, so later notifications in that same chunk
  // still run first — awaiting fixes no ordering. It would also withhold this command's reply while
  // sendCommand has no default timeout. Buffering (not awaiting) is what actually orders things.
  _sendStart(method, params, label, resolved = null) {
    const gen = this._gen;
    this.app.request(method, params).then(
      (res) => this._onStartResponse(gen, res, label, resolved),
      (err) => {
        // Generation check: a late rejection from a superseded turn must never touch live state.
        if (this.turn.gen !== gen) return;
        // Status guard mirrors _onAppExit's: if the app already died, that failure message wins.
        if (this.turn.status === 'running' || this.turn.status === 'awaiting_input') {
          this.turn.awaitingResponse = false;
          this.turn.buffered = [];
          this._clearBackstop();
          this.turn.status = 'failed';
          this.turn.message = `${label} failed: ${err.message}`;
          this._resolveWaiters();
        }
      },
    );
  }

  // The response is the SOLE source of turn.id — for every turn kind. Live-verified against
  // codex-cli 0.144.5: for turn/start the response id, turn/started, turn/completed and every
  // item/completed all agree; but for review/start, turn/started announces a DIFFERENT id while
  // turn/completed and item/completed carry the RESPONSE's id. Adopting turn/started's id (as this
  // daemon used to) therefore makes _isStaleTurn drop the review's own completion and hang `wait`
  // forever. There is deliberately NO "ids disagree -> fail" rule: for reviews they legitimately do.
  _onStartResponse(gen, res, label, resolved) {
    if (this.turn.gen !== gen) return;                 // superseded turn: log-and-drop
    if (!this.turn.awaitingResponse) return;           // already resolved by the backstop or an exit
    const id = res && res.turn && res.turn.id;
    if (!id) return this._failTurn(`${label} response carried no turn id`);
    // delivery:'inline' means the review runs on the requesting thread. Live-confirmed, but validated
    // at runtime anyway: a foreign reviewThreadId would mean we are about to attribute someone else's
    // review to this session. STRICT equality — a missing/blank value must fail too, not sail through
    // a truthiness guard: "we couldn't tell whose review this is" is not a reason to accept it.
    if (resolved && res.reviewThreadId !== this.threadId) {
      return this._failTurn(`${label} returned an unusable reviewThreadId (${JSON.stringify(res.reviewThreadId)})`);
    }
    this.turn.id = id;
    this.turn.awaitingResponse = false;
    this._clearBackstop();
    // Replay in arrival order, now that the id is known and the stale filter can do its job.
    // Server requests replay through the same path they'd have taken live, so a stale one is
    // declined-and-answered rather than parked.
    const pending = this.turn.buffered;
    this.turn.buffered = [];
    for (const [m, p] of pending) {
      if (m === '__serverRequest') this._onServerRequest(p);
      else this._dispatchNotification(m, p);
    }
  }

  // A turn that ends is OVER. Without `finalized`, failing a turn left turn.id null, so _isStaleTurn
  // (which needs a truthy turn.id) filtered nothing and the server's still-streaming notifications
  // walked the turn from `failed` back to `completed` — handing back the very review text we rejected.
  // Probed: mismatched reviewThreadId -> failed -> late exitedReviewMode + turn/completed -> completed.
  _failTurn(message) {
    this.turn.awaitingResponse = false;
    this.turn.buffered = [];
    this._clearBackstop();
    this.turn.status = 'failed';
    this.turn.message = message;
    this.turn.finalized = true;
    this._resolveWaiters();
  }

  // Armed ONLY when a turn/completed is buffered — i.e. the turn finished but the response that
  // authorises us to read it never came. Never armed at RPC send: a response can legitimately take a
  // moment, and a 5s cap there would fail healthy turns.
  _armResponseBackstop() {
    if (this.turn.backstop) return;
    const gen = this._gen;
    const t = setTimeout(() => {
      if (this.turn.gen !== gen || !this.turn.awaitingResponse) return;
      // Drop the buffer: a completed-but-never-validated review must NEVER be released as clean.
      this._failTurn('turn completed but the start response never arrived (unvalidated)');
    }, RESPONSE_BACKSTOP_MS);
    t.unref?.();   // never hold the process open on a backstop
    this.turn.backstop = t;
  }

  _clearBackstop() {
    if (this.turn && this.turn.backstop) { clearTimeout(this.turn.backstop); this.turn.backstop = null; }
  }

  _wait() {
    if (this.turn.status === 'awaiting_input') return Promise.resolve(this._parkedResult());
    if (['completed', 'interrupted', 'failed', 'idle'].includes(this.turn.status)) {
      return Promise.resolve(this._terminalResult());
    }
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  _terminalResult() { return this._completedResult(); }
  // Terminal/read result. Flags a `completed` turn whose final message is empty/whitespace-only as
  // `empty:true` so the orchestrator can deterministically detect a malformed (no-content) Codex turn
  // instead of treating it as a valid-but-empty plan/review.
  _completedResult() {
    const res = { status: this.turn.status, message: this.turn.message };
    const blank = !(this.turn.message && String(this.turn.message).trim());
    if (this.turn.status === 'completed' && blank) res.empty = true;
    return res;
  }
  _parkedResult() {
    const p = this.turn.parked;
    if (p.kind === 'question') return { status: 'question', question: p.params };
    if (p.kind === 'approval') return { status: 'approval', request: { method: p.method, params: p.params } };
    // elicitation / unknown: not answerable by this client — surface as unsupported so the
    // orchestrator interrupts rather than sending a wrong-shaped answer.
    return { status: 'unsupported', request: { method: p.method, params: p.params } };
  }

  _resolveWaiters() {
    const result = this.turn.status === 'awaiting_input' ? this._parkedResult() : this._terminalResult();
    const ws = this._waiters; this._waiters = [];
    ws.forEach((r) => r(result));
  }

  async _answer(questionId, answers) {
    if (this.turn.status !== 'awaiting_input' || !this.turn.parked || this.turn.parked.kind !== 'question') {
      return { error: 'no_pending_question' };
    }
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

  async _approve(decision) {
    if (this.turn.status !== 'awaiting_input' || !this.turn.parked || this.turn.parked.kind !== 'approval') {
      return { error: 'no_pending_approval' };
    }
    const p = this.turn.parked;
    let response;
    try {
      response = buildApprovalResponse(decision, p.method);
    } catch (e) {
      return { error: e.message };
    }
    this.app.respond(p.id, response);
    this.turn.parked = null;
    this.turn.status = 'running';
    return { ok: true };
  }

  async _interrupt() {
    if (!this.turn.id) return { error: 'no_active_turn' };
    await this.app.request(METHODS.TURN_INTERRUPT, { threadId: this.threadId, turnId: this.turn.id });
    return { ok: true };
  }

  // Ignore notifications from any turn other than the active one — a late delta/completion from
  // a previous or interrupted turn must not corrupt or prematurely finish the current turn.
  _isStaleTurn(turnId) {
    return this.turn.id && turnId && turnId !== this.turn.id;
  }

  // Same leniency as _isStaleTurn, and deliberately so: the AppServer forwards every notification
  // unfiltered, but a STRICT form (rejecting anything without a threadId) would drop real traffic.
  // This exists for delegated/subagent threads, which `ultra` effort actively creates.
  _isForeignThread(threadId) {
    return this.threadId && threadId && threadId !== this.threadId;
  }

  // The turn's text is assembled from streamed deltas, with the authoritative final item text from
  // item/completed preferred when present. TWO content channels matter:
  //   - item/agentMessage/delta  → the chat/answer/review stream (this.turn.buffer)
  //   - item/plan/delta          → Plan-mode's actual PLAN stream (this.turn.planBuffer)
  // In Plan mode Codex narrates its reasoning via agentMessage but emits the real file-by-file plan via
  // item/plan/delta and a final item/completed{item.type:'plan'}. Listening to agentMessage alone
  // captured only the "I'll inspect…" preamble and DROPPED the plan — so we capture both and, at turn
  // end, prefer the plan text when there is one (else fall back to the agentMessage buffer for reviews).
  // Gate: until the start response lands we do not know this turn's id, so nothing can be safely
  // attributed to it — buffer everything and replay after the id is known. This is what makes the
  // ordering sound; it also subsumes the "completion barrier" idea, because a turn/completed that
  // arrives early is simply buffered and cannot finalise anything.
  _onNotification(method, params) {
    // Drop foreign traffic at the door, before it can be buffered or arm anything. The AppServer
    // forwards every notification unfiltered, including delegated/subagent threads.
    if (params && this._isForeignThread(params.threadId)) return;
    if (this.turn.awaitingResponse) {
      this.turn.buffered.push([method, params]);
      // The turn is already over but the response that authorises reading it hasn't arrived. We can
      // no longer assume it ever will, so bound the wait rather than hanging `wait` forever.
      // Only a SUCCESSFUL completion needs the response: interrupted/failed are already fail-closed
      // and carry nothing we would have had to validate.
      if (method === NOTIFY.TURN_COMPLETED && params && params.turn && params.turn.status === 'completed') {
        this._armResponseBackstop();
      }
      return;
    }
    this._dispatchNotification(method, params);
  }

  _dispatchNotification(method, params) {
    // A finalized turn is OVER. The server keeps streaming after we reject a turn, and without this
    // a failed turn walks back to `completed` carrying the text we just refused.
    if (this.turn.finalized) return;
    // Foreign-thread filter, applied to every kind: delegated/subagent threads emit their own
    // lifecycle, and adopting any of it would attribute another thread's work to this turn.
    if (params && this._isForeignThread(params.threadId)) return;

    if (method === NOTIFY.TURN_STARTED) {
      // Deliberately NOT a source of turn.id — see _onStartResponse. For a review, turn/started's id
      // is not the id anything else uses; adopting it drops the review's own completion.
      return;
    } else if (method === NOTIFY.AGENT_MESSAGE_DELTA) {
      if (this._isStaleTurn(params.turnId)) return;
      if (typeof params.delta === 'string') this.turn.buffer += params.delta;
    } else if (method === NOTIFY.PLAN_DELTA) {
      if (this._isStaleTurn(params.turnId)) return;
      if (typeof params.delta === 'string') this.turn.planBuffer += params.delta;
    } else if (method === NOTIFY.ITEM_COMPLETED) {
      // Authoritative final text for an item. Capture the completed PLAN item (and a plan delivered as
      // an agentMessage, just in case). item/completed often omits turnId, so guard leniently.
      if (this._isStaleTurn(params.turnId)) return;
      const item = (params && params.item) || {};
      if (item.type === 'plan' && typeof item.text === 'string' && item.text.trim()) this.turn.planText = item.text;
      // The review's verdict text. It goes to its OWN field, never turn.message: the TURN_COMPLETED
      // handler below rebuilds turn.message unconditionally and would clobber it.
      // (item.type === REVIEW_ITEM.ENTERED also fires, earlier in the turn — nothing to capture.)
      if (item.type === REVIEW_ITEM.EXITED && typeof item.review === 'string') this.turn.reviewText = item.review;
    } else if (method === NOTIFY.TURN_COMPLETED) {
      const completedId = params.turn && params.turn.id;
      if (this._isStaleTurn(completedId)) return;
      const status = params.turn ? params.turn.status : 'completed';
      this.turn.status = status === 'completed' ? 'completed' : status;
      // In PLAN mode prefer the captured plan (authoritative completed item, else streamed deltas); in
      // any other mode (e.g. a review `send`) use the agentMessage stream — a review's internal-checklist
      // item/plan/delta must NOT shadow the actual review + VERDICT line.
      const plan = this.turn.isPlan
        ? ((this.turn.planText && this.turn.planText.trim()) ? this.turn.planText
          : ((this.turn.planBuffer && this.turn.planBuffer.trim()) ? this.turn.planBuffer : ''))
        : '';
      if (this.turn.isReview) {
        // A native review's content NEVER comes from the agent-message stream, so falling back to it
        // would present narration as the review. Blank => failed, never completed-with-empty: the
        // gate reads a clean-looking empty review as "ship it".
        const text = this.turn.reviewText;
        if (this.turn.status === 'completed' && !(text && text.trim())) {
          this.turn.status = 'failed';
          this.turn.message = 'review completed without any review text';
        } else {
          this.turn.message = text || '';
        }
      } else {
        this.turn.message = plan || this.turn.buffer;
      }
      this.turn.finalized = true;   // terminal: later notifications for this turn are noise
      this._clearBackstop();
      this._resolveWaiters();
    }
  }

  _onAppExit(info) {
    // The codex app-server died. Pending RPCs were already rejected by AppServer; here we make
    // sure an in-flight turn (and anyone blocked on `wait`) resolves instead of hanging forever.
    this._appExited = true;
    if (this.turn.status === 'running' || this.turn.status === 'awaiting_input') {
      this.turn.awaitingResponse = false;   // nothing more is coming; stop buffering
      this.turn.buffered = [];
      this._clearBackstop();
      this.turn.status = 'failed';
      this.turn.message = `codex app-server exited${info && info.code != null ? ` (code=${info.code})` : ''}`;
      this.turn.parked = null;
      this.turn.finalized = true;
      this._resolveWaiters();
    }
  }

  // Park a request only if it belongs to THIS thread's current turn. Anything else must still be
  // ANSWERED — an unanswered JSON-RPC request breaks the request/response contract and can wedge the
  // turn that issued it — but it must never park ours (which would strand `wait` on a foreign prompt).
  _onServerRequest(req) {
    const p = req.params || {};
    // Server requests must respect the SAME response barrier as notifications. While turn.id is
    // unknown, _isStaleTurn cannot judge them (it needs a truthy turn.id), so a stale same-thread
    // request would park our fresh turn on someone else's prompt. Buffer and replay instead.
    if (this.turn.awaitingResponse && !this._isForeignThread(p.threadId)) {
      this.turn.buffered.push(['__serverRequest', req]);
      return;
    }
    const foreign = this._isForeignThread(p.threadId) || this._isStaleTurn(p.turnId);
    const c = classifyServerRequest(req.method, req.params);
    if (foreign) {
      // Decline in the request's own shape when we know it; otherwise a deterministic JSON-RPC error.
      if (c.kind === 'approval') {
        try { return this.app.respond(req.id, buildApprovalResponse('deny', req.method)); } catch { /* fall through */ }
      }
      return this.app.respondError(req.id, -32600, 'request does not belong to this session');
    }
    this.turn.parked = { id: req.id, kind: c.kind, method: req.method, params: req.params };
    this.turn.status = 'awaiting_input';
    this._resolveWaiters();
  }

  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._clearBackstop();
    // Best-effort unsubscribe — skip if the app already died (a fresh request would never resolve),
    // and race a timeout so a stuck server can't hang shutdown.
    if (!this._appExited && this.threadId && this.app) {
      const timeout = new Promise((r) => setTimeout(r, 500));
      try { await Promise.race([this.app.request(METHODS.THREAD_UNSUBSCRIBE, { threadId: this.threadId }), timeout]); } catch {}
    }
    if (this.app) await this.app.stop();
    // Destroy any lingering client connections so server.close() doesn't wait on them.
    for (const s of this._sockets) { try { s.destroy(); } catch {} }
    this._sockets.clear();
    if (this.server) await new Promise((r) => this.server.close(r));
    if (existsSync(this.socketPath)) { try { unlinkSync(this.socketPath); } catch {} }
  }
}
