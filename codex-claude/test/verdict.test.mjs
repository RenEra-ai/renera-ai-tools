// The shared verdict rule. It was previously inlined twice inside scripts/review-round.mjs — the
// one script the reviewer agent is BANNED from running — so the rule that decides whether a Codex
// review counts as clean had no test of its own and no reachable consumer on the sanctioned path.
//
// Every case here is a way a review can LOOK decided and not be. The strictness is the feature: a
// model that emits its verdict and keeps talking has not delivered one, and UNCLEAR is what makes
// the drivers re-ask instead of certifying half a review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, hasVerdict } from '../lib/verdict.mjs';

test('a well-formed final verdict line parses, in either polarity and any case', () => {
  assert.equal(parseVerdict('Reviewed a.js.\nVERDICT: NO ISSUES'), 'NO ISSUES');
  assert.equal(parseVerdict('a.js:1 — bug\nVERDICT: ISSUES FOUND'), 'ISSUES FOUND');
  // Case-insensitive match, but the RESULT is always the canonical upper-case form the contract
  // names — a downstream === comparison must not depend on how the model capitalised it.
  assert.equal(parseVerdict('verdict: no issues'), 'NO ISSUES');
  assert.equal(parseVerdict('Verdict:   Issues Found'), 'ISSUES FOUND');
});

test('trailing blank lines and whitespace do not hide the verdict', () => {
  assert.equal(parseVerdict('body\nVERDICT: NO ISSUES\n\n   \n'), 'NO ISSUES');
  assert.equal(parseVerdict('body\n   VERDICT: NO ISSUES   '), 'NO ISSUES');
});

test('ONLY the final non-empty line counts — trailing prose is UNCLEAR', () => {
  // The case the whole rule exists for: a review that announces a verdict and then keeps going has
  // not finished. Accepting it would certify a truncated review as clean.
  assert.equal(parseVerdict('VERDICT: NO ISSUES\nOne more thing I noticed…'), 'UNCLEAR');
  assert.equal(parseVerdict('VERDICT: ISSUES FOUND\n- and here they are'), 'UNCLEAR');
});

test('a literal UNCLEAR line, an unparseable line, and no message are all UNCLEAR', () => {
  assert.equal(parseVerdict('VERDICT: UNCLEAR'), 'UNCLEAR');
  assert.equal(parseVerdict('VERDICT: MAYBE'), 'UNCLEAR');
  assert.equal(parseVerdict('VERDICT:NO ISSUES extra'), 'UNCLEAR');
  assert.equal(parseVerdict(''), 'UNCLEAR');
  assert.equal(parseVerdict('   \n\n'), 'UNCLEAR');
  assert.equal(parseVerdict(null), 'UNCLEAR');
  assert.equal(parseVerdict(undefined), 'UNCLEAR');
});

test('hasVerdict agrees with parseVerdict on every input', () => {
  // They are two views of ONE rule; drift between them is exactly what re-implementing the regex
  // twice in one file produced. hasVerdict gates the drivers' static re-ask, parseVerdict decides
  // the reported verdict — if they disagree, a review gets re-asked and then certified anyway.
  for (const m of ['VERDICT: NO ISSUES', 'x\nVERDICT: ISSUES FOUND', 'VERDICT: UNCLEAR',
    'VERDICT: NO ISSUES\ntrailing', '', null, undefined, 'nothing here']) {
    assert.equal(hasVerdict(m), parseVerdict(m) !== 'UNCLEAR', `disagreement on ${JSON.stringify(m)}`);
  }
});
