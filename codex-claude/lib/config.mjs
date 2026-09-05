import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Read the user's default model from ~/.codex/config.toml (the `model = "..."` or `model = '...'` line at the
// top level, before any [section] table). This is a compatibility fallback for explicit modes
// when the app-server supplies no session model metadata; it does not reproduce layered Codex
// configuration resolution. Returns null if not found.
export function readConfiguredModel(codexHome = join(homedir(), '.codex')) {
  const cfg = join(codexHome, 'config.toml');
  if (!existsSync(cfg)) return null;
  try {
    const text = readFileSync(cfg, 'utf8');
    for (const line of text.split('\n')) {
      if (/^\s*\[/.test(line)) break; // entered a [table]; stop scanning top-level keys
      const m = /^\s*model\s*=\s*(['"])(.+?)\1/.exec(line); // accept "..." or '...'
      if (m) return m[2];
    }
    return null;
  } catch {
    return null;
  }
}
