import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { JsonRpc } from './jsonrpc.mjs';
import { METHODS } from './protocol.mjs';

export class AppServer extends EventEmitter {
  // `cwd` is forwarded to the child. Without it the app-server inherits THIS process's cwd, which
  // for the in-process drivers (scripts/*-round.mjs) is wherever the caller happened to be — so the
  // review would resolve its scope against one repo while Codex read another.
  constructor({ command = 'codex', args = ['app-server'], spawnFn = spawn, cwd = null } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.spawnFn = spawnFn;
    this.cwd = cwd;
    this.child = null;
    this.rpc = null;
  }

  async start() {
    const opts = { stdio: ['pipe', 'pipe', 'inherit'] };
    if (this.cwd) opts.cwd = this.cwd;
    this.child = this.spawnFn(this.command, this.args, opts);
    this.rpc = new JsonRpc((line) => this.child.stdin.write(line));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this.rpc.feed(d));
    this.rpc.onNotification = (method, params) => this.emit('notification', method, params);
    this.rpc.onServerRequest = (id, method, params) => this.emit('serverRequest', { id, method, params });
    this.child.on('exit', (code, signal) => {
      this.rpc.rejectAll(new Error(`codex app-server exited (code=${code}, signal=${signal})`));
      this.emit('exit', { code, signal });
    });
    // 'error' (e.g. spawn failure) — reject pending and surface via 'exit' (never emit bare 'error',
    // which throws on an EventEmitter with no listener).
    this.child.on('error', (err) => {
      this.rpc.rejectAll(err);
      this.emit('exit', { error: err });
    });
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
  // Needed for server requests we can neither honour nor decline in their own shape (an unknown
  // method, an elicitation). Leaving a JSON-RPC request unanswered violates the request/response
  // contract and can wedge the originating turn, so every request gets SOME response.
  respondError(id, code, message) { this.rpc.respondError(id, code, message); }

  async stop() {
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
  }
}
