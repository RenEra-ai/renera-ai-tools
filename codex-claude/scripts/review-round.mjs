// Dogfood driver: use codex-drive to get ONE Codex review of the on-disk code, then exit.
// Run from the repo root so the spawned `codex app-server` sees this project as cwd.
// Auto-answers any clarifying question (first option) and DECLINES any command approval
// (a review should only need to read files, which full-access allows without prompting).
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Daemon } from '../lib/daemon.mjs';
import { sendCommand } from '../lib/client.mjs';
import { isSafeCommand } from '../lib/safe-command.mjs';

// Prefer --prompt-file (avoids shell-quoting/injection from review/plan text with backticks, $(), quotes).
const pf = process.argv.indexOf('--prompt-file');
const prompt = pf >= 0 ? readFileSync(process.argv[pf + 1], 'utf8') : process.argv[2];
if (!prompt) { console.error('usage: review-round.mjs ("<prompt>" | --prompt-file <path>)'); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'cdx-review-'));
const socketPath = join(dir, 'r.sock');
const daemon = new Daemon({ socketPath, clientInfo: { name: 'codex-drive', version: '0.1.0' } });
await daemon.start();

// Bounded wait: a client-side cap (under the ~10-min Bash cap) so a wedged Codex turn can't hang the
// driver forever; on timeout, interrupt the turn and surface status:'timeout'.
const WAIT_TIMEOUT_MS = 540000;
async function driveWait() {
  try {
    return await sendCommand(socketPath, { cmd: 'wait' }, { timeoutMs: WAIT_TIMEOUT_MS });
  } catch (e) {
    if (!/timeout/i.test(e.message)) throw e;
    process.stderr.write('[driver] wait timed out — interrupting the turn\n');
    try { await sendCommand(socketPath, { cmd: 'interrupt' }, { timeoutMs: 10000 }); } catch {}
    return { status: 'timeout', message: '' };
  }
}

// Drain clarifying questions / command-approval prompts, declining commands (a review only needs to
// read). Records `flags.declinedExec` when a command-exec approval was denied — the same stall the
// plan driver hits (Codex wants to run the tests, can't, then stops before emitting its verdict).
async function drain(res, flags) {
  let guard = 0;
  while ((res.status === 'question' || res.status === 'approval') && guard++ < 20) {
    if (res.status === 'approval') {
      const method = (res.request && res.request.method) || '';
      const params = (res.request && res.request.params) || {};
      const isExec = /commandExecution|execCommand/i.test(method);
      if (isExec && isSafeCommand(params.command)) {
        process.stderr.write(`[driver] approving safe command: ${String(params.command).slice(0, 140)}\n`);
        await sendCommand(socketPath, { cmd: 'approve', decision: 'allow' });
      } else {
        if (isExec) flags.declinedExec = true;   // a DENIED exec is what triggers the static re-ask
        process.stderr.write(`[driver] declining approval: ${method}\n`);
        await sendCommand(socketPath, { cmd: 'approve', decision: 'deny' });
      }
    } else {
      const qs = res.question && res.question.questions;
      if (!Array.isArray(qs) || qs.length === 0) { process.stderr.write('[driver] malformed question payload — stopping\n'); break; }
      const q = qs[0];
      const first = q.options && q.options[0];
      const answer = first == null ? 'proceed' : (typeof first === 'string' ? first : first.label);
      process.stderr.write(`[driver] answering question ${q.id} -> ${answer}\n`);
      await sendCommand(socketPath, { cmd: 'answer', id: q.id, answers: [answer] });
    }
    res = await driveWait();
  }
  return res;
}

const hasVerdict = (m) => /(^|\n)\s*VERDICT:\s*(NO ISSUES|ISSUES FOUND)\s*$/im.test(m || '');

let res = { status: 'failed', message: '' };
const flags = { declinedExec: false };
try {
  await sendCommand(socketPath, { cmd: 'send', prompt });
  res = await driveWait();
  res = await drain(res, flags);
  // Stall recovery: if we DENIED a command approval AND the review ended without a verdict, re-ask
  // ONCE for a static-only review in the SAME session so a denied test-run doesn't yield UNCLEAR.
  if (res.status === 'completed' && flags.declinedExec && !hasVerdict(res.message)) {
    process.stderr.write('[driver] denied a command + no verdict — re-asking for a static-only review\n');
    await sendCommand(socketPath, { cmd: 'send', prompt: 'Approvals are unavailable in this read-only review session — do NOT attempt to run pytest or any command. Complete the review now from static reading only and END with the verdict on its own final line: exactly "VERDICT: NO ISSUES" or "VERDICT: ISSUES FOUND".' });
    let r2 = await driveWait();
    r2 = await drain(r2, flags);
    if (r2.message && r2.message.trim()) res = r2;
  }
} finally {
  // ALWAYS tear down the ephemeral daemon — even on timeout/error — so it never orphans a codex app-server.
  await daemon.stop();
}

// Deterministic verdict: ONLY the FINAL non-empty line may be the verdict (trailing text → UNCLEAR).
const msg = res.message || '';
const lines = msg.split('\n').map((l) => l.trim()).filter(Boolean);
const last = lines.length ? lines[lines.length - 1] : '';
const vm = /^VERDICT:\s*(NO ISSUES|ISSUES FOUND)$/i.exec(last);
const parsed = vm ? vm[1].toUpperCase() : 'UNCLEAR';
console.log('STATUS: ' + res.status + (res.empty ? ' (empty)' : ''));
console.log('PARSED_VERDICT: ' + parsed);
console.log('=== REVIEW ===');
console.log(msg || '(empty)');
process.exit(0);
