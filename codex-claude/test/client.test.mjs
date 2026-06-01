import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
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

test('sendCommand rejects with timeout when the server never replies', { timeout: 5000 }, async () => {
  // Bare server that accepts the connection but never writes a response line.
  const dir = mkdtempSync(join(tmpdir(), 'cdx-to-'));
  const socketPath = join(dir, 'silent.sock');
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const conns = new Set();
  const server = createServer((s) => { conns.add(s); s.on('close', () => conns.delete(s)); });
  await new Promise((r) => server.listen(socketPath, r));
  await assert.rejects(sendCommand(socketPath, { cmd: 'wait' }, { timeoutMs: 200 }), /timeout/i);
  for (const s of conns) s.destroy(); // so server.close() doesn't hang on the lingering connection
  await new Promise((r) => server.close(r));
});
