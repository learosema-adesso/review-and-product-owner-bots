import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLlm } from './llm.mjs';

/** A real HTTP server that speaks just enough of the chat completions API. */
const requests = [];
let mode = 'ok';
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    requests.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      type: req.headers['content-type'],
      body: JSON.parse(raw),
    });
    if (mode === 'hang') return; // never answers
    if (mode === 'unauthorized') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error":{"message":"Incorrect API key"}}');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          { message: { content: '{"verdict":"fixed","reply":"done"}' }, finish_reason: 'stop' },
        ],
      }),
    );
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => {
  server.closeAllConnections?.();
  server.close();
});

const env = () => ({
  LLM_PROVIDER: 'openai',
  LLM_API_KEY: 'sk-local',
  LLM_MODEL: 'local-model',
  LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
});
const schema = {
  type: 'OBJECT',
  properties: { verdict: { type: 'STRING', enum: ['fixed', 'open'] }, reply: { type: 'STRING' } },
  required: ['verdict', 'reply'],
};

test('with the real fetch: request format and structured answer', async () => {
  mode = 'ok';
  requests.length = 0;
  const { ask } = createLlm({ env: env() });
  const answer = await ask({ system: 'Judge.', prompt: 'Is it fixed?', schema, temperature: 0.1 });
  assert.deepEqual(answer, { verdict: 'fixed', reply: 'done' });

  const [request] = requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/v1/chat/completions');
  assert.equal(request.auth, 'Bearer sk-local');
  assert.equal(request.type, 'application/json');
  assert.equal(request.body.model, 'local-model');
  assert.equal(request.body.temperature, 0.1);
  assert.equal(request.body.response_format.json_schema.schema.properties.verdict.type, 'string');
});

test('with the real fetch: an error status becomes a readable error', async () => {
  mode = 'unauthorized';
  const { ask } = createLlm({ env: env() });
  await assert.rejects(
    ask({ system: 's', prompt: 'p' }),
    /HTTP 401: \{"error":\{"message":"Incorrect API key"\}\}/,
  );
});

test('with the real fetch: a server that never answers hits the timeout', async () => {
  mode = 'hang';
  const { ask } = createLlm({ env: env(), timeoutMs: 150 });
  await assert.rejects(ask({ system: 's', prompt: 'p' }), /timed out after 150 ms/);
});
