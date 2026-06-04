// Pure classification of a repo workflow's noLand result, extracted from codex-wrap.js so it is
// unit-testable (a sandboxed Workflow script cannot import modules; codex-wrap.js inlines a mirror —
// keep them in sync, the test guards this copy).
export function classifyRepoResult(repo) {
  if (!repo || typeof repo !== 'object') return { status: 'failed', detail: 'no result' };
  if (repo.terminal === 'ready_to_land') {
    if (!repo.branch || !repo.base_sha) return { status: 'failed', detail: 'ready_to_land missing branch/base_sha' };
    return { status: 'ready', branch: repo.branch, base_sha: repo.base_sha };
  }
  // Asked for noLand but did NOT return ready_to_land → caller must check whether it landed anyway.
  return { status: 'needs_land_check', terminal: repo.terminal || null, detail: repo.detail || '' };
}
