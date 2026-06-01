import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daemon } from '../lib/daemon.mjs';
import { sendCommand } from '../lib/client.mjs';

const LIVE = process.env.CODEX_DRIVE_LIVE === '1';

test('live: send a trivial turn and read the reply', { skip: !LIVE, timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-live-'));
  const socketPath = join(dir, 't.sock');
  const daemon = new Daemon({ socketPath, clientInfo: { name: 'codex-drive', version: '0.1.0' } });
  await daemon.start();
  await sendCommand(socketPath, { cmd: 'send', prompt: 'Reply with exactly: OK' });
  const res = await sendCommand(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'completed');
  assert.match(res.message, /OK/);
  await daemon.stop();
});

test('live: plan mode produces a plan', { skip: !LIVE, timeout: 180000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-live2-'));
  const socketPath = join(dir, 't.sock');
  // No --model: the daemon resolves the model from ~/.codex/config.toml for plan mode.
  const daemon = new Daemon({ socketPath, clientInfo: { name: 'codex-drive', version: '0.1.0' } });
  await daemon.start();
  await sendCommand(socketPath, { cmd: 'plan', prompt: 'Plan how to add a /healthz endpoint to a small Express app. Do not write code.', effort: 'medium' });
  let res = await sendCommand(socketPath, { cmd: 'wait' });
  // If Codex asks a clarifying question, answer the first option and continue. Real options
  // are objects { label, description }; answer with the label string.
  while (res.status === 'question') {
    const q = res.question.questions[0];
    const first = q.options && q.options[0];
    const answer = first == null ? 'proceed' : (typeof first === 'string' ? first : first.label);
    await sendCommand(socketPath, { cmd: 'answer', id: q.id, answers: [answer] });
    res = await sendCommand(socketPath, { cmd: 'wait' });
  }
  assert.equal(res.status, 'completed');
  assert.ok(res.message.length > 0);
  await daemon.stop();
});

test('live: a command approval can be declined and the turn completes (nothing executes)', { skip: !LIVE, timeout: 120000 }, async () => {
  const probeFile = join(tmpdir(), 'codex_drive_live_decline_probe');
  rmSync(probeFile, { force: true });
  const dir = mkdtempSync(join(tmpdir(), 'cdx-live3-'));
  const socketPath = join(dir, 't.sock');
  const daemon = new Daemon({ socketPath, clientInfo: { name: 'codex-drive', version: '0.1.0' } });
  await daemon.start();
  // approvalPolicy:"untrusted" forces an approval prompt for the command (config is full-access).
  await sendCommand(socketPath, { cmd: 'send', approvalPolicy: 'untrusted',
    prompt: `Use your shell tool to actually run exactly this command: touch ${probeFile}` });
  let res = await sendCommand(socketPath, { cmd: 'wait' });
  let guard = 0;
  while ((res.status === 'approval' || res.status === 'question') && guard++ < 6) {
    if (res.status === 'approval') {
      await sendCommand(socketPath, { cmd: 'approve', decision: 'deny' }); // decline → nothing runs
    } else {
      const q = res.question.questions[0];
      const first = q.options && q.options[0];
      const answer = first == null ? 'no' : (typeof first === 'string' ? first : first.label);
      await sendCommand(socketPath, { cmd: 'answer', id: q.id, answers: [answer] });
    }
    res = await sendCommand(socketPath, { cmd: 'wait' });
  }
  assert.equal(res.status, 'completed');
  assert.equal(existsSync(probeFile), false); // declined → the command never executed
  await daemon.stop();
});
