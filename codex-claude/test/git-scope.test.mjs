import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveReviewTarget, buildNativeReviewTarget, detectDefaultBranch } from '../lib/git-scope.mjs';
import { git, makeRepo } from './fixtures/helpers.mjs';

// Real temp-dir git fixtures: the module's whole job is talking to git, so a mock would only test
// our idea of git rather than git. Clean-by-default here (most scope rules key off a clean tree),
// which is the one place this suite differs from the shared default.
const repo = (opts = {}) => makeRepo({ dirty: false, prefix: 'cdx-gs-', ...opts });

test('auto on a dirty tree -> working-tree', () => {
  const { dir } = repo({ dirty: true });
  const r = resolveReviewTarget(dir, {});
  assert.equal(r.mode, 'working-tree');
  assert.equal(r.explicit, false);
  assert.deepEqual(buildNativeReviewTarget(r), { type: 'uncommittedChanges' });
  rmSync(dir, { recursive: true, force: true });
});

test('auto counts UNTRACKED files as dirty (the native target reviews untracked too)', () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'brand-new.txt'), 'x\n');   // untracked only
  assert.equal(resolveReviewTarget(dir, {}).mode, 'working-tree');
  rmSync(dir, { recursive: true, force: true });
});

test('auto on a clean tree with no default-branch delta errors rather than reviewing nothing', () => {
  // On `main`, clean: the detected default IS HEAD, so a branch review would cover nothing.
  const { dir } = repo();
  assert.throws(() => resolveReviewTarget(dir, {}), /nothing to review/);
  rmSync(dir, { recursive: true, force: true });
});

test('auto on a clean tree ahead of the default branch -> branch diff', () => {
  const { dir } = repo();
  git(dir, 'checkout', '-qb', 'feature');
  writeFileSync(join(dir, 'b.txt'), 'feat\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'feature work');
  const r = resolveReviewTarget(dir, {});
  assert.equal(r.mode, 'branch');
  assert.equal(r.baseRef, 'main');
  assert.equal(r.explicit, false);
  assert.deepEqual(buildNativeReviewTarget(r), { type: 'baseBranch', branch: 'main' });
  rmSync(dir, { recursive: true, force: true });
});

test('explicit --base SHA resolves to a full immutable sha', () => {
  const { dir, first } = repo();
  const r = resolveReviewTarget(dir, { base: first.slice(0, 7) });
  assert.equal(r.mode, 'branch');
  assert.equal(r.baseRef, first);                 // pinned full sha, not the abbreviation
  assert.equal(buildNativeReviewTarget(r).branch, first);
  rmSync(dir, { recursive: true, force: true });
});

test('--base that does not resolve errors (before any daemon boot)', () => {
  const { dir } = repo();
  assert.throws(() => resolveReviewTarget(dir, { base: 'nosuchref123' }), /does not resolve/);
  rmSync(dir, { recursive: true, force: true });
});

test('--base === HEAD errors: there is nothing committed to review', () => {
  // Caught explicitly rather than via the delta check: HEAD is its own ancestor, and on a DIRTY tree
  // `git diff HEAD` even reports a delta — so it would sail through as a "branch diff against HEAD"
  // that is really just a working-tree review wearing the wrong label.
  const { dir, head } = repo();
  assert.throws(() => resolveReviewTarget(dir, { base: head }), /is HEAD itself/);
  const dirty = repo({ dirty: true });
  assert.throws(() => resolveReviewTarget(dirty.dir, { base: dirty.head }), /is HEAD itself/);
  rmSync(dir, { recursive: true, force: true });
  rmSync(dirty.dir, { recursive: true, force: true });
});

test('an ancestor base whose changes were reverted errors: an empty delta is never a clean review', () => {
  // Resolves, is a strict ancestor, and still yields nothing — the case the delta check exists for.
  const { dir } = repo();
  writeFileSync(join(dir, 'a.txt'), 'three\n');
  git(dir, 'commit', '-aqm', 'third');
  const base = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.txt'), 'four\n');
  git(dir, 'commit', '-aqm', 'fourth');
  writeFileSync(join(dir, 'a.txt'), 'three\n');          // revert it back
  git(dir, 'commit', '-aqm', 'revert to third');
  assert.notEqual(git(dir, 'rev-parse', 'HEAD'), base);  // genuinely a different commit...
  assert.throws(() => resolveReviewTarget(dir, { base }), /empty delta/);  // ...with an identical tree
  rmSync(dir, { recursive: true, force: true });
});

test('a git failure (status > 1) is an error, never read as "there are changes"', () => {
  // `git diff --quiet` answers 0 (same) or 1 (differs). Anything else is git FAILING, and a bare
  // `status !== 0` test silently reports that as a delta — admitting the vacuous review outright.
  const { dir, first } = repo();
  // Corrupt the base commit's object so git errors (128) rather than answering. Loose objects are
  // written read-only, hence the chmod.
  const objPath = join(dir, '.git', 'objects', first.slice(0, 2), first.slice(2));
  chmodSync(objPath, 0o644);
  writeFileSync(objPath, 'not a git object');
  assert.throws(() => resolveReviewTarget(dir, { base: first }), /does not resolve|git diff failed|could not resolve/);
  rmSync(dir, { recursive: true, force: true });
});

test('--base that is not an ancestor of HEAD errors', () => {
  const { dir } = repo();
  git(dir, 'checkout', '-qb', 'other');
  writeFileSync(join(dir, 'c.txt'), 'other\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'other work');
  const otherHead = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  assert.throws(() => resolveReviewTarget(dir, { base: otherHead }), /not an ancestor/);
  rmSync(dir, { recursive: true, force: true });
});

test('a valueless --base (parsed as boolean true) errors instead of silently reviewing auto scope', () => {
  const { dir } = repo({ dirty: true });
  assert.throws(() => resolveReviewTarget(dir, { base: true }), /non-blank/);
  assert.throws(() => resolveReviewTarget(dir, { base: '' }), /non-blank/);
  assert.throws(() => resolveReviewTarget(dir, { base: '   ' }), /non-blank/);
  rmSync(dir, { recursive: true, force: true });
});

test('--base and --scope together are a hard error (no precedence rule)', () => {
  const { dir } = repo({ dirty: true });
  assert.throws(() => resolveReviewTarget(dir, { base: 'main', scope: 'working-tree' }), /mutually exclusive/);
  rmSync(dir, { recursive: true, force: true });
});

test('an unknown --scope errors; a valueless --scope (boolean true) errors too', () => {
  const { dir } = repo({ dirty: true });
  assert.throws(() => resolveReviewTarget(dir, { scope: 'bogus' }), /invalid --scope/);
  assert.throws(() => resolveReviewTarget(dir, { scope: true }), /invalid --scope/);
  rmSync(dir, { recursive: true, force: true });
});

test('--scope working-tree on a clean tree errors rather than reviewing nothing', () => {
  const { dir } = repo();
  assert.throws(() => resolveReviewTarget(dir, { scope: 'working-tree' }), /nothing to review/);
  rmSync(dir, { recursive: true, force: true });
});

test('detached HEAD is NOT an error — it resolves normally', () => {
  const { dir, first } = repo();
  git(dir, 'checkout', '-q', first);              // detach on a CLEAN tree, then dirty it
  writeFileSync(join(dir, 'a.txt'), 'one\nDIRTY\n');
  const r = resolveReviewTarget(dir, {});
  assert.equal(r.mode, 'working-tree');           // dirty -> working tree, no throw
  rmSync(dir, { recursive: true, force: true });
});

test('outside a git repo -> error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-nogit-'));
  assert.throws(() => resolveReviewTarget(dir, {}), /not a git repository/);
  rmSync(dir, { recursive: true, force: true });
});

test('a repo-local status.showUntrackedFiles=no does NOT hide a dirty tree', () => {
  // Without an explicit --untracked-files=normal this config makes `git status --porcelain` return
  // empty, routing auto to a branch review that misses the very work under review.
  const { dir } = repo();
  git(dir, 'config', 'status.showUntrackedFiles', 'no');
  writeFileSync(join(dir, 'untracked.txt'), 'x\n');
  assert.equal(git(dir, 'status', '--porcelain'), '');       // proves the config is active
  assert.equal(resolveReviewTarget(dir, {}).mode, 'working-tree');
  rmSync(dir, { recursive: true, force: true });
});

test('inherited GIT_DIR/GIT_WORK_TREE cannot move the review scope', () => {
  const a = repo({ dirty: true });
  const b = repo();                        // a DIFFERENT repo, clean
  const saved = { ...process.env };
  try {
    // Point the environment at repo B while asking about repo A. Unscrubbed, git would honour these.
    process.env.GIT_DIR = join(b.dir, '.git');
    process.env.GIT_WORK_TREE = b.dir;
    const r = resolveReviewTarget(a.dir, {});
    assert.equal(r.mode, 'working-tree');  // still A's dirty tree, not B's clean one
  } finally {
    delete process.env.GIT_DIR; delete process.env.GIT_WORK_TREE;
    Object.assign(process.env, saved);
  }
  rmSync(a.dir, { recursive: true, force: true });
  rmSync(b.dir, { recursive: true, force: true });
});

test('inherited GIT_CONFIG_COUNT/KEY/VALUE cannot reconfigure the review scope', () => {
  // Live-verified injection channel: GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=... GIT_CONFIG_VALUE_0=...
  // sets config for the child. Here it would flip showUntrackedFiles and hide the dirty tree.
  const { dir } = repo();
  writeFileSync(join(dir, 'untracked.txt'), 'x\n');
  const saved = { ...process.env };
  try {
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'status.showUntrackedFiles';
    process.env.GIT_CONFIG_VALUE_0 = 'no';
    assert.equal(resolveReviewTarget(dir, {}).mode, 'working-tree');   // scrubbed -> still dirty
  } finally {
    delete process.env.GIT_CONFIG_COUNT; delete process.env.GIT_CONFIG_KEY_0; delete process.env.GIT_CONFIG_VALUE_0;
    Object.assign(process.env, saved);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('a --base value with shell metacharacters is one literal argv token, never executed', () => {
  const { dir } = repo({ dirty: true });
  const canary = join(dir, 'pwned.txt');
  assert.throws(() => resolveReviewTarget(dir, { base: `main; touch ${canary}` }), /does not resolve/);
  assert.throws(() => resolveReviewTarget(dir, { base: '$(touch /tmp/cdx-pwned)' }), /does not resolve/);
  rmSync(dir, { recursive: true, force: true });
});

test('buildNativeReviewTarget throws on unimplemented/malformed modes (never returns null)', () => {
  assert.throws(() => buildNativeReviewTarget({ mode: 'commit', sha: 'x' }), /unsupported mode/);
  assert.throws(() => buildNativeReviewTarget({ mode: 'custom' }), /unsupported mode/);
  assert.throws(() => buildNativeReviewTarget({ mode: 'branch' }), /requires a baseRef/);
  assert.throws(() => buildNativeReviewTarget(null), /missing resolved scope/);
});

test('detectDefaultBranch prefers a bare local name over origin/<c>', () => {
  // Bare `main` is preferred because `main@{upstream}` works while `origin/main@{upstream}` -> fatal,
  // which matters if the reviewer's @{upstream} prompt template is ever selected.
  const { dir } = repo();
  assert.equal(detectDefaultBranch(dir), 'main');
  rmSync(dir, { recursive: true, force: true });
});

test('detectDefaultBranch errors when no candidate exists', () => {
  const { dir } = repo({ branch: 'weird-name' });
  assert.throws(() => detectDefaultBranch(dir), /could not detect the default branch/);
  rmSync(dir, { recursive: true, force: true });
});
