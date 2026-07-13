// Ephemeral Plan-mode driver: boot a PRIVATE-socket Codex daemon (not the shared ~/.codex-drive
// session), run ONE Plan-mode architect turn, auto-answer any clarifying question (first option) and
// decline any approval (Plan mode is read-only), print the plan, and exit. Used by the codex-wrap
// workflow's "architect plan" phase. Mirrors review-round.mjs but in Plan mode (needs a model).
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { Daemon } from '../lib/daemon.mjs';
import { sendCommand } from '../lib/client.mjs';
import { readConfiguredModel } from '../lib/config.mjs';
import { isSafeCommand } from '../lib/safe-command.mjs';
import { looksLikeNoPlan, isUsablePlan } from '../lib/plan-output.mjs';

// Prefer --prompt-file (avoids shell-quoting/injection from issue/plan text with backticks, $(), quotes).
const pf = process.argv.indexOf('--prompt-file');
const prompt = pf >= 0 ? readFileSync(process.argv[pf + 1], 'utf8') : process.argv[2];
if (!prompt) { console.error('usage: plan-round.mjs ("<prompt>" | --prompt-file <path>) [--model <m>] [--effort <e>]'); process.exit(1); }
const mi = process.argv.indexOf('--model');
const ei = process.argv.indexOf('--effort');
const oi = process.argv.indexOf('--out');
const outPath = oi >= 0 ? process.argv[oi + 1] : null;   // persist the plan body here when usable
const model = (mi >= 0 ? process.argv[mi + 1] : null) || readConfiguredModel();
const effort = ei >= 0 ? process.argv[ei + 1] : 'ultra';
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

// Drain any clarifying questions / command-approval prompts on the current turn, declining commands
// (Plan mode is read-only). Records into `flags.declinedExec` whether a command-exec approval was
// denied — the classic Plan-mode stall (Codex wants to run pytest, can't, then stops at a preamble).
async function drain(res, flags) {
  let guard = 0;
  while ((res.status === 'question' || res.status === 'approval') && guard++ < 20) {
    if (res.status === 'approval') {
      const method = (res.request && res.request.method) || '';
      const params = (res.request && res.request.params) || {};
      const isExec = /commandExecution|execCommand/i.test(method);
      if (isExec && isSafeCommand(params.command)) {
        process.stderr.write(`[plan] approving safe command: ${String(params.command).slice(0, 140)}\n`);
        await sendCommand(socketPath, { cmd: 'approve', decision: 'allow' });
      } else {
        if (isExec) flags.declinedExec = true;   // a DENIED exec is what triggers the static re-ask
        process.stderr.write(`[plan] declining approval: ${method}\n`);
        await sendCommand(socketPath, { cmd: 'approve', decision: 'deny' });
      }
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
  return res;
}

let res = { status: 'failed', message: '' };
const flags = { declinedExec: false };
try {
  await sendCommand(socketPath, { cmd: 'plan', prompt, effort });
  res = await driveWait();
  res = await drain(res, flags);
  // Stall recovery: if we DENIED a command approval AND the turn ended with only a preamble, re-ask
  // ONCE for a static-only plan in the SAME session (a plain `send` inherits the thread's plan mode,
  // so it stays read-only). This directly counters Codex giving up after it couldn't run pytest.
  if (res.status === 'completed' && flags.declinedExec && looksLikeNoPlan(res.message)) {
    process.stderr.write('[plan] denied a command + thin plan body — re-asking for a static-only plan\n');
    await sendCommand(socketPath, { cmd: 'plan', effort, prompt: 'Approvals are unavailable in this read-only planning session — do NOT attempt to run pytest or any shell command (read-only MCP queries are fine). Output the COMPLETE file-by-file plan now as plain text, based only on reading the source files and any read-only MCP lookups.' });
    let r2 = await driveWait();
    r2 = await drain(r2, flags);
    if (r2.message && r2.message.trim()) res = r2;
  }
} finally {
  // ALWAYS tear down the ephemeral daemon — even on timeout/error — so it never orphans a codex app-server.
  await daemon.stop();
}

// Deterministic degraded-plan signal: a completed turn whose body is a preamble / non-substantive is
// marked '(no-plan)' so codex-wrap fails loud rather than treating it as a valid plan.
const noPlan = res.status === 'completed' && !res.empty && looksLikeNoPlan(res.message);

// Durable artifact: when --out is given AND the turn produced a usable plan, write the verbatim body to
// that path (creating parent dirs) so the approved plan survives as a reviewable file — not just an
// in-memory string / a journal field. A degraded turn writes nothing; we print 'PLAN_FILE: (none)' so
// the caller never reports a path that does not exist. The retry above already settled `res`, so the
// final (post-retry) plan is what lands on disk.
let planFile = '(none)';
if (outPath && isUsablePlan(res.status, res.message, res.empty)) {
  const abs = resolve(outPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, res.message.endsWith('\n') ? res.message : res.message + '\n');
  planFile = abs;
}

console.log('STATUS: ' + res.status + (res.empty ? ' (empty)' : (noPlan ? ' (no-plan)' : '')));
if (outPath) console.log('PLAN_FILE: ' + planFile);
console.log('=== PLAN ===');
console.log(res.message || '(empty)');
process.exit(0);
