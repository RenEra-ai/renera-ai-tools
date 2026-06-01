import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export class StateStore {
  constructor(baseDir = join(homedir(), '.codex-drive')) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
    this.statePath = join(this.baseDir, 'state.json');
  }

  readState() {
    if (!existsSync(this.statePath)) return null;
    try { return JSON.parse(readFileSync(this.statePath, 'utf8')); }
    catch { return null; }
  }

  writeState(rec) {
    writeFileSync(this.statePath, JSON.stringify(rec, null, 2));
  }

  socketPathFor(threadId) {
    return join(this.baseDir, `${threadId}.sock`);
  }
}
