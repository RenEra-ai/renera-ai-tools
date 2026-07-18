// Shared test fixtures. Four copies of these builders had drifted apart (different `dirty`
// defaults, different return shapes, one making a single commit) — so a git-environment fix had to
// be repeated four times and a miss only failed on the machine that hit it.
//
// NOT named *.test.mjs on purpose: `npm test` globs test/*.test.mjs, and this file has no tests.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * A real temp-dir git repo. Real git, not a mock: the code under test shells out for real, so a
 * mock would only test our idea of git.
 *
 * TWO commits deliberately: with one, `first` IS HEAD and a --base test would exercise the
 * base-is-HEAD rejection instead of a real branch diff.
 *
 * @returns {{dir: string, first: string, head: string}}
 */
export function makeRepo({ dirty = true, branch = 'main', prefix = 'cdx-t-' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 'T');
  // A machine with global commit.gpgsign=true otherwise fails every commit here — the exact
  // environment fix that had to be applied per-copy before.
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'first');
  const first = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  git(dir, 'commit', '-aqm', 'second');
  const head = git(dir, 'rev-parse', 'HEAD');
  if (dirty) writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nDIRTY\n');
  return { dir, first, head };
}

// The gated offline seam every driver/CLI test runs through: no live Codex, no network.
// `fixtureArgs` are appended to the mock's argv (e.g. ['--lifecycle-file', path]).
export function seamEnv(fixturePath, mode = 'ok', extra = {}, fixtureArgs = []) {
  return {
    ...process.env,
    CODEX_DRIVE_TEST_MODE: '1',
    CODEX_DRIVE_TEST_APPSERVER: JSON.stringify([process.execPath, fixturePath, '--review-mode', mode, ...fixtureArgs]),
    ...extra,
  };
}

export function rmDir(dir) {
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

/** True while `pid` exists. EPERM means alive-but-not-ours; only ESRCH means gone. */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}

/** Poll `fn` (may be async) until truthy, or throw after `timeoutMs`. */
export async function pollUntil(fn, { timeoutMs = 8000, intervalMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`pollUntil: timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Run `fn`, then clean up every path in `dirs` — even when `fn` throws or the daemon boot inside it
 * fails partway. Assertion failures used to skip the trailing cleanup entirely, leaking temp dirs
 * and (for the detached suites) orphaning a real daemon.
 */
export async function withCleanup(dirs, fn) {
  try {
    return await fn();
  } finally {
    for (const d of dirs) rmDir(d);
  }
}
