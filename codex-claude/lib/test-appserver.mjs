// TEST-ONLY seam: point the app-server at a mock instead of the real `codex app-server`.
//
// Exists so the one-shot drivers and the detached `__daemon` CLI path — neither of which lets a
// caller reach the Daemon constructor — can be exercised offline. Both go through THIS helper so
// their parsing and their refusals cannot drift apart.
//
// Deliberately hostile to accidents:
//   - honoured ONLY when CODEX_DRIVE_TEST_MODE=1. Set on its own, CODEX_DRIVE_TEST_APPSERVER is a
//     LOUD error, never a silent substitution of the review backend — an ambient env collision must
//     not be able to quietly replace what reviews your code.
//   - a JSON string array, never whitespace-split and never shell-parsed (a shell-split would make
//     the value an injection vector and mangle any path containing a space).
//   - entries must be ABSOLUTE: the daemon spawns the child with the REVIEW cwd (a temp-dir git
//     fixture under test), so a relative command resolves against that and silently fails to spawn.
//
// Undocumented in user-facing help on purpose.
import { isAbsolute } from 'node:path';

export const TEST_MODE_ENV = 'CODEX_DRIVE_TEST_MODE';
export const TEST_APPSERVER_ENV = 'CODEX_DRIVE_TEST_APPSERVER';
export const TEST_WAIT_MS_ENV = 'CODEX_DRIVE_TEST_WAIT_MS';

const inTestMode = (env) => env[TEST_MODE_ENV] === '1';

/** @returns {{command:string,args:string[]}|{}} appServerOpts overrides, or {} for the real binary. */
export function testAppServerOpts(env = process.env) {
  const raw = env[TEST_APPSERVER_ENV];
  if (raw === undefined) return {};
  if (!inTestMode(env)) {
    throw new Error(`${TEST_APPSERVER_ENV} is set but ${TEST_MODE_ENV}=1 is not; refusing to substitute the app-server`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${TEST_APPSERVER_ENV} must be a JSON array of strings: ${e.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((s) => typeof s === 'string')) {
    throw new Error(`${TEST_APPSERVER_ENV} must be a non-empty JSON array of strings`);
  }
  const [command, ...args] = parsed;
  if (!isAbsolute(command)) {
    throw new Error(`${TEST_APPSERVER_ENV} command must be an absolute path (got '${command}')`);
  }
  return { command, args };
}

/** Override a driver's client-side wait cap. @returns {number|null} */
export function testWaitMs(env = process.env) {
  const raw = env[TEST_WAIT_MS_ENV];
  if (raw === undefined) return null;
  if (!inTestMode(env)) {
    throw new Error(`${TEST_WAIT_MS_ENV} is set but ${TEST_MODE_ENV}=1 is not; refusing to shorten the wait cap`);
  }
  const n = Number(raw);
  // Integer, not merely finite-and-positive: `0.5` passed the old n<=0 guard and Math.floor turned
  // it into 0 — which sendCommand reads as NO timeout (client.mjs:8), making the wait unbounded in
  // the very harness that exists to bound it.
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${TEST_WAIT_MS_ENV} must be a positive integer (got '${raw}')`);
  return n;
}
