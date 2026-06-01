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

  async stop() {
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
  }
}
