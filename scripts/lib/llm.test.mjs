import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { askFromEnv, createLlm, loadLlmConfig, DEFAULT_BASE_URL } from './llm.mjs';

test('gemini is the default and keeps working with the old variables', () => {
  const config = loadLlmConfig({
    GEMINI_API_KEY: 'g',
    GEMINI_MODEL: 'gem-x',
    GEMINI_PROJECT_ID: 'p',
    GEMINI_LOCATION: 'eu',
  });
  assert.deepEqual(config, {
    provider: 'gemini',
    apiKey: 'g',
    model: 'gem-x',
    projectId: 'p',
    location: 'eu',
  });
  assert.equal(loadLlmConfig({ GEMINI_API_KEY: 'g' }).model, 'gemini-3.6-flash');
});

test('the LLM_ variables win over the GEMINI_ ones, empty values count as unset', () => {
  const config = loadLlmConfig({
    LLM_API_KEY: 'new',
    GEMINI_API_KEY: 'old',
    LLM_MODEL: 'm1',
    GEMINI_MODEL: 'm2',
  });
  assert.deepEqual([config.apiKey, config.model], ['new', 'm1']);
  const empty = loadLlmConfig({
    LLM_PROVIDER: '',
    LLM_API_KEY: '  ',
    GEMINI_API_KEY: 'old',
    LLM_MODEL: '',
  });
  assert.deepEqual([empty.provider, empty.apiKey], ['gemini', 'old']);
});

test('the openai provider needs a key and a model and defaults to the OpenAI API', () => {
  const config = loadLlmConfig({
    LLM_PROVIDER: 'OpenAI',
    LLM_API_KEY: 'sk',
    LLM_MODEL: 'some-model',
  });
  assert.deepEqual(config, {
    provider: 'openai',
    apiKey: 'sk',
    model: 'some-model',
    baseUrl: DEFAULT_BASE_URL,
  });
  assert.equal(DEFAULT_BASE_URL, 'https://api.openai.com/v1');
  assert.equal(
    loadLlmConfig({
      LLM_PROVIDER: 'openai',
      LLM_API_KEY: 'k',
      LLM_MODEL: 'm',
      LLM_BASE_URL: 'http://localhost:11434/v1',
    }).baseUrl,
    'http://localhost:11434/v1',
  );
});

test('a missing key fails early and names the variable of the selected provider', () => {
  assert.throws(
    () => loadLlmConfig({}),
    /LLM_API_KEY secret is missing! \(for the gemini provider, GEMINI_API_KEY works too\)/,
  );
  assert.throws(
    () => loadLlmConfig({ LLM_PROVIDER: 'openai', GEMINI_API_KEY: 'g', LLM_MODEL: 'm' }),
    /LLM_API_KEY secret is missing!/,
  );
  assert.throws(
    () => loadLlmConfig({ LLM_PROVIDER: 'openai', LLM_API_KEY: 'k' }),
    /LLM_MODEL is not set/,
  );
  assert.throws(
    () => loadLlmConfig({ LLM_PROVIDER: 'claude', LLM_API_KEY: 'k' }),
    /LLM_PROVIDER "claude" is unknown. Use one of: gemini, openai/,
  );
});

test('both providers sit behind the same ask()', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
    };
  };
  const openai = createLlm({
    env: { LLM_PROVIDER: 'openai', LLM_API_KEY: 'k', LLM_MODEL: 'm' },
    fetchImpl,
  });
  assert.equal(await openai.ask({ system: 's', prompt: 'p' }), 'hi');
  assert.equal(requests[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(requests[0].body.model, 'm');

  const ai = { models: { generateContent: async () => ({ text: 'hello' }) } };
  const gemini = createLlm({ env: { GEMINI_API_KEY: 'g' }, ai });
  assert.deepEqual([gemini.provider, gemini.model], ['gemini', 'gemini-3.6-flash']);
  assert.equal(await gemini.ask({ system: 's', prompt: 'p' }), 'hello');
});

test('askFromEnv fails the job with the message instead of throwing', () => {
  const core = {
    failed: null,
    infos: [],
    setFailed(m) {
      this.failed = m;
    },
    info(m) {
      this.infos.push(m);
    },
  };
  assert.equal(askFromEnv(core, { env: {} }), null);
  assert.match(core.failed, /LLM_API_KEY/);

  const ok = {
    infos: [],
    setFailed() {
      throw new Error('should not fail');
    },
    info(m) {
      this.infos.push(m);
    },
  };
  assert.equal(typeof askFromEnv(ok, { env: { GEMINI_API_KEY: 'g' }, ai: {} }), 'function');
  assert.match(ok.infos[0], /AI provider: gemini, model: gemini-3.6-flash/);
});

test('the Gemini SDK is not loaded when another provider is used', () => {
  // A child process where importing the SDK throws: the openai provider must work regardless
  const script = `
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier === '@google/genai') throw new Error('the Gemini SDK was loaded');
        return next(specifier, context);
      },
    });
    const { createLlm } = await import(${JSON.stringify(new URL('./llm.mjs', import.meta.url).href)});
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
    const { ask } = createLlm({ env: { LLM_PROVIDER: 'openai', LLM_API_KEY: 'k', LLM_MODEL: 'm' }, fetchImpl });
    console.log(await ask({ system: 's', prompt: 'p' }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  assert.equal(out.trim(), 'ok');
});
