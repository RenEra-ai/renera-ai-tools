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
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, assertOnlyFlags } from '../lib/verbs.mjs';

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

// The load-bearing distinction: a REGULAR file only. statSync().isFile() rejects a directory (the exact
// shape the correlated-double-failure path leaves behind when the atomic write could not replace it),
// and a caught error rejects a missing/unreadable path. Mere existence never counts.
function readRegularFile(dir, name) {
  try {
    if (!statSync(join(dir, name)).isFile()) return null;
    const raw = readFileSync(join(dir, name), 'utf8').trim();
    return raw.length ? raw : null;
  } catch {
    return null;
  }
}

const dir = stateDir.trim();
const startHead = readRegularFile(dir, 'start-head');
const marker = readRegularFile(dir, 'last-reviewed-sha');

// Completed IFF the marker is a regular readable file AND holds the exact reviewed SHA. Requiring the
// content to equal start-head rejects a directory, an empty file, and a stale placeholder alike.
if (startHead && marker && marker === startHead) {
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
