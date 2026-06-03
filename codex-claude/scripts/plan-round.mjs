// Ephemeral Plan-mode driver: boot a PRIVATE-socket Codex daemon (not the shared ~/.codex-drive
// session), run ONE Plan-mode architect turn, auto-answer any clarifying question (first option) and
// decline any approval (Plan mode is read-only), print the plan, and exit. Used by the codex-wrap
// workflow's "architect plan" phase. Mirrors review-round.mjs but in Plan mode (needs a model).
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daemon } from '../lib/daemon.mjs';
import { sendCommand } from '../lib/client.mjs';
import { readConfiguredModel } from '../lib/config.mjs';

// Prefer --prompt-file (avoids shell-quoting/injection from issue/plan text with backticks, $(), quotes).
const pf = process.argv.indexOf('--prompt-file');
const prompt = pf >= 0 ? readFileSync(process.argv[pf + 1], 'utf8') : process.argv[2];
if (!prompt) { console.error('usage: plan-round.mjs ("<prompt>" | --prompt-file <path>) [--model <m>] [--effort <e>]'); process.exit(1); }
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

// Bounded wait: a client-side cap (under the ~10-min Bash cap) so a wedged Codex turn can't hang the
// driver forever; on timeout, interrupt the turn and surface status:'timeout'.
const WAIT_TIMEOUT_MS = 540000;
async function driveWait() {
  try {
    return await sendCommand(socketPath, { cmd: 'wait' }, { timeoutMs: WAIT_TIMEOUT_MS });
  } catch (e) {
    if (!/timeout/i.test(e.message)) throw e;
    process.stderr.write('[plan] wait timed out — interrupting the turn\n');
    try { await sendCommand(socketPath, { cmd: 'interrupt' }, { timeoutMs: 10000 }); } catch {}
    return { status: 'timeout', message: '' };
  }
}

let res = { status: 'failed', message: '' };
try {
  await sendCommand(socketPath, { cmd: 'plan', prompt, effort });
  res = await driveWait();
  let guard = 0;
  while ((res.status === 'question' || res.status === 'approval') && guard++ < 20) {
    if (res.status === 'approval') {
      process.stderr.write(`[plan] declining approval: ${res.request.method}\n`);
      await sendCommand(socketPath, { cmd: 'approve', decision: 'deny' });
    } else {
      const qs = res.question && res.question.questions;
      if (!Array.isArray(qs) || qs.length === 0) { process.stderr.write('[plan] malformed question payload — stopping\n'); break; }
      const q = qs[0];
      const first = q.options && q.options[0];
      const answer = first == null ? 'proceed' : (typeof first === 'string' ? first : first.label);
      process.stderr.write(`[plan] answering question ${q.id} -> ${answer}\n`);
      await sendCommand(socketPath, { cmd: 'answer', id: q.id, answers: [answer] });
    }
    res = await driveWait();
  }
} finally {
  // ALWAYS tear down the ephemeral daemon — even on timeout/error — so it never orphans a codex app-server.
  await daemon.stop();
}

console.log('STATUS: ' + res.status + (res.empty ? ' (empty)' : ''));
console.log('=== PLAN ===');
console.log(res.message || '(empty)');
process.exit(0);
