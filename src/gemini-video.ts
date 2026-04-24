import { createWriteStream } from 'fs';
import { appendFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import type { GlobalConfig } from './config.js';

export type GeneratedVideo = {
  filePath: string;
  mimeType: string;
};

export type GeminiVideoOptions = {
  aspectRatio?: '16:9' | '9:16';
  durationSeconds?: 4 | 6 | 8;
  resolution?: '720p' | '1080p' | '4k';
  personGeneration?: 'allow_all' | 'allow_adult' | 'dont_allow';
};

type VeoOperationResponse = {
  name?: string;
  done?: boolean;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{
        video?: {
          uri?: string;
        };
      }>;
    };
  };
};

const GEMINI_VIDEO_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_VIDEO_POLL_INTERVAL_MS = 10_000;
const GEMINI_VIDEO_TIMEOUT_MS = 7 * 60_000;
const GEMINI_VIDEO_MIME_TYPE = 'video/mp4';
const GEMINI_VIDEO_LOG_PATH = process.env['WABOT_VIDEO_LOG_PATH'] ?? join(process.cwd(), 'logs', 'video-generation.jsonl');
const GEMINI_VIDEO_PROMPT_PREVIEW_CHARS = 500;
const DEFAULT_PERSON_GENERATION_ATTEMPTS: Array<GeminiVideoOptions['personGeneration'] | undefined> = [
  'allow_all',
  'allow_adult',
  undefined,
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack?.slice(0, 1200),
    };
  }
  return { message: getErrorMessage(err) };
}

async function appendVideoLog(event: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(dirname(GEMINI_VIDEO_LOG_PATH), { recursive: true });
    await appendFile(
      GEMINI_VIDEO_LOG_PATH,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
      'utf8',
    );
  } catch (err) {
    console.warn(`[gemini-video] Failed to write video log ${GEMINI_VIDEO_LOG_PATH}:`, err);
  }
}

function getPromptPreview(prompt: string): string {
  return prompt.length > GEMINI_VIDEO_PROMPT_PREVIEW_CHARS
    ? `${prompt.slice(0, GEMINI_VIDEO_PROMPT_PREVIEW_CHARS)}...`
    : prompt;
}

function buildVideoParameters(
  options: GeminiVideoOptions,
  personGeneration: GeminiVideoOptions['personGeneration'] | undefined,
): Record<string, unknown> {
  const durationSeconds = options.durationSeconds ?? 8;
  const resolution = options.resolution ?? '720p';
  const parameters: Record<string, unknown> = {
    aspectRatio: options.aspectRatio ?? '9:16',
    durationSeconds,
    resolution,
  };

  if (personGeneration) {
    parameters.personGeneration = personGeneration;
  }

  if ((resolution === '1080p' || resolution === '4k') && durationSeconds !== 8) {
    parameters.durationSeconds = 8;
  }

  return parameters;
}

function getPersonGenerationAttempts(options: GeminiVideoOptions): Array<GeminiVideoOptions['personGeneration'] | undefined> {
  if (options.personGeneration) {
    return [options.personGeneration, undefined];
  }
  return DEFAULT_PERSON_GENERATION_ATTEMPTS;
}

function shouldRetryPersonGeneration(err: unknown): boolean {
  const message = getErrorMessage(err);
  return /personGeneration|person_generation|person generation/i.test(message)
    && /invalid|unsupported|not supported|not allowed|allowed values|unknown|unrecognized|remove/i.test(message);
}

function getVideoUri(operation: VeoOperationResponse): string | undefined {
  return operation.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
}

async function readJsonResponse(response: Response): Promise<VeoOperationResponse> {
  const text = await response.text();
  try {
    return JSON.parse(text) as VeoOperationResponse;
  } catch {
    throw new Error(`Gemini video API returned non-JSON response (${response.status}): ${text.slice(0, 400)}`);
  }
}

async function startVideoOperation(
  globalConfig: GlobalConfig,
  model: string,
  prompt: string,
  parameters: Record<string, unknown>,
): Promise<VeoOperationResponse> {
  const response = await fetch(
    `${GEMINI_VIDEO_BASE_URL}/models/${encodeURIComponent(model)}:predictLongRunning`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': globalConfig.geminiApiKey!,
      },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters,
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  const operation = await readJsonResponse(response);
  if (!response.ok || !operation.name) {
    throw new Error(`Gemini video request failed (${response.status}): ${JSON.stringify(operation).slice(0, 400)}`);
  }
  return operation;
}

async function pollVideoOperation(globalConfig: GlobalConfig, operationName: string): Promise<VeoOperationResponse> {
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < GEMINI_VIDEO_TIMEOUT_MS) {
    attempt += 1;
    await sleep(attempt === 1 ? 0 : GEMINI_VIDEO_POLL_INTERVAL_MS);
    const response = await fetch(
      `${GEMINI_VIDEO_BASE_URL}/${operationName}`,
      { headers: { 'x-goog-api-key': globalConfig.geminiApiKey! } },
    );
    const operation = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(`Gemini video operation poll failed (${response.status}): ${JSON.stringify(operation).slice(0, 400)}`);
    }
    if (operation.error) {
      throw new Error(`Gemini video generation failed: ${operation.error.message ?? operation.error.status ?? operation.error.code ?? 'unknown error'}`);
    }

    console.log(
      `[gemini-video] Poll ${attempt} operation=${operationName} done=${operation.done === true} ` +
      `elapsedMs=${Date.now() - startedAt}`,
    );

    if (operation.done === true) {
      return operation;
    }
  }

  throw new Error(`Gemini video generation timed out after ${GEMINI_VIDEO_TIMEOUT_MS}ms`);
}

async function downloadVideo(globalConfig: GlobalConfig, uri: string): Promise<string> {
  const directory = join(tmpdir(), 'wabot-veo');
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, `${randomUUID()}.mp4`);
  const response = await fetch(uri, {
    headers: { 'x-goog-api-key': globalConfig.geminiApiKey! },
  });

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to download Gemini video (${response.status}): ${body.slice(0, 400)}`);
  }

  await pipeline(Readable.fromWeb(response.body as any), createWriteStream(filePath));
  return filePath;
}

export async function generateVideo(
  globalConfig: GlobalConfig,
  prompt: string,
  options: GeminiVideoOptions = {},
): Promise<GeneratedVideo | null> {
  if (!globalConfig.geminiApiKey) {
    console.warn('[gemini-video] GEMINI_API_KEY is not set; skipping video generation.');
    return null;
  }

  const model = globalConfig.geminiVideoModel;
  const startedAt = Date.now();
  console.log(`[gemini-video] Prompt:\n${prompt}`);

  let operation: VeoOperationResponse | null = null;
  let parameters: Record<string, unknown> = {};
  const personGenerationAttempts = getPersonGenerationAttempts(options);
  for (let attemptIndex = 0; attemptIndex < personGenerationAttempts.length; attemptIndex += 1) {
    const personGeneration = personGenerationAttempts[attemptIndex];
    parameters = buildVideoParameters(options, personGeneration);
    console.log(
      `[gemini-video] Starting video request model=${model} promptChars=${prompt.length} ` +
      `parameters=${JSON.stringify(parameters)} timeoutMs=${GEMINI_VIDEO_TIMEOUT_MS}`,
    );
    await appendVideoLog({
      event: 'request_started',
      model,
      attemptIndex: attemptIndex + 1,
      parameters,
      promptChars: prompt.length,
      promptPreview: getPromptPreview(prompt),
    });

    try {
      operation = await startVideoOperation(globalConfig, model, prompt, parameters);
      break;
    } catch (err) {
      await appendVideoLog({
        event: 'request_failed',
        model,
        attemptIndex: attemptIndex + 1,
        parameters,
        elapsedMs: Date.now() - startedAt,
        error: describeError(err),
      });

      const canRetry = attemptIndex < personGenerationAttempts.length - 1 && shouldRetryPersonGeneration(err);
      if (!canRetry) {
        throw err;
      }
      const nextPersonGeneration = personGenerationAttempts[attemptIndex + 1] ?? 'omitted';
      console.warn(
        `[gemini-video] Retrying video request with personGeneration=${nextPersonGeneration} after rejection: ${getErrorMessage(err)}`,
      );
    }
  }

  if (!operation?.name) {
    throw new Error('Gemini video request did not return an operation.');
  }

  console.log(`[gemini-video] Operation started name=${operation.name}`);
  await appendVideoLog({
    event: 'operation_started',
    model,
    operationName: operation.name,
    parameters,
    elapsedMs: Date.now() - startedAt,
  });

  let completed: VeoOperationResponse;
  try {
    completed = await pollVideoOperation(globalConfig, operation.name);
  } catch (err) {
    await appendVideoLog({
      event: 'operation_failed',
      model,
      operationName: operation.name,
      parameters,
      elapsedMs: Date.now() - startedAt,
      error: describeError(err),
    });
    throw err;
  }

  const videoUri = getVideoUri(completed);
  if (!videoUri) {
    console.warn(`[gemini-video] No video URI returned after ${Date.now() - startedAt}ms`);
    await appendVideoLog({
      event: 'no_video_uri',
      model,
      operationName: operation.name,
      parameters,
      elapsedMs: Date.now() - startedAt,
      operation: completed,
    });
    return null;
  }

  let filePath: string;
  try {
    filePath = await downloadVideo(globalConfig, videoUri);
  } catch (err) {
    await appendVideoLog({
      event: 'download_failed',
      model,
      operationName: operation.name,
      parameters,
      elapsedMs: Date.now() - startedAt,
      error: describeError(err),
    });
    throw err;
  }
  console.log(`[gemini-video] Video downloaded after ${Date.now() - startedAt}ms path=${filePath}`);
  await appendVideoLog({
    event: 'video_downloaded',
    model,
    operationName: operation.name,
    parameters,
    elapsedMs: Date.now() - startedAt,
  });
  return {
    filePath,
    mimeType: GEMINI_VIDEO_MIME_TYPE,
  };
}

export async function cleanupGeneratedVideo(video: GeneratedVideo | null | undefined): Promise<void> {
  if (!video?.filePath) return;
  try {
    await rm(video.filePath, { force: true });
  } catch (err) {
    console.warn(`[gemini-video] Failed to remove temp video ${video.filePath}:`, err);
  }
}
