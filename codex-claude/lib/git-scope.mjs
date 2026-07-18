// Resolve a git review scope into a native `review/start` target. Port of the openai-codex
// companion's resolveReviewTarget semantics (its lib/git.mjs:135-191), with STRICT validation.
//
// Why strict: this module is the AUTHORITATIVE validator. The CLI flag parser turns a valueless
// `--base` into boolean `true` and preserves empty strings (verbs.mjs), so truthiness is never a
// safe test — `if (base)` would accept `true` and silently review the wrong thing. Every rule below
// fails CLOSED: a bad scope is an error, never a fallback to `auto`. The one outcome we must never
// produce is a review that silently covers NOTHING and comes back clean, because the Stage-2 gate
// reads "no findings" as "ship it".
//
// Subprocess discipline: argv arrays with shell:false (never a shell string), so a `--base` value
// like `x; rm -rf /` is one literal argv token. That alone is NOT sufficient — see scrubEnv.

import { spawnSync } from 'node:child_process';

// Exported so the one-shot's usage text and preflight cannot drift from the authoritative validator
// (it used to inline its own copy of this list, and of the --base/--scope exclusivity rule).
export const SCOPES = ['auto', 'working-tree', 'branch'];
const DEFAULT_BRANCH_CANDIDATES = ['main', 'master', 'trunk'];

// git reads a LOT of its behaviour from the environment, which would silently defeat the daemon's
// "one coherent cwd" invariant even though we pass cwd explicitly. Both of these are live-verified:
//   GIT_DIR=<other>/.git git rev-parse --show-toplevel   (run from /tmp) -> /private/tmp, status 0
//   GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=INJECTED git config user.name
//                                                                       -> INJECTED
// So an attacker (or just a confused parent process) controlling env can move the repo out from
// under us, or inject config — e.g. core.excludesFile changes what counts as untracked, which
// changes the auto dirty-rule. This list is the codex binary's OWN scrub list (extracted from
// 0.144.5), preferred over a hand-rolled one because it is upstream-aligned and a strict superset.
const GIT_ENV_SCRUB = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX', 'GIT_REPLACE_REF_BASE', 'GIT_WORK_TREE',
];

function scrubEnv() {
  const env = { ...process.env };
  for (const k of GIT_ENV_SCRUB) delete env[k];
  // A fixed list cannot cover the indexed config channel (GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n>),
  // so sweep the whole prefix.
  for (const k of Object.keys(env)) if (k.startsWith('GIT_CONFIG_')) delete env[k];
  env.GIT_OPTIONAL_LOCKS = '0';   // never take the index lock: we only ever read.
  return env;
}

// Sync on purpose: the daemon awaits its command handlers, so a blocking git call is safe there,
// and sync keeps every rule below a plain readable sequence with no interleaving to reason about.
function git(cwd, args) {
  // maxBuffer well above Node's 1 MiB default: `status --porcelain --untracked-files=normal` on a
  // big dirty tree (an unignored node_modules, tens of thousands of untracked files) blows past it,
  // and spawnSync then reports ENOBUFS — which surfaced as a cryptic `spawnSync git ENOBUFS`
  // instead of a resolved working-tree scope.
  const r = spawnSync('git', args, { cwd, env: scrubEnv(), encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
  if (r.error && r.error.code === 'ENOENT') throw new Error('git is not installed');
  if (r.error) throw r.error;
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

const ok = (cwd, args) => git(cwd, args).status === 0;

function ensureRepo(cwd) {
  if (!ok(cwd, ['rev-parse', '--show-toplevel'])) {
    throw new Error(`not a git repository: ${cwd}`);
  }
}

// `--end-of-options` stops a ref that looks like a flag from being parsed as one; `^{commit}` makes
// this reject a tag/tree that isn't a commit, not merely "some object exists".
function refExists(cwd, ref) {
  return ok(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
}

/**
 * Resolve a ref to an immutable full commit SHA, or null when it does not resolve.
 *
 * Returns null rather than throwing so each call site can raise the error that fits it — the base
 * path wants "--base ref does not resolve", not a generic one. This also folds away a duplicate
 * subprocess: refExists() ran this exact `rev-parse` and threw the SHA away, purely to reword the
 * failure. EVERY caller must check for null; a null reaching .slice() or a review target is a bug.
 * @returns {string|null}
 */
export function fullSha(cwd, ref) {
  const r = git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  return r.status === 0 && r.stdout ? r.stdout : null;
}

const isAncestor = (cwd, ref) => ok(cwd, ['merge-base', '--is-ancestor', ref, 'HEAD']);

// merge-base, not the raw ref: when the base has diverged from HEAD this is what the native reviewer
// itself compares against, so our emptiness check matches what will actually be reviewed. For an
// ancestor base merge-base(HEAD, base) === base, so this generalises both cases.
function mergeBase(cwd, ref) {
  const r = git(cwd, ['merge-base', 'HEAD', ref]);
  return r.status === 0 && r.stdout ? r.stdout : null;
}

// `git diff --quiet <ref>` is exactly what the native reviewer runs (live-observed:
// `git diff 874bad72...`), so this asks the real question: will the reviewer see anything?
// It is WORKTREE-INCLUSIVE — commits plus uncommitted changes — which is the intended semantics.
//
// ONLY 0 and 1 are answers: 0 = identical, 1 = differs. Anything else (128 on a corrupt object or a
// bad ref, 129 on a usage error) is git FAILING, and a `status !== 0` test silently reads that as
// "there are changes" — admitting exactly the vacuous review this check exists to prevent.
function hasDelta(cwd, ref) {
  const r = git(cwd, ['diff', '--quiet', ref]);
  if (r.status === 0) return false;
  if (r.status === 1) return true;
  throw new Error(`git diff failed against ${ref} (status ${r.status})${r.stderr ? `: ${r.stderr}` : ''}`);
}

// Explicit --untracked-files=normal: a repo-local `status.showUntrackedFiles=no` otherwise makes a
// tree with new files report CLEAN, which would route `auto` to a branch review and silently miss
// exactly the work under review.
function isDirty(cwd) {
  const r = git(cwd, ['status', '--porcelain', '--untracked-files=normal']);
  if (r.status !== 0) throw new Error(`git status failed: ${r.stderr}`);
  return r.stdout.length > 0;
}

// Preference order is the companion's. Note origin/HEAD's answer is returned UNVERIFIED by the
// companion; we verify it like everything else and fall through to the candidates when it is stale.
export function detectDefaultBranch(cwd) {
  const sym = git(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (sym.status === 0 && sym.stdout.startsWith('refs/remotes/origin/')) {
    const name = sym.stdout.replace('refs/remotes/origin/', '');
    if (refExists(cwd, name)) return name;
    if (refExists(cwd, `origin/${name}`)) return `origin/${name}`;
  }
  // TWO passes, not one interleaved loop: ALL local candidates before ANY remote one. Interleaving
  // meant a repo whose local default is `master` but which also has a stale `origin/main` resolved
  // to `origin/main` — diffing against the wrong branch entirely.
  for (const c of DEFAULT_BRANCH_CANDIDATES) {
    if (ok(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${c}`])) return c;
  }
  for (const c of DEFAULT_BRANCH_CANDIDATES) {
    // KNOWN EDGE, deliberately not papered over: `origin/<c>` resolves locally, yet
    // `git rev-parse --abbrev-ref "origin/main@{upstream}"` -> fatal. If the reviewer's @{upstream}
    // prompt template is ever selected, an origin/<c> base fails server-side and ref-existence will
    // NOT have caught it. Bare local names are preferred above for exactly this reason; the Stage-2
    // gate never reaches here (it passes --base <sha>).
    if (ok(cwd, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${c}`])) return `origin/${c}`;
  }
  throw new Error('could not detect the default branch; pass --base <ref> or --scope working-tree');
}

const isNonBlankString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * @param {string} cwd absolute path the daemon owns
 * @param {{base?: unknown, scope?: unknown}} options raw, UNTRUSTED values straight off the CLI
 * @returns {{mode:'working-tree'|'branch', label:string, baseRef?:string}}
 */
export function resolveReviewTarget(cwd, options = {}) {
  const { base, scope } = options;
  const hasBase = base !== undefined;
  const hasScope = scope !== undefined;

  // Pure input validation first: no git needed, and the fastest possible failure.
  // Mutual exclusion before either value is inspected — deterministic, no precedence rule to learn.
  if (hasBase && hasScope) throw new Error('--base and --scope are mutually exclusive');
  if (hasBase && !isNonBlankString(base)) {
    // Catches the valueless `--base` (parsed as boolean true) and `--base ""`.
    throw new Error('--base requires a non-blank ref value');
  }
  if (hasScope && !(typeof scope === 'string' && SCOPES.includes(scope))) {
    throw new Error(`invalid --scope '${String(scope)}'; expected one of ${SCOPES.join(', ')}`);
  }

  ensureRepo(cwd);

  if (hasBase) {
    const ref = base.trim();
    // Fail here, not after a daemon boot and a full Codex turn: a typo'd --base is the single most
    // likely gate mistake, and its late failure surfaces as an unexplained blank review.
    //
    // Resolve to an immutable full SHA BEFORE any other git question is asked. Two reasons: every
    // later call then gets an unambiguous object (a ref named like `-base` can't be re-parsed as an
    // option by a command lacking --end-of-options), and the answers can't drift if the ref moves.
    // One rev-parse answers BOTH "does it exist" and "what is it" — the separate refExists() probe
    // was the identical command run twice.
    const sha = fullSha(cwd, ref);
    if (!sha) throw new Error(`--base ref does not resolve: ${ref}`);
    const head = fullSha(cwd, 'HEAD');
    // No HEAD means an unborn branch (a fresh repo with no commits): there is nothing to review
    // against, and a null here would otherwise sail into the sha===head compare and the delta check.
    if (!head) throw new Error('could not resolve HEAD (no commits yet?)');
    // base === HEAD is an ancestor of itself and, on a dirty tree, even has a delta — so neither
    // check below catches it. But "review everything since HEAD" is never what the gate means: that
    // is a working-tree review wearing a branch-diff label. Say so explicitly.
    if (sha === head) {
      throw new Error(`--base ${ref} is HEAD itself (nothing committed to review); use --scope working-tree for uncommitted work`);
    }
    // Strict ancestry: the gate's baseline is a commit on this branch by construction, so a
    // non-ancestor means the caller GUESSED wrong (e.g. picked a SHA off another branch) and the
    // reviewer would silently widen scope through the merge base. Diverged-branch semantics are a
    // legitimate want — they are what `--scope branch` is for.
    if (!isAncestor(cwd, sha)) {
      throw new Error(`--base ${ref} is not an ancestor of HEAD; use --scope branch for a diverged base`);
    }
    // The point of the delta check: a base can resolve, be a strict ancestor, and STILL yield
    // nothing (e.g. a commit whose changes were reverted) — a review that comes back clean having
    // read no changes. Never let that reach the gate.
    if (!hasDelta(cwd, sha)) {
      throw new Error(`--base ${ref} yields an empty delta (nothing to review)`);
    }
    return { mode: 'branch', label: `branch diff against ${ref} (${sha.slice(0, 7)})`, baseRef: sha };
  }

  if (scope === 'working-tree') {
    if (!isDirty(cwd)) throw new Error('--scope working-tree on a clean tree (nothing to review)');
    return { mode: 'working-tree', label: 'working tree diff' };
  }

  if (scope === 'branch') return branchAgainstDefault(cwd);

  // auto: dirty -> the working tree is the interesting thing; clean -> compare against the default
  // branch. Untracked files count as dirty, which is correct: the native uncommittedChanges target
  // reviews "staged, unstaged, and untracked files" (0.144.5 docstring).
  if (isDirty(cwd)) return { mode: 'working-tree', label: 'working tree diff' };
  return branchAgainstDefault(cwd);
}

function branchAgainstDefault(cwd) {
  // No refExists() recheck here: every return path of detectDefaultBranch has ALREADY verified the
  // exact ref it returns (the origin/HEAD path via refExists, the candidate loops via show-ref
  // --verify), so re-asking spawned a second identical subprocess for a question just answered.
  // A pathological race (the ref deleted in between) still surfaces below as "no merge base".
  const ref = detectDefaultBranch(cwd);
  const mb = mergeBase(cwd, ref);
  if (!mb) throw new Error(`no merge base between HEAD and ${ref}`);
  if (!hasDelta(cwd, mb)) throw new Error(`no changes between HEAD and ${ref} (nothing to review)`);
  return { mode: 'branch', label: `branch diff against ${ref}`, baseRef: ref };
}

/**
 * Map a resolved scope to the `review/start` wire target.
 * The full ReviewTarget enum has four variants (uncommittedChanges | baseBranch | commit | custom);
 * this design implements the first two. THROWS on anything else — the companion returns null here
 * (its :268), which turns a programming error into a malformed request we'd only diagnose live.
 */
export function buildNativeReviewTarget(resolved) {
  if (!resolved || typeof resolved !== 'object') throw new Error('buildNativeReviewTarget: missing resolved scope');
  if (resolved.mode === 'working-tree') return { type: 'uncommittedChanges' };
  if (resolved.mode === 'branch') {
    if (!isNonBlankString(resolved.baseRef)) throw new Error('buildNativeReviewTarget: branch mode requires a baseRef');
    return { type: 'baseBranch', branch: resolved.baseRef };
  }
  throw new Error(`buildNativeReviewTarget: unsupported mode '${String(resolved.mode)}'`);
}
