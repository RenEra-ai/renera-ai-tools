#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs, toCommand, parseStartProfile } from '../lib/verbs.mjs';
import { sendCommand } from '../lib/client.mjs';
import { StateStore } from '../lib/state.mjs';
import { Daemon } from '../lib/daemon.mjs';
import { testAppServerOpts } from '../lib/test-appserver.mjs';

const CLIENT_INFO = { name: 'codex-drive', version: '0.1.0' };

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
    await daemon.start();
    process.on('SIGTERM', () => daemon.stop().then(() => process.exit(0)));
    return; // keep process alive via the listening socket
  }

  const parsed = parseArgs(argv);
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
  if ('timeout-ms' in parsed.flags && typeof parsed.flags['timeout-ms'] !== 'string') fail('--timeout-ms requires a value');
  const timeoutMs = parsed.flags['timeout-ms'] ? Number(parsed.flags['timeout-ms']) : 0;
  if (timeoutMs && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) fail('--timeout-ms must be a positive number');
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
  // Normalize to an ABSOLUTE path: a relative `--cwd repo` is anchored to the start-time process cwd
  // (where the daemon is also spawned), so `state.cwd` stays a stable absolute anchor. Later consumers —
  // `read --out` artifact resolution and `--resume-latest` thread-index matching — then can't drift to a
  // different caller cwd.
  const cwd = resolve(parsed.flags.cwd || process.cwd());
  // --private: a self-owned session that neither reads nor writes the global state. Without it the
  // long-review fallback cannot work as documented — its own `start` would refuse whenever ANY
  // unrelated session is live (below), while itself clobbering state.json for everyone else. The
  // caller keeps the printed socket and passes --socket to every later verb.
  const isPrivate = parsed.flags.private === true;
  if ('private' in parsed.flags && !isPrivate) fail('--private is a boolean flag and takes no value');

  // Idempotency: do NOT silently clobber a LIVE session — that orphans its detached codex app-server.
  // Probe the recorded socket; if a daemon answers, refuse (or, with --force, stop it first).
  const existing = isPrivate ? null : store.readState();
  if (existing && existing.socket) {
    let live = false;
    try { await sendCommand(existing.socket, { cmd: 'status' }, { timeoutMs: 2000 }); live = true; } catch { /* stale/dead socket → safe to replace */ }
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
  const socketPath = join(store.baseDir, `daemon-${process.pid}-${Date.now()}.sock`);
  const payload = JSON.stringify({ socketPath, resume: resumeId, model: parsed.flags.model, cwd, profile });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__daemon', payload], {
    detached: true, stdio: 'ignore', cwd,
  });
  child.unref();

  for (let i = 0; i < 50 && !existsSync(socketPath); i++) await delay(100);
  if (!existsSync(socketPath)) fail('daemon did not come up');

  const status = await sendCommand(socketPath, { cmd: 'status' });
  const threadId = status.threadId;
  // A --private session stays out of the global record entirely: nothing to clobber, nothing to
  // leave behind pointing at a daemon its owner will stop.
  if (!isPrivate) store.writeState({ threadId, pid: child.pid, socket: socketPath, cwd, model: parsed.flags.model || null });
  process.stdout.write(JSON.stringify({ ok: true, threadId, socket: socketPath, pid: child.pid, cwd, private: isPrivate }) + '\n');
}

function fail(msg) { process.stderr.write(`codex-drive: ${msg}\n`); process.exit(1); }

main().catch((e) => fail(e.message));
