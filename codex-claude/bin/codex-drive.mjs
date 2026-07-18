#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { parseArgs, toCommand, parseStartProfile, assertKnownFlags } from '../lib/verbs.mjs';
import { sendCommand } from '../lib/client.mjs';
import { StateStore } from '../lib/state.mjs';
import { Daemon } from '../lib/daemon.mjs';
import { testAppServerOpts } from '../lib/test-appserver.mjs';
import { CLIENT_INFO } from '../lib/protocol.mjs';


async function main() {
  const argv = process.argv.slice(2);

  // Internal: detached daemon process entrypoint.
  if (argv[0] === '__daemon') {
    const opts = JSON.parse(argv[1]);
    const daemon = new Daemon({
      socketPath: opts.socketPath,
      clientInfo: CLIENT_INFO,
      resume: opts.resume,
      model: opts.model,
      // The profile MUST ride the payload: without it this detached daemon would record none and
      // every `review` on the session would be refused wrong_thread_profile.
      cwd: opts.cwd,
      profile: opts.profile,
      // Env is inherited through the detached spawn (it passes no `env`), so the same gated test
      // seam the one-shot uses also reaches here — which is what makes the detached path testable
      // offline at all.
      appServerOpts: testAppServerOpts(),
    });
    try {
      await daemon.start();
    } catch (e) {
      // Nothing reads this process's stderr (the parent spawns it with stdio:'ignore'), so leave the
      // reason on disk beside the socket. Without this, a bind failure, a bad seam or a spawn error
      // were all indistinguishable from "it was just slow".
      try { writeFileSync(`${opts.socketPath}.err`, String((e && e.message) || e)); } catch { /* nothing left to try */ }
      process.exit(1);
    }
    process.on('SIGTERM', () => daemon.stop().then(() => process.exit(0)));
    return; // keep process alive via the listening socket
  }

  const parsed = parseArgs(argv);

  // NOTE: the StateStore is constructed AFTER validation below — its constructor mkdirs
  // ~/.codex-drive, which is itself an observable side effect. Creating it here meant a rejected
  // `start --help` still touched a clean HOME.

  // `doctor` and `start` return before toCommand(), which is where assertKnownFlags normally runs —
  // so validate here, BEFORE anything observable happens. For `start` that means before the profile
  // is parsed, before the existing-session probe, and before any spawn: `start --help` used to
  // print no help, boot a real daemon and overwrite the global state file, exiting 0.
  if (parsed.verb === 'doctor' || parsed.verb === 'start') {
    try { assertKnownFlags(parsed.verb, parsed.flags); } catch (e) { fail(e.message); }
    // A positional here is a forgotten flag name, never an argument: `start /some/repo` silently
    // anchored the daemon to the caller's cwd instead of that path.
    if (parsed.positional !== undefined) {
      fail(`verb '${parsed.verb}' takes no positional argument (got '${parsed.positional}')`);
    }
  }

  // Only now, once the verb and its flags are known-good, may we touch the filesystem.
  const store = new StateStore();

  if (parsed.verb === 'doctor') {
    const { doctorReport } = await import('../lib/doctor.mjs');
    process.stdout.write(JSON.stringify(doctorReport(), null, 2) + '\n');
    return;
  }

  if (parsed.verb === 'start') {
    return startDaemon(parsed, store);
  }

  // --socket <path> talks to a specific daemon, bypassing the single mutable ~/.codex-drive/state.json.
  // That file is global: a concurrent `start` by any other process rewrites it and would silently
  // redirect this session's wait/read/stop at someone else's daemon. Resolved BEFORE the state guard,
  // since a --socket caller needs no global state at all.
  const socketFlag = parsed.flags.socket;
  if ('socket' in parsed.flags && (typeof socketFlag !== 'string' || !socketFlag.trim())) {
    fail('--socket requires a path');
  }
  const state = socketFlag ? null : store.readState();
  if (!socketFlag && !state) { fail('no active session; run `codex-drive start` first (or pass --socket <path>)'); }
  const socket = socketFlag || state.socket;
  const cmd = toCommand(parsed);
  // --timeout-ms is a client-side per-call wall-clock cap (mainly for `wait`): if the daemon
  // doesn't respond in time, report {status:"timeout"} so an unattended orchestrator can interrupt.
  // A valueless --timeout-ms would otherwise be Number(true) === 1, i.e. a 1ms cap that reports an
  // instant bogus timeout — and the long-review fallback recipe leans on this flag.
  // Validate on PRESENCE, never on truthiness: `--timeout-ms abc` -> Number('abc') === NaN, and NaN
  // is falsy, so a truthiness-gated check skips itself and the cap silently becomes "none" — the
  // opposite of what was asked for, on the flag the long-review fallback depends on.
  let timeoutMs = 0;
  if ('timeout-ms' in parsed.flags) {
    const raw = parsed.flags['timeout-ms'];
    if (typeof raw !== 'string') fail('--timeout-ms requires a value');
    timeoutMs = Number(raw);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail(`--timeout-ms must be a positive number (got '${raw}')`);
  }
  let res;
  try {
    res = await sendCommand(socket, cmd, { timeoutMs });
  } catch (e) {
    if (/timeout/i.test(e.message)) { process.stdout.write(JSON.stringify({ status: 'timeout' }) + '\n'); process.exit(2); }
    throw e;
  }
  // Subagent-mode plan persistence: `read --out <path>` writes the completed turn's verbatim message to
  // a durable file (the JSON object still goes to stdout so the caller parses it exactly as before). The
  // orchestrator uses this to persist the approved architect plan to `.codex/plans/issue-<N>.md` — the
  // workflow-mode counterpart of plan-round.mjs's --out. Only a non-empty message is written. A RELATIVE
  // --out resolves against the daemon's recorded cwd (`state.cwd`, set at `start`), NOT this process's
  // cwd — so the artifact lands in the repo the daemon runs against even if the caller cd'd elsewhere.
  if (parsed.verb === 'read' && 'out' in parsed.flags) {
    // A valueless --out is truthy but not a path: String(true) would write a file literally named
    // "true" into the daemon's repo.
    if (typeof parsed.flags.out !== 'string' || !parsed.flags.out.trim()) fail('--out requires a path');
    if (res && typeof res.message === 'string' && res.message.trim()) {
      // Prefer the DAEMON's own cwd (it now reports it on read/status) over state.cwd: with --socket
      // there is no state.json to consult, and a stale/foreign one would anchor the artifact in the
      // wrong repo. Fail closed rather than silently falling back to this process's cwd.
      const base = res.cwd || (state && state.cwd);
      if (!base) fail('daemon did not report a cwd; cannot resolve a relative --out');
      const abs = resolve(base, parsed.flags.out);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, res.message.endsWith('\n') ? res.message : res.message + '\n');
    }
  }
  process.stdout.write(JSON.stringify(res) + '\n');
  if (res.error) process.exit(2);
}

async function startDaemon(parsed, store) {
  // FIRST, before anything observable happens: validate the flags. Not merely before the spawn —
  // before the existing-session probe below, which with --force STOPS that session. Validating later
  // means `start --force --sandbox bogus` destroys an unrelated live session and only then errors.
  let profile;
  try {
    profile = parseStartProfile(parsed.flags);
  } catch (e) {
    fail(e.message);
  }
  // Validate the test seam HERE, in the parent. The detached child calls testAppServerOpts() too —
  // authoritatively — but its stdio is 'ignore', so a seam misconfiguration (CODEX_DRIVE_TEST_APPSERVER
  // set without CODEX_DRIVE_TEST_MODE=1, malformed JSON, a relative command) threw into /dev/null and
  // the caller saw only a generic 'daemon did not come up' five seconds later.
  try { testAppServerOpts(); } catch (e) { fail(e.message); }
  // Normalize to an ABSOLUTE path: a relative `--cwd repo` is anchored to the start-time process cwd
  // (where the daemon is also spawned), so `state.cwd` stays a stable absolute anchor. Later consumers —
  // `read --out` artifact resolution and `--resume-latest` thread-index matching — then can't drift to a
  // different caller cwd.
  const cwd = resolve(parsed.flags.cwd || process.cwd());
  // --private: a self-owned session that neither reads nor writes the global state. Without it the
  // long-review fallback cannot work as documented — its own `start` would refuse whenever ANY
  // unrelated session is live (below), while itself clobbering state.json for everyone else. The
  // caller keeps the printed socket and passes --socket to every later verb.
  // parseStartProfile already rejected a valued --private (with every other boolean-only flag),
  // and it runs BEFORE the session probe — which is the point: validating here would have meant
  // `start --force --privte` tore down a live session first and only then complained.
  const isPrivate = parsed.flags.private === true;

  // Idempotency: do NOT silently clobber a LIVE session — that orphans its detached codex app-server.
  // Probe the recorded socket; if a daemon answers, refuse (or, with --force, stop it first).
  const existing = isPrivate ? null : store.readState();
  if (existing && existing.socket) {
    let live = false;
    try {
      // 10s, not 2s: scope resolution runs a chain of synchronous git calls in the daemon, and on a
      // large or cold-cache repo that can block the event loop for several seconds. A busy daemon is
      // still a LIVE daemon.
      await sendCommand(existing.socket, { cmd: 'status' }, { timeoutMs: 10000 });
      live = true;
    } catch (e) {
      // A raised cap only moves the threshold; what matters is HOW the probe failed. Only definite
      // absence — nothing listening on that path — proves the session is gone and its state may be
      // replaced. A timeout means "busy, or wedged, but something is there", so fail CLOSED rather
      // than overwrite state.json and orphan a live daemon plus its codex app-server.
      const gone = e && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED');
      if (!gone && !parsed.flags.force) {
        fail(`a codex-drive session may still be live at ${existing.socket} (probe: ${e.message}). `
          + 'Run `codex-drive stop` to end it, or `start --force` to stop it and start fresh.');
      }
      // --force IS the documented escape hatch, so it must actually work here: refusing even with
      // --force made the error message above advertise a recovery the code then rejected. Treat the
      // unreachable session as replaceable, after one best-effort stop.
      if (!gone) {
        try { await sendCommand(existing.socket, { cmd: 'stop' }, { timeoutMs: 5000 }); } catch { /* unreachable anyway */ }
      }
    }
    if (live && !parsed.flags.force) {
      fail(`a codex-drive session is already live (pid ${existing.pid}, thread ${existing.threadId}). Run \`codex-drive stop\` first, or \`start --force\` to stop it and start fresh.`);
    }
    if (live && parsed.flags.force) {
      try { await sendCommand(existing.socket, { cmd: 'stop' }, { timeoutMs: 5000 }); } catch { /* best-effort teardown */ }
    }
  }
  // Resolve the resume thread id.
  let resumeId = parsed.flags.resume || null;
  if (parsed.flags['resume-latest']) {
    const { readThreadRows, latestThreadIdFromIndex } = await import('../lib/doctor.mjs');
    resumeId = latestThreadIdFromIndex(readThreadRows(), cwd);
    if (!resumeId) fail('no resumable thread found for this cwd');
  }
  // Spawn the detached daemon ONCE on a unique socket, then ask it for its real threadId.
  // (No probe: a probe spawned a throwaway thread whose id disagreed with the real daemon's.)
  // SHORT on purpose: macOS caps Unix socket paths at 104 bytes, and the old
  // `daemon-<pid>-<ms>.sock` (31 chars) pushed a temp-HOME path to 109 — bind() then failed inside
  // the stdio-ignored child, surfacing only as "daemon did not come up". base36 keeps it unique.
  const socketPath = join(store.baseDir, `d-${process.pid}-${Date.now().toString(36)}.sock`);
  const payload = JSON.stringify({ socketPath, resume: resumeId, model: parsed.flags.model, cwd, profile });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__daemon', payload], {
    detached: true, stdio: 'ignore', cwd,
  });
  // Keep OWNERSHIP through the handshake. unref'ing here and then bailing on a failed startup would
  // leave a detached daemon (and its codex app-server) running with nobody holding its socket —
  // exactly the orphan this file's idempotency guard exists to prevent.
  const abort = (msg) => { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } } fail(msg); };

  for (let i = 0; i < 50 && !existsSync(socketPath); i++) await delay(100);
  if (!existsSync(socketPath)) {
    // The child's stdio is 'ignore', so its real failure was invisible and every boot problem looked
    // identical. It now leaves the reason next to the socket path; read it before giving up.
    let why = '';
    try {
      if (existsSync(`${socketPath}.err`)) {
        why = `: ${readFileSync(`${socketPath}.err`, 'utf8').trim()}`;
        unlinkSync(`${socketPath}.err`);
      }
    } catch { /* best effort — the generic message still gets through */ }
    abort(`daemon did not come up${why}`);
  }

  let status;
  try {
    status = await sendCommand(socketPath, { cmd: 'status' });
  } catch (e) {
    abort(`daemon came up but did not answer status: ${e.message}`);
  }
  if (!status || !status.threadId) abort('daemon did not report a threadId');
  child.unref();   // only now is it a healthy session someone can address
  const threadId = status.threadId;
  // A --private session stays out of the global record entirely: nothing to clobber, nothing to
  // leave behind pointing at a daemon its owner will stop.
  if (!isPrivate) store.writeState({ threadId, pid: child.pid, socket: socketPath, cwd, model: parsed.flags.model || null });
  process.stdout.write(JSON.stringify({ ok: true, threadId, socket: socketPath, pid: child.pid, cwd, private: isPrivate }) + '\n');
}

function fail(msg) { process.stderr.write(`codex-drive: ${msg}\n`); process.exit(1); }

main().catch((e) => fail(e.message));
