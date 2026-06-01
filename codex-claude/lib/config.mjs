import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Read the user's default model from ~/.codex/config.toml (the `model = "..."` line at the
// top level, before any [section] table). Plan mode requires a concrete model string and the
// `collaborationMode/list` plan preset reports model=null, so this is how we resolve the
// model the desktop/CLI would use. Returns null if not found.
export function readConfiguredModel(codexHome = join(homedir(), '.codex')) {
  const cfg = join(codexHome, 'config.toml');
  if (!existsSync(cfg)) return null;
  try {
    const text = readFileSync(cfg, 'utf8');
    for (const line of text.split('\n')) {
      if (/^\s*\[/.test(line)) break; // entered a [table]; stop scanning top-level keys
      const m = /^\s*model\s*=\s*"([^"]+)"/.exec(line);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}
