import { toJsonSchema, validateAgainstSchema } from '../llm-schema.mjs';

/**
 * Provider for every service with an OpenAI-compatible chat completions API (OpenAI, OpenRouter,
 * Mistral, Ollama, vLLM, Azure OpenAI, ...). Plain `fetch`, no dependency.
 */

const RETRYABLE = new Set([429, 500, 503]);
const MAX_HTTP_ATTEMPTS = 3;
const MAX_ANSWER_ATTEMPTS = 2;
const TIMEOUT_MS = 180_000;
const ERROR_BODY_CHARS = 300;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Some services return the content as a list of parts instead of a string. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('');
  return '';
}

/** Reads the JSON out of an answer that may be fenced or preceded by reasoning. */
export function parseJsonAnswer(text) {
  const withoutThinking = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = withoutThinking.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : withoutThinking);
}

export function createOpenAiProvider({
  apiKey,
  model,
  baseUrl,
  fetchImpl = fetch,
  sleep = defaultSleep,
  timeoutMs = TIMEOUT_MS,
}) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  /** One chat completion, with retries for rate limits and server errors. */
  async function complete(body) {
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError')
          throw new Error(
            `The request to ${url} timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} seconds` : `${timeoutMs} ms`}`,
          );
        throw new Error(`The request to ${url} failed: ${error?.message ?? error}`);
      }

      if (!response.ok) {
        if (attempt < MAX_HTTP_ATTEMPTS && RETRYABLE.has(response.status)) {
          await sleep(2000 * attempt);
          continue;
        }
        const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim();
        const error = new Error(
          `The AI service answered with HTTP ${response.status}${detail ? `: ${detail.slice(0, ERROR_BODY_CHARS)}` : ''}`,
        );
        error.status = response.status;
        throw error;
      }

      const data = await response.json();
      const choice = data?.choices?.[0];
      const text = contentText(choice?.message?.content).trim();
      if (!text)
        throw new Error(
          `The AI service returned no text (finish_reason: ${choice?.finish_reason ?? 'n/a'})`,
        );
      return text;
    }
  }

  return async function ask({ system, prompt, schema, temperature = 0.85 }) {
    const jsonSchema = schema ? toJsonSchema(schema) : null;
    const body = {
      model,
      temperature,
      messages: [
        {
          role: 'system',
          // Not every compatible service supports response_format: say it in words as well
          content: jsonSchema
            ? `${system}\n\nAnswer with one JSON object and nothing else. It must match this JSON schema:\n${JSON.stringify(jsonSchema)}`
            : system,
        },
        { role: 'user', content: prompt },
      ],
      ...(jsonSchema && {
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'answer', schema: jsonSchema, strict: false },
        },
      }),
    };

    for (let attempt = 1; ; attempt++) {
      const text = await complete(body);
      if (!jsonSchema) return text;
      try {
        const value = parseJsonAnswer(text);
        const problems = validateAgainstSchema(value, jsonSchema);
        if (problems.length) throw new Error(problems.slice(0, 3).join('; '));
        return value;
      } catch (error) {
        // a malformed answer is retried once, then the run fails with a message that says why
        if (attempt >= MAX_ANSWER_ATTEMPTS)
          throw new Error(
            `The model did not return a valid answer for the schema, even after a retry (${error.message}). ` +
              'Models that cannot reliably produce structured output are a poor fit for the bots.',
          );
      }
    }
  };
}
