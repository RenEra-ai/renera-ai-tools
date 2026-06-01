import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METHODS, MODE, EFFORTS, SERVER_REQUEST } from '../lib/protocol.mjs';
import { buildTurnStart, classifyServerRequest, buildQuestionAnswer, buildApprovalResponse } from '../lib/protocol.mjs';

test('core client method names are pinned', () => {
  assert.equal(METHODS.INITIALIZE, 'initialize');
  assert.equal(METHODS.THREAD_START, 'thread/start');
  assert.equal(METHODS.THREAD_RESUME, 'thread/resume');
  assert.equal(METHODS.TURN_START, 'turn/start');
  assert.equal(METHODS.TURN_INTERRUPT, 'turn/interrupt');
});

test('mode and effort enums match the protocol', () => {
  assert.deepEqual(MODE, { PLAN: 'plan', DEFAULT: 'default' });
  assert.deepEqual(EFFORTS, ['none', 'minimal', 'low', 'high', 'medium', 'xhigh'].sort());
});

test('server-request method names are classified', () => {
  assert.ok(SERVER_REQUEST.QUESTION.includes('item/tool/requestUserInput'));
  assert.ok(SERVER_REQUEST.APPROVAL.includes('item/commandExecution/requestApproval'));
});

test('buildTurnStart default mode sends only threadId+input', () => {
  const p = buildTurnStart({ threadId: 't1', text: 'hi' });
  assert.deepEqual(p, { threadId: 't1', input: [{ type: 'text', text: 'hi' }] });
});

test('buildTurnStart default mode with effort sets top-level effort', () => {
  const p = buildTurnStart({ threadId: 't1', text: 'hi', effort: 'high' });
  assert.deepEqual(p, { threadId: 't1', input: [{ type: 'text', text: 'hi' }], effort: 'high' });
});

test('buildTurnStart plan mode puts model+effort in settings (no null fields, no top-level effort)', () => {
  const p = buildTurnStart({ threadId: 't1', text: 'go', mode: 'plan', effort: 'xhigh', model: 'gpt-5.5' });
  // settings.model is a REQUIRED string in the protocol; null is rejected (-32600). Only
  // include non-null fields; reasoning_effort lives in settings, not as a top-level param.
  assert.deepEqual(p.collaborationMode, { mode: 'plan', settings: { model: 'gpt-5.5', reasoning_effort: 'xhigh' } });
  assert.equal(p.effort, undefined);
});

test('buildTurnStart plan mode without a model throws (never sends model:null)', () => {
  assert.throws(() => buildTurnStart({ threadId: 't1', text: 'go', mode: 'plan' }), /model/);
});

test('buildTurnStart default mode sets collaborationMode default (exits plan mode)', () => {
  const p = buildTurnStart({ threadId: 't1', text: 'save it', mode: 'default', model: 'gpt-5.5', effort: 'high' });
  assert.deepEqual(p.collaborationMode, { mode: 'default', settings: { model: 'gpt-5.5', reasoning_effort: 'high' } });
  assert.equal(p.effort, undefined);
});

test('buildTurnStart default mode without a model throws', () => {
  assert.throws(() => buildTurnStart({ threadId: 't1', text: 'x', mode: 'default' }), /model/);
});

test('buildTurnStart passes through approvalPolicy when provided', () => {
  const p = buildTurnStart({ threadId: 't1', text: 'x', approvalPolicy: 'untrusted' });
  assert.equal(p.approvalPolicy, 'untrusted');
});

test('buildTurnStart rejects an invalid effort', () => {
  assert.throws(() => buildTurnStart({ threadId: 't', text: 'x', effort: 'turbo' }), /effort/);
});

test('classifyServerRequest tags question vs approval vs elicitation vs unknown', () => {
  assert.equal(classifyServerRequest('item/tool/requestUserInput', {}).kind, 'question');
  assert.equal(classifyServerRequest('execCommandApproval', {}).kind, 'approval');
  assert.equal(classifyServerRequest('mcpServer/elicitation/request', {}).kind, 'elicitation');
  assert.equal(classifyServerRequest('something/else', {}).kind, 'unknown');
});

test('buildQuestionAnswer maps a free-text or option answer to the response shape', () => {
  const r = buildQuestionAnswer('q1', ['Option B']);
  assert.deepEqual(r, { answers: { q1: { answers: ['Option B'] } } });
});

test('buildApprovalResponse: v2 command/fileChange use accept/decline', () => {
  assert.deepEqual(buildApprovalResponse('allow', 'item/commandExecution/requestApproval'), { decision: 'accept' });
  assert.deepEqual(buildApprovalResponse('deny', 'item/commandExecution/requestApproval'), { decision: 'decline' });
  assert.deepEqual(buildApprovalResponse('allow', 'item/fileChange/requestApproval'), { decision: 'accept' });
  assert.deepEqual(buildApprovalResponse('deny', 'item/fileChange/requestApproval'), { decision: 'decline' });
});

test('buildApprovalResponse: legacy methods (and unknown/undefined) use approved/denied', () => {
  assert.deepEqual(buildApprovalResponse('allow', 'execCommandApproval'), { decision: 'approved' });
  assert.deepEqual(buildApprovalResponse('deny', 'applyPatchApproval'), { decision: 'denied' });
  assert.deepEqual(buildApprovalResponse('allow'), { decision: 'approved' }); // back-compat default
});

test('buildApprovalResponse: permissions approval is not supported (throws)', () => {
  assert.throws(() => buildApprovalResponse('allow', 'item/permissions/requestApproval'), /permissions/);
});

test('buildApprovalResponse: invalid decision throws', () => {
  assert.throws(() => buildApprovalResponse('maybe', 'item/commandExecution/requestApproval'), /allow\|deny/);
});
