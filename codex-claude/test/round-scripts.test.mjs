// The review/plan drivers' REAL drive path, offline.
//
// Until now neither script had any coverage of it: review-round.test.mjs covers only the
// --plan-file fail-closed guard (it exits before the daemon boots) and plan-round had no test file
// at all. That gap is why migrating both onto the shared drive-loop needed these — without them the
// migration could regress question answering, approval policy, the static re-ask or the output
// contract and every suite would still pass.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { seamEnv, rmDir } from './fixtures/helpers.mjs';

const run = promisify(execFile);
const REVIEW = fileURLToPath(new URL('../scripts/review-round.mjs', import.meta.url));
const PLAN = fileURLToPath(new URL('../scripts/plan-round.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/mock-appserver.mjs', import.meta.url));

const DIRS = [];
after(() => { for (const d of DIRS) rmDir(d); });

function workdir() {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-rs-'));
  DIRS.push(dir);
  return dir;
}

// The mock branches on the prompt text, so the prompt doubles as the scenario selector.
function promptFile(dir, text) {
  const p = join(dir, 'prompt.txt');
  writeFileSync(p, text);
  return p;
}

async function script(path, args, dir, extraEnv = {}) {
  // A model is required for plan mode; pass it explicitly so the run never depends on ~/.codex.
  try {
    const { stdout, stderr } = await run(process.execPath, [path, ...args], {
      cwd: dir,
      env: seamEnv(FIXTURE, 'ok', { CODEX_DRIVE_TEST_WAIT_MS: '20000', ...extraEnv }),
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

test('review-round drives a turn to a verdict through the shared loop', async () => {
  const dir = workdir();
  // REVIEWPLAN makes the mock emit an internal-checklist plan delta AND the real review text, which
  // also pins that the plan stream never shadows the agent-message verdict on a plain send.
  const r = await script(REVIEW, ['--prompt-file', promptFile(dir, 'REVIEWPLAN please review')], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /STATUS: completed/);
  assert.match(r.stdout, /PARSED_VERDICT: NO ISSUES/);
  assert.match(r.stdout, /=== REVIEW ===/);
});

test('review-round answers a parked question with the first option', async () => {
  const dir = workdir();
  const r = await script(REVIEW, ['--prompt-file', promptFile(dir, 'ASK me something')], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /answering question q1 -> A/);
  assert.match(r.stdout, /STATUS: completed/);
});

test('review-round DECLINES an unsafe command approval (a review only needs to read)', async () => {
  const dir = workdir();
  const r = await script(REVIEW, ['--prompt-file', promptFile(dir, 'APPROVE a command')], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /declining approval: item\/commandExecution\/requestApproval/);
  // A DENIED exec with no verdict is precisely what must trigger the ONE static-only re-ask, so a
  // Codex that stalled on "I need to run the tests" still produces a review rather than UNCLEAR.
  assert.match(r.stderr, /denied a command \+ no verdict — re-asking/);
  assert.match(r.stdout, /STATUS: completed/);
});

test('plan-round persists a plan via --out and reports PLAN_FILE', async () => {
  const dir = workdir();
  const out = join(dir, 'plan.md');
  const r = await script(PLAN, ['--prompt-file', promptFile(dir, 'PLANITEM design it'), '--out', out, '--model', 'gpt-5.6-sol'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /STATUS: completed/);
  assert.match(r.stdout, /PLAN_FILE:/);
  assert.equal(existsSync(out), true, 'the plan must be persisted');
  assert.match(readFileSync(out, 'utf8'), /Add GET \/healthz/);
});

test('plan-round answers a parked question and still completes', async () => {
  const dir = workdir();
  const r = await script(PLAN, ['--prompt-file', promptFile(dir, 'ASK before planning'), '--model', 'gpt-5.6-sol'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /answering question q1 -> A/);
  assert.match(r.stdout, /STATUS: completed/);
});

test('both drivers tear the daemon down on SIGTERM instead of orphaning the app-server', async () => {
  // Killing a driver mid-turn is exactly how app-servers get orphaned — observed for real when a
  // 9-minute review was interrupted. HANGTURN keeps the turn open so there IS something to kill.
  for (const [name, path, extra] of [['review', REVIEW, []], ['plan', PLAN, ['--model', 'gpt-5.6-sol']]]) {
    const dir = workdir();
    const child = execFile(process.execPath, [path, '--prompt-file', promptFile(dir, 'HANGTURN forever'), ...extra], {
      cwd: dir,
      env: seamEnv(FIXTURE, 'ok', { CODEX_DRIVE_TEST_WAIT_MS: '60000' }),
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    await new Promise((r) => setTimeout(r, 1200));          // let it boot and start the turn
    child.kill('SIGTERM');
    const { code, signal } = await Promise.race([exited, new Promise((r) => setTimeout(() => r({ code: 'HUNG' }), 8000))]);
    assert.notEqual(code, 'HUNG', `${name}-round did not exit on SIGTERM`);
    // EXACTLY 143 from our own handler, not signal-death: an unhandled SIGTERM also terminates the
    // process (code null / signal SIGTERM) but skips teardown, so accepting that would let the
    // orphan bug pass this test.
    assert.equal(code, 143, `${name}-round must exit 143 via its own teardown (got code=${code} signal=${signal})`);
    assert.match(err, /SIGTERM — cleaning up/, `${name}-round must run its cleanup handler`);
  }
});
