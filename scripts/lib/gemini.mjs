import { GoogleGenAI } from '@google/genai';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const RETRYABLE = new Set([429, 500, 503]);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Provider for the Gemini API. Retries when the model is overloaded.
 * `ai` can be passed in to replace the real client (tests).
 */
export function createGeminiProvider({
  apiKey,
  model = DEFAULT_GEMINI_MODEL,
  projectId,
  location = 'us-central1',
  ai = new GoogleGenAI({ apiKey, enterprise: true, project: projectId, location }),
  sleep = defaultSleep,
}) {
  return async function ask({ system, prompt, schema, temperature = 0.85 }) {
    let response;

    for (let attempt = 1; ; attempt++) {
      try {
        response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction: system,
            temperature,
            abortSignal: AbortSignal.timeout(180_000),
            ...(schema && { responseMimeType: 'application/json', responseSchema: schema }),
          },
        });
        break;
      } catch (error) {
        // overload (429/503) happens fairly often with the flash models
        if (attempt >= 3 || !RETRYABLE.has(error.status)) throw error;
        await sleep(2000 * attempt);
      }
    }

    const text = response.text?.trim(); // joins text parts, thinking parts are left out
    if (!text) {
      const candidate = response.candidates?.[0];
      throw new Error(
        `Gemini returned no text (finishReason: ${candidate?.finishReason ?? 'n/a'}, ` +
          `blockReason: ${response.promptFeedback?.blockReason ?? 'n/a'})`,
      );
    }
    return schema ? JSON.parse(text) : text;
  };
}
