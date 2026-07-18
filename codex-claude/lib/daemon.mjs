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
export const REVIEW_PROFILE = { sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true };

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
    // SESSION state (not per-turn). When a turn ends locally while its authoritative id is still
    // unknown, the server may keep streaming for a turn we can never identify — and _isStaleTurn
    // needs a truthy turn.id to judge anything. Rather than let that orphan's traffic be attributed
    // to a later turn, the session refuses new turns until it is restarted. Fail-closed and honest.
    this.restartRequired = false;
    this.restartReason = null;
    // The last id we ever learned authoritatively. A completion carrying THIS id belongs to the
    // previous turn, so it can be dropped even while the current turn's id is still unknown — the
    // pre-response stale filter that _isStaleTurn cannot provide.
    this._lastTurnId = null;
  }

  _freshTurn(extra = {}) {
    return {
      id: null, status: 'idle', buffer: '', planBuffer: '', planText: null, parked: null,
      message: null, isPlan: false, isReview: false, reviewText: null,
      gen: this._gen, awaitingResponse: false, buffered: [], backstop: null, finalized: false,
      cancelRequested: false,
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
      case 'status': return {
        threadId: this.threadId, turnStatus: this.turn.status,
        parked: this.turn.parked ? this.turn.parked.kind : null, cwd: this.cwd,
        restartRequired: this.restartRequired,
        ...(this.restartRequired ? { restartReason: this.restartReason } : {}),
      };
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
    if (this._appExited) return { error: 'app_server_exited' };
    if (this.restartRequired) return { error: 'restart_required', reason: this.restartReason };
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
    // The transport is gone: AppServer already rejected every pending RPC, so a new turn would be
    // written into a dead pipe and then wait forever for a response nobody will send.
    if (this._appExited) return { error: 'app_server_exited' };
    // Profile first: it is STRUCTURAL — a thread cannot be re-profiled, so restarting would not help.
    // Reporting restart_required here would send the caller off to do something that cannot work.
    if (!this._hasReviewProfile()) return { error: 'wrong_thread_profile' };
    if (this.restartRequired) return { error: 'restart_required', reason: this.restartReason };
    let resolved, params;
    try {
      resolved = resolveReviewTarget(this.cwd, { base, scope });
      params = buildReviewStart({ threadId: this.threadId, target: buildNativeReviewTarget(resolved) });
    } catch (e) {
      return { error: e.message };
    }
    this._beginTurn({ isReview: true });
    this._sendStart(METHODS.REVIEW_START, params, 'review/start');
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
    // Defensive: the busy guard should make this unreachable, but the turn object is replaced on the
    // next line and with it the only reference to anything still parked — which is exactly how a
    // server request came to be dropped unanswered.
    this._settleOutstandingRequests();
    // Remember the outgoing turn's id so a straggling completion for it can be recognised as stale
    // during the next turn's pre-response window, when _isStaleTurn has no id to work with.
    if (this.turn.id) this._lastTurnId = this.turn.id;
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
  _sendStart(method, params, label) {
    const gen = this._gen;
    this.app.request(method, params).then(
      (res) => this._onStartResponse(gen, res, label),
      (err) => {
        // Generation check: a late rejection from a superseded turn must never touch live state.
        if (this.turn.gen !== gen) return;
        // Status guard mirrors _onAppExit's: if the app already died, that failure message wins.
        if (this.turn.status === 'running' || this.turn.status === 'awaiting_input') {
          // Through the finalizer, so `finalized` is set: the server keeps streaming after it
          // rejects a turn, and without that flag a late exitedReviewMode + turn/completed walked
          // this very turn back to `completed`, carrying the text we just refused.
          //
          // NOT quarantined: an error RESPONSE means the server never created a turn at all, so
          // there is no orphan to be confused by later. Quarantining here would turn an ordinary
          // recoverable rejection (a bad --base, a rejected approvalPolicy) into a session that
          // demands a restart.
          this._finalizeTurn(`${label} failed: ${err.message}`);
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
  _onStartResponse(gen, res, label) {
    const lateId = res && res.turn && res.turn.id;
    if (this.turn.gen !== gen) return;                 // superseded turn: log-and-drop
    if (!this.turn.awaitingResponse) {
      // The turn already ended (backstop, app exit, an immediate failed completion, or an explicit
      // interrupt) and only now do we learn its id. Record it so the orphan's later traffic can be
      // recognised as stale, and cancel it server-side ONLY if a cancel was actually requested —
      // spec: a late superseded response is otherwise simply dropped, not acted on.
      if (lateId) this._lastTurnId = lateId;
      if (lateId && this.turn.cancelRequested && !this._appExited) {
        // Synchronous try AS WELL as .catch: JsonRpc.request throws synchronously once the child's
        // stdin is gone, and this runs in exactly the teardown window where that happens.
        try { this.app.request(METHODS.TURN_INTERRUPT, { threadId: this.threadId, turnId: lateId }).catch(() => {}); }
        catch { /* transport already gone — the turn dies with the app */ }
      }
      return;
    }
    if (!lateId) {
      // No id at all: a server turn may well be running that we can never name again.
      return this._finalizeTurn(`${label} response carried no turn id`, { quarantine: true });
    }
    // Adopt the id BEFORE any validation that can fail. The reviewThreadId gate below used to run
    // first, so a foreign-thread failure finalized with turn.id still null — throwing away the very
    // id that makes _isStaleTurn work, and (once quarantine existed) bricking a session that had
    // everything it needed to stay honest.
    this.turn.id = lateId;
    this._lastTurnId = lateId;
    // delivery:'inline' means the review runs on the requesting thread. Live-confirmed, but validated
    // at runtime anyway: a foreign reviewThreadId would mean we are about to attribute someone else's
    // review to this session. STRICT equality — a missing/blank value must fail too, not sail through
    // a truthiness guard: "we couldn't tell whose review this is" is not a reason to accept it.
    // Gated on the turn's OWN recorded kind, not on an optional side-channel argument that a future
    // call path could forget to thread through.
    if (this.turn.isReview && res.reviewThreadId !== this.threadId) {
      return this._finalizeTurn(`${label} returned an unusable reviewThreadId (${JSON.stringify(res.reviewThreadId)})`);
    }
    this.turn.awaitingResponse = false;
    this._clearBackstop();
    // Replay in arrival order, now that the id is known and the stale filter can do its job.
    // Notifications go back through _onNotification — NOT straight to _dispatchNotification — so the
    // params and foreign-thread guards there really are the single authoritative filter rather than
    // one that replayed traffic quietly bypasses. awaitingResponse is already false, so nothing
    // re-buffers. Server requests replay through the path they'd have taken live, so a stale one is
    // declined-and-answered rather than parked.
    const pending = this.turn.buffered;
    this.turn.buffered = [];
    for (const [m, p] of pending) {
      if (m === '__serverRequest') this._onServerRequest(p);
      else this._onNotification(m, p);
    }
  }

  // THE single terminal writer. Every non-`completed` ending goes through here, so "a new failure
  // path forgot to set finalized" is not expressible — which is the bug class that let a rejected
  // turn walk back to `completed`: _isStaleTurn needs a truthy turn.id, so with none it filtered
  // nothing and the server's still-streaming notifications resurrected the turn, handing back the
  // very review text we had just refused.
  //
  // Two policies, because the call sites genuinely differ:
  //  - settleRequests: answer everything the server is still waiting on. FALSE only when the
  //    transport is dead (app exit) — see _onAppExit.
  //  - quarantine: this ending leaves an orphan turn we can never identify. TRUE only where a
  //    server-side turn really exists but its id never reached us. Inferring it from `!turn.id`
  //    would be wrong in both directions: a rejected start has no server turn at all (nothing to
  //    confuse us later), while the reviewThreadId gate runs before turn.id is assigned even though
  //    the response carried a perfectly good id.
  _finalizeTurn(message, { status = 'failed', settleRequests = true, quarantine = false, reason = null } = {}) {
    if (settleRequests) this._settleOutstandingRequests();
    this.turn.parked = null;
    this.turn.awaitingResponse = false;
    this.turn.buffered = [];
    this._clearBackstop();
    this.turn.status = status;
    this.turn.message = message;
    this.turn.finalized = true;
    if (quarantine && !this.restartRequired) {
      this.restartRequired = true;
      this.restartReason = reason || message;
    }
    this._resolveWaiters();
  }

  // Answer ONE server request we are abandoning. Deny approvals in their own shape; anything whose
  // shape we cannot fake (permissions-shaped approvals throw in buildApprovalResponse) gets a
  // deterministic JSON-RPC error. The inner try/fall-through matters: a respond() that throws must
  // still leave a respondError attempt behind, or the request stays unanswered — the exact wedge
  // this helper exists to prevent.
  _answerServerRequest(req) {
    const c = classifyServerRequest(req.method, req.params);
    if (c.kind === 'approval') {
      try { return this.app.respond(req.id, buildApprovalResponse('deny', req.method)); }
      catch { /* unfakeable shape (or a write failure) — fall through to a plain error */ }
    }
    try { this.app.respondError(req.id, -32600, 'request abandoned: the turn ended'); }
    catch { /* transport gone: nothing left to answer with */ }
  }

  // Answer everything the server is still blocked on: the parked request and any that were buffered
  // behind an outstanding start response. IDEMPOTENT by construction — whatever it answers it also
  // removes — so _interrupt settling and a later _finalizeTurn settling again can never emit two
  // responses for one JSON-RPC id.
  //
  // Buffered NOTIFICATIONS are deliberately left in place: only __serverRequest entries are removed,
  // so an interrupt that races an in-flight start response does not discard replayable traffic.
  _settleOutstandingRequests() {
    if (this.turn.parked) {
      const p = this.turn.parked;
      this.turn.parked = null;
      this._answerServerRequest(p);
    }
    if (this.turn.buffered && this.turn.buffered.length) {
      const pending = this.turn.buffered.filter(([m]) => m === '__serverRequest');
      this.turn.buffered = this.turn.buffered.filter(([m]) => m !== '__serverRequest');
      for (const [, req] of pending) this._answerServerRequest(req);
    }
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
      this._finalizeTurn('turn completed but the start response never arrived (unvalidated)', { quarantine: true });
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
    // Judged on whether a turn is RUNNING, not on whether we happen to know its id. The old
    // `!this.turn.id` test refused exactly the case the documented recovery exists for: a turn whose
    // start response never arrived, which is precisely when the caller needs to cancel.
    if (this.turn.status !== 'running' && this.turn.status !== 'awaiting_input') {
      return { error: 'no_active_turn' };
    }
    this.turn.cancelRequested = true;
    // Answer any parked request FIRST, before awaiting anything. The server can withhold
    // turn/completed while its own request sits unanswered, so interrupting with one parked could
    // block on a turn that is itself blocked on us.
    this._settleOutstandingRequests();
    // awaiting_input always implies a parked request; settling cleared it, so the status must move
    // too or _parkedResult would dereference a null parked.
    if (this.turn.status === 'awaiting_input') this.turn.status = 'running';
    if (!this.turn.id) {
      // Nothing addressable server-side yet. End it locally so `wait` resolves and the busy guard
      // lifts; if the response lands later, _onStartResponse cancels it for real (cancelRequested).
      // Quarantined: a server turn probably IS running under an id we will never be able to match,
      // and while turn.id is null _isStaleTurn cannot tell its traffic from a new turn's.
      this._finalizeTurn('interrupted before the turn id was known', {
        status: 'interrupted',
        quarantine: true,
        reason: 'a turn was interrupted before its id was known; this session can no longer tell that turn\'s traffic apart from a new one\'s',
      });
      return { ok: true };
    }
    try {
      await this.app.request(METHODS.TURN_INTERRUPT, { threadId: this.threadId, turnId: this.turn.id });
    } catch (e) {
      // The server refused (or the transport died). We have already settled the parked request and
      // moved off awaiting_input, so leaving the turn `running` would strand `wait` forever and make
      // every later turn answer `busy`. End it locally — we know the id, so no quarantine is needed.
      this._finalizeTurn(`turn/interrupt failed: ${e.message}`, { status: 'interrupted' });
      return { ok: true, interruptFailed: e.message };
    }
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
    // A notification with no params carries nothing attributable. Dropped HERE, above the buffer, so
    // it can never be replayed either — reaching _dispatchNotification threw a TypeError inside the
    // child's stdout data handler, which kills the whole daemon mid-turn.
    if (!params || typeof params !== 'object') return;
    // Drop foreign traffic at the door, before it can be buffered or arm anything. THE single
    // authoritative filter: replay routes back through here rather than round it.
    if (this._isForeignThread(params.threadId)) return;
    if (this.turn.awaitingResponse) {
      if (method === NOTIFY.TURN_COMPLETED && params.turn) {
        // A completion carrying the PREVIOUS turn's id belongs to that turn. While our own id is
        // unknown _isStaleTurn cannot say so, and one review legitimately spans several ids (see
        // _onStartResponse), so without this a straggler could finalise the turn that follows it.
        if (params.turn.id && params.turn.id === this._lastTurnId) return;
        const endStatus = params.turn.status;
        // Only a SUCCESSFUL completion needs the response before it can be read, so it is buffered
        // and bounded by the backstop. failed/interrupted carry nothing to validate and must finalise
        // AT ONCE: buffering them meant a turn that ended badly before its response arrived sat
        // forever — `wait` hung, every later command answered `busy`, and interrupt refused to help.
        if (endStatus === 'failed' || endStatus === 'interrupted') {
          return this._finalizeTurn(`turn ${endStatus} before its start response arrived`, {
            status: endStatus,
            quarantine: true,
            reason: `a turn ended (${endStatus}) before its id was known; this session can no longer tell that turn's traffic apart from a new one's`,
          });
        }
        if (endStatus === 'completed') {
          this.turn.buffered.push([method, params]);
          this._armResponseBackstop();
          return;
        }
      }
      this.turn.buffered.push([method, params]);
      return;
    }
    this._dispatchNotification(method, params);
  }

  _dispatchNotification(method, params) {
    // A finalized turn is OVER. The server keeps streaming after we reject a turn, and without this
    // a failed turn walks back to `completed` carrying the text we just refused.
    if (this.turn.finalized) return;
    // No foreign-thread re-check here: _onNotification is the ONE place that filter lives, and every
    // path into this method — live traffic and replayed buffer entries alike — comes through it.
    // Maintaining a second copy invited a future edit to delete whichever one looked redundant.

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
      // A turn that COMPLETES is just as terminal as one that fails, so it owes the same debts: the
      // server may still be blocked on a request we parked (or buffered), and nothing else will ever
      // answer it once this turn is finalized. Settling here — not only on the failure paths — is
      // what makes "every server request gets exactly one response" hold on the happy path too.
      this._settleOutstandingRequests();
      this.turn.finalized = true;   // terminal: later notifications for this turn are noise
      this._clearBackstop();
      this._resolveWaiters();
    }
  }

  _onAppExit(info) {
    // The codex app-server died. Make sure an in-flight turn (and anyone blocked on `wait`) resolves
    // instead of hanging forever.
    //
    // settleRequests:false is the ONE declared exception to "every server request gets exactly one
    // response": that rule holds only WHILE THE TRANSPORT IS WRITABLE, and the child's stdin is now
    // gone — a respond() here writes into a dead pipe, it does not answer anyone. (AppServer's
    // rejectAll settles our OUTBOUND requests only; inbound ones are simply abandoned with the
    // transport.) Not quarantined either: with no server left there is no orphan turn that could
    // confuse a later one, and the session is finished regardless.
    this._appExited = true;
    if (this.turn.status === 'running' || this.turn.status === 'awaiting_input') {
      this._finalizeTurn(`codex app-server exited${info && info.code != null ? ` (code=${info.code})` : ''}`,
        { settleRequests: false });
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
    // `finalized` belongs in this test: a turn that has ended must never be re-opened by a late
    // request. Without it, parking one walked a completed turn back to `awaiting_input` — the read
    // reported no message and the finished review was lost — and on a failed id-less turn it left
    // the busy guard refusing every new turn while interrupt said there was none.
    const notOurs = this._isForeignThread(p.threadId) || this._isStaleTurn(p.turnId) || this.turn.finalized;
    // Only ONE request can be parked at a time — `parked` is a single slot and `answer`/`approve`
    // address it implicitly. JSON-RPC allows concurrent requests, so a second one used to OVERWRITE
    // the first: its id became unreachable and never got any response (and the client's next answer
    // was applied to the wrong request). Decline the extra one instead of losing it. Same during
    // cancellation: once an interrupt is in flight, re-parking would revive the turn we are ending.
    if (notOurs || this.turn.parked || this.turn.cancelRequested) {
      // Decline through the shared helper: it denies in the request's own shape when it can, falls
      // back to a JSON-RPC error, and — unlike the old inline version, whose respondError was
      // UNCAUGHT — cannot throw out of the stdout data handler and kill the daemon.
      return this._answerServerRequest(req);
    }
    const c = classifyServerRequest(req.method, req.params);
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
