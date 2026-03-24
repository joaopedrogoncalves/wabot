import type { GlobalConfig } from './config.js';

export type GeneratedImage = {
  data: Buffer;
  mimeType: string;
};

export type GeminiImageContext = {
  latestUserText?: string;
  replyText?: string;
  visualBrief?: string;
  reason?: string;
  literalness?: 'vibe' | 'balanced' | 'literal';
  mood?: string;
  style?: string;
  keySubjects?: string[];
  mustAvoid?: string[];
  textInImage?: 'none' | 'minimal' | 'allowed';
};

const GEMINI_IMAGE_TIMEOUT_MS = 180_000;
const GEMINI_IMAGE_MAX_ATTEMPTS = 2;
const GEMINI_LOGGABLE_RESPONSE_HEADERS = [
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-request-id',
  'request-id',
];

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

function getElapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}

function describeResponseHeaders(response: Response): string {
  const parts: string[] = [];
  for (const name of GEMINI_LOGGABLE_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) {
      parts.push(`${name}=${value}`);
    }
  }
  return parts.join(', ');
}

function buildGeminiPrompt(prompt: string, context?: GeminiImageContext): string {
  if (!context) return prompt;

  const sections = [
    'Create one image that captures the intended scene, characters, and mood without turning the idea into a wall of visible text.',
    'Use the caption and visual brief to understand the situation, but do not reproduce the wording as text inside the image.',
    'Preserve named characters, relationships, setting details, and the comedic or emotional premise when they are visually meaningful.',
    'Treat figurative language, similes, and metaphors as tone or styling cues, not literal objects or creatures, unless explicit literal depiction was requested.',
    'Example: if the caption says someone is "like a wet dog", capture the pathetic soaked-at-the-door vibe, but do not add an actual dog unless requested.',
  ];

  if (context.literalness === 'vibe') {
    sections.push(
      'Rendering mode: vibe.',
      'Prioritize atmosphere, body language, composition, lighting, and emotional tone over literal depiction of every sentence detail.',
      'Favor suggestive storytelling and mood over explicit textual references or infographic-like layouts.',
    );
  } else if (context.literalness === 'literal') {
    sections.push(
      'Rendering mode: literal.',
      'Depict the concrete scene details closely, but still avoid adding readable text unless explicitly allowed.',
    );
  } else {
    sections.push(
      'Rendering mode: balanced.',
      'Keep the main scene and joke recognizable, but lean on mood and composition more than literal wording.',
    );
  }

  if ((context.textInImage ?? 'none') === 'none') {
    sections.push(
      'Do not include readable text anywhere in the image.',
      'Avoid signs, posters, newspapers, subtitles, chat bubbles, labels, UI, headlines, captions, screenshots, and typographic layouts.',
      'If environmental text would naturally appear, keep it blurred, cropped, abstract, or unreadable.',
    );
  } else if (context.textInImage === 'minimal') {
    sections.push(
      'Keep visible text to an absolute minimum.',
      'Any unavoidable text should be tiny, secondary, and preferably unreadable rather than crisp headline text.',
    );
  } else {
    sections.push(
      'Readable text is allowed only when genuinely required by the request.',
      'Even then, keep the image visually led rather than text led.',
    );
  }

  if (context.reason) {
    sections.push(`Why this image is being generated: ${context.reason}`);
  }
  if (context.mood) {
    sections.push(`Target mood:\n${context.mood}`);
  }
  if (context.style) {
    sections.push(`Suggested style:\n${context.style}`);
  }
  if (context.keySubjects && context.keySubjects.length > 0) {
    sections.push(`Key subjects to include:\n- ${context.keySubjects.join('\n- ')}`);
  }
  if (context.mustAvoid && context.mustAvoid.length > 0) {
    sections.push(`Avoid these elements:\n- ${context.mustAvoid.join('\n- ')}`);
  }
  if (context.latestUserText) {
    sections.push(`Latest user request:\n${context.latestUserText}`);
  }
  if (context.replyText) {
    sections.push(`Bot reply/caption for context:\n${context.replyText}`);
  }
  sections.push(`Primary visual brief:\n${context.visualBrief ?? prompt}`);

  return sections.join('\n\n');
}

export async function generateImage(
  globalConfig: GlobalConfig,
  prompt: string,
  context?: GeminiImageContext,
): Promise<GeneratedImage | null> {
  if (!globalConfig.geminiApiKey) {
    console.warn('[gemini] GEMINI_API_KEY is not set; skipping image generation.');
    return null;
  }

  const model = globalConfig.geminiImageModel;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(globalConfig.geminiApiKey)}`;
  const finalPrompt = buildGeminiPrompt(prompt, context);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= GEMINI_IMAGE_MAX_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    console.log(
      `[gemini] Starting image request attempt ${attempt}/${GEMINI_IMAGE_MAX_ATTEMPTS} ` +
      `model=${model} promptChars=${finalPrompt.length} timeoutMs=${GEMINI_IMAGE_TIMEOUT_MS}`,
    );
    console.log(`[gemini] Final prompt for attempt ${attempt}/${GEMINI_IMAGE_MAX_ATTEMPTS}:\n${finalPrompt}`);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{ text: finalPrompt }],
          }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
          },
        }),
        signal: AbortSignal.timeout(GEMINI_IMAGE_TIMEOUT_MS),
      });
      const responseElapsedMs = getElapsedMs(startedAt);
      const headerSummary = describeResponseHeaders(response);
      console.log(
        `[gemini] Response received on attempt ${attempt}/${GEMINI_IMAGE_MAX_ATTEMPTS} ` +
        `after ${responseElapsedMs}ms: status=${response.status} ${response.statusText}` +
        (headerSummary ? ` headers=[${headerSummary}]` : ''),
      );

      if (!response.ok) {
        const bodyText = await response.text();
        throw new Error(`Gemini image request failed (${response.status}): ${bodyText.slice(0, 400)}`);
      }

      const payload = await response.json() as GeminiResponse;
      const imagePart = payload.candidates
        ?.flatMap((candidate) => candidate.content?.parts ?? [])
        .find((part) => part.inlineData?.data);

      if (!imagePart?.inlineData?.data) {
        console.warn(
          `[gemini] No image part returned on attempt ${attempt}/${GEMINI_IMAGE_MAX_ATTEMPTS} ` +
          `after ${getElapsedMs(startedAt)}ms`,
        );
        return null;
      }

      console.log(
        `[gemini] Image generated on attempt ${attempt}/${GEMINI_IMAGE_MAX_ATTEMPTS} ` +
        `after ${getElapsedMs(startedAt)}ms mimeType=${imagePart.inlineData.mimeType || 'image/png'}`,
      );

      return {
        data: Buffer.from(imagePart.inlineData.data, 'base64'),
        mimeType: imagePart.inlineData.mimeType || 'image/png',
      };
    } catch (err) {
      lastError = err;
      const elapsedMs = getElapsedMs(startedAt);
      console.warn(
        `[gemini] Image request failed on attempt ${attempt}/${GEMINI_IMAGE_MAX_ATTEMPTS} ` +
        `after ${elapsedMs}ms: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!isTimeoutError(err) || attempt >= GEMINI_IMAGE_MAX_ATTEMPTS) {
        break;
      }
      console.warn(`[gemini] Image request timed out on attempt ${attempt}/${GEMINI_IMAGE_MAX_ATTEMPTS}; retrying once.`);
    }
  }

  throw lastError;
}
