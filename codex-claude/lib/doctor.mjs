import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

export function doctorReport() {
  return {
    codexVersion: codexVersion(),
    authPresent: checkAuth(),
    threads: readThreadRows().length,
  };
}
