import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeNoPlan, isUsablePlan } from '../lib/plan-output.mjs';

test('looksLikeNoPlan rejects empty and generic Plan-mode output', () => {
  assert.equal(looksLikeNoPlan(''), true);
  assert.equal(looksLikeNoPlan("I'm Codex in this workspace. I can help you plan."), true);
  assert.equal(looksLikeNoPlan('Current mode: **Plan Mode**\nI can inspect files.'), true);
});

test('looksLikeNoPlan rejects reasoning preambles without plan structure', () => {
  assert.equal(looksLikeNoPlan("I'll inspect the Express app layout first so the plan names the right files."), true);
});

test('looksLikeNoPlan accepts substantive file, numbered, and bulleted plans', () => {
  assert.equal(looksLikeNoPlan('src/app.js\nAdd GET /healthz near existing routes.'), false);
  assert.equal(looksLikeNoPlan('1. Locate the route entrypoint.\n2. Add a health check.'), false);
  assert.equal(looksLikeNoPlan('- Add GET /healthz.\n- Add a request test.'), false);
});

test('isUsablePlan persists only a completed turn with a substantive plan body', () => {
  const good = 'src/app.js\nAdd GET /healthz near existing routes.';
  // The happy path: completed, non-empty, real file-by-file plan -> persist it.
  assert.equal(isUsablePlan('completed', good, false), true);
  // Degraded / non-terminal turns must NOT be written to the artifact file.
  assert.equal(isUsablePlan('completed', good, true), false);   // empty:true flag
  assert.equal(isUsablePlan('timeout', good, false), false);    // turn never completed
  assert.equal(isUsablePlan('failed', good, false), false);
  assert.equal(isUsablePlan('completed', '', false), false);    // blank body
  assert.equal(isUsablePlan('completed', '(empty)', false), false);
  assert.equal(isUsablePlan('completed', "I'm Codex in this workspace. I can help you plan.", false), false); // preamble-only
});
