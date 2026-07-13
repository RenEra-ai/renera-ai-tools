// Method/enum constants pinned to the installed Codex app-server protocol.
// Verified via `codex app-server generate-json-schema` (see plan Task 1, Step 3).

export const METHODS = {
  INITIALIZE: 'initialize',
  INITIALIZED: 'initialized',
  THREAD_START: 'thread/start',
  THREAD_RESUME: 'thread/resume',
  THREAD_READ: 'thread/read',
  THREAD_UNSUBSCRIBE: 'thread/unsubscribe',
  TURN_START: 'turn/start',
  TURN_INTERRUPT: 'turn/interrupt',
  COLLAB_MODE_LIST: 'collaborationMode/list',
};

export const NOTIFY = {
  THREAD_STARTED: 'thread/started',
  TURN_STARTED: 'turn/started',
  TURN_COMPLETED: 'turn/completed',
  AGENT_MESSAGE_DELTA: 'item/agentMessage/delta',
  PLAN_DELTA: 'item/plan/delta',        // Plan mode streams the actual plan here (NOT agentMessage)
  ITEM_COMPLETED: 'item/completed',
  ERROR: 'error',
};

export const MODE = { PLAN: 'plan', DEFAULT: 'default' };

// Sorted; known ReasoningEffort values. The v2 protocol schema types ReasoningEffort as an open
// non-empty string ("advertised by the model") — this list is the superset of values the installed
// models advertise (GPT-5.6 Sol adds max/ultra), kept as a client-side guard for early typo errors.
export const EFFORTS = ['high', 'low', 'max', 'medium', 'minimal', 'none', 'ultra', 'xhigh'];

export const SERVER_REQUEST = {
  QUESTION: ['item/tool/requestUserInput'],
  APPROVAL: [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'execCommandApproval',
    'applyPatchApproval',
  ],
  ELICITATION: ['mcpServer/elicitation/request'],
};

export function buildTurnStart({ threadId, text, mode, effort, model, approvalPolicy }) {
  if (effort && !EFFORTS.includes(effort)) {
    throw new Error(`invalid effort '${effort}'; expected one of ${EFFORTS.join(', ')}`);
  }
  const params = { threadId, input: [{ type: 'text', text }] };
  if (approvalPolicy) params.approvalPolicy = approvalPolicy;
  if (mode === MODE.PLAN || mode === MODE.DEFAULT) {
    // Explicitly set the collaboration mode. PLAN enters read-only planning; DEFAULT exits it
    // (the manual "Shift+Tab to leave plan mode" before saving). collaborationMode.settings.model
    // must be a NON-NULL string for either mode (null is rejected -32600); reasoning_effort lives
    // in settings here, not as the top-level param.
    if (!model || typeof model !== 'string') {
      throw new Error(`${mode} mode requires a model string (collaborationMode.settings.model is required by the protocol)`);
    }
    const settings = { model };
    if (effort) settings.reasoning_effort = effort;
    params.collaborationMode = { mode, settings };
  } else if (effort) {
    // Plain send (no explicit mode): no collaborationMode, effort goes top-level.
    params.effort = effort;
  }
  return params;
}

export function classifyServerRequest(method, params) {
  let kind = 'unknown';
  if (SERVER_REQUEST.QUESTION.includes(method)) kind = 'question';
  else if (SERVER_REQUEST.APPROVAL.includes(method)) kind = 'approval';
  else if (SERVER_REQUEST.ELICITATION.includes(method)) kind = 'elicitation';
  return { kind, method, params };
}

// requestUserInput response: { answers: { <questionId>: { answers: string[] } } }
export function buildQuestionAnswer(questionId, answers) {
  return { answers: { [questionId]: { answers } } };
}

// Approval response shape depends on the request method (verified against codex 0.130.0 via
// generate-json-schema AND a live probe):
//   - v2 item/commandExecution/requestApproval & item/fileChange/requestApproval → accept|decline
//   - legacy execCommandApproval & applyPatchApproval (and unknown/undefined) → approved|denied
//   - item/permissions/requestApproval uses a different shape entirely → not supported here
const V2_ACCEPT_DECLINE = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
export function buildApprovalResponse(decision, method) {
  if (decision !== 'allow' && decision !== 'deny') {
    throw new Error(`invalid decision '${decision}'; expected allow|deny`);
  }
  if (method === 'item/permissions/requestApproval') {
    throw new Error('permissions approval not supported by approve yet (response shape is {permissions,scope,strictAutoReview})');
  }
  if (V2_ACCEPT_DECLINE.has(method)) {
    return { decision: decision === 'allow' ? 'accept' : 'decline' };
  }
  return { decision: decision === 'allow' ? 'approved' : 'denied' };
}
