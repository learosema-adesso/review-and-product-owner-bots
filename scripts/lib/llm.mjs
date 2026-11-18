import { createGeminiProvider, DEFAULT_GEMINI_MODEL } from './providers/gemini.mjs';
import { createOpenAiProvider } from './providers/openai.mjs';

/**
 * The one place that talks to an AI provider. Both bots call `ask()` and do not care which
 * provider answers. Configuration comes from the environment (empty values count as unset):
 *
 *   LLM_PROVIDER   gemini (default) or openai
 *   LLM_API_KEY    API key. For gemini, GEMINI_API_KEY works as well
 *   LLM_MODEL      model name. For gemini, GEMINI_MODEL works as well and a default exists
 *   LLM_BASE_URL   openai only: default https://api.openai.com/v1
 *   GEMINI_PROJECT_ID, GEMINI_LOCATION   gemini only
 */

export const PROVIDERS = ['gemini', 'openai'];
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

const pick = (...values) => values.map((v) => String(v ?? '').trim()).find(Boolean);

/** Reads and checks the configuration. Throws an error that names the variable to fix. */
export function loadLlmConfig(env = process.env) {
  const provider = (pick(env.LLM_PROVIDER) ?? 'gemini').toLowerCase();
  if (!PROVIDERS.includes(provider))
    throw new Error(`LLM_PROVIDER "${provider}" is unknown. Use one of: ${PROVIDERS.join(', ')}.`);

  if (provider === 'gemini') {
    const apiKey = pick(env.LLM_API_KEY, env.GEMINI_API_KEY);
    if (!apiKey)
      throw new Error(
        'LLM_API_KEY secret is missing! (for the gemini provider, GEMINI_API_KEY works too)',
      );
    return {
      provider,
      apiKey,
      model: pick(env.LLM_MODEL, env.GEMINI_MODEL) ?? DEFAULT_GEMINI_MODEL,
      projectId: pick(env.GEMINI_PROJECT_ID),
      location: pick(env.GEMINI_LOCATION),
    };
  }

  const apiKey = pick(env.LLM_API_KEY);
  if (!apiKey)
    throw new Error(
      'LLM_API_KEY secret is missing! (the openai provider needs it, services without a key accept any value)',
    );
  const model = pick(env.LLM_MODEL);
  if (!model)
    throw new Error('LLM_MODEL is not set. The openai provider needs the name of a chat model.');
  return { provider, apiKey, model, baseUrl: pick(env.LLM_BASE_URL) ?? DEFAULT_BASE_URL };
}

/**
 * Creates the provider. `fetchImpl`, `sleep`, `ai` and `timeoutMs` are test seams.
 * Returns `{ provider, model, ask }`, `ask({ system, prompt, schema, temperature })` resolves to
 * the parsed JSON when a schema is given, otherwise to the text.
 */
export function createLlm({ env = process.env, fetchImpl, sleep, ai, timeoutMs } = {}) {
  const config = loadLlmConfig(env);
  const ask =
    config.provider === 'gemini'
      ? createGeminiProvider({ ...config, ai, sleep })
      : createOpenAiProvider({ ...config, fetchImpl, sleep, timeoutMs });
  return { provider: config.provider, model: config.model, ask };
}

/** For the bots: the ask function, or null after the job was failed with a clear message. */
export function askFromEnv(core, options) {
  try {
    const llm = createLlm(options);
    core.info(`AI provider: ${llm.provider}, model: ${llm.model}`);
    return llm.ask;
  } catch (error) {
    core.setFailed(error.message);
    return null;
  }
}
