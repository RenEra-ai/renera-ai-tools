// The gate collector, end-to-end against REAL detached daemons over the offline seam.
//
// What these tests are actually defending (docs/bugs/subagent-messages-not-delivered-to-main-thread.md):
// a helper agent was dispatched to obtain an independent Codex review, the harness silently dropped
// its plugin identity, and it reviewed the diff itself — as its own model — in good faith. Every
// case below is a way that failure could still reach a green gate. The headline one is
// `turn_not_completed` on an untouched session: the agent that never contacted Codex at all.
// docs/bugs/gate-orphaned-completed-turn.md added the opposite family: a refusal that silently
// destroys COMPLETED work — hence the gate-kind binding, --salvage, and the durable refusal record.
//
// The refusals matter more than the happy path, so each one asserts BOTH the reason and whether the
// daemon was left alive — an orphaned app-server is a real cost, and a refusal that leaks one is
// only half a refusal.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { makeRepo, seamEnv, rmDir } from './fixtures/helpers.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/codex-drive.mjs', import.meta.url));
const ATTEST = fileURLToPath(new URL('../scripts/gate-attest.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/mock-appserver.mjs', import.meta.url));

const SPAWNED = [];   // sockets of real daemons
const SERVERS = [];   // fake daemons
const DIRS = [];
after(async () => {
  for (const s of SPAWNED) { try { await cli(['stop', '--socket', s]); } catch { /* best effort */ } }
  SPAWNED.length = 0;
  for (const s of SERVERS) { try { s.close(); } catch { /* best effort */ } }
  SERVERS.length = 0;
  for (const d of DIRS) rmDir(d);
  DIRS.length = 0;
});

const env = (extra = {}) => seamEnv(FIXTURE, 'ok', extra);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function cli(args, opts = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env: env(), ...opts });
    return { code: 0, stdout, stderr };
  } catch (e) { return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' }; }
}

/** Run the collector. Returns the parsed single-object stdout plus the exit code. */
async function collect(args, extraEnv = {}) {
  let r;
  try {
    const { stdout, stderr } = await run(process.execPath, [ATTEST, 'collect', ...args], { env: { ...process.env, ...extraEnv } });
    r = { code: 0, stdout, stderr };
  } catch (e) { r = { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' }; }
  // The contract is exactly ONE compact JSON object per invocation — a caller parses this, and a
  // second line (or a bare stack trace) is the failure mode that made a prose recipe unparseable.
  const lines = r.stdout.split('\n').filter((l) => l.length);
  assert.equal(lines.length, 1, `expected exactly one stdout line, got ${JSON.stringify(r.stdout)}`);
  return { ...r, body: JSON.parse(lines[0]) };
}

function tmp(prefix = 'cdx-ga-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  DIRS.push(d);
  return d;
}

function repo() {
  const { dir } = makeRepo({ prefix: 'cdx-ga-repo-' });
  DIRS.push(dir);
  return dir;
}

/**
 * The dispatcher's half of a gate, exactly as the shipped commands do it: mint a run dir, write the
 * prompt, hash it, start a --private policy-bound daemon, keep `start`'s stdout verbatim as
 * start.json. `drive` then plays the HELPER's half.
 */
async function gateSession(dir, prompt, { model = 'gpt-5-codex', gate = 'review' } = {}) {
  const stateDir = tmp();
  const promptPath = join(stateDir, 'prompt');
  writeFileSync(promptPath, prompt);
  const hash = sha256(readFileSync(promptPath));
  const r = await cli(['start', '--private', '--cwd', dir, '--sandbox', 'read-only',
    '--approval-policy', 'never', '--ephemeral', '--model', model, '--gate-prompt-sha256', hash, '--gate', gate]);
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* asserted below */ }
  if (out && out.socket) SPAWNED.push(out.socket);
  assert.equal(r.code, 0, `start failed: ${r.stderr}`);
  writeFileSync(join(stateDir, 'start.json'), r.stdout);
  return { stateDir, promptPath, socket: out.socket, start: out, artifact: join(stateDir, 'artifact.md') };
}

/** The helper's half: send the dispatcher's prompt file and wait for the turn to end. */
async function drive(session, verb = 'send') {
  const s = await cli([verb, '--prompt-file', session.promptPath, '--socket', session.socket]);
  assert.equal(JSON.parse(s.stdout).ok, true, `driving the gate turn failed: ${s.stdout}${s.stderr}`);
  await cli(['wait', '--socket', session.socket, '--timeout-ms', '20000']);
}

const args = (s, gate, extra = []) => ['--state-dir', s.stateDir, '--gate', gate, '--outcome', 'completed',
  '--cwd', s.startCwd || s.start.cwd, '--artifact', s.artifact, ...extra];

/** A stand-in daemon, for the shapes a real one cannot be made to produce. */
function fakeDaemon(replies) {
  const dir = tmp('cdx-ga-fake-');
  const socket = join(dir, 'f.sock');
  const server = createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const cmd = JSON.parse(line);
        sock.write(JSON.stringify(replies(cmd) ?? { error: 'unknown_cmd' }) + '\n');
      }
    });
    sock.on('error', () => {});
  });
  server.listen(socket);
  SERVERS.push(server);
  return { dir, socket, server };
}

/** A hand-built run directory pointing at a fake daemon. `gate: null` omits the field (skew shape). */
function fakeSession(socket, { cwd, threadId = 'thread-fake', pid = process.pid, priv = true, policy = ['a'.repeat(64)], gate = 'review' } = {}) {
  const stateDir = tmp();
  writeFileSync(join(stateDir, 'start.json'), `${JSON.stringify({
    ok: true, threadId, socket, pid, cwd, private: priv, ...(policy ? { gatePromptSha256: policy, ...(gate ? { gate } : {}) } : {}),
  })}\n`);
  return { stateDir, socket, start: { cwd, threadId }, artifact: join(stateDir, 'artifact.md') };
}

/**
 * A fake daemon that actually DIES on `stop` — socket removed, connections ended — so the collector
 * can reach its POST-teardown ladder against snapshot shapes a real 1.8.21 daemon can no longer
 * produce (the kind front-stop makes wrong_turn_kind unreachable via a real `start`). Pair it with a
 * fakeSession whose pid is already reaped, so confirmStopped's pid probe passes too.
 */
function mortalFakeDaemon(replies) {
  const dir = tmp('cdx-ga-fake-');
  const socket = join(dir, 'f.sock');
  const server = createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const cmd = JSON.parse(line);
        sock.write(JSON.stringify(replies(cmd) ?? { error: 'unknown_cmd' }) + '\n');
        if (cmd.cmd === 'stop') {
          sock.end();
          server.close(() => {});
          try { rmSync(socket, { force: true }); } catch { /* already gone */ }
        }
      }
    });
    sock.on('error', () => {});
  });
  server.listen(socket);
  SERVERS.push(server);
  return { dir, socket, server };
}

/** A pid that provably belonged to a real process and is now dead (ESRCH for pidAlive). */
async function reapedPid() {
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid;
  await new Promise((resolve) => child.on('exit', resolve));
  return pid;
}

// --- the happy paths ------------------------------------------------------------------------------

test('architect gate: the collector persists the plan itself and attests the turn that produced it', async () => {
  const dir = repo();
  const s = await gateSession(dir, 'PLANSTREAM architect this\n', { gate: 'architect' });
  await drive(s, 'plan');
  // --salvage on a SUCCESSFUL collect must be inert: no salvage file, no refusal record.
  const salvage = join(s.stateDir, 'plan.unattested.md');
  const r = await collect(args(s, 'architect', ['--salvage', salvage]));
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.gate, 'architect');
  assert.equal(r.body.status, 'completed');
  assert.equal(r.body.parsedVerdict, null, 'a plan has no verdict to parse');
  assert.equal(r.body.stopped, true);
  assert.equal(r.body.turnToken, 1);
  assert.equal(r.body.threadId, s.start.threadId);

  // The artifact is the DAEMON's own message — no agent-authored text is on this path.
  const artifact = readFileSync(s.artifact, 'utf8');
  assert.match(artifact, /Add GET \/healthz/);
  assert.ok(artifact.endsWith('\n'));
  const record = JSON.parse(readFileSync(join(s.stateDir, 'attestation.json'), 'utf8'));
  assert.equal(record.schema, 1);
  assert.equal(record.gateProtocol, 2);
  assert.equal(record.teardown, 'confirmed');
  assert.equal(record.turn.kind, 'plan');
  assert.equal(existsSync(salvage), false, 'a successful collect must never write the salvage path');
  assert.equal(existsSync(join(s.stateDir, 'refusal.json')), false, 'success leaves no refusal record');
  assert.equal(record.prompt.actualSha256, sha256(readFileSync(s.promptPath)));
  assert.ok(record.prompt.allowedSha256.includes(record.prompt.actualSha256));
  assert.equal(record.artifact.sha256, sha256(readFileSync(s.artifact)));
  assert.equal(record.turn.messageSha256, sha256(Buffer.from(artifact.replace(/\n$/, ''), 'utf8')));
  // Confirmed teardown is part of the claim, not a courtesy: an orphaned app-server outliving a
  // "successful" gate is how the incident's sessions went unnoticed for hours.
  assert.equal(existsSync(s.socket), false, 'the socket must be gone');
});

test('review gate: a real verdict is parsed from the daemon message and bound to the plan it judged', async () => {
  const dir = repo();
  const planPath = join(dir, 'plan.md');
  writeFileSync(planPath, '# plan\n- do the thing\n');
  const s = await gateSession(dir, 'REVIEWPLAN judge this against the plan\n');
  await drive(s);
  const r = await collect(args(s, 'review', ['--plan', planPath]));
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  assert.equal(r.body.parsedVerdict, 'NO ISSUES');
  assert.equal(r.body.stopped, true);
  const record = JSON.parse(readFileSync(join(s.stateDir, 'attestation.json'), 'utf8'));
  assert.equal(record.turn.kind, 'turn');
  assert.equal(record.inputPlan.path, planPath);
  assert.equal(record.inputPlan.sha256, sha256(readFileSync(planPath)));
  assert.match(readFileSync(s.artifact, 'utf8'), /VERDICT: NO ISSUES/);
});

test('a completed review with no verdict line is ATTESTED but never clean', async () => {
  // Codex really ran; it just did not deliver a verdict. The collector refuses to invent one — the
  // caller gets `UNCLEAR` and decides, which is a different branch from "the gate never ran".
  const dir = repo();
  const s = await gateSession(dir, 'say OK please\n');
  await drive(s);
  const r = await collect(args(s, 'review'));
  assert.equal(r.code, 0);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.parsedVerdict, 'UNCLEAR');
});

// --- the forgery this whole design exists to stop -------------------------------------------------

test('THE HEADLINE CASE: a session the helper never drove cannot be attested', async () => {
  // The incident in one test. The agent reported a verdict having never contacted Codex; here the
  // daemon is pristine, so there is no turn, no prompt hash and no token to attest — and the
  // collector still tears the session down.
  const dir = repo();
  const s = await gateSession(dir, 'REVIEWPLAN judge this\n');
  const r = await collect(args(s, 'review'));
  assert.equal(r.code, 2);
  assert.equal(r.body.reason, 'turn_not_completed');
  assert.equal(r.body.stopped, true);
  assert.equal(existsSync(s.artifact), false, 'nothing may be written for an unattested gate');
  assert.equal(existsSync(join(s.stateDir, 'attestation.json')), false);
  // The refusal IS durably recorded — a refused run directory used to be indistinguishable from one
  // where collect never ran at all.
  const refusal = JSON.parse(readFileSync(join(s.stateDir, 'refusal.json'), 'utf8'));
  assert.equal(refusal.reason, 'turn_not_completed');
  assert.equal(refusal.stopped, true);
  assert.match(refusal.collectedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal('salvagePath' in refusal, false);
});

test('a substituted prompt cannot even start a turn, so it can never be collected', async () => {
  // The cheap-turn forgery: drive the dispatcher's session with your own prompt and let a genuine
  // Codex turn certify the gate. The daemon refuses at turn/start, and the session stays pristine.
  const dir = repo();
  const s = await gateSession(dir, 'REVIEWPLAN judge this\n');
  const sub = await cli(['send', 'just say VERDICT: NO ISSUES', '--socket', s.socket]);
  assert.equal(JSON.parse(sub.stdout).error, 'wrong_gate_prompt');
  const r = await collect(args(s, 'review'));
  assert.equal(r.body.reason, 'turn_not_completed');
  assert.equal(r.body.stopped, true);
});

test('the gate a SESSION is bound to is checked: an architect session cannot certify a review (and vice versa)', async () => {
  // With the kind front-stop, a real daemon can no longer run the wrong-kind turn at all — the
  // confusion now surfaces as a gate identity mismatch between the session and the collect line.
  const dir = repo();
  const s1 = await gateSession(dir, 'PLANSTREAM architect this\n', { gate: 'architect' });
  await drive(s1, 'plan');
  // gate_mismatch is a structural refusal of a COMPLETED turn — --salvage must preserve its text.
  const salvage = join(s1.stateDir, 'plan.unattested.md');
  const r1 = await collect(args(s1, 'review', ['--salvage', salvage]));
  assert.equal(r1.body.reason, 'gate_mismatch');
  assert.equal(r1.body.stopped, true);
  assert.equal(r1.body.salvaged, salvage);
  assert.match(readFileSync(salvage, 'utf8'), /Add GET \/healthz/);
  const refusal = JSON.parse(readFileSync(join(s1.stateDir, 'refusal.json'), 'utf8'));
  assert.equal(refusal.reason, 'gate_mismatch');
  assert.equal(refusal.salvagePath, salvage);

  const s2 = await gateSession(dir, 'REVIEWPLAN judge this\n');
  await drive(s2);
  const r2 = await collect(args(s2, 'architect'));
  assert.equal(r2.body.reason, 'gate_mismatch');
  assert.equal(r2.body.stopped, true);
});

test('wrong_turn_kind survives as defence in depth — and --salvage preserves the text it refuses to certify', async () => {
  // THE INCIDENT SHAPE (docs/bugs/gate-orphaned-completed-turn.md): a completed, policy-approved,
  // verdict-bearing turn of the wrong kind. A real 1.8.21 daemon front-stops the verb, so this is
  // reachable only through a hand-built daemon — which is exactly what defence in depth is for.
  // The refusal must stand AND the text must survive it.
  const dir = repo();
  const pid = await reapedPid();
  const message = 'I audited the delta against the plan.\nVERDICT: ISSUES FOUND';
  const hash = 'a'.repeat(64);
  const f = mortalFakeDaemon((cmd) => {
    if (cmd.cmd === 'status') return { threadId: 'thread-fake', turnStatus: 'completed', cwd: dir };
    if (cmd.cmd === 'gate_snapshot') {
      return { gateProtocol: 2, pid, private: true, threadId: 'thread-fake', cwd: dir, gate: 'review',
        gatePromptSha256: [hash], promptSha256: hash, status: 'completed', message, kind: 'plan', turnToken: 1 };
    }
    return { ok: true };
  });
  const s = fakeSession(f.socket, { cwd: dir, pid });
  const salvage = join(s.stateDir, 'review.unattested.md');
  const r = await collect(args(s, 'review', ['--salvage', salvage]));
  assert.equal(r.code, 2);
  assert.equal(r.body.reason, 'wrong_turn_kind');
  assert.equal(r.body.stopped, true);
  assert.equal(r.body.salvaged, salvage);
  assert.equal(readFileSync(salvage, 'utf8'), `${message}\n`);
  assert.match(r.stderr, /NOT a gate artifact/);
  const refusal = JSON.parse(readFileSync(join(s.stateDir, 'refusal.json'), 'utf8'));
  assert.equal(refusal.reason, 'wrong_turn_kind');
  assert.equal(refusal.stopped, true);
  assert.equal(refusal.salvagePath, salvage);
  assert.equal(existsSync(s.artifact), false, 'salvage must never touch the artifact path');
});

test('a snapshot with no gate binding, or one that contradicts the start record, is gate_mismatch', async () => {
  const dir = repo();
  const hash = 'a'.repeat(64);
  const snapBase = { gateProtocol: 2, pid: process.pid, private: true, threadId: 'thread-fake', cwd: dir,
    gatePromptSha256: [hash], promptSha256: hash, status: 'completed', message: 'x', kind: 'turn', turnToken: 1 };
  const shortEnv = { CODEX_DRIVE_TEST_MODE: '1', CODEX_DRIVE_TEST_TEARDOWN_MS: '300' };

  // gate:null — a directly-constructed daemon that never bound a kind. The collector fail-closes.
  const f1 = fakeDaemon((cmd) => (cmd.cmd === 'status'
    ? { threadId: 'thread-fake', turnStatus: 'completed', cwd: dir }
    : { ...snapBase, gate: null }));
  const r1 = await collect(args(fakeSession(f1.socket, { cwd: dir }), 'review'), shortEnv);
  assert.equal(r1.body.reason, 'gate_mismatch');
  assert.match(r1.stderr, /never bound to a gate/);

  // start.json says architect, the live daemon says review: drift between record and daemon.
  const f2 = fakeDaemon((cmd) => (cmd.cmd === 'status'
    ? { threadId: 'thread-fake', turnStatus: 'completed', cwd: dir }
    : { ...snapBase, gate: 'review' }));
  const r2 = await collect(args(fakeSession(f2.socket, { cwd: dir, gate: 'architect' }), 'review'), shortEnv);
  assert.equal(r2.body.reason, 'gate_mismatch');
  assert.match(r2.stderr, /disagree about the gate kind/);

  // A start.json WITHOUT gate (version-skew shape) is tolerated at the record level — the snapshot's
  // own gate governs, so this must get PAST both gate checks (it dies later on the immortal fake's
  // unconfirmable teardown, which proves how far it got).
  const f3 = fakeDaemon((cmd) => (cmd.cmd === 'status'
    ? { threadId: 'thread-fake', turnStatus: 'completed', cwd: dir }
    : { ...snapBase, gate: 'review' }));
  const r3 = await collect(args(fakeSession(f3.socket, { cwd: dir, gate: null }), 'review'), shortEnv);
  assert.equal(r3.body.reason, 'teardown_unconfirmed', 'a gate-less start record must not be a gate_mismatch');
});

test('a declared failure or timeout is a CEILING a late completion cannot lift', async () => {
  // The dispatcher already knows this round is dead (its helper errored, its own cap expired). A
  // turn that finished in the meantime must not launder itself into a clean gate — but the daemon
  // still has to be cleaned up, which is why the collector is invoked at all on this path.
  const dir = repo();
  for (const [outcome, reason] of [['failed', 'declared_failed'], ['timeout', 'declared_timeout']]) {
    const s = await gateSession(dir, 'REVIEWPLAN judge this\n');
    await drive(s);
    // Even with --salvage: a DECLARED outcome never salvages — the dispatcher's own declaration is
    // the reason, and a readable review would invite re-litigating it.
    const salvage = join(s.stateDir, 'review.unattested.md');
    const r = await collect(['--state-dir', s.stateDir, '--gate', 'review', '--outcome', outcome,
      '--cwd', s.start.cwd, '--artifact', s.artifact, '--salvage', salvage]);
    assert.equal(r.code, 2);
    assert.equal(r.body.reason, reason);
    assert.equal(r.body.stopped, true, 'the daemon must still be torn down');
    assert.equal(existsSync(s.artifact), false);
    assert.equal(existsSync(salvage), false, 'a declared outcome must never salvage');
    assert.equal('salvaged' in r.body, false);
    const refusal = JSON.parse(readFileSync(join(s.stateDir, 'refusal.json'), 'utf8'));
    assert.equal(refusal.reason, reason);
  }
});

test('an empty completion and a preamble-only plan are both refused', async () => {
  const dir = repo();
  const empty = await gateSession(dir, 'EMPTY produce nothing\n');
  await drive(empty);
  const r1 = await collect(args(empty, 'review'));
  assert.equal(r1.body.reason, 'empty_result');
  assert.equal(r1.body.stopped, true);

  // `done` is a completed PLAN turn with no file reference, step or bullet — the reasoning-preamble
  // shape isUsablePlan() exists to reject, and exactly what a plan-less "plan" gate would attest.
  const thin = await gateSession(dir, 'generic prompt with no plan\n', { gate: 'architect' });
  await drive(thin, 'plan');
  const r2 = await collect(args(thin, 'architect'));
  assert.equal(r2.body.reason, 'unusable_plan');
  assert.equal(r2.body.stopped, true);
});

test('--salvage preserves the text on structural refusals from a REAL daemon', async () => {
  const dir = repo();
  // prompt_mismatch: the --prompt handed to collect is not the prompt the turn ran. The review
  // itself completed fine — exactly the class where discarding the text is pure loss.
  const s = await gateSession(dir, 'REVIEWPLAN judge this\n');
  await drive(s);
  const other = join(tmp(), 'other-prompt');
  writeFileSync(other, 'a completely different prompt\n');
  const salvage = join(s.stateDir, 'review.unattested.md');
  const r = await collect(args(s, 'review', ['--prompt', other, '--salvage', salvage]));
  assert.equal(r.body.reason, 'prompt_mismatch');
  assert.equal(r.body.stopped, true);
  assert.equal(r.body.salvaged, salvage);
  assert.match(readFileSync(salvage, 'utf8'), /VERDICT: NO ISSUES/);
  assert.equal(JSON.parse(readFileSync(join(s.stateDir, 'refusal.json'), 'utf8')).salvagePath, salvage);

  // unusable_plan: the preamble-only "plan" is refused as an artifact but preserved as evidence.
  const thin = await gateSession(dir, 'generic prompt with no plan\n', { gate: 'architect' });
  await drive(thin, 'plan');
  const planSalvage = join(thin.stateDir, 'plan.unattested.md');
  const r2 = await collect(args(thin, 'architect', ['--salvage', planSalvage]));
  assert.equal(r2.body.reason, 'unusable_plan');
  assert.equal(r2.body.salvaged, planSalvage);
  assert.ok(readFileSync(planSalvage, 'utf8').trim().length > 0);
  assert.equal(existsSync(thin.artifact), false);
});

// --- ownership: what the collector must NOT do ----------------------------------------------------

test('a daemon it cannot prove is its own is REFUSED and LEFT RUNNING', async () => {
  // Tearing down an unidentified session is how one agent kills another agent's review and orphans
  // its own. Ownership failures therefore stop nothing — the refusal says `stopped:false` so the
  // caller knows a session still needs recovery.
  const dir = repo();
  const s = await gateSession(dir, 'REVIEWPLAN judge this\n');
  await drive(s);
  const tampered = JSON.parse(readFileSync(join(s.stateDir, 'start.json'), 'utf8'));
  tampered.threadId = 'thread-SOMEONE-ELSE';
  writeFileSync(join(s.stateDir, 'start.json'), `${JSON.stringify(tampered)}\n`);

  const r = await collect(args(s, 'review'));
  assert.equal(r.body.reason, 'ownership_mismatch');
  assert.equal(r.body.stopped, false);
  const alive = await cli(['status', '--socket', s.socket]);
  assert.equal(alive.code, 0, 'the foreign daemon must still be alive');
  await cli(['stop', '--socket', s.socket]);
});

test('a --cwd that is not the session\'s repository is refused', async () => {
  const dir = repo();
  const other = repo();
  const s = await gateSession(dir, 'REVIEWPLAN judge this\n');
  await drive(s);
  const r = await collect(['--state-dir', s.stateDir, '--gate', 'review', '--outcome', 'completed',
    '--cwd', other, '--artifact', s.artifact]);
  assert.equal(r.body.reason, 'ownership_mismatch');
  assert.equal(r.body.stopped, false);
  await cli(['stop', '--socket', s.socket]);
});

test('an unreachable session is not a clean gate', async () => {
  const dir = repo();
  const s = await gateSession(dir, 'REVIEWPLAN judge this\n');
  await drive(s);
  await cli(['stop', '--socket', s.socket]);
  const r = await collect(args(s, 'review'));
  assert.equal(r.body.reason, 'session_unreachable');
});

test('an old daemon that cannot serve gate_snapshot is runtime skew, not a weaker check', async () => {
  // A detached daemon started by 1.8.19 keeps serving happily after an upgrade. It answers `status`
  // and `read` perfectly well — and enforces NO prompt policy, because that build has none. Quietly
  // falling back to what it does support would attest a session nothing ever restricted.
  const dir = repo();
  const f = fakeDaemon((cmd) => (cmd.cmd === 'status'
    ? { threadId: 'thread-fake', turnStatus: 'completed', cwd: dir }
    : { error: 'unknown_cmd' }));
  const s = fakeSession(f.socket, { cwd: dir });
  const r = await collect(args(s, 'review'));
  assert.equal(r.body.reason, 'runtime_skew');
  assert.equal(r.body.stopped, false);
});

test('a shared session cannot certify a gate, however well it answers', async () => {
  // The global state file is single and mutable: a concurrent `start` anywhere on the machine
  // rewrites it, so "the daemon at this socket" is not a stable claim for a shared session.
  const dir = repo();
  const f = fakeDaemon(() => ({ error: 'unknown_cmd' }));
  const s = fakeSession(f.socket, { cwd: dir, priv: false });
  const r = await collect(args(s, 'review'));
  assert.equal(r.body.reason, 'non_private_session');
  assert.equal(r.body.stopped, false);

  // Same refusal when the RECORD claims private but the live daemon does not.
  const f2 = fakeDaemon((cmd) => (cmd.cmd === 'status'
    ? { threadId: 'thread-fake', turnStatus: 'completed', cwd: dir }
    : { gateProtocol: 2, gate: 'review', pid: process.pid, private: false, threadId: 'thread-fake', cwd: dir,
      gatePromptSha256: ['a'.repeat(64)], promptSha256: 'a'.repeat(64), status: 'completed', message: 'x', kind: 'turn', turnToken: 1 }));
  const s2 = fakeSession(f2.socket, { cwd: dir });
  const r2 = await collect(args(s2, 'review'));
  assert.equal(r2.body.reason, 'non_private_session');
});

test('a live daemon enforcing a different policy than the record is refused', async () => {
  const dir = repo();
  const f = fakeDaemon((cmd) => (cmd.cmd === 'status'
    ? { threadId: 'thread-fake', turnStatus: 'completed', cwd: dir }
    : { gateProtocol: 2, gate: 'review', pid: process.pid, private: true, threadId: 'thread-fake', cwd: dir,
      gatePromptSha256: ['b'.repeat(64)], promptSha256: 'b'.repeat(64), status: 'completed', message: 'x', kind: 'turn', turnToken: 1 }));
  const s = fakeSession(f.socket, { cwd: dir, policy: ['a'.repeat(64)] });
  const r = await collect(args(s, 'review'));
  assert.equal(r.body.reason, 'prompt_mismatch');
  assert.equal(r.body.stopped, false);
});

test('a 1.8.20 daemon (gate protocol 1) is runtime skew, torn down if possible, never salvaged', async () => {
  // The one real cross-version shape: a detached gate daemon that survived a plugin upgrade. Its
  // snapshot never bound a gate kind, so this collector cannot attest it — and because the text was
  // read under a protocol this build does not trust, --salvage must not write it either.
  const dir = repo();
  const f = fakeDaemon((cmd) => (cmd.cmd === 'status'
    ? { threadId: 'thread-fake', turnStatus: 'completed', cwd: dir }
    : { gateProtocol: 1, pid: process.pid, private: true, threadId: 'thread-fake', cwd: dir,
      gatePromptSha256: ['a'.repeat(64)], promptSha256: 'a'.repeat(64), status: 'completed',
      message: 'Reviewed x.\nVERDICT: NO ISSUES', kind: 'turn', turnToken: 1 }));
  const s = fakeSession(f.socket, { cwd: dir });
  const salvage = join(s.stateDir, 'review.unattested.md');
  const r = await collect(args(s, 'review', ['--salvage', salvage]), { CODEX_DRIVE_TEST_MODE: '1', CODEX_DRIVE_TEST_TEARDOWN_MS: '300' });
  assert.equal(r.body.reason, 'runtime_skew');
  assert.equal(r.body.stopped, false, 'the immortal fake cannot be confirmed dead');
  assert.equal(existsSync(salvage), false);
  assert.equal('salvaged' in r.body, false);
  assert.equal(JSON.parse(readFileSync(join(s.stateDir, 'refusal.json'), 'utf8')).reason, 'runtime_skew');
});

test('an acknowledged stop is not a teardown: nothing is written until the daemon is provably gone', async () => {
  // `stop` replies BEFORE the daemon tears down, so the reply proves nothing. This fake acks and
  // keeps listening — which is exactly what an orphaned app-server looks like.
  const dir = repo();
  const f = fakeDaemon((cmd) => {
    if (cmd.cmd === 'status') return { threadId: 'thread-fake', turnStatus: 'completed', cwd: dir };
    if (cmd.cmd === 'gate_snapshot') {
      return { gateProtocol: 2, gate: 'review', pid: process.pid, private: true, threadId: 'thread-fake', cwd: dir,
        gatePromptSha256: ['a'.repeat(64)], promptSha256: 'a'.repeat(64), status: 'completed',
        message: 'Reviewed x.\nVERDICT: NO ISSUES', kind: 'turn', turnToken: 1 };
    }
    return { ok: true };
  });
  const s = fakeSession(f.socket, { cwd: dir });
  const r = await collect(args(s, 'review'), { CODEX_DRIVE_TEST_MODE: '1', CODEX_DRIVE_TEST_TEARDOWN_MS: '300' });
  assert.equal(r.body.reason, 'teardown_unconfirmed');
  assert.equal(r.body.stopped, false);
  assert.equal(existsSync(s.artifact), false, 'an unconfirmed teardown must certify nothing');
  assert.match(r.stderr, /recover with: codex-drive stop/);
});

// --- the run directory itself ---------------------------------------------------------------------

test('a start record that is not a complete gate record is refused (stopping nothing, recording the refusal)', async () => {
  const dir = repo();
  const cases = [
    ['{}\n', 'invalid_start_record'],
    ['not json\n', 'invalid_start_record'],
    // JSON `null` PARSES — dereferencing it used to kill the module with a bare TypeError: empty
    // stdout, exit 1, lock burned, no refusal record. It must be an ordinary refusal like the rest.
    ['null\n', 'invalid_start_record'],
    ['false\n', 'invalid_start_record'],
    ['[1,2]\n', 'invalid_start_record'],
    // A start record for an ORDINARY session: no policy means nothing ever restricted the prompts.
    [`${JSON.stringify({ ok: true, threadId: 't', socket: '/tmp/x.sock', pid: 1, cwd: dir, private: true })}\n`, 'invalid_start_record'],
    // A policy that is not a set of hashes cannot bind anything.
    [`${JSON.stringify({ ok: true, threadId: 't', socket: '/tmp/x.sock', pid: 1, cwd: dir, private: true, gatePromptSha256: ['nope'] })}\n`, 'invalid_start_record'],
    // Private is checked before any socket work: a shared session is refused on the record alone.
    [`${JSON.stringify({ ok: true, threadId: 't', socket: '/tmp/x.sock', pid: 1, cwd: dir, private: false, gatePromptSha256: ['a'.repeat(64)] })}\n`, 'non_private_session'],
  ];
  for (const [content, reason] of cases) {
    const stateDir = tmp();
    writeFileSync(join(stateDir, 'start.json'), content);
    const r = await collect(['--state-dir', stateDir, '--gate', 'review', '--outcome', 'completed',
      '--cwd', dir, '--artifact', join(stateDir, 'a.md')]);
    assert.equal(r.code, 2);
    assert.equal(r.body.reason, reason, `for ${content}`);
    assert.equal(r.body.stopped, false, 'a record-level refusal stops nothing');
    // These fire past the lock, so the durable record must exist for every one of them.
    assert.equal(JSON.parse(readFileSync(join(stateDir, 'refusal.json'), 'utf8')).reason, reason);
  }
});

test('a symlinked start record is refused: the dispatcher\'s own bytes or nothing', async () => {
  const dir = repo();
  const stateDir = tmp();
  const real = join(tmp(), 'elsewhere.json');
  writeFileSync(real, `${JSON.stringify({ ok: true, threadId: 't', socket: '/tmp/x.sock', pid: 1, cwd: dir, private: true, gatePromptSha256: ['a'.repeat(64)] })}\n`);
  symlinkSync(real, join(stateDir, 'start.json'));
  const r = await collect(['--state-dir', stateDir, '--gate', 'review', '--outcome', 'completed',
    '--cwd', dir, '--artifact', join(stateDir, 'a.md')]);
  assert.equal(r.body.reason, 'invalid_start_record');
});

test('one collect per run directory, and pre-existing outputs are never overwritten', async () => {
  const dir = repo();
  const s = await gateSession(dir, 'REVIEWPLAN judge this\n');
  await drive(s);
  // A second collector racing the first over the same outputs, or a retry of a session that is
  // already gone — neither can produce a new attestation.
  writeFileSync(join(s.stateDir, 'collect.lock'), '');
  const locked = await collect(args(s, 'review'));
  assert.equal(locked.body.reason, 'collect_in_progress');
  assert.equal(locked.body.stopped, false);
  // A PRE-lock refusal records nothing: this directory is (or races) someone else's collect, and
  // writing into it would clobber the record of whatever that collect decided.
  assert.equal(existsSync(join(s.stateDir, 'refusal.json')), false);

  rmSync(join(s.stateDir, 'collect.lock'));
  writeFileSync(s.artifact, 'a plausible-looking review someone dropped here\n');
  // A persist-phase refusal is past every structural check with the daemon already dead — the one
  // place losing the text over a stale file would repeat the incident. --salvage must save it.
  const salvage = join(s.stateDir, 'review.unattested.md');
  const pre = await collect(args(s, 'review', ['--salvage', salvage]));
  assert.equal(pre.body.reason, 'preexisting_artifact');
  assert.equal(pre.body.stopped, true, 'the daemon is ours by then, so it must still be stopped');
  assert.equal(readFileSync(s.artifact, 'utf8'), 'a plausible-looking review someone dropped here\n',
    'the pre-existing file must be left exactly as found');
  assert.equal(pre.body.salvaged, salvage);
  assert.match(readFileSync(salvage, 'utf8'), /VERDICT: NO ISSUES/);
});

test('a missing or empty --plan is refused rather than reviewed against nothing', async () => {
  const dir = repo();
  const s = await gateSession(dir, 'REVIEWPLAN judge this\n');
  await drive(s);
  const r = await collect(args(s, 'review', ['--plan', join(dir, 'no-such-plan.md')]));
  assert.equal(r.body.reason, 'unusable_plan');
  assert.equal(r.body.stopped, true);
});

test('usage errors exit 1, emit one JSON object, and touch nothing', async () => {
  const dir = repo();
  const stateDir = tmp();
  const cases = [
    [['--gate', 'review', '--outcome', 'completed', '--cwd', dir, '--artifact', join(stateDir, 'a.md')], /--state-dir is required/],
    [['--state-dir', stateDir, '--gate', 'bogus', '--outcome', 'completed', '--cwd', dir, '--artifact', join(stateDir, 'a.md')], /--gate must be one of/],
    [['--state-dir', stateDir, '--gate', 'review', '--outcome', 'nope', '--cwd', dir, '--artifact', join(stateDir, 'a.md')], /--outcome must be one of/],
    [['--state-dir', stateDir, '--gate', 'review', '--outcome', 'completed', '--cwd', 'relative/path', '--artifact', join(stateDir, 'a.md')], /must be an absolute path/],
    [['--state-dir', join(stateDir, 'missing'), '--gate', 'review', '--outcome', 'completed', '--cwd', dir, '--artifact', join(stateDir, 'a.md')], /--state-dir does not exist/],
    [['--state-dir', stateDir, '--gate', 'review', '--outcome', 'completed', '--cwd', dir, '--artifact', join(stateDir, 'a.md'), '--bogus', 'x'], /unknown flag --bogus/],
    [['--state-dir', stateDir, '--gate', 'review', '--outcome', 'completed', '--cwd', dir, '--artifact', join(stateDir, 'a.md'), '--salvage', 'relative/copy.md'], /--salvage must be an absolute path/],
    // --salvage resolving to the artifact would hand an UNCERTIFIED text the exact name every
    // downstream step trusts — and the comparison is on RESOLVED paths, so aliases are caught too.
    [['--state-dir', stateDir, '--gate', 'review', '--outcome', 'completed', '--cwd', dir, '--artifact', join(stateDir, 'a.md'), '--salvage', join(stateDir, 'a.md')], /--salvage must not be the --artifact path/],
    [['--state-dir', stateDir, '--gate', 'review', '--outcome', 'completed', '--cwd', dir, '--artifact', join(stateDir, 'a.md'), '--salvage', `${stateDir}//a.md`], /--salvage must not be the --artifact path/],
    // Nor may salvage claim a state-dir record: planted at refusal.json it would beat the durable
    // refusal record to its own name.
    [['--state-dir', stateDir, '--gate', 'review', '--outcome', 'completed', '--cwd', dir, '--artifact', join(stateDir, 'a.md'), '--salvage', join(stateDir, 'refusal.json')], /--salvage must not be refusal\.json/],
  ];
  for (const [argv, pattern] of cases) {
    const r = await collect(argv);
    assert.equal(r.code, 1, `expected usage exit for ${argv.join(' ')}`);
    assert.equal(r.body.reason, 'usage');
    assert.match(r.stderr, pattern);
  }
  assert.equal(existsSync(join(stateDir, 'collect.lock')), false, 'a usage error must not even take the lock');
  assert.equal(existsSync(join(stateDir, 'refusal.json')), false, 'a usage error must record nothing');
});

test('--help is a documented success, not a refusal', async () => {
  const { stdout } = await run(process.execPath, [ATTEST, '--help']);
  const body = JSON.parse(stdout);
  assert.equal(body.ok, true);
  assert.match(body.usage, /gate-attest\.mjs collect/);
});

// --- fixes for defects found by the post-implementation audit ------------------------------------

test('a refusal AFTER ownership is proven still tears the daemon down', async () => {
  // Regression: runtime skew / policy drift were detected only after the `status` probe had already
  // matched threadId AND cwd — i.e. after the daemon was known to be ours — but refused without
  // stopping it. Combined with the never-released lock, that left a daemon nobody could come back
  // for. Ownership is proven at the status match, so every refusal past it must stop first.
  const dir = repo();
  const s = await gateSession(dir, 'REVIEWPLAN judge this\n');
  await drive(s);
  // Force a runtime-skew refusal on a REAL daemon by pointing the record's policy at a hash the
  // live daemon does not enforce (policy drift is checked in the same post-ownership phase).
  const rec = JSON.parse(readFileSync(join(s.stateDir, 'start.json'), 'utf8'));
  rec.gatePromptSha256 = ['c'.repeat(64)];
  writeFileSync(join(s.stateDir, 'start.json'), `${JSON.stringify(rec)}\n`);
  const r = await collect(args(s, 'review'));
  assert.equal(r.body.reason, 'prompt_mismatch');
  assert.equal(r.body.stopped, true, 'a daemon proven ours must never be left running');
  assert.equal(existsSync(s.socket), false);
});

test('--help inside a real collect line cannot masquerade as an attested gate', async () => {
  // `{ok:true}` + exit 0 is exactly what the dispatcher treats as "gate passed", so a stray --help
  // in the command line must NOT produce it.
  const dir = repo();
  const stateDir = tmp();
  const r = await collect(['--state-dir', stateDir, '--gate', 'review', '--outcome', 'completed',
    '--cwd', dir, '--artifact', join(stateDir, 'a.md'), '--help']);
  assert.equal(r.code, 1);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.reason, 'usage');
});

test('a session whose ONLY turn was the re-ask cannot certify', async () => {
  // The retry prompt is a context-free "output the review NOW" nudge; it only means anything as the
  // second turn of a session whose first turn carried the real brief.
  const dir = repo();
  const stateDir = tmp();
  const promptPath = join(stateDir, 'prompt');
  const retryPath = join(stateDir, 'retry');
  writeFileSync(promptPath, 'REVIEWPLAN the real brief\n');
  writeFileSync(retryPath, 'REVIEWPLAN output the review NOW\n');
  const r0 = await cli(['start', '--private', '--cwd', dir, '--sandbox', 'read-only',
    '--approval-policy', 'never', '--ephemeral', '--model', 'gpt-5-codex',
    '--gate-prompt-sha256', sha256(readFileSync(promptPath)),
    '--gate-retry-prompt-sha256', sha256(readFileSync(retryPath)), '--gate', 'review']);
  const out = JSON.parse(r0.stdout);
  SPAWNED.push(out.socket);
  writeFileSync(join(stateDir, 'start.json'), r0.stdout);
  // Send ONLY the retry — a legitimate helper never does this.
  await cli(['send', '--prompt-file', retryPath, '--socket', out.socket]);
  await cli(['wait', '--socket', out.socket, '--timeout-ms', '20000']);
  const s = { stateDir, socket: out.socket, start: out, artifact: join(stateDir, 'artifact.md') };
  const r = await collect(args(s, 'review'));
  assert.equal(r.body.reason, 'prompt_mismatch');
  assert.equal(r.body.stopped, true);
});

test('the re-ask guard binds to prompts that RAN, not to the turn counter', async () => {
  // Two consecutive re-ask turns used to satisfy the old "turnToken >= 2" heuristic — a session that
  // never ran the real brief could have a genuine completed retry turn attest it. The daemon now
  // records which approved prompts actually started turns; the collector demands the primary.
  const dir = repo();
  const mk = async () => {
    const stateDir = tmp();
    const promptPath = join(stateDir, 'prompt');
    const retryPath = join(stateDir, 'retry');
    writeFileSync(promptPath, 'REVIEWPLAN the real brief\n');
    writeFileSync(retryPath, 'REVIEWPLAN output the review NOW\n');
    const r0 = await cli(['start', '--private', '--cwd', dir, '--sandbox', 'read-only',
      '--approval-policy', 'never', '--ephemeral', '--model', 'gpt-5-codex',
      '--gate-prompt-sha256', sha256(readFileSync(promptPath)),
      '--gate-retry-prompt-sha256', sha256(readFileSync(retryPath)), '--gate', 'review']);
    const out = JSON.parse(r0.stdout);
    SPAWNED.push(out.socket);
    writeFileSync(join(stateDir, 'start.json'), r0.stdout);
    return { stateDir, promptPath, retryPath, socket: out.socket, start: out, artifact: join(stateDir, 'artifact.md') };
  };

  // The forgery: the re-ask twice. turnToken reaches 2, but the primary never ran.
  const forged = await mk();
  for (let i = 0; i < 2; i++) {
    await cli(['send', '--prompt-file', forged.retryPath, '--socket', forged.socket]);
    await cli(['wait', '--socket', forged.socket, '--timeout-ms', '20000']);
  }
  const r1 = await collect(args(forged, 'review'));
  assert.equal(r1.body.reason, 'prompt_mismatch');
  assert.equal(r1.body.stopped, true);
  assert.match(r1.stderr, /primary brief never ran/);

  // The legit shape the guard must not break: primary, then the retry — the retry's turn attests.
  const legit = await mk();
  for (const p of [legit.promptPath, legit.retryPath]) {
    await cli(['send', '--prompt-file', p, '--socket', legit.socket]);
    await cli(['wait', '--socket', legit.socket, '--timeout-ms', '20000']);
  }
  const r2 = await collect(args(legit, 'review'));
  assert.equal(r2.code, 0, `${r2.stdout}${r2.stderr}`);
  assert.equal(r2.body.turnToken, 2);
});

test('--prompt binds the record end-to-end: wrong prompt, or a plan that was never inlined, refuses', async () => {
  // The failure this catches is not an attack but a dispatcher that followed the recipe imperfectly:
  // without inlining, "reviewed against the plan" would be attested for a review that never saw it.
  const dir = repo();
  const planPath = join(dir, 'plan.md');
  writeFileSync(planPath, '# plan\n- the load-bearing constraint\n');
  const withPlan = await gateSession(dir, `REVIEWPLAN judge this\n=== PLAN ===\n${readFileSync(planPath, 'utf8')}`);
  await drive(withPlan);
  const good = await collect(args(withPlan, 'review', ['--prompt', withPlan.promptPath, '--plan', planPath]));
  assert.equal(good.code, 0, `${good.stdout}${good.stderr}`);
  const record = JSON.parse(readFileSync(join(withPlan.stateDir, 'attestation.json'), 'utf8'));
  assert.equal(record.prompt.verified, true);

  // Same session shape, but the prompt never contained the plan.
  const without = await gateSession(dir, 'REVIEWPLAN judge this with no plan inlined\n');
  await drive(without);
  const bad = await collect(args(without, 'review', ['--prompt', without.promptPath, '--plan', planPath]));
  assert.equal(bad.body.reason, 'unusable_plan');
  assert.equal(bad.body.stopped, true);

  // A --prompt that is not the prompt the turn ran.
  const mismatched = await gateSession(dir, 'REVIEWPLAN judge this\n');
  await drive(mismatched);
  const other = join(tmp(), 'other-prompt');
  writeFileSync(other, 'a completely different prompt\n');
  const wrong = await collect(args(mismatched, 'review', ['--prompt', other]));
  assert.equal(wrong.body.reason, 'prompt_mismatch');
  assert.equal(wrong.body.stopped, true);
});
