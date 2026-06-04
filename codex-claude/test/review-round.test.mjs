import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// These cover ONLY the --plan-file fail-closed guard, which exits BEFORE the Codex daemon boots — so the
// script can be exercised without a live Codex session. The happy/no-plan paths boot a daemon and are not
// unit-tested here (the pure assembly is covered by review-prompt.test.mjs). A short timeout doubles as a
// safety net: if the guard ever regressed and fell through to daemon.start(), the test would time out.
const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'review-round.mjs');

function tmpFile(name, content) {
  const p = join(mkdtempSync(join(tmpdir(), 'cdx-rr-')), name);
  writeFileSync(p, content);
  return p;
}

test('review-round fails CLOSED (UNCLEAR) when a requested --plan-file cannot be read', async () => {
  const promptFile = tmpFile('prompt.txt', 'review body');
  const missing = join(tmpdir(), 'cdx-definitely-missing-plan-xyz.md');
  const { stdout } = await run('node', [script, '--prompt-file', promptFile, '--plan-file', missing], { timeout: 15000 });
  assert.match(stdout, /^STATUS: failed$/m);
  assert.match(stdout, /^PARSED_VERDICT: UNCLEAR$/m);
});

test('review-round fails CLOSED (UNCLEAR) when a requested --plan-file is empty', async () => {
  const promptFile = tmpFile('prompt.txt', 'review body');
  const emptyPlan = tmpFile('issue.md', '   \n\n');
  const { stdout } = await run('node', [script, '--prompt-file', promptFile, '--plan-file', emptyPlan], { timeout: 15000 });
  assert.match(stdout, /^STATUS: failed$/m);
  assert.match(stdout, /^PARSED_VERDICT: UNCLEAR$/m);
});

test('review-round fails CLOSED (UNCLEAR) when --plan-file is given without a path (last token)', async () => {
  const promptFile = tmpFile('prompt.txt', 'review body');
  const { stdout } = await run('node', [script, '--prompt-file', promptFile, '--plan-file'], { timeout: 15000 });
  assert.match(stdout, /^STATUS: failed$/m);
  assert.match(stdout, /^PARSED_VERDICT: UNCLEAR$/m);
});

test('review-round fails CLOSED (UNCLEAR) when --plan-file value is an empty string', async () => {
  const promptFile = tmpFile('prompt.txt', 'review body');
  const { stdout } = await run('node', [script, '--prompt-file', promptFile, '--plan-file', ''], { timeout: 15000 });
  assert.match(stdout, /^STATUS: failed$/m);
  assert.match(stdout, /^PARSED_VERDICT: UNCLEAR$/m);
});
