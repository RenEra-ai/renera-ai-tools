import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServer } from '../lib/appserver.mjs';

// This exercises the installed Codex runtime, not the mock app-server. All model requests
// terminate at the local deterministic fixture: no login, credentials, or paid inference.
const ENABLED = process.env.CODEX_DRIVE_MODEL_PROTOCOL === '1';
const CODEX = process.env.CODEX_DRIVE_MODEL_PROTOCOL_CODEX || 'codex';
const CONFIG_MODEL = 'gpt-5.5';
const SESSION_MODEL = 'gpt-5.6-sol';
const TURN_MODEL = 'gpt-5.6-terra';
const REVIEW_MODEL = 'gpt-5.4';
const REVIEW_TEXT = JSON.stringify({ findings: [], overall_correctness: 'patch is correct',
  overall_explanation: 'The local protocol fixture found no issues.', overall_confidence_score: 1 });

async function bounded(promise, label, ms = 15000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function localProvider() {
  const models = [];
  const errors = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/responses');
      assert.equal(req.headers.authorization, undefined, 'fixture must not receive credentials');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(typeof body.model, 'string');
      models.push(body.model);
      const id = `fixture-response-${models.length}`;
      const item = { id: `fixture-message-${models.length}`, type: 'message', role: 'assistant',
        status: 'completed', content: [{ type: 'output_text', text: REVIEW_TEXT, annotations: [] }] };
      const response = { id, object: 'response', model: body.model, status: 'completed',
        output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0,
          item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0,
          delta: REVIEW_TEXT },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    } catch (error) {
      errors.push(error);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  return { server, models, errors };
}

async function stopChild(app) {
  const child = app.child;
  if (!child) return;
  const signal = (name) => {
    try {
      if (process.platform === 'win32') child.kill(name);
      else process.kill(-child.pid, name);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  if (child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close');
    signal('SIGTERM');
    try { await bounded(closed, 'app-server shutdown', 3000); }
    catch { signal('SIGKILL'); await bounded(closed, 'app-server kill', 3000); }
  }
  // Also reap descendants if the launcher exited before its app-server child.
  if (process.platform !== 'win32') signal('SIGKILL');
  await app.stop();
}

for (const reviewModel of [null, REVIEW_MODEL]) {
  test(`installed model protocol: native review ${reviewModel ? 'uses review_model' : 'inherits the session model'}`,
    { skip: !ENABLED, timeout: 60000 }, async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'cdx-model-protocol-'));
      const codexHome = join(dir, 'codex-home');
      const cwd = join(dir, 'project');
      mkdirSync(codexHome);
      mkdirSync(cwd);
      const provider = localProvider();
      let app;
      let stderr = '';
      const notifications = [];
      try {
        provider.server.listen(0, '127.0.0.1');
        await bounded(once(provider.server, 'listening'), 'local provider startup');
        const baseUrl = `http://127.0.0.1:${provider.server.address().port}/v1`;
        // Explicit allowlist: do not inherit API keys, Codex app state, or HTTP proxies.
        const env = { PATH: process.env.PATH, CODEX_HOME: codexHome,
          TMPDIR: dir, TMP: dir, TEMP: dir, RUST_LOG: 'off' };
        if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
        const version = execFileSync(CODEX, ['--version'], { cwd, env, encoding: 'utf8', timeout: 10000 }).trim();
        t.diagnostic(version);
        writeFileSync(join(codexHome, 'config.toml'), `model = "${CONFIG_MODEL}"
model_provider = "protocol_fixture"
${reviewModel ? `review_model = "${reviewModel}"` : ''}
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
web_search = "disabled"
[analytics]
enabled = false
[feedback]
enabled = false
[otel]
exporter = "none"
metrics_exporter = "none"
trace_exporter = "none"
[model_providers.protocol_fixture]
name = "Local model protocol fixture"
base_url = "${baseUrl}"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 5000
`);
        app = new AppServer({ command: CODEX, args: ['app-server'], cwd,
          spawnFn: (command, args, opts) => {
            const child = spawn(command, args, { ...opts, env, detached: process.platform !== 'win32',
              stdio: ['pipe', 'pipe', 'pipe'] });
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-12000); });
            return child;
          } });
        app.on('notification', (method, params) => notifications.push({ method, params }));
        app.on('serverRequest', ({ id, method }) => app.respondError(id, -32601,
          `The local protocol fixture does not execute tools: ${method}`));
        await app.start();
        await bounded(app.initialize({ name: 'codex-drive-model-protocol', version: '0.1.0' }), 'initialize');
        const started = await bounded(app.request('thread/start', { cwd, model: SESSION_MODEL,
          modelProvider: 'protocol_fixture', approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true }),
        'thread/start');
        assert.equal(started.model, SESSION_MODEL, 'thread/start must echo the resolved model');
        assert.equal(started.modelProvider, 'protocol_fixture');
        const threadId = started.thread.id;

        async function run(method, params, expectedModel) {
          const previousCount = provider.models.length;
          const offset = notifications.length;
          const result = await bounded(app.request(method, { threadId, ...params }), method);
          // Review turn/started IDs may differ from response/completion IDs. Match the response.
          const isCompleted = ({ method: name, params: event }) => name === 'turn/completed'
            && event.threadId === threadId && event.turn.id === result.turn.id;
          let completion = notifications.slice(offset).find(isCompleted);
          if (!completion) {
            let listener;
            try {
              completion = await bounded(new Promise((resolve) => {
                listener = (name, event) => {
                  if (isCompleted({ method: name, params: event })) resolve({ method: name, params: event });
                };
                app.on('notification', listener);
              }), `${method} completion`);
            } finally { app.off('notification', listener); }
          }
          assert.equal(completion.params.turn.status, 'completed', JSON.stringify(completion.params.turn.error));
          assert.deepEqual(provider.errors, []);
          assert.deepEqual(provider.models.slice(previousCount), [expectedModel],
            `${method} must send exactly one request using ${expectedModel}`);
        }

        const target = { type: 'custom', instructions: 'Return an empty review with no findings.' };
        await run('review/start', { target, delivery: 'inline' }, reviewModel || SESSION_MODEL);
        await run('turn/start', { model: TURN_MODEL, input: [{ type: 'text', text: 'Return an empty review.' }] }, TURN_MODEL);
        await run('review/start', { target, delivery: 'inline' }, reviewModel || TURN_MODEL);
        t.diagnostic(`outbound models: ${provider.models.join(' -> ')}`);
        const settings = notifications.filter(({ method }) => method === 'thread/settings/updated');
        t.diagnostic(`thread/settings/updated models: ${settings.map(({ params }) => params.threadSettings.model).join(', ') || '(none)'}`);
      } catch (error) {
        if (stderr) t.diagnostic(`app-server stderr: ${stderr}`);
        throw error;
      } finally {
        try { if (app) await stopChild(app); }
        finally {
          provider.server.closeAllConnections();
          await new Promise((resolve) => provider.server.close(resolve));
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });
}
