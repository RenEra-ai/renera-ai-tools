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
      const err = new Error(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? `no daemon at ${socketPath}` : e.message);
      // Keep the original code: callers must be able to tell "nothing is listening there" (the
      // session really is gone) from every other failure. `start` decides whether it may replace
      // the recorded session on exactly that distinction, and a message-sniffing test would be a
      // far more fragile place to make it.
      if (e && e.code) err.code = e.code;
      reject(err);
    });
  });
}
