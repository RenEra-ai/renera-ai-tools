#!/usr/bin/env node
// One-shot native commit review, for a shell gate (boomi-mcp-server's CLAUDE.md Stage 2).
//
// Boots a PRIVATE ephemeral daemon on a temp socket, runs one git-scoped `review/start`, prints the
// review verbatim, and exits with an honest code. It reuses review-round.mjs's daemon LIFECYCLE only:
// that script always exits 0 and fronts metadata by design of its /codex-issue parser, whereas this
// one is consumed by `&&`-style shell logic and MUST be exit-code-honest.
//
// It never touches ~/.codex-drive/state.json: the global CLI verbs would let a concurrent `start`
// elsewhere redirect this review, and our own state write would clobber someone else's session.
//
// Output contract (order matters — the trailers are LAST so they survive a `tail`):
//   <review text, raw and in full>
//   STATUS: completed|timeout|failed
//   SCOPE: <label> [base=<sha> head=<sha>]
//
// No verdict parsing: deciding "zero issues" is Claude's job under receiving-code-review. This script
// only guarantees that a clean exit means a REAL review of a NON-EMPTY diff actually happened.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Daemon } from '../lib/daemon.mjs';
import { sendCommand } from '../lib/client.mjs';
import { testAppServerOpts, testWaitMs } from '../lib/test-appserver.mjs';

const USAGE = 'usage: commit-review-round.mjs [--base <ref> | --scope <auto|working-tree|branch>] [--cwd <repo>]';

// Client-side cap, under the ~10-min Bash cap so a wedged turn can't hang the gate forever. NOTE
// this is a WAIT cap, unrelated to the daemon's own short response backstop.
const WAIT_TIMEOUT_MS = testWaitMs() ?? 540000;

// The review thread profile the daemon requires for `review` (the companion's exact profile).
const REVIEW_PROFILE = { sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true };

function die(msg, code) {
  process.stderr.write(`[commit-review] ${msg}\n`);
  process.exit(code);
}

// --- preflight: fail fast, BEFORE booting a daemon. The daemon re-validates authoritatively; this
// is purely so a typo costs a millisecond instead of a Codex turn. ---
const KNOWN_FLAGS = new Set(['base', 'scope', 'cwd']);

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  // Blank counts as missing. `--cwd ""` would otherwise pass this guard, then lose to
  // `flag('cwd') || process.cwd()` and review whatever directory we happen to be in — a review of
  // the wrong repository that still exits 0.
  if (v === undefined || v.startsWith('--') || !v.trim()) die(`--${name} requires a non-blank value\n${USAGE}`, 1);
  return v;
}

// Every argument must be recognised. An UNKNOWN flag is a hard error, never ignored: silently
// ignoring one means the caller asked for something specific, got a full unscoped review of the cwd
// instead, and pays for a live Codex turn to find out. (`--help` hitting that path is how this was
// found.) Values are skipped by the same walk, so `--base <sha>` is not mistaken for a flag.
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help' || a === '-h') { process.stdout.write(`${USAGE}\n`); process.exit(0); }
  if (!a.startsWith('--')) die(`unexpected argument '${a}'\n${USAGE}`, 1);
  const key = a.slice(2);
  // Mirror the CLI parser's refusal: `--base=<sha>` must never be silently read as "no base given",
  // which would review auto scope instead of the requested range.
  if (key.includes('=')) die(`--${key.split('=')[0]}=value is not supported; use \`--${key.split('=')[0]} <value>\`\n${USAGE}`, 1);
  if (!KNOWN_FLAGS.has(key)) die(`unknown flag --${key}\n${USAGE}`, 1);
  i++;   // skip this flag's value; flag() re-reads and validates it below
}

const base = flag('base');
const scope = flag('scope');
const cwd = flag('cwd') || process.cwd();
if (base !== undefined && scope !== undefined) die(`--base and --scope are mutually exclusive\n${USAGE}`, 1);
if (scope !== undefined && !['auto', 'working-tree', 'branch'].includes(scope)) die(`invalid --scope '${scope}'\n${USAGE}`, 1);
try {
  execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: 'ignore' });
} catch {
  die(`not a git repository: ${cwd}\n${USAGE}`, 1);
}

// Identify what was ACTUALLY reviewed, not merely what was asked for: a SCOPE line that only echoes
// the request cannot distinguish a real review from one anchored at the wrong commit.
function headSha() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(); } catch { return null; }
}

let daemon = null;
let dir = null;
let status = 'failed';
let reviewText = '';
let scopeLabel = '(unresolved)';
let fatal = null;   // set instead of exiting: process.exit() inside the try would SKIP the finally,
                    // leaking the temp dir and orphaning a codex app-server.

try {
  // Boot INSIDE the try: review-round.mjs boots before its try, so a boot failure there skips
  // cleanup and leaks a temp dir (and possibly an app-server).
  dir = mkdtempSync(join(tmpdir(), 'cdx-creview-'));
  const socketPath = join(dir, 'r.sock');
  daemon = new Daemon({
    socketPath,
    clientInfo: { name: 'codex-drive', version: '0.1.0' },
    cwd,
    profile: REVIEW_PROFILE,
    appServerOpts: testAppServerOpts(),
  });
  await daemon.start();

  const started = await sendCommand(socketPath, { cmd: 'review', base, scope });
  if (started.error) {
    // A scope/validation rejection is a usage error (exit 1); `busy` cannot happen on a fresh
    // private daemon, but if it ever did it is a real failure, not bad input.
    fatal = { msg: started.error, code: started.error === 'busy' ? 2 : 1 };
  } else {
    scopeLabel = started.scope || scopeLabel;
    const res = await drive(socketPath);
    status = res.status;
    reviewText = res.message || '';
  }
} catch (e) {
  fatal = { msg: e.message, code: 1 };   // boot/transport failure
} finally {
  await teardown();
}

if (fatal) {
  process.stderr.write(`[commit-review] ${fatal.msg}\n`);
  if (fatal.code === 1) process.stderr.write(`${USAGE}\n`);
  process.exit(fatal.code);
}

async function teardown() {
  try { if (daemon) await daemon.stop(); } catch { /* best effort */ }
  try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  daemon = null; dir = null;
}

async function drive(socketPath) {
  let res = await waitOnce(socketPath);
  let guard = 0;
  while ((res.status === 'question' || res.status === 'approval') && guard++ < 20) {
    if (res.status === 'approval') {
      // Deny. NOT because a review never runs commands — it runs many (git diff, ls, …) — but
      // because under approvalPolicy:'never' + sandbox:'read-only' they never PROMPT. An approval
      // arriving here means the thread profile is wrong, so granting it would be the actual mistake.
      process.stderr.write(`[commit-review] denying approval: ${(res.request && res.request.method) || '?'}\n`);
      await sendCommand(socketPath, { cmd: 'approve', decision: 'deny' });
    } else {
      const qs = res.question && res.question.questions;
      if (!Array.isArray(qs) || !qs.length) return interruptAndFail(socketPath, 'malformed question payload');
      const q = qs[0];
      const first = q.options && q.options[0];
      const answer = first == null ? 'proceed' : (typeof first === 'string' ? first : first.label);
      await sendCommand(socketPath, { cmd: 'answer', id: q.id, answers: [answer] });
    }
    res = await waitOnce(socketPath);
  }
  if (res.status === 'question' || res.status === 'approval') {
    return interruptAndFail(socketPath, 'drain guard exhausted');
  }
  // 'unsupported' = a parked shape this client cannot answer (an elicitation, or a permissions-shaped
  // approval whose response shape protocol.mjs deliberately refuses to fake). Do not pretend the
  // review continues.
  if (res.status === 'unsupported') return interruptAndFail(socketPath, `unsupported request: ${(res.request && res.request.method) || '?'}`);
  return res;
}

async function waitOnce(socketPath) {
  try {
    return await sendCommand(socketPath, { cmd: 'wait' }, { timeoutMs: WAIT_TIMEOUT_MS });
  } catch (e) {
    if (!/timeout/i.test(e.message)) throw e;
    process.stderr.write('[commit-review] wait cap expired — interrupting\n');
    try { await sendCommand(socketPath, { cmd: 'interrupt' }, { timeoutMs: 10000 }); } catch { /* best effort */ }
    return { status: 'timeout', message: '' };
  }
}

async function interruptAndFail(socketPath, why) {
  process.stderr.write(`[commit-review] ${why} — interrupting\n`);
  try { await sendCommand(socketPath, { cmd: 'interrupt' }, { timeoutMs: 10000 }); } catch { /* best effort */ }
  return { status: 'failed', message: '' };
}

// --- output ---
const clean = status === 'completed' && reviewText.trim().length > 0;
if (reviewText) process.stdout.write(reviewText.endsWith('\n') ? reviewText : reviewText + '\n');
// Blank text on a 'completed' turn is NOT a clean review — the daemon already fails such a turn, and
// this is the second line of defence, because the gate reads "no findings" as "ship it".
process.stdout.write(`STATUS: ${clean ? 'completed' : (status === 'timeout' ? 'timeout' : 'failed')}\n`);
const head = headSha();
process.stdout.write(`SCOPE: ${scopeLabel}${head ? ` head=${head}` : ''}\n`);
process.exit(clean ? 0 : (status === 'timeout' ? 2 : 2));
