import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiProvider } from './gemini.mjs';

const fakeAi = (...steps) => {
  const calls = [];
  return {
    calls,
    models: {
      generateContent: async (params) => {
        calls.push(params);
        const step = steps.length > 1 ? steps.shift() : steps[0];
        if (step instanceof Error) throw step;
        return step;
      },
    },
  };
};
const make = (ai, extra = {}) =>
  createGeminiProvider({ apiKey: 'k', model: 'm', ai, sleep: async () => {}, ...extra });

test('passes model, prompt, system and temperature, and returns the text', async () => {
  const ai = fakeAi({ text: ' Hello ' });
  assert.equal(await make(ai)({ system: 'S', prompt: 'P', temperature: 0.3 }), 'Hello');
  assert.equal(ai.calls[0].model, 'm');
  assert.equal(ai.calls[0].contents, 'P');
  assert.equal(ai.calls[0].config.systemInstruction, 'S');
  assert.equal(ai.calls[0].config.temperature, 0.3);
  assert.equal('responseSchema' in ai.calls[0].config, false);
});

test('a schema is passed in the Gemini dialect as it is and the answer is parsed', async () => {
  const schema = { type: 'OBJECT', properties: { a: { type: 'STRING' } } };
  const ai = fakeAi({ text: '{"a":"x"}' });
  assert.deepEqual(await make(ai)({ system: 'S', prompt: 'P', schema }), { a: 'x' });
  assert.equal(ai.calls[0].config.responseSchema, schema);
  assert.equal(ai.calls[0].config.responseMimeType, 'application/json');
});

test('overload is retried up to three attempts, other errors are not', async () => {
  const overloaded = Object.assign(new Error('busy'), { status: 503 });
  const ok = fakeAi(overloaded, Object.assign(new Error('busy'), { status: 429 }), {
    text: 'fine',
  });
  assert.equal(await make(ok)({ system: 'S', prompt: 'P' }), 'fine');
  assert.equal(ok.calls.length, 3);

  const never = fakeAi(overloaded);
  await assert.rejects(make(never)({ system: 'S', prompt: 'P' }), /busy/);
  assert.equal(never.calls.length, 3);

  const bad = fakeAi(Object.assign(new Error('bad request'), { status: 400 }));
  await assert.rejects(make(bad)({ system: 'S', prompt: 'P' }), /bad request/);
  assert.equal(bad.calls.length, 1);
});

test('no text is an error with the reason', async () => {
  const ai = fakeAi({
    text: '',
    candidates: [{ finishReason: 'SAFETY' }],
    promptFeedback: { blockReason: 'OTHER' },
  });
  await assert.rejects(
    make(ai)({ system: 'S', prompt: 'P' }),
    /no text \(finishReason: SAFETY, blockReason: OTHER\)/,
  );
});
