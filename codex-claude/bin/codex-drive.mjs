#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs, toCommand } from '../lib/verbs.mjs';
import { sendCommand } from '../lib/client.mjs';
import { StateStore } from '../lib/state.mjs';
import { Daemon } from '../lib/daemon.mjs';

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

  const state = store.readState();
  if (!state) { fail('no active session; run `codex-drive start` first'); }
  const cmd = toCommand(parsed);
  // --timeout-ms is a client-side per-call wall-clock cap (mainly for `wait`): if the daemon
  // doesn't respond in time, report {status:"timeout"} so an unattended orchestrator can interrupt.
  const timeoutMs = parsed.flags['timeout-ms'] ? Number(parsed.flags['timeout-ms']) : 0;
  let res;
  try {
    res = await sendCommand(state.socket, cmd, { timeoutMs });
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
  if (parsed.verb === 'read' && parsed.flags.out && res && typeof res.message === 'string' && res.message.trim()) {
    const abs = resolve(state.cwd || process.cwd(), String(parsed.flags.out));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, res.message.endsWith('\n') ? res.message : res.message + '\n');
  }
  process.stdout.write(JSON.stringify(res) + '\n');
  if (res.error) process.exit(2);
}

async function startDaemon(parsed, store) {
  const cwd = parsed.flags.cwd || process.cwd();
  // Idempotency: do NOT silently clobber a LIVE session — that orphans its detached codex app-server.
  // Probe the recorded socket; if a daemon answers, refuse (or, with --force, stop it first).
  const existing = store.readState();
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
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__daemon', JSON.stringify({ socketPath, resume: resumeId, model: parsed.flags.model })], {
    detached: true, stdio: 'ignore', cwd,
  });
  child.unref();

  for (let i = 0; i < 50 && !existsSync(socketPath); i++) await delay(100);
  if (!existsSync(socketPath)) fail('daemon did not come up');

  const status = await sendCommand(socketPath, { cmd: 'status' });
  const threadId = status.threadId;
  store.writeState({ threadId, pid: child.pid, socket: socketPath, cwd, model: parsed.flags.model || null });
  process.stdout.write(JSON.stringify({ ok: true, threadId, socket: socketPath, pid: child.pid }) + '\n');
}

function fail(msg) { process.stderr.write(`codex-drive: ${msg}\n`); process.exit(1); }

main().catch((e) => fail(e.message));
