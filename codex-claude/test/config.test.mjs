import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfiguredModel } from '../lib/config.mjs';

test('readConfiguredModel reads a top-level model from config.toml', () => {
  const home = mkdtempSync(join(tmpdir(), 'cdx-cfg-'));
  writeFileSync(join(home, 'config.toml'), 'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n');
  assert.equal(readConfiguredModel(home), 'gpt-5.5');
});

test('readConfiguredModel reads a single-quoted top-level model', () => {
  const home = mkdtempSync(join(tmpdir(), 'cdx-cfgq-'));
  writeFileSync(join(home, 'config.toml'), "model = 'gpt-5.5'\nmodel_reasoning_effort = \"xhigh\"\n");
  assert.equal(readConfiguredModel(home), 'gpt-5.5');
});

test('readConfiguredModel ignores a model key inside a [table] section', () => {
  const home = mkdtempSync(join(tmpdir(), 'cdx-cfg2-'));
  writeFileSync(join(home, 'config.toml'), 'personality = "pragmatic"\n[some_provider]\nmodel = "other"\n');
  assert.equal(readConfiguredModel(home), null);
});

test('readConfiguredModel returns null when config.toml is absent', () => {
  const home = mkdtempSync(join(tmpdir(), 'cdx-cfg3-'));
  assert.equal(readConfiguredModel(home), null);
});
