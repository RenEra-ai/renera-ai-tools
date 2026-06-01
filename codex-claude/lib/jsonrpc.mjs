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

  // Reject every in-flight request — call when the transport dies so callers don't hang forever.
  rejectAll(err) {
    for (const { reject } of this._pending.values()) reject(err);
    this._pending.clear();
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
