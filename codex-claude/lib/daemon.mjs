import { createServer } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import { AppServer } from './appserver.mjs';
import { METHODS, NOTIFY, buildTurnStart, classifyServerRequest, buildQuestionAnswer, buildApprovalResponse } from './protocol.mjs';
import { readConfiguredModel } from './config.mjs';

export class Daemon {
  constructor({ socketPath, appServerOpts = {}, clientInfo, resume = null, model = null, codexHome = null }) {
    this.socketPath = socketPath;
    this.appServerOpts = appServerOpts;
    this.clientInfo = clientInfo;
    this.resume = resume;
    this.model = model;
    this.codexHome = codexHome;
    this.app = null;
    this.server = null;
    this.threadId = null;
    this.turn = { id: null, status: 'idle', buffer: '', planBuffer: '', planText: null, parked: null, message: null };
    this.planMode = false; // thread is in Plan mode (set by a mode:'plan' turn, cleared by mode:'default')
    this._waiters = []; // resolve fns awaiting a terminal/awaiting state
    this._sockets = new Set(); // open client connections (so stop() can tear them down)
    this._stopped = false;
    this._appExited = false;
  }

  async start() {
    this.app = new AppServer(this.appServerOpts);
    await this.app.start();
    this.app.on('notification', (m, p) => this._onNotification(m, p));
    this.app.on('serverRequest', (req) => this._onServerRequest(req));
    this.app.on('exit', (info) => this._onAppExit(info));
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
      case 'wait': return this._wait();
      case 'answer': return this._answer(cmd.id, cmd.answers);
      case 'approve': return this._approve(cmd.decision);
      case 'read': return this._completedResult();
      case 'interrupt': return this._interrupt();
      case 'status': return { threadId: this.threadId, turnStatus: this.turn.status, parked: this.turn.parked ? this.turn.parked.kind : null };
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
    // Track Plan mode across turns: a `plan` turn enters it, a `default` turn exits it, a plain `send`
    // (undefined) inherits the thread's current mode — so plan-round's plain-`send` re-ask stays in plan.
    if (explicitMode === 'plan') this.planMode = true;
    else if (explicitMode === 'default') this.planMode = false;
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
    this.turn = { id: null, status: 'running', buffer: '', planBuffer: '', planText: null, parked: null, message: null };
    // Don't await the response: notifications drive turn state, and awaiting would race
    // turn/completed on a fast server (response + notifications arrive in one stdout burst).
    // But a turn/start REJECTION must be surfaced — otherwise `wait` hangs forever.
    this.app.request(METHODS.TURN_START, params).then(
      () => {},
      (err) => {
        if (this.turn.status === 'running' || this.turn.status === 'awaiting_input') {
          this.turn.status = 'failed';
          this.turn.message = `turn/start failed: ${err.message}`;
          this._resolveWaiters();
        }
      },
    );
    return { ok: true, status: 'running' };
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

  // The turn's text is assembled from streamed deltas, with the authoritative final item text from
  // item/completed preferred when present. TWO content channels matter:
  //   - item/agentMessage/delta  → the chat/answer/review stream (this.turn.buffer)
  //   - item/plan/delta          → Plan-mode's actual PLAN stream (this.turn.planBuffer)
  // In Plan mode Codex narrates its reasoning via agentMessage but emits the real file-by-file plan via
  // item/plan/delta and a final item/completed{item.type:'plan'}. Listening to agentMessage alone
  // captured only the "I'll inspect…" preamble and DROPPED the plan — so we capture both and, at turn
  // end, prefer the plan text when there is one (else fall back to the agentMessage buffer for reviews).
  _onNotification(method, params) {
    if (method === NOTIFY.TURN_STARTED) {
      // Adopt the id of the turn we just started (only while running and not yet identified).
      if (this.turn.status === 'running' && !this.turn.id) {
        this.turn.id = params.turnId || (params.turn && params.turn.id) || null;
      }
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
    } else if (method === NOTIFY.TURN_COMPLETED) {
      const completedId = params.turn && params.turn.id;
      if (this._isStaleTurn(completedId)) return;
      const status = params.turn ? params.turn.status : 'completed';
      this.turn.status = status === 'completed' ? 'completed' : status;
      // In PLAN mode prefer the captured plan (authoritative completed item, else streamed deltas); in
      // any other mode (e.g. a review `send`) use the agentMessage stream — a review's internal-checklist
      // item/plan/delta must NOT shadow the actual review + VERDICT line.
      const plan = this.planMode
        ? ((this.turn.planText && this.turn.planText.trim()) ? this.turn.planText
          : ((this.turn.planBuffer && this.turn.planBuffer.trim()) ? this.turn.planBuffer : ''))
        : '';
      this.turn.message = plan || this.turn.buffer;
      this._resolveWaiters();
    }
  }

  _onAppExit(info) {
    // The codex app-server died. Pending RPCs were already rejected by AppServer; here we make
    // sure an in-flight turn (and anyone blocked on `wait`) resolves instead of hanging forever.
    this._appExited = true;
    if (this.turn.status === 'running' || this.turn.status === 'awaiting_input') {
      this.turn.status = 'failed';
      this.turn.message = `codex app-server exited${info && info.code != null ? ` (code=${info.code})` : ''}`;
      this.turn.parked = null;
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
    if (this._stopped) return;
    this._stopped = true;
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
