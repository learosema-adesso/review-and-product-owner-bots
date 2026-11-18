import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiProvider, parseJsonAnswer } from './openai.mjs';

const SCHEMA = {
  type: 'OBJECT',
  properties: { verdict: { type: 'STRING', enum: ['fixed', 'open'] }, reply: { type: 'STRING' } },
  required: ['verdict', 'reply'],
};

const reply = (content, extra = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }], ...extra }),
  text: async () => '',
});
const failure = (status, body = '') => ({ ok: false, status, text: async () => body });

/** Fake fetch that answers from a list and records the requests. */
function fakeFetch(...answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

const make = (fetchImpl, extra = {}) =>
  createOpenAiProvider({
    apiKey: 'sk-test',
    model: 'my-model',
    baseUrl: 'https://api.example.com/v1/',
    fetchImpl,
    sleep: async () => {},
    ...extra,
  });

test('sends a chat completion with key, model, messages and temperature', async () => {
  const fetchImpl = fakeFetch(reply('Hello there'));
  const text = await make(fetchImpl)({ system: 'Be nice.', prompt: 'Hi', temperature: 0.2 });
  assert.equal(text, 'Hello there');

  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://api.example.com/v1/chat/completions'); // trailing slash handled
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(call.body, {
    model: 'my-model',
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'Be nice.' },
      { role: 'user', content: 'Hi' },
    ],
  });
  assert.ok(call.init.signal, 'a request timeout applies');
});

test('a schema is sent as response_format in standard JSON Schema, and named in the system prompt', async () => {
  const fetchImpl = fakeFetch(reply('{"verdict":"fixed","reply":"ok"}'));
  const value = await make(fetchImpl)({ system: 'Judge.', prompt: 'x', schema: SCHEMA });
  assert.deepEqual(value, { verdict: 'fixed', reply: 'ok' });

  const { body } = fetchImpl.calls[0];
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, false);
  assert.equal(body.response_format.json_schema.schema.type, 'object');
  assert.deepEqual(body.response_format.json_schema.schema.required, ['verdict', 'reply']);
  assert.match(body.messages[0].content, /^Judge\.\n\nAnswer with one JSON object/);
  assert.match(body.messages[0].content, /"verdict"/);
});

test('rate limits and server errors are retried, a good answer afterwards is used', async () => {
  const fetchImpl = fakeFetch(failure(429), failure(503), reply('done'));
  const sleeps = [];
  const text = await make(fetchImpl, { sleep: async (ms) => sleeps.push(ms) })({
    system: 's',
    prompt: 'p',
  });
  assert.equal(text, 'done');
  assert.equal(fetchImpl.calls.length, 3);
  assert.deepEqual(sleeps, [2000, 4000]);

  const again = fakeFetch(failure(500), reply('ok'));
  assert.equal(await make(again)({ system: 's', prompt: 'p' }), 'ok');
});

test('after three attempts the error says what the service answered', async () => {
  const fetchImpl = fakeFetch(failure(503, 'overloaded'));
  await assert.rejects(make(fetchImpl)({ system: 's', prompt: 'p' }), (error) => {
    assert.match(error.message, /HTTP 503: overloaded/);
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 3);
});

test('other errors are not retried, and the key never shows up in the message', async () => {
  const fetchImpl = fakeFetch(failure(401, '{"error":{"message":"Incorrect API key"}}'));
  await assert.rejects(make(fetchImpl)({ system: 's', prompt: 'p' }), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.equal(error.message.includes('sk-test'), false);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test('a timeout and a network error get a clear message', async () => {
  const timeout = Object.assign(new Error('x'), { name: 'TimeoutError' });
  await assert.rejects(
    make(fakeFetch(timeout), { timeoutMs: 5000 })({ system: 's', prompt: 'p' }),
    /timed out after 5 seconds/,
  );
  await assert.rejects(
    make(fakeFetch(new Error('ECONNREFUSED')))({ system: 's', prompt: 'p' }),
    /failed: ECONNREFUSED/,
  );
});

test('a malformed answer is retried once and then used', async () => {
  const fetchImpl = fakeFetch(
    reply('Sure! Here is the verdict'),
    reply('{"verdict":"open","reply":"nope"}'),
  );
  const value = await make(fetchImpl)({ system: 's', prompt: 'p', schema: SCHEMA });
  assert.equal(value.verdict, 'open');
  assert.equal(fetchImpl.calls.length, 2);
});

test('an answer that breaks the schema is retried once, then the run fails with a clear message', async () => {
  const fetchImpl = fakeFetch(reply('{"verdict":"maybe","reply":"x"}'));
  await assert.rejects(
    make(fetchImpl)({ system: 's', prompt: 'p', schema: SCHEMA }),
    /did not return a valid answer for the schema, even after a retry \(\$\.verdict should be one of fixed, open\)/,
  );
  assert.equal(fetchImpl.calls.length, 2);

  const missing = fakeFetch(reply('{"verdict":"fixed"}'));
  await assert.rejects(
    make(missing)({ system: 's', prompt: 'p', schema: SCHEMA }),
    /\$\.reply is missing/,
  );
});

test('fenced JSON, reasoning blocks and content parts are understood', async () => {
  assert.deepEqual(parseJsonAnswer('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonAnswer('<think>hmm {"a":2}</think>\n{"a":1}'), { a: 1 });
  assert.throws(() => parseJsonAnswer('not json'));

  const parts = fakeFetch(
    reply([
      { type: 'text', text: '{"verdict":"fixed",' },
      { type: 'text', text: '"reply":"r"}' },
    ]),
  );
  assert.equal((await make(parts)({ system: 's', prompt: 'p', schema: SCHEMA })).reply, 'r');
});

test('an empty answer is an error that names the finish reason', async () => {
  const empty = {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
  };
  await assert.rejects(
    make(fakeFetch(empty))({ system: 's', prompt: 'p' }),
    /no text \(finish_reason: length\)/,
  );
});

test('without a schema the answer stays text, even if it looks like JSON', async () => {
  assert.equal(await make(fakeFetch(reply('{"a":1}')))({ system: 's', prompt: 'p' }), '{"a":1}');
});
