#!/usr/bin/env node
// Recovery reader for a gate-attest run directory.
//
// When the collector's stdout is lost (a dropped turn, a truncated capture), the outcome must still
// be recoverable from the run directory — before this existed, a refused run directory was
// indistinguishable from one where collect never ran at all
// (docs/bugs/gate-orphaned-completed-turn.md). A reader must NEVER infer a false success: path
// EXISTENCE is not an outcome — a directory, an empty or garbage file, or a symlink all "exist".
//
//   attested          attestation.json is a REGULAR file holding a valid schema-1 record with
//                     confirmed teardown, a named gate, and an artifact path
//   refused: <reason> refusal.json is a REGULAR file whose reason is an identifier-shaped token
//   unknown           anything else — nothing was durably recorded; treated as not-attested
//
// THIS READER AUTHORIZES NOTHING. A gate is authorized only by the collector's own exit-0 line, in
// the turn that ran it (scripts/gate-attest.mjs); this is recovery evidence for a human or a
// dispatcher deciding whether a round needs re-running, never a credential.
//
// Prints exactly one line and exits 0 (it is a pure read of a retained directory; the daemon is
// already gone). Exit 1 is usage only.
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, assertOnlyFlags } from '../lib/verbs.mjs';

const USAGE = 'usage: gate-attest-status.mjs --state-dir <dir>';

// Identifier-shaped, not an allowlist: a reason added to the collector later must not silently read
// as `unknown`, while prose, JSON fragments or path-looking garbage still must.
const REASON_RE = /^[a-z_]{1,40}$/;

function die(msg, code) {
  process.stderr.write(`[gate-status] ${msg}\n`);
  if (code === 1) process.stderr.write(`${USAGE}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(`${USAGE}\n`); process.exit(0); }

let parsed;
try {
  parsed = parseArgs(['gate-attest-status', ...argv]);
  assertOnlyFlags(parsed.flags, ['state-dir']);
} catch (e) {
  die(e.message, 1);
}
if (parsed.positional !== undefined) die(`unexpected argument '${parsed.positional}'`, 1);

const stateDir = parsed.flags['state-dir'];
if (typeof stateDir !== 'string' || !stateDir.trim()) die('--state-dir requires a non-blank value', 1);

// A REGULAR file only, checked with lstatSync — NOT statSync — so a SYMLINK is rejected even when it
// points at a regular file (a symlinked record has no provenance; it can aim anywhere). isFile()
// also rejects a directory, and a caught error rejects a missing/unreadable path.
function readRegularFile(dir, name) {
  try {
    if (!lstatSync(join(dir, name)).isFile()) return null;
    const raw = readFileSync(join(dir, name), 'utf8').trim();
    return raw.length ? raw : null;
  } catch {
    return null;
  }
}

function readJson(dir, name) {
  const raw = readRegularFile(dir, name);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const dir = stateDir.trim();

// `attested` wins over `refused`: the collector writes exactly one of the two per run directory, so
// both present means someone assembled the directory by hand — and preferring the attestation is
// still safe, because the record only ever exists after a confirmed-teardown success path.
const record = readJson(dir, 'attestation.json');
if (record && typeof record === 'object'
  && record.schema === 1
  && record.teardown === 'confirmed'
  && (record.gate === 'architect' || record.gate === 'review')
  && record.artifact && typeof record.artifact.path === 'string' && record.artifact.path.length) {
  process.stdout.write('attested\n');
  process.exit(0);
}

const refusal = readJson(dir, 'refusal.json');
if (refusal && typeof refusal === 'object'
  && typeof refusal.reason === 'string' && REASON_RE.test(refusal.reason)) {
  process.stdout.write(`refused: ${refusal.reason}\n`);
  process.exit(0);
}

// Neither record parses to a recognized shape: nothing was durably recorded. Not-attested, never
// success.
process.stdout.write('unknown\n');
process.exit(0);
