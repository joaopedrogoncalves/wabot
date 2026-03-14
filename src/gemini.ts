import type { GlobalConfig } from './config.js';

export type GeneratedImage = {
  data: Buffer;
  mimeType: string;
};

const GEMINI_IMAGE_TIMEOUT_MS = 180_000;
const GEMINI_IMAGE_MAX_ATTEMPTS = 2;

type GeminiPart = {
  text?: string;
  inlineData?: {
    mimeType?: string;
    data?: string;
  };
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
  }>;
};

function isTimeoutError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'TimeoutError';
}

export async function generateImage(
  globalConfig: GlobalConfig,
  prompt: string,
): Promise<GeneratedImage | null> {
  if (!globalConfig.geminiApiKey) {
    console.warn('[gemini] GEMINI_API_KEY is not set; skipping image generation.');
    return null;
  }

  const model = globalConfig.geminiImageModel;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(globalConfig.geminiApiKey)}`;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= GEMINI_IMAGE_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{ text: prompt }],
          }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
          },
        }),
        signal: AbortSignal.timeout(GEMINI_IMAGE_TIMEOUT_MS),
      });

      if (!response.ok) {
        const bodyText = await response.text();
        throw new Error(`Gemini image request failed (${response.status}): ${bodyText.slice(0, 400)}`);
      }

      const payload = await response.json() as GeminiResponse;
      const imagePart = payload.candidates
        ?.flatMap((candidate) => candidate.content?.parts ?? [])
        .find((part) => part.inlineData?.data);

      if (!imagePart?.inlineData?.data) {
        return null;
      }

      return {
        data: Buffer.from(imagePart.inlineData.data, 'base64'),
        mimeType: imagePart.inlineData.mimeType || 'image/png',
      };
    } catch (err) {
      lastError = err;
      if (!isTimeoutError(err) || attempt >= GEMINI_IMAGE_MAX_ATTEMPTS) {
        break;
      }
      console.warn(`[gemini] Image request timed out on attempt ${attempt}/${GEMINI_IMAGE_MAX_ATTEMPTS}; retrying once.`);
    }
  }

  throw lastError;
}
