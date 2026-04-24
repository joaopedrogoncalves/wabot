import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

export type ChatModelProvider = 'anthropic' | 'google';

export interface ChatModelConfig {
  id: string;
  label: string;
  provider: ChatModelProvider;
  apiModel: string;
  supportsWebSearch: boolean;
  supportsThinking: boolean;
  supportsThinkingConfig: boolean;
}

export const BUILTIN_CHAT_MODELS: ChatModelConfig[] = [
  {
    id: '1a',
    label: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    apiModel: 'claude-sonnet-4-6',
    supportsWebSearch: true,
    supportsThinking: true,
    supportsThinkingConfig: true,
  },
  {
    id: '1d',
    label: 'Gemini 3.1 Pro',
    provider: 'google',
    apiModel: 'gemini-3.1-pro-preview',
    supportsWebSearch: true,
    supportsThinking: true,
    supportsThinkingConfig: true,
  },
  {
    id: '1g',
    label: 'Gemma 4 31B',
    provider: 'google',
    apiModel: 'gemma-4-31b-it',
    supportsWebSearch: false,
    supportsThinking: true,
    supportsThinkingConfig: false,
  },
];

export interface GlobalConfig {
  anthropicApiKey: string;
  geminiApiKey?: string;
  googleServiceAccountEmail: string;
  googlePrivateKey: string;
  twitterBearerToken?: string;
  claudeModel: string;
  claudeMaxTokens: number;
  chatMaxOutputTokens: number;
  geminiImageModel: string;
  geminiVideoModel: string;
  chatModels: ChatModelConfig[];
  defaultChatModelId: string;
}

export interface EventsConfig {
  spreadsheetId: string;
  sheetName: string;
  messageTemplate: string;
  cronSchedule: string;
  label?: string;
  enableImageAnnouncements?: boolean;
}

export interface ChatbotGroupConfig {
  enabled?: boolean;
  botName: string;
  systemPrompt: string;
  allowedModelIds?: string[];
  defaultModelId?: string;
  activeModelId?: string;
  enableThinking?: boolean;
  thinkingBudget?: number;
  enableWebSearch?: boolean;
  maxSearches?: number;
  hotness?: number;
  responseRateLimitCount?: number;
  responseRateLimitWindowSec?: number;
  responseRateLimitWarn?: boolean;
  enableImageGeneration?: boolean;
  enableVideoGeneration?: boolean;
  enableAutoImageReplies?: boolean;
}

export interface ScheduledPostJobConfig {
  enabled?: boolean;
  label?: string;
  cronSchedule: string;
  prompt: string;
  lookbackHours?: number;
  enableWebSearch?: boolean;
  maxSearches?: number;
}

export interface GroupConfig {
  jid: string;
  name?: string;
  webToken?: string;
  events?: EventsConfig;
  chatbot?: ChatbotGroupConfig;
  scheduledPosts?: ScheduledPostJobConfig[];
}

export interface AppConfig {
  global: GlobalConfig;
  groups: GroupConfig[];
}

export type ConfigHolder = { current: AppConfig; path: string };

function clampInteger(value: unknown, fallback: number, min: number, max?: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const int = Math.floor(num);
  if (int < min) return fallback;
  if (max != null && int > max) return max;
  return int;
}

function parseChatModels(rawValue: unknown): ChatModelConfig[] {
  if (!Array.isArray(rawValue) || rawValue.length === 0) {
    return BUILTIN_CHAT_MODELS.map((model) => ({ ...model }));
  }

  const seen = new Set<string>();
  const parsed: ChatModelConfig[] = [];

  for (const entry of rawValue) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const provider = raw.provider === 'anthropic' || raw.provider === 'google' ? raw.provider : undefined;
    const apiModel = typeof raw.apiModel === 'string' ? raw.apiModel.trim() : '';
    if (!id || !provider || !apiModel || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    parsed.push({
      id,
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : id,
      provider,
      apiModel,
      supportsWebSearch: raw.supportsWebSearch === true,
      supportsThinking: raw.supportsThinking !== false,
      supportsThinkingConfig: raw.supportsThinkingConfig !== false && raw.supportsThinking !== false,
    });
  }

  return parsed.length > 0 ? parsed : BUILTIN_CHAT_MODELS.map((model) => ({ ...model }));
}

export function getChatModelById(globalConfig: GlobalConfig, modelId: string | undefined): ChatModelConfig | undefined {
  if (!modelId) return undefined;
  const normalized = modelId.trim().toLowerCase();
  return globalConfig.chatModels.find((model) => model.id.toLowerCase() === normalized);
}

function hasProviderCredentials(globalConfig: GlobalConfig, provider: ChatModelProvider): boolean {
  return provider === 'anthropic'
    ? !!globalConfig.anthropicApiKey
    : !!globalConfig.geminiApiKey;
}

export function isChatModelAvailable(globalConfig: GlobalConfig, model: ChatModelConfig): boolean {
  return hasProviderCredentials(globalConfig, model.provider);
}

export function getAllowedChatModels(globalConfig: GlobalConfig, groupConfig: GroupConfig): ChatModelConfig[] {
  const configuredIds = groupConfig.chatbot?.allowedModelIds ?? [];
  const allowed = configuredIds
    .map((id) => getChatModelById(globalConfig, id))
    .filter((model): model is ChatModelConfig => !!model);
  return allowed.length > 0 ? allowed : [];
}

export function resolveGroupChatModel(globalConfig: GlobalConfig, groupConfig: GroupConfig): ChatModelConfig {
  const allowed = getAllowedChatModels(globalConfig, groupConfig);
  const available = allowed.filter((model) => isChatModelAvailable(globalConfig, model));
  const fallback = getChatModelById(globalConfig, globalConfig.defaultChatModelId)
    ?? globalConfig.chatModels[0]
    ?? BUILTIN_CHAT_MODELS[0];
  const candidatePool = available.length > 0 ? available : allowed;
  const defaultCandidate = getChatModelById(globalConfig, groupConfig.chatbot?.defaultModelId);
  const defaultModel = defaultCandidate && candidatePool.some((model) => model.id === defaultCandidate.id)
    ? defaultCandidate
    : (candidatePool[0] ?? fallback);
  const activeCandidate = getChatModelById(globalConfig, groupConfig.chatbot?.activeModelId);
  return activeCandidate && candidatePool.some((model) => model.id === activeCandidate.id)
    ? activeCandidate
    : defaultModel;
}

export function loadAppConfig(): AppConfig {
  const configPath = process.env['CONFIG_FILE'] || './groups.json';

  let rawJson: any;
  try {
    const content = readFileSync(configPath, 'utf-8');
    rawJson = JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to read config file "${configPath}": ${err}`);
  }

  const globalJson = rawJson.global ?? {};
  const groupsJson: any[] = rawJson.groups ?? [];

  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  const geminiApiKey = process.env['GEMINI_API_KEY'] ?? '';
  const googleServiceAccountEmail = process.env['GOOGLE_SERVICE_ACCOUNT_EMAIL'] ?? '';
  const googlePrivateKey = (process.env['GOOGLE_PRIVATE_KEY'] ?? '').replace(/\\n/g, '\n');
  const twitterBearerToken = process.env['TWITTER_BEARER_TOKEN'] ?? '';
  const chatModels = parseChatModels(globalJson.chatModels);

  const global: GlobalConfig = {
    anthropicApiKey,
    googleServiceAccountEmail,
    googlePrivateKey,
    twitterBearerToken: twitterBearerToken || undefined,
    claudeModel: globalJson.claudeModel ?? 'claude-sonnet-4-6',
    claudeMaxTokens: globalJson.claudeMaxTokens ?? 1024,
    chatMaxOutputTokens: globalJson.chatMaxOutputTokens ?? globalJson.claudeMaxTokens ?? 1024,
    geminiApiKey: geminiApiKey || undefined,
    geminiImageModel: globalJson.geminiImageModel ?? 'gemini-3.1-flash-image-preview',
    geminiVideoModel: globalJson.geminiVideoModel ?? 'veo-3.1-generate-preview',
    chatModels,
    defaultChatModelId: '',
  };
  global.defaultChatModelId = getChatModelById(global, typeof globalJson.defaultChatModelId === 'string' ? globalJson.defaultChatModelId : '')
    ?.id ?? chatModels[0]?.id ?? BUILTIN_CHAT_MODELS[0].id;

  const groups: GroupConfig[] = groupsJson.map((g: any, i: number) => {
    if (!g.jid) {
      throw new Error(`Group at index ${i} is missing required field "jid"`);
    }

    const group: GroupConfig = {
      jid: g.jid,
      name: g.name,
      webToken: g.webToken,
    };

    const eventsRaw = g.events;
    if (eventsRaw) {
      if (!eventsRaw.spreadsheetId) {
        throw new Error(`Group "${g.name ?? g.jid}" has events config but missing "spreadsheetId"`);
      }
      if (!googleServiceAccountEmail || !googlePrivateKey) {
        throw new Error(
          `Group "${g.name ?? g.jid}" has events config but GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY is not set`,
        );
      }
      group.events = {
        spreadsheetId: eventsRaw.spreadsheetId,
        sheetName: eventsRaw.sheetName ?? 'Sheet1',
        messageTemplate:
          eventsRaw.messageTemplate ??
          '🎂 Happy Birthday, {name}! 🎉 Wishing you an amazing day!',
        cronSchedule: eventsRaw.cronSchedule ?? '0 8 * * *',
        label: eventsRaw.label ?? 'events',
        enableImageAnnouncements: eventsRaw.enableImageAnnouncements ?? false,
      };
    }

    if (g.chatbot) {
      const chatbotEnabled = g.chatbot.enabled !== false;
      const allowedModelIds = Array.isArray(g.chatbot.allowedModelIds)
        ? g.chatbot.allowedModelIds
          .map((value: unknown) => (typeof value === 'string' ? value.trim() : ''))
          .filter(Boolean)
          .filter((value: string, index: number, list: string[]) =>
            list.findIndex((entry) => entry.toLowerCase() === value.toLowerCase()) === index)
          .filter((value: string) => !!getChatModelById(global, value))
        : [global.defaultChatModelId];
      const defaultModelCandidate = getChatModelById(global, g.chatbot.defaultModelId)?.id;
      const defaultModelId = defaultModelCandidate && allowedModelIds.some((id: string) => id.toLowerCase() === defaultModelCandidate.toLowerCase())
        ? defaultModelCandidate
        : (allowedModelIds[0] ?? global.defaultChatModelId);
      const activeModelCandidate = getChatModelById(global, g.chatbot.activeModelId)?.id;
      const activeModelId = activeModelCandidate && allowedModelIds.some((id: string) => id.toLowerCase() === activeModelCandidate.toLowerCase())
        ? activeModelCandidate
        : defaultModelId;

      if (chatbotEnabled) {
        if (!g.chatbot.botName) {
          throw new Error(`Group "${g.name ?? g.jid}" has chatbot config but missing "botName"`);
        }
        const allowedModels = allowedModelIds
          .map((id: string) => getChatModelById(global, id))
          .filter((model: ChatModelConfig | undefined): model is ChatModelConfig => !!model);
        if (allowedModels.length === 0) {
          throw new Error(
            `Group "${g.name ?? g.jid}" has chatbot config but no valid allowed chat models`,
          );
        }
        if (!allowedModels.some((model: ChatModelConfig) => isChatModelAvailable(global, model))) {
          throw new Error(
            `Group "${g.name ?? g.jid}" has chatbot config but no API key for any allowed chat model provider`,
          );
        }
      }
      group.chatbot = {
        enabled: chatbotEnabled,
        botName: g.chatbot.botName ?? '',
        systemPrompt:
          g.chatbot.systemPrompt ??
          'You are a helpful assistant in a WhatsApp group chat. Be concise and friendly.',
        allowedModelIds,
        defaultModelId,
        activeModelId,
        enableThinking: g.chatbot.enableThinking ?? false,
        thinkingBudget: g.chatbot.thinkingBudget ?? 2000,
        enableWebSearch: g.chatbot.enableWebSearch ?? false,
        maxSearches: g.chatbot.maxSearches ?? 3,
        hotness: clampInteger(g.chatbot.hotness, 35, 0, 100),
        responseRateLimitCount: clampInteger(g.chatbot.responseRateLimitCount, 5, 1),
        responseRateLimitWindowSec: clampInteger(g.chatbot.responseRateLimitWindowSec, 60, 1),
        responseRateLimitWarn: g.chatbot.responseRateLimitWarn ?? true,
        enableImageGeneration: g.chatbot.enableImageGeneration ?? true,
        enableVideoGeneration: g.chatbot.enableVideoGeneration ?? true,
        enableAutoImageReplies: g.chatbot.enableAutoImageReplies ?? false,
      };
    }

    const scheduledPostsRaw: any[] = Array.isArray(g.scheduledPosts) ? g.scheduledPosts : [];
    if (scheduledPostsRaw.length > 0) {
      group.scheduledPosts = scheduledPostsRaw.map((job: any, jobIndex: number) => {
        const jobEnabled = job?.enabled !== false;
        if (jobEnabled) {
          if (!job?.prompt) {
            throw new Error(
              `Group "${g.name ?? g.jid}" scheduled post at index ${jobIndex} is missing "prompt"`,
            );
          }
          if (!job?.cronSchedule) {
            throw new Error(
              `Group "${g.name ?? g.jid}" scheduled post "${job.label ?? jobIndex + 1}" is missing "cronSchedule"`,
            );
          }
          if (!anthropicApiKey) {
            throw new Error(
              `Group "${g.name ?? g.jid}" has scheduled posts but ANTHROPIC_API_KEY is not set`,
            );
          }
        }

        const label = String(job?.label ?? '').trim() || `scheduled-post-${jobIndex + 1}`;
        return {
          enabled: jobEnabled,
          label,
          cronSchedule: job?.cronSchedule ?? '0 9 * * *',
          prompt: job?.prompt ?? '',
          lookbackHours: clampInteger(job?.lookbackHours, 24, 1, 168),
          enableWebSearch: job?.enableWebSearch ?? false,
          maxSearches: clampInteger(job?.maxSearches, 3, 1, 10),
        } satisfies ScheduledPostJobConfig;
      });
    }

    return group;
  });

  return { global, groups };
}

export function syncGroups(
  configPath: string,
  whatsappGroups: Record<string, string>,
): AppConfig {
  let rawJson: any;
  try {
    const content = readFileSync(configPath, 'utf-8');
    rawJson = JSON.parse(content);
  } catch {
    rawJson = {};
  }

  const groups: any[] = rawJson.groups ?? [];
  const existingJids = new Set(groups.map((g: any) => g.jid));

  // Update names and ensure webTokens exist
  for (const group of groups) {
    if (whatsappGroups[group.jid]) {
      group.name = whatsappGroups[group.jid];
    }
    if (!group.webToken) {
      group.webToken = randomUUID();
    }
  }

  // Append new groups not yet in config
  for (const [jid, name] of Object.entries(whatsappGroups)) {
    if (!existingJids.has(jid)) {
      groups.push({ jid, name, webToken: randomUUID() });
      console.log(`Added new group to config: "${name}" (${jid})`);
    }
  }

  rawJson.groups = groups;
  writeFileSync(configPath, JSON.stringify(rawJson, null, 2) + '\n', 'utf-8');
  console.log('Synced group names from WhatsApp into config.');

  return loadAppConfig();
}

export function updateConfigFile(
  configPath: string,
  configHolder: ConfigHolder,
  updater: (rawJson: any) => void,
): void {
  const backup = readFileSync(configPath, 'utf-8');
  try {
    const rawJson = JSON.parse(backup);
    updater(rawJson);
    writeFileSync(configPath, JSON.stringify(rawJson, null, 2) + '\n', 'utf-8');
    configHolder.current = loadAppConfig();
  } catch (err) {
    writeFileSync(configPath, backup, 'utf-8');
    throw err;
  }
}
