import { createWriteStream } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildVideoParameters(options: GeminiVideoOptions): Record<string, unknown> {
  const durationSeconds = options.durationSeconds ?? 4;
  const resolution = options.resolution ?? '720p';
  const parameters: Record<string, unknown> = {
    aspectRatio: options.aspectRatio ?? '9:16',
    durationSeconds,
    resolution,
    personGeneration: options.personGeneration ?? 'allow_all',
  };

  if ((resolution === '1080p' || resolution === '4k') && durationSeconds !== 8) {
    parameters.durationSeconds = 8;
  }

  return parameters;
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
  const parameters = buildVideoParameters(options);
  const startedAt = Date.now();
  console.log(
    `[gemini-video] Starting video request model=${model} promptChars=${prompt.length} ` +
    `parameters=${JSON.stringify(parameters)} timeoutMs=${GEMINI_VIDEO_TIMEOUT_MS}`,
  );
  console.log(`[gemini-video] Prompt:\n${prompt}`);

  const response = await fetch(
    `${GEMINI_VIDEO_BASE_URL}/models/${encodeURIComponent(model)}:predictLongRunning`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': globalConfig.geminiApiKey,
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

  console.log(`[gemini-video] Operation started name=${operation.name}`);
  const completed = await pollVideoOperation(globalConfig, operation.name);
  const videoUri = getVideoUri(completed);
  if (!videoUri) {
    console.warn(`[gemini-video] No video URI returned after ${Date.now() - startedAt}ms`);
    return null;
  }

  const filePath = await downloadVideo(globalConfig, videoUri);
  console.log(`[gemini-video] Video downloaded after ${Date.now() - startedAt}ms path=${filePath}`);
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
