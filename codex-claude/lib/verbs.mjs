// Pure argv parsing + mapping to daemon commands (no I/O), so it is unit-testable.

export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const flags = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) { flags[key] = true; }
      else { flags[key] = next; i++; }
    } else {
      positionals.push(tok);
    }
  }
  return { verb, positional: positionals.length ? positionals.join(' ') : undefined, flags };
}

// Drop keys whose value is undefined so commands don't carry empty fields over the wire
// (and so equality checks stay clean).
function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function toCommand({ verb, positional, flags = {} }) {
  switch (verb) {
    case 'plan': return compact({ cmd: 'plan', prompt: positional, effort: flags.effort, approvalPolicy: flags['approval-policy'] });
    case 'send': return compact({ cmd: 'send', prompt: positional, effort: flags.effort, approvalPolicy: flags['approval-policy'], mode: flags.mode });
    case 'wait': return { cmd: 'wait' };
    case 'answer': {
      const answers = flags.text !== undefined ? [String(flags.text)] : [`__option:${flags.option}`];
      return { cmd: 'answer', id: flags.id, answers };
    }
    case 'approve': return { cmd: 'approve', decision: flags.decision };
    case 'read': return { cmd: 'read', full: !!flags.full };
    case 'interrupt': return { cmd: 'interrupt' };
    case 'status': return { cmd: 'status' };
    case 'stop': return { cmd: 'stop' };
    default: throw new Error(`unknown verb '${verb}'`);
  }
}
