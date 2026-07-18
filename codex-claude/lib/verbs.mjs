// Pure argv parsing + mapping to daemon commands (no I/O), so it is unit-testable.

export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const flags = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      // `--flag=value` is NOT supported, and silently mis-parsing it is dangerous rather than merely
      // surprising: `--base=<sha>` would land as flags['base=<sha>']=true with flags.base undefined,
      // which compact() then drops — emitting a bare {cmd:'review'} indistinguishable from "no base
      // given", so the daemon would happily review AUTO scope instead of the requested commit range.
      // No downstream validator can recover the intent, so reject it at the source. This also covers
      // `start`, which never reaches toCommand().
      if (key.includes('=')) {
        throw new Error(`--${key.split('=')[0]}=value is not supported; use \`--${key.split('=')[0]} <value>\``);
      }
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) { flags[key] = true; }
      else { flags[key] = next; i++; }
    } else {
      positionals.push(tok);
    }
  }
  return { verb, positional: positionals.length ? positionals.join(' ') : undefined, flags };
}

const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVAL_POLICIES = ['never', 'untrusted', 'on-request'];

// A flag's value must be a real string, not the boolean `true` a valueless flag produces.
function requireValue(flags, key) {
  if (!(key in flags)) return undefined;
  const v = flags[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`--${key} requires a value`);
  return v;
}

/**
 * Validate `start`'s thread-profile flags into the object the Daemon records.
 *
 * Pure and exported so it can be unit-tested without booting a daemon — and so bin can call it as
 * its FIRST action, before it probes/stops any existing session. Validating later would mean
 * `start --force --sandbox bogus` tears down an unrelated live session and only THEN errors.
 */
export function parseStartProfile(flags = {}) {
  const sandbox = requireValue(flags, 'sandbox');
  if (sandbox !== undefined && !SANDBOXES.includes(sandbox)) {
    throw new Error(`invalid --sandbox '${sandbox}'; expected one of ${SANDBOXES.join(', ')}`);
  }
  const approvalPolicy = requireValue(flags, 'approval-policy');
  if (approvalPolicy !== undefined && !APPROVAL_POLICIES.includes(approvalPolicy)) {
    throw new Error(`invalid --approval-policy '${approvalPolicy}'; expected one of ${APPROVAL_POLICIES.join(', ')}`);
  }
  // Every boolean-only flag validated the same way. `--force no` used to be the string 'no', which
  // is TRUTHY — so it force-stopped a live session the caller was trying not to touch. `--private no`
  // was the mirror image: it looked private but wrote global state.
  for (const b of ['ephemeral', 'force', 'private', 'resume-latest']) {
    if (b in flags && flags[b] !== true) throw new Error(`--${b} is a boolean flag and takes no value`);
  }
  const ephemeral = flags.ephemeral === true ? true : undefined;
  const resuming = 'resume' in flags || 'resume-latest' in flags;
  // Resuming an ephemeral thread is a contradiction, and today the daemon would silently prefer
  // resume and drop the flag.
  if (ephemeral && resuming) throw new Error('--ephemeral cannot be combined with --resume/--resume-latest');
  // A resumed thread keeps the profile it was born with; the protocol offers no re-profiling, so
  // accepting these flags would be a lie.
  if (resuming && (sandbox !== undefined || approvalPolicy !== undefined)) {
    throw new Error('--sandbox/--approval-policy cannot be used with --resume/--resume-latest (a resumed thread keeps its original profile)');
  }
  // Same truthiness family, in the flags this sits next to: a valueless --resume/--cwd/--model
  // otherwise flows on as boolean true (`resolve(true)` throws a raw TypeError; `model: true` reaches
  // the protocol).
  if ('resume' in flags) requireValue(flags, 'resume');
  if ('cwd' in flags) requireValue(flags, 'cwd');
  if ('model' in flags) requireValue(flags, 'model');

  const profile = {};
  if (sandbox !== undefined) profile.sandbox = sandbox;
  if (approvalPolicy !== undefined) profile.approvalPolicy = approvalPolicy;
  if (ephemeral) profile.ephemeral = true;
  return Object.keys(profile).length ? profile : null;
}

// Drop keys whose value is undefined so commands don't carry empty fields over the wire
// (and so equality checks stay clean).
function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// Flags each verb understands, PLUS the transport flags bin consumes before/around toCommand
// (`--socket` on every non-start verb, `--timeout-ms` on wait, `--out` on read). The allowlist must
// include them: bin hands toCommand the FULL flags object, so omitting them would break real calls.
//
// Why an allowlist at all: an unrecognised flag was silently DISCARDED, so `review --bsae abc` and
// `review --help` both degraded into a bare auto-scope review — the caller asked for one thing and
// got a full unscoped review of the cwd, at the cost of a live Codex turn to notice. Same class as
// the `--flag=value` hazard below.
const TRANSPORT_FLAGS = ['socket', 'timeout-ms'];
// `start` and `doctor` never reach toCommand (bin returns early for both), so they had NO allowlist
// at all: `start --help` silently booted a live daemon and overwrote ~/.codex-drive/state.json, and
// a typo'd profile flag was dropped so every later `review` failed wrong_thread_profile — after the
// session had already been paid for. They are listed here and asserted from bin directly.
const VERB_FLAGS = {
  start: ['cwd', 'model', 'resume', 'resume-latest', 'force', 'private', 'sandbox', 'approval-policy', 'ephemeral'],
  doctor: [],
  plan: ['effort', 'approval-policy'],
  send: ['effort', 'approval-policy', 'mode'],
  review: ['base', 'scope'],
  wait: [],
  answer: ['id', 'option', 'text'],
  approve: ['decision'],
  read: ['out'],
  interrupt: [],
  status: [],
  stop: [],
};

// Neither start nor doctor talks to an existing daemon, so the transport flags are not merely
// unused there — accepting them would be a NEW silently-ignored flag, the very class this exists
// to close.
const takesTransportFlags = (verb) => verb !== 'start' && verb !== 'doctor';

export function assertKnownFlags(verb, flags) {
  const allowed = VERB_FLAGS[verb];
  if (!allowed) return;   // unknown verb: toCommand's default throws with a better message
  assertOnlyFlags(flags, takesTransportFlags(verb) ? [...allowed, ...TRANSPORT_FLAGS] : allowed,
    `unknown flag --%s for verb '${verb}'`);
}

/**
 * Reject any flag outside `allowed`. Shared so every entry point — the CLI verbs and the one-shot
 * gate script — enforces the same rule from one place instead of hand-rolling it (the one-shot's
 * own copy is how `--help` once ran a live review).
 */
export function assertOnlyFlags(flags, allowed, template = 'unknown flag --%s') {
  for (const k of Object.keys(flags)) {
    if (!allowed.includes(k)) throw new Error(template.replace('%s', k));
  }
}

export function toCommand({ verb, positional, flags = {} }) {
  assertKnownFlags(verb, flags);
  // A positional on a verb that takes none is a forgotten flag name, not a prompt — and for `review`
  // it would be silently ignored while the review ran unscoped.
  if (positional !== undefined && !['plan', 'send'].includes(verb)) {
    throw new Error(`verb '${verb}' takes no positional argument (got '${positional}')`);
  }
  switch (verb) {
    case 'plan': return compact({ cmd: 'plan', prompt: positional, effort: flags.effort, approvalPolicy: flags['approval-policy'] });
    case 'send': return compact({ cmd: 'send', prompt: positional, effort: flags.effort, approvalPolicy: flags['approval-policy'], mode: flags.mode });
    // Native git-scoped review. Values are passed through RAW (including a valueless flag's boolean
    // `true`) — git-scope in the daemon is the authoritative validator and rejects them there, so the
    // two cannot drift apart. compact() keeps an omitted flag off the wire entirely, which is what
    // lets the daemon distinguish "no base given" from a bad one.
    case 'review': return compact({ cmd: 'review', base: flags.base, scope: flags.scope });
    case 'wait': return { cmd: 'wait' };
    case 'answer': {
      // The daemon matches /^__option:(\d+)$/ and sends anything else VERBATIM as the answer text.
      // So a valueless `--option` (boolean true) built the literal string '__option:true' and
      // answered a live Codex question with it, while the caller believed option 1 was chosen.
      // Same for a valueless `--text`, which became the answer "true".
      if ((flags.text === undefined) === (flags.option === undefined)) {
        throw new Error('answer requires exactly one of --text or --option');
      }
      requireValue(flags, 'id');
      if (flags.id === undefined) throw new Error('--id requires a value');
      let answers;
      if (flags.text !== undefined) {
        answers = [String(requireValue(flags, 'text'))];
      } else {
        const opt = requireValue(flags, 'option');
        // 1-based index, so 0 is as wrong as 'abc'.
        if (!/^[1-9]\d*$/.test(opt)) throw new Error(`--option must be a positive integer (got '${opt}')`);
        answers = [`__option:${opt}`];
      }
      return { cmd: 'answer', id: flags.id, answers };
    }
    case 'approve': return { cmd: 'approve', decision: flags.decision };
    // No `full`: nothing in lib/ ever read cmd.full, so `read --full` was accepted, sent over the
    // wire and silently ignored — it is now a loud unknown-flag error like any other typo.
    case 'read': return { cmd: 'read' };
    case 'interrupt': return { cmd: 'interrupt' };
    case 'status': return { cmd: 'status' };
    case 'stop': return { cmd: 'stop' };
    default: throw new Error(`unknown verb '${verb}'`);
  }
}
