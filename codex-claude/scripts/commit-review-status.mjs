#!/usr/bin/env node
// Recovery reader for a retained detached Stage-2 review run directory.
//
// When the collector's stdout is lost (a dropped turn, a truncated capture), the outcome must still be
// recoverable from the run directory — and a reader must NEVER infer a false success. Path EXISTENCE is
// not completion: a directory, an empty or garbage file, or a stale pre-created placeholder all "exist".
// A round is `completed` ONLY when `last-reviewed-sha` is a REGULAR, READABLE file whose content equals
// the recorded `start-head` (i.e. it holds the exact reviewed SHA the collector writes on success). An
// UNHAPPY round is read from `phase` (`failed`|`timeout`). Anything else is `unknown` — no result was
// durably recorded, which is treated as not-complete, never as success.
//
// Prints exactly one line — completed | failed | timeout | unknown — and exits 0 (it is a pure read of a
// retained directory; the daemon is already gone). Exit 1 is usage only.
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, assertOnlyFlags } from '../lib/verbs.mjs';

// A canonical git object name: 40 hex (SHA-1) or 64 hex (SHA-256). Equality to start-head is not
// enough — both must be real SHAs, or a matching not-a-sha / non-hex placeholder would read as success.
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const USAGE = 'usage: commit-review-status.mjs --state-dir <dir>';

function die(msg, code) {
  process.stderr.write(`[status] ${msg}\n`);
  if (code === 1) process.stderr.write(`${USAGE}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(`${USAGE}\n`); process.exit(0); }

let parsed;
try {
  parsed = parseArgs(['commit-review-status', ...argv]);
  assertOnlyFlags(parsed.flags, ['state-dir']);
} catch (e) {
  die(e.message, 1);
}
if (parsed.positional !== undefined) die(`unexpected argument '${parsed.positional}'`, 1);

const stateDir = parsed.flags['state-dir'];
if (typeof stateDir !== 'string' || !stateDir.trim()) die('--state-dir requires a non-blank value', 1);

// The load-bearing distinction: a REGULAR file only, checked with lstatSync — NOT statSync — so a
// SYMLINK is rejected even when it points at a regular file (a symlinked record has no provenance; it
// can aim anywhere). isFile() also rejects a directory (the shape the correlated-double-failure path
// leaves behind), and a caught error rejects a missing/unreadable path. Mere existence never counts.
function readRegularFile(dir, name) {
  try {
    if (!lstatSync(join(dir, name)).isFile()) return null;
    const raw = readFileSync(join(dir, name), 'utf8').trim();
    return raw.length ? raw : null;
  } catch {
    return null;
  }
}

const dir = stateDir.trim();
const startHead = readRegularFile(dir, 'start-head');
const marker = readRegularFile(dir, 'last-reviewed-sha');
const teardown = readRegularFile(dir, 'teardown');

// Completed requires the FULL provenance of a genuine finished run, not just a matching string:
//   - `start-head` is a canonical SHA and the marker holds that exact value (rejects a directory, an
//     empty file, a stale placeholder, a matching not-a-sha, and — via readRegularFile — a symlink), and
//   - teardown evidence is present (`confirmed stopped`). The collector writes that only after proving
//     the daemon was torn down, and always BEFORE the marker — so a marker without it is not a real
//     completed run.
if (startHead && SHA_RE.test(startHead) && marker === startHead && teardown === 'confirmed stopped') {
  process.stdout.write('completed\n');
  process.exit(0);
}

const phase = readRegularFile(dir, 'phase');
if (phase === 'failed' || phase === 'timeout') {
  process.stdout.write(`${phase}\n`);
  process.exit(0);
}

// No completion record and no recognized unhappy verdict: the collection did not durably record a
// result. Not-complete, never success.
process.stdout.write('unknown\n');
process.exit(0);
