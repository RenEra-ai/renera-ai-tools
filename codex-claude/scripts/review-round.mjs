// Dogfood driver: use codex-drive to get ONE Codex review of the on-disk code, then exit.
// Run from the repo root so the spawned `codex app-server` sees this project as cwd.
// Auto-answers any clarifying question (first option) and DECLINES any command approval
// (a review should only need to read files, which full-access allows without prompting).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Daemon } from '../lib/daemon.mjs';
import { sendCommand } from '../lib/client.mjs';

const prompt = process.argv[2];
if (!prompt) { console.error('usage: review-round.mjs "<prompt>"'); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'cdx-review-'));
const socketPath = join(dir, 'r.sock');
const daemon = new Daemon({ socketPath, clientInfo: { name: 'codex-drive', version: '0.1.0' } });
await daemon.start();

await sendCommand(socketPath, { cmd: 'send', prompt });

let res = await sendCommand(socketPath, { cmd: 'wait' });
let guard = 0;
while ((res.status === 'question' || res.status === 'approval') && guard++ < 20) {
  if (res.status === 'approval') {
    process.stderr.write(`[driver] declining approval: ${res.request.method}\n`);
    await sendCommand(socketPath, { cmd: 'approve', decision: 'deny' });
  } else {
    const q = res.question.questions[0];
    const first = q.options && q.options[0];
    const answer = first == null ? 'proceed' : (typeof first === 'string' ? first : first.label);
    process.stderr.write(`[driver] answering question ${q.id} -> ${answer}\n`);
    await sendCommand(socketPath, { cmd: 'answer', id: q.id, answers: [answer] });
  }
  res = await sendCommand(socketPath, { cmd: 'wait' });
}

console.log('STATUS: ' + res.status);
console.log('=== REVIEW ===');
console.log(res.message || '(empty)');
await daemon.stop();
process.exit(0);
