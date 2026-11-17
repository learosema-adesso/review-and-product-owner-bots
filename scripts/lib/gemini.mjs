import { GoogleGenAI } from '@google/genai';

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const RETRYABLE = new Set([429, 500, 503]);

/** Creates the Gemini client shared by all bots. */
export const createGeminiClient = (apiKey) =>
  new GoogleGenAI({
    apiKey,
    enterprise: true,
    project: process.env.GEMINI_PROJECT_ID,
    location: process.env.GEMINI_LOCATION || 'us-central1',
  });

/**
 * Calls the Gemini API and retries when the model is overloaded.
 */
export async function gemini({ ai, system, prompt, schema, temperature = 0.85 }) {
  let response;

  for (let attempt = 1; ; attempt++) {
    try {
      response = await ai.models.generateContent({
        model: GEMINI_MODEL,
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
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
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
}
