// Ephemeral Plan-mode driver: boot a PRIVATE-socket Codex daemon (not the shared ~/.codex-drive
// session), run ONE Plan-mode architect turn, auto-answer any clarifying question (first option) and
// decline any approval (Plan mode is read-only), print the plan, and exit. Used by the codex-wrap
// workflow's "architect plan" phase. Mirrors review-round.mjs but in Plan mode (needs a model).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daemon } from '../lib/daemon.mjs';
import { sendCommand } from '../lib/client.mjs';
import { readConfiguredModel } from '../lib/config.mjs';

const prompt = process.argv[2];
if (!prompt) { console.error('usage: plan-round.mjs "<prompt>" [--model <m>] [--effort <e>]'); process.exit(1); }
const mi = process.argv.indexOf('--model');
const ei = process.argv.indexOf('--effort');
const model = (mi >= 0 ? process.argv[mi + 1] : null) || readConfiguredModel();
const effort = ei >= 0 ? process.argv[ei + 1] : 'xhigh';
if (!model) {
  console.error('plan-round: Plan mode needs a model — pass --model <name> or set model = "..." in ~/.codex/config.toml');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'cdx-plan-'));
const socketPath = join(dir, 'p.sock');
const daemon = new Daemon({ socketPath, clientInfo: { name: 'codex-drive', version: '0.1.0' }, model });
await daemon.start();

await sendCommand(socketPath, { cmd: 'plan', prompt, effort });

let res = await sendCommand(socketPath, { cmd: 'wait' });
let guard = 0;
while ((res.status === 'question' || res.status === 'approval') && guard++ < 20) {
  if (res.status === 'approval') {
    process.stderr.write(`[plan] declining approval: ${res.request.method}\n`);
    await sendCommand(socketPath, { cmd: 'approve', decision: 'deny' });
  } else {
    const q = res.question.questions[0];
    const first = q.options && q.options[0];
    const answer = first == null ? 'proceed' : (typeof first === 'string' ? first : first.label);
    process.stderr.write(`[plan] answering question ${q.id} -> ${answer}\n`);
    await sendCommand(socketPath, { cmd: 'answer', id: q.id, answers: [answer] });
  }
  res = await sendCommand(socketPath, { cmd: 'wait' });
}

console.log('STATUS: ' + res.status + (res.empty ? ' (empty)' : ''));
console.log('=== PLAN ===');
console.log(res.message || '(empty)');
await daemon.stop();
process.exit(0);
