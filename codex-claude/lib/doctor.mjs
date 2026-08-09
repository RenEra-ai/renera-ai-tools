import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sendCommand } from './client.mjs';

export function parseVersion(text) {
  const m = /(\d+\.\d+\.\d+)/.exec(text);
  return m ? m[1] : null;
}

// rows: [{id, cwd, archived, updated_at_ms}]
export function latestThreadIdFromIndex(rows, cwd) {
  const candidates = rows
    .filter((r) => !r.archived && (!cwd || r.cwd === cwd))
    .sort((a, b) => b.updated_at_ms - a.updated_at_ms);
  return candidates.length ? candidates[0].id : null;
}

export function checkAuth() {
  return existsSync(join(homedir(), '.codex', 'auth.json'));
}

export function codexVersion() {
  try { return parseVersion(execFileSync('codex', ['--version'], { encoding: 'utf8' })); }
  catch { return null; }
}

// Reads the threads table read-only via the `sqlite3` CLI if available; returns [] otherwise.
export function readThreadRows() {
  const db = join(homedir(), '.codex', 'state_5.sqlite');
  if (!existsSync(db)) return [];
  try {
    const out = execFileSync('sqlite3', ['-readonly', '-json', db,
      'SELECT id, cwd, archived, updated_at_ms FROM threads'], { encoding: 'utf8' });
    return JSON.parse(out || '[]');
  } catch { return []; }
}

/**
 * Enumerate LIVE detached daemons by probing every socket in the drive dir.
 *
 * Why: a --private daemon deliberately never touches the global state file, so its socket file is
 * its ONLY on-disk trace — and an orphan (agent died before `stop`) keeps running its turn to
 * completion with nothing anywhere to surface it (docs/bugs/gate-orphaned-completed-turn.md: a
 * finished 17-minute review sat unreachable behind exactly such a socket while the dispatcher told
 * the user no turn had ever been sent). Visibility, not termination: no TTL and no reaper, by
 * design — an ultra turn is legitimately silent for long stretches, so any idle-killer would
 * destroy precisely the turns the detached design exists to protect.
 *
 * Socket FILES that are provably dead (nothing listening: ENOENT/ECONNREFUSED — the same
 * distinction `start` relies on before replacing a recorded session) are pruned. Anything else — a
 * wedged or merely slow daemon included — is reported with its error and left alone.
 *
 * Never throws; a missing dir is an empty list. {baseDir, timeoutMs} are injectable for tests.
 */
export async function listLiveDaemons({ baseDir = join(homedir(), '.codex-drive'), timeoutMs = 1500 } = {}) {
  let names = [];
  try { names = readdirSync(baseDir).filter((f) => f.endsWith('.sock')); } catch { return []; }
  const deadCode = (e) => e && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED');
  const probes = names.map(async (name) => {
    const socket = join(baseDir, name);
    // Only a real socket may ever be probed-and-pruned: a `.sock`-NAMED regular file yields a
    // platform-dependent errno (ENOTSOCK on Darwin, ECONNREFUSED on Linux), and on the latter the
    // prune rule would delete a file that was never a daemon's.
    try { if (!lstatSync(socket).isSocket()) return { socket, error: 'not a socket' }; }
    catch (e) {
      if (e && e.code === 'ENOENT') return null;   // vanished between readdir and lstat: already gone
      return { socket, error: e.message };         // EACCES etc: reported, never silently omitted
    }
    let st;
    try {
      st = await sendCommand(socket, { cmd: 'status' }, { timeoutMs });
    } catch (e) {
      if (!deadCode(e)) return { socket, error: e.message };   // timeout etc: possibly live, never pruned
      // Confirm before pruning: a momentarily swamped listener (full backlog) can refuse one
      // connect and still be alive — one refused probe must never cost a live daemon its socket.
      await new Promise((r) => setTimeout(r, 150));
      try {
        st = await sendCommand(socket, { cmd: 'status' }, { timeoutMs });
      } catch (e2) {
        if (!deadCode(e2)) return { socket, error: e2.message };
        try { unlinkSync(socket); } catch { /* best effort */ }
        return null;   // provably dead twice: pruned and omitted
      }
    }
    // A reply that parses but is not an object (JSON `null`, a bare string) would throw on the
    // field reads below — inside the probe's async fn, which would reject Promise.all and violate
    // the never-throws contract.
    if (!st || typeof st !== 'object') return { socket, error: 'malformed status reply' };
    if (st.error) return { socket, error: String(st.error) };
    return {
      socket,
      ...(Number.isInteger(st.pid) ? { pid: st.pid } : {}),   // pre-1.8.21 daemons report none
      threadId: st.threadId ?? null,
      turnStatus: st.turnStatus ?? null,
      cwd: st.cwd ?? null,
      lastEventAgoMs: st.lastEventAgoMs ?? null,
    };
  });
  return (await Promise.all(probes)).filter(Boolean);
}

export async function doctorReport(opts = {}) {
  return {
    codexVersion: codexVersion(),
    authPresent: checkAuth(),
    threads: readThreadRows().length,
    daemons: await listLiveDaemons(opts),
  };
}
