import { areJidsSameUser, downloadMediaMessage, type WAMessageKey, type WASocket } from '@whiskeysockets/baileys';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { ConfigHolder, GroupConfig } from './config.js';
import { getAllowedChatModels, isChatModelAvailable, resolveGroupChatModel, updateConfigFile } from './config.js';
import { addMessage, findMessageById, getNameToJidMap, getRecentBotMessages, updateMessageText } from './chat-history.js';
import { generateImage } from './gemini.js';
import { cleanupGeneratedVideo, generateVideo } from './gemini-video.js';
import {
  decideImageForReply,
  decideContextualTrigger,
  generateImagePromptForDirectRequest,
  generateImagePromptForReply,
  generateRateLimitWarning,
  generateResponse,
  generateVideoPromptForDirectRequest,
  recordRecentReactionEmoji,
} from './llm.js';
import { maybeRefreshProfiles } from './group-profiles.js';
import { enrichTextWithTweets } from './twitter.js';
import { getSocket, onConnectionReady, reportTraffic, waitForConnectionWithTimeout } from './whatsapp.js';

const GREETING_PREFIXES = [
  'hey',
  'hi',
  'hello',
  'yo',
  'oi',
  'ola',
  'olá',
];

const IMAGE_REQUEST_TERMS = /\b(image|picture|pic|photo|meme|poster|illustration|drawing|art|avatar|wallpaper|imagem|foto|meme)\b/iu;
const IMAGE_REQUEST_CUES = /\b(draw|generate|make|create|render|illustrate|paint|show|send|post|desenha|gera|cria|faz|manda|posta|mostra|ilustra|can you|could you|please|pls|quero|queria|pode)\b/iu;
const VIDEO_REQUEST_TERMS = /\b(video|vídeo|clip|movie|film|animation|animação|animacao|filme)\b/iu;
const VIDEO_REQUEST_CUES = /\b(generate|make|create|render|animate|show|send|post|gera|cria|faz|manda|posta|mostra|anima|animar|can you|could you|please|pls|quero|queria|pode)\b/iu;
const MODEL_COMMAND_RE = /(?:^|[\s,!.?:;_-])\/model(?:\s+([^\s]+))?\s*$/iu;
const AUTO_IMAGE_LONG_REPLY_THRESHOLD = 260;
const AUTO_IMAGE_COOLDOWN_MS = 60_000;
const AUTO_IMAGE_BOT_REPLY_GAP = 2;
const VIDEO_REACTION_ANIMATION_INTERVAL_MS = 2_000;
const VIDEO_REACTION_ANIMATION_EMOJIS = ['🎬', '🎞️', '📽️', '⏳'];
const IMAGE_REACTION_ANIMATION_INTERVAL_MS = 1_500;
const IMAGE_REACTION_ANIMATION_EMOJIS = ['🎨', '🖌️', '🖼️', '✨'];
const CONTEXTUAL_TRIGGER_STATE_PATH = process.env['WABOT_CONTEXT_TRIGGER_STATE_PATH']
  ?? join(process.cwd(), 'logs', 'contextual-trigger-state.json');

function parseBotAliases(botName: string): string[] {
  const aliases = botName
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return aliases.length > 0 ? aliases : [botName.trim()].filter(Boolean);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPrefixTrigger(text: string, aliases: string[]): boolean {
  if (aliases.length === 0) return false;
  const aliasPattern = aliases.map((a) => escapeRegex(a)).join('|');
  const greetingPattern = GREETING_PREFIXES.map((g) => escapeRegex(g)).join('|');
  const re = new RegExp(
    `^\\s*(?:(?:${greetingPattern})[\\s,!.?:;_-]+)?(?:@)?(?:${aliasPattern})(?=$|[\\s,!.?:;_-])`,
    'iu',
  );
  return re.test(text);
}

function isExplicitImageRequest(text: string): boolean {
  return IMAGE_REQUEST_TERMS.test(text) && IMAGE_REQUEST_CUES.test(text);
}

function isExplicitVideoRequest(text: string): boolean {
  return VIDEO_REQUEST_TERMS.test(text) && VIDEO_REQUEST_CUES.test(text);
}

function extractText(msg: { message?: Record<string, any> | null }): string | null {
  const m = msg.message;
  if (!m) return null;
  return (
    (m.conversation as string) ??
    (m.extendedTextMessage?.text as string) ??
    (m.imageMessage?.caption as string) ??
    (m.videoMessage?.caption as string) ??
    null
  );
}

async function extractImage(
  msg: any,
): Promise<{ data: string; mimeType: string } | null> {
  const imageMessage = msg.message?.imageMessage;
  if (!imageMessage) return null;
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    return {
      data: (buffer as Buffer).toString('base64'),
      mimeType: imageMessage.mimetype ?? 'image/jpeg',
    };
  } catch (err) {
    console.error('Failed to download image:', err);
    return null;
  }
}

function extractMentionedJids(msg: { message?: Record<string, any> | null }): string[] {
  const m = msg.message;
  if (!m) return [];
  const ctx =
    m.extendedTextMessage?.contextInfo ??
    m.imageMessage?.contextInfo ??
    m.videoMessage?.contextInfo;
  return ctx?.mentionedJid ?? [];
}

const MAX_TRIGGERED_IDS = 200;
const triggeredMessageIds = new Set<string>();

function trackTriggered(id: string): void {
  triggeredMessageIds.add(id);
  if (triggeredMessageIds.size > MAX_TRIGGERED_IDS) {
    const first = triggeredMessageIds.values().next().value!;
    triggeredMessageIds.delete(first);
  }
}

const groupLocks = new Map<string, Promise<void>>();

function withGroupLock<T>(groupJid: string, fn: () => Promise<T>): Promise<T> {
  const prev = groupLocks.get(groupJid) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  groupLocks.set(groupJid, next.then(() => {}, () => {}));
  return next;
}

type GroupRateLimitState = {
  timestamps: number[];
  warned: boolean;
  warningText?: string;
  lastImageSentAt?: number;
};

const groupRateLimits = new Map<string, GroupRateLimitState>();

type TriggerRateEvent = {
  messageId?: string;
  timestamp: number;
  triggered: boolean;
  kind?: 'direct' | 'context';
};

type TriggerRateSnapshot = {
  total: number;
  triggered: number;
  percent: number;
  maxPercent: number;
  windowMessages: number;
  minSample: number;
};

const triggerRateEventsByGroup = new Map<string, TriggerRateEvent[]>();
const TRIGGER_RATE_MIN_SAMPLE = 20;

type ContextualTriggerPersistentState = {
  groups?: Record<string, { lastTriggeredAt?: number }>;
};

let contextualTriggerPersistentState: ContextualTriggerPersistentState | null = null;

function loadContextualTriggerPersistentState(): ContextualTriggerPersistentState {
  if (contextualTriggerPersistentState) return contextualTriggerPersistentState;
  if (!existsSync(CONTEXTUAL_TRIGGER_STATE_PATH)) {
    contextualTriggerPersistentState = { groups: {} };
    return contextualTriggerPersistentState;
  }

  try {
    const parsed = JSON.parse(readFileSync(CONTEXTUAL_TRIGGER_STATE_PATH, 'utf-8')) as ContextualTriggerPersistentState;
    contextualTriggerPersistentState = parsed && typeof parsed === 'object' ? parsed : { groups: {} };
  } catch (err) {
    console.warn(`[chat] Failed to read contextual trigger state from ${CONTEXTUAL_TRIGGER_STATE_PATH}:`, err);
    contextualTriggerPersistentState = { groups: {} };
  }
  if (!contextualTriggerPersistentState.groups) {
    contextualTriggerPersistentState.groups = {};
  }
  return contextualTriggerPersistentState;
}

function saveContextualTriggerPersistentState(): void {
  const state = loadContextualTriggerPersistentState();
  try {
    mkdirSync(dirname(CONTEXTUAL_TRIGGER_STATE_PATH), { recursive: true });
    const tmpPath = `${CONTEXTUAL_TRIGGER_STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, CONTEXTUAL_TRIGGER_STATE_PATH);
  } catch (err) {
    console.error(`[chat] Failed to write contextual trigger state to ${CONTEXTUAL_TRIGGER_STATE_PATH}:`, err);
  }
}

function getContextualTriggerCooldownMs(groupConfig: GroupConfig): number {
  const minutes = groupConfig.chatbot?.contextualTriggerCooldownMinutes ?? 120;
  return Math.max(0, minutes * 60_000);
}

function getContextualTriggerCooldownRemainingMs(groupJid: string, groupConfig: GroupConfig): number {
  const cooldownMs = getContextualTriggerCooldownMs(groupConfig);
  if (cooldownMs <= 0) return 0;
  const state = loadContextualTriggerPersistentState();
  const lastTriggeredAt = state.groups?.[groupJid]?.lastTriggeredAt;
  if (!lastTriggeredAt || !Number.isFinite(lastTriggeredAt)) return 0;
  return Math.max(0, cooldownMs - (Date.now() - lastTriggeredAt));
}

function recordContextualTriggerCooldown(groupJid: string): void {
  const state = loadContextualTriggerPersistentState();
  if (!state.groups) state.groups = {};
  state.groups[groupJid] = { lastTriggeredAt: Date.now() };
  saveContextualTriggerPersistentState();
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function getTriggerRateSettings(groupConfig: GroupConfig): { maxPercent: number; windowMessages: number; minSample: number } {
  const chatbot = groupConfig.chatbot!;
  const windowMessages = Math.max(10, chatbot.contextualTriggerWindowMessages ?? 100);
  return {
    maxPercent: Math.max(1, Math.min(100, chatbot.contextualTriggerMaxPercent ?? 12)),
    windowMessages,
    minSample: Math.min(TRIGGER_RATE_MIN_SAMPLE, windowMessages),
  };
}

function getGroupTriggerRateEvents(groupJid: string): TriggerRateEvent[] {
  let events = triggerRateEventsByGroup.get(groupJid);
  if (!events) {
    events = [];
    triggerRateEventsByGroup.set(groupJid, events);
  }
  return events;
}

function recordInboundTriggerRateMessage(groupJid: string, groupConfig: GroupConfig, messageId?: string): void {
  const events = getGroupTriggerRateEvents(groupJid);
  if (messageId && events.some((event) => event.messageId === messageId)) {
    return;
  }
  events.push({ messageId, timestamp: Date.now(), triggered: false });
  const { windowMessages } = getTriggerRateSettings(groupConfig);
  const maxStored = Math.max(windowMessages, 1000);
  if (events.length > maxStored) {
    events.splice(0, events.length - maxStored);
  }
}

function markTriggerRateMessage(groupJid: string, groupConfig: GroupConfig, messageId: string | undefined, kind: 'direct' | 'context'): TriggerRateSnapshot {
  const events = getGroupTriggerRateEvents(groupJid);
  const target = messageId
    ? [...events].reverse().find((event) => event.messageId === messageId)
    : [...events].reverse().find((event) => !event.triggered);
  if (target) {
    target.triggered = true;
    target.kind = kind;
  }
  return getTriggerRateSnapshot(groupJid, groupConfig);
}

function getTriggerRateSnapshot(groupJid: string, groupConfig: GroupConfig): TriggerRateSnapshot {
  const { maxPercent, windowMessages, minSample } = getTriggerRateSettings(groupConfig);
  const recent = getGroupTriggerRateEvents(groupJid).slice(-windowMessages);
  const total = recent.length;
  const triggered = recent.filter((event) => event.triggered).length;
  const percent = total > 0 ? (triggered / total) * 100 : 0;
  return { total, triggered, percent, maxPercent, windowMessages, minSample };
}

function shouldAdmitContextualTriggerByRate(groupJid: string, groupConfig: GroupConfig): { allowed: boolean; snapshot: TriggerRateSnapshot; projectedPercent: number } {
  const snapshot = getTriggerRateSnapshot(groupJid, groupConfig);
  const projectedPercent = snapshot.total > 0
    ? ((snapshot.triggered + 1) / snapshot.total) * 100
    : 100;
  return {
    allowed: snapshot.total < snapshot.minSample || projectedPercent <= snapshot.maxPercent,
    snapshot,
    projectedPercent,
  };
}

function formatTriggerRate(snapshot: TriggerRateSnapshot, projectedPercent?: number): string {
  const projected = projectedPercent == null ? '' : `, projected ${projectedPercent.toFixed(1)}%`;
  return `${snapshot.triggered}/${snapshot.total} messages (${snapshot.percent.toFixed(1)}%${projected}, cap ${snapshot.maxPercent}% over last ${snapshot.windowMessages})`;
}

function getGroupRateLimitState(groupJid: string): GroupRateLimitState {
  let state = groupRateLimits.get(groupJid);
  if (!state) {
    state = { timestamps: [], warned: false };
    groupRateLimits.set(groupJid, state);
  }
  return state;
}

function getRateLimitSettings(groupConfig: GroupConfig): { limit: number; windowMs: number; warn: boolean } {
  const chatbot = groupConfig.chatbot!;
  return {
    limit: chatbot.responseRateLimitCount ?? 5,
    windowMs: (chatbot.responseRateLimitWindowSec ?? 60) * 1000,
    warn: chatbot.responseRateLimitWarn ?? true,
  };
}

function admitTriggeredReply(groupJid: string, groupConfig: GroupConfig): { allowed: boolean; count: number; limit: number; windowMs: number; warn: boolean } {
  const state = getGroupRateLimitState(groupJid);
  const { limit, windowMs, warn } = getRateLimitSettings(groupConfig);
  const cutoff = Date.now() - windowMs;
  state.timestamps = state.timestamps.filter((ts) => ts > cutoff);

  if (state.timestamps.length < limit) {
    state.timestamps.push(Date.now());
    state.warned = false;
    return { allowed: true, count: state.timestamps.length, limit, windowMs, warn };
  }

  return { allowed: false, count: state.timestamps.length, limit, windowMs, warn };
}

function claimRateLimitWarning(groupJid: string, groupConfig: GroupConfig): boolean {
  const state = getGroupRateLimitState(groupJid);
  const { warn } = getRateLimitSettings(groupConfig);
  if (!warn || state.warned) return false;
  state.warned = true;
  return true;
}

function recordSentImage(groupJid: string): void {
  const state = getGroupRateLimitState(groupJid);
  state.lastImageSentAt = Date.now();
}

function getImageCooldownRemainingMs(groupJid: string): number {
  const state = getGroupRateLimitState(groupJid);
  if (!state.lastImageSentAt) return 0;
  return Math.max(0, AUTO_IMAGE_COOLDOWN_MS - (Date.now() - state.lastImageSentAt));
}

function hasRecentBotImageReply(groupJid: string): boolean {
  const recentBotMessages = getRecentBotMessages(groupJid, AUTO_IMAGE_BOT_REPLY_GAP);
  return recentBotMessages.some((message) => !!message.imageData);
}

function isMessageFromBot(
  sock: WASocket,
  msg: { key: { fromMe?: boolean | null; participant?: string | null; remoteJid?: string | null } },
): boolean {
  if (msg.key.fromMe) return true;
  const senderJid = msg.key.participant ?? msg.key.remoteJid ?? '';
  const botJid = sock.user?.id;
  const botLid = sock.user?.lid;
  return (!!botJid && areJidsSameUser(senderJid, botJid))
    || (!!botLid && areJidsSameUser(senderJid, botLid));
}

function resolveMentions(groupJid: string, response: string): { responseText: string; mentions: string[] } {
  const nameToJid = getNameToJidMap(groupJid);
  const numberToJid = new Map<string, string>();
  for (const jid of nameToJid.values()) {
    const num = jid.replace(/[:@].+$/, '');
    numberToJid.set(num, jid);
  }

  const mentions: string[] = [];
  const mentionRegex = /@([\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} ]*[\p{L}\p{M}\p{N}]|[\p{L}\p{M}\p{N}]+)/gu;
  let responseText = response;
  const matches = [...response.matchAll(mentionRegex)].reverse();
  for (const match of matches) {
    const captured = match[1];
    const jid = nameToJid.get(captured.toLowerCase()) ?? numberToJid.get(captured);
    if (jid && !mentions.includes(jid)) {
      mentions.push(jid);
    }
    if (jid) {
      const num = jid.replace(/[:@].+$/, '');
      responseText = responseText.slice(0, match.index!) + '@' + num + responseText.slice(match.index! + match[0].length);
    }
  }
  if (mentions.length > 0) {
    console.log(`[chat] Resolved ${mentions.length} mention(s): ${mentions.join(', ')}`);
  }

  return { responseText, mentions };
}

function sanitizeReplyTextForDelivery(text: string): string {
  return text
    .replace(/!\[[\s\S]*?\]\((?:https?:\/\/)?[^)\s]+(?:\?[^)\s]*)?\)/giu, ' ')
    .replace(/https?:\/\/image\.pollinations\.ai\/\S+/giu, ' ')
    .replace(/\[\s*(?:imagem|image|image prompt|prompt de imagem|image description|caption)\s*:\s*[\s\S]*?\]/giu, ' ')
    .replace(/\n?\s*---+\s*\n?\s*(?:[*_`#>\- ]*)?(?:imagem gerada|image generated|prompt de imagem|image prompt|imagem|image)\s*:\s*[\s\S]*$/giu, ' ')
    .replace(/\n?\s*(?:[*_`#>\- ]*)?(?:imagem gerada|image generated|prompt de imagem|image prompt|imagem|image)\s*:\s*[\s\S]*$/giu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sanitizeExplicitImageFallbackText(text: string): string {
  const firstSegment = text
    .split(/\n\s*---+\s*\n|\s---\s|\n{2,}/u)[0]
    ?.replace(/[*_`#]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim() ?? '';
  if (!firstSegment) return 'Aí tens.';
  if (firstSegment.length <= 220) return firstSegment;

  const sentenceMatch = firstSegment.match(/^(.{1,220}?[.!?])(?:\s|$)/u);
  if (sentenceMatch?.[1]) {
    return sentenceMatch[1].trim();
  }
  return `${firstSegment.slice(0, 217).trimEnd()}...`;
}

function parseModelCommand(text: string): { command: 'list' | 'set'; modelId?: string } | null {
  const match = text.match(MODEL_COMMAND_RE);
  if (!match) return null;
  const modelId = match[1]?.trim();
  return modelId ? { command: 'set', modelId } : { command: 'list' };
}

function formatModelList(groupConfig: GroupConfig, configHolder: ConfigHolder): string {
  const allowedModels = getAllowedChatModels(configHolder.current.global, groupConfig)
    .filter((model) => isChatModelAvailable(configHolder.current.global, model));
  const activeModel = resolveGroupChatModel(configHolder.current.global, groupConfig);
  const defaultModelId = groupConfig.chatbot?.defaultModelId ?? activeModel.id;

  if (allowedModels.length === 0) {
    return 'Nenhum modelo está autorizado para este grupo.';
  }

  const lines = ['Modelos disponíveis neste grupo:'];
  for (const model of allowedModels) {
    const markers = [
      ...(model.id === activeModel.id ? ['ativo'] : []),
      ...(model.id === defaultModelId ? ['default'] : []),
    ];
    lines.push(`- ${model.id} — ${model.label}${markers.length > 0 ? ` — ${markers.join(', ')}` : ''}`);
  }
  lines.push('Usa `/model <id>` para mudar.');
  return lines.join('\n');
}

async function evaluateContextualTrigger(
  configHolder: ConfigHolder,
  groupConfig: GroupConfig,
  remoteJid: string,
  text: string,
  senderName: string,
  sourceLabel = '',
): Promise<boolean> {
  if (groupConfig.chatbot?.enableContextualTriggers === false) {
    return false;
  }

  const cooldownRemainingMs = getContextualTriggerCooldownRemainingMs(remoteJid, groupConfig);
  if (cooldownRemainingMs > 0) {
    console.log(
      `[chat] Contextual trigger suppressed for ${remoteJid}${sourceLabel}: ` +
      `cooldown active for ${formatDuration(cooldownRemainingMs)}`,
    );
    return false;
  }

  const rateDecision = shouldAdmitContextualTriggerByRate(remoteJid, groupConfig);
  if (!rateDecision.allowed) {
    console.log(
      `[chat] Contextual trigger suppressed for ${remoteJid}${sourceLabel}: ` +
      `trigger share too high (${formatTriggerRate(rateDecision.snapshot, rateDecision.projectedPercent)})`,
    );
    return false;
  }

  try {
    const decision = await decideContextualTrigger(
      configHolder.current,
      groupConfig,
      remoteJid,
      text,
      senderName,
    );
    if (decision.shouldRespond) {
      console.log(
        `[chat] Contextual trigger admitted for ${remoteJid}${sourceLabel}: ` +
        `${decision.reason ?? 'classifier chose to respond'} ` +
        `(${formatTriggerRate(rateDecision.snapshot, rateDecision.projectedPercent)})`,
      );
      return true;
    }
    console.log(
      `[chat] Contextual trigger skipped for ${remoteJid}${sourceLabel}` +
      `${decision.reason ? `: ${decision.reason}` : ''}`,
    );
  } catch (err) {
    console.error(`Failed to classify contextual trigger for ${remoteJid}${sourceLabel}:`, err);
  }

  return false;
}

async function sendPlainReply(remoteJid: string, text: string, quoted?: any): Promise<void> {
  await waitForConnectionWithTimeout(30_000);
  const sendSock = getSocket();
  await sendSock.sendMessage(remoteJid, { text }, quoted ? { quoted } : undefined);
}

async function sendReaction(remoteJid: string, key: WAMessageKey, emoji: string): Promise<void> {
  await waitForConnectionWithTimeout(30_000);
  const sendSock = getSocket();
  await sendSock.sendMessage(remoteJid, {
    react: {
      text: emoji,
      key,
    },
  });
}

function startReactionAnimation(
  remoteJid: string,
  key: WAMessageKey,
  emojis = VIDEO_REACTION_ANIMATION_EMOJIS,
  intervalMs = VIDEO_REACTION_ANIMATION_INTERVAL_MS,
  label = 'generation',
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let index = 0;

  const tick = async () => {
    if (stopped) return;
    const emoji = emojis[index % emojis.length] ?? '🎬';
    index += 1;

    try {
      await sendReaction(remoteJid, key, emoji);
      console.log(`[chat] Updated ${label} reaction for ${remoteJid}: ${emoji}`);
    } catch (err) {
      console.error(`Failed to update ${label} reaction for ${remoteJid}:`, err);
    }

    if (!stopped) {
      timer = setTimeout(() => {
        void tick();
      }, intervalMs);
    }
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

async function sendFinalVideoReaction(remoteJid: string, key: WAMessageKey, emoji: string): Promise<void> {
  await sendReaction(remoteJid, key, emoji);
  setTimeout(() => {
    void sendReaction(remoteJid, key, emoji).catch((err) => {
      console.error(`Failed to reinforce final video reaction for ${remoteJid}:`, err);
    });
  }, 1_500);
}

async function sendFinalImageReaction(remoteJid: string, key: WAMessageKey, emoji: string): Promise<void> {
  await sendReaction(remoteJid, key, emoji);
  setTimeout(() => {
    void sendReaction(remoteJid, key, emoji).catch((err) => {
      console.error(`Failed to reinforce final image reaction for ${remoteJid}:`, err);
    });
  }, 1_500);
}

async function handleModelCommand(
  configHolder: ConfigHolder,
  groupConfig: GroupConfig,
  remoteJid: string,
  commandText: string,
  quoted?: any,
): Promise<void> {
  const command = parseModelCommand(commandText);
  if (!command) return;

  if (command.command === 'list') {
    await sendPlainReply(remoteJid, formatModelList(groupConfig, configHolder), quoted);
    return;
  }

  const requestedId = command.modelId ?? '';
  const allowedModels = getAllowedChatModels(configHolder.current.global, groupConfig)
    .filter((model) => isChatModelAvailable(configHolder.current.global, model));
  const targetModel = allowedModels.find((model) => model.id.toLowerCase() === requestedId.toLowerCase());

  if (!targetModel) {
    await sendPlainReply(
      remoteJid,
      `Modelo inválido ou não permitido: ${requestedId}\n\n${formatModelList(groupConfig, configHolder)}`,
      quoted,
    );
    return;
  }

  updateConfigFile(configHolder.path, configHolder, (raw) => {
    const groups: any[] = raw.groups ?? [];
    const group = groups.find((entry: any) => entry.jid === remoteJid);
    if (!group) throw new Error('Group not found in config file.');
    if (!group.chatbot) group.chatbot = {};
    group.chatbot.activeModelId = targetModel.id;
  });

  await sendPlainReply(remoteJid, `Modelo ativo: ${targetModel.id} — ${targetModel.label}`, quoted);
}

async function sendGeneratedReply(
  configHolder: ConfigHolder,
  groupConfig: GroupConfig,
  remoteJid: string,
  primaryBotName: string,
  triggerSenderName: string,
  latestUserText: string,
  explicitImageRequest: boolean,
  reactionTargetKey?: WAMessageKey,
  quoted?: any,
): Promise<void> {
  const currentSock = getSocket();
  await currentSock.sendPresenceUpdate('composing', remoteJid);

  const canGenerateDirectImages = !!configHolder.current.global.geminiApiKey
    && groupConfig.chatbot?.enableImageGeneration !== false;
  const canGenerateAutoImages = !!configHolder.current.global.geminiApiKey
    && groupConfig.chatbot?.enableAutoImageReplies === true;
  const response = await generateResponse(configHolder.current, groupConfig, remoteJid, {
    expectsImage: canGenerateDirectImages && explicitImageRequest,
    latestUserText,
    triggerSenderName,
  });
  const resolved = resolveMentions(remoteJid, response.text);
  const mentions = resolved.mentions;
  let responseText = sanitizeReplyTextForDelivery(resolved.responseText);
  if (!responseText) {
    responseText = explicitImageRequest ? 'Aí tens.' : '...';
  }

  if (response.reactionEmoji && reactionTargetKey) {
    try {
      await currentSock.sendMessage(remoteJid, {
        react: {
          text: response.reactionEmoji,
          key: reactionTargetKey,
        },
      });
      recordRecentReactionEmoji(remoteJid, response.reactionEmoji);
      console.log(`[chat] Sent early reaction to ${remoteJid}: ${response.reactionEmoji}`);
    } catch (err) {
      console.error(`Failed to send early reaction to ${remoteJid}:`, err);
    }
  }

  let generatedImage:
    | { data: Buffer; mimeType: string }
    | null = null;

  if (canGenerateDirectImages || canGenerateAutoImages) {
    try {
      let imagePrompt: string | null = null;
      let imageReason: string | null = null;
      let imagePlanContext: Parameters<typeof generateImage>[2] | undefined;
      if (explicitImageRequest && canGenerateDirectImages) {
        const imagePlan = await generateImagePromptForDirectRequest(
          configHolder.current,
          groupConfig,
          remoteJid,
          latestUserText,
          responseText,
        );
        imagePrompt = imagePlan?.prompt ?? null;
        imagePlanContext = imagePlan ? {
          literalness: imagePlan.literalness,
          mood: imagePlan.mood,
          style: imagePlan.style,
          keySubjects: imagePlan.keySubjects,
          mustAvoid: imagePlan.mustAvoid,
          textInImage: imagePlan.textInImage,
        } : undefined;
        imageReason = 'direct request';
        if (!imagePrompt) {
          console.warn(`[chat] Direct image request for ${remoteJid} produced no usable image prompt; falling back to text reply.`);
        }
      } else if (!explicitImageRequest && canGenerateAutoImages) {
        const cooldownRemainingMs = getImageCooldownRemainingMs(remoteJid);
        const recentBotImageReply = hasRecentBotImageReply(remoteJid);
        const shouldForceLongReplyImage = responseText.length >= AUTO_IMAGE_LONG_REPLY_THRESHOLD
          && cooldownRemainingMs === 0
          && !recentBotImageReply;

        if (shouldForceLongReplyImage) {
          const imagePlan = await generateImagePromptForReply(
            configHolder.current,
            groupConfig,
            remoteJid,
            latestUserText,
            responseText,
            `reply length ${responseText.length} characters and no bot image sent in the last ${Math.round(AUTO_IMAGE_COOLDOWN_MS / 1000)} seconds`,
          );
          imagePrompt = imagePlan?.prompt ?? null;
          imagePlanContext = imagePlan ? {
            literalness: imagePlan.literalness,
            mood: imagePlan.mood,
            style: imagePlan.style,
            keySubjects: imagePlan.keySubjects,
            mustAvoid: imagePlan.mustAvoid,
            textInImage: imagePlan.textInImage,
          } : undefined;
          imageReason = `long reply heuristic (${responseText.length} chars)`;
          console.log(`[chat] Auto image forced for ${remoteJid}: long reply (${responseText.length} chars), cooldown clear`);
        } else if (recentBotImageReply) {
          console.log(`[chat] Auto image skipped for ${remoteJid}: bot already sent an image within the last ${AUTO_IMAGE_BOT_REPLY_GAP} bot replies`);
        } else if (cooldownRemainingMs > 0) {
          console.log(`[chat] Auto image skipped for ${remoteJid}: image cooldown active for ${Math.ceil(cooldownRemainingMs / 1000)}s`);
        } else {
          const decision = await decideImageForReply(
            configHolder.current,
            groupConfig,
            remoteJid,
            latestUserText,
            responseText,
          );
          imagePrompt = decision.shouldGenerate ? decision.image?.prompt ?? null : null;
          imagePlanContext = decision.shouldGenerate && decision.image ? {
            literalness: decision.image.literalness,
            mood: decision.image.mood,
            style: decision.image.style,
            keySubjects: decision.image.keySubjects,
            mustAvoid: decision.image.mustAvoid,
            textInImage: decision.image.textInImage,
          } : undefined;
          imageReason = decision.shouldGenerate ? 'LLM auto decision' : null;
        }
      }

      if (imagePrompt) {
        console.log(`[chat] Generating Gemini image for ${remoteJid} with model ${configHolder.current.global.geminiImageModel} (${imageReason ?? 'unspecified'})`);
        console.log(`[chat] Gemini prompt for ${remoteJid}:\n${imagePrompt}`);
        if (imagePlanContext) {
          console.log(`[chat] Gemini image plan for ${remoteJid}: ${JSON.stringify(imagePlanContext)}`);
        }
        const imageStartedAt = Date.now();
        const stopImageReactionAnimation = reactionTargetKey
          ? startReactionAnimation(
              remoteJid,
              reactionTargetKey,
              IMAGE_REACTION_ANIMATION_EMOJIS,
              IMAGE_REACTION_ANIMATION_INTERVAL_MS,
              'image generation',
            )
          : () => {};
        try {
          generatedImage = await generateImage(configHolder.current.global, imagePrompt, {
            latestUserText,
            replyText: responseText,
            visualBrief: imagePrompt,
            reason: imageReason ?? undefined,
            ...imagePlanContext,
          });
        } finally {
          stopImageReactionAnimation();
        }
        if (!generatedImage) {
          console.log(`[chat] Gemini returned no image for ${remoteJid}`);
          if (explicitImageRequest && reactionTargetKey) {
            await sendFinalImageReaction(remoteJid, reactionTargetKey, '❌').catch((reactionErr) => {
              console.error(`Failed to send image failure reaction to ${remoteJid}:`, reactionErr);
            });
          }
        } else {
          console.log(
            `[chat] Gemini image ready for ${remoteJid} after ${Date.now() - imageStartedAt}ms ` +
            `mimeType=${generatedImage.mimeType}`,
          );
          if (reactionTargetKey) {
            await sendFinalImageReaction(remoteJid, reactionTargetKey, response.reactionEmoji ?? '🖼️').catch((reactionErr) => {
              console.error(`Failed to send image success reaction to ${remoteJid}:`, reactionErr);
            });
          }
        }
      }
    } catch (err) {
      console.error('Failed to generate reply image:', err);
      if (explicitImageRequest && reactionTargetKey) {
        await sendFinalImageReaction(remoteJid, reactionTargetKey, '❌').catch((reactionErr) => {
          console.error(`Failed to send image failure reaction to ${remoteJid}:`, reactionErr);
        });
      }
      if (explicitImageRequest) {
        responseText = sanitizeExplicitImageFallbackText(responseText);
      }
    }
  }

  await waitForConnectionWithTimeout(30_000);
  const sendSock = getSocket();
  await sendSock.sendPresenceUpdate('paused', remoteJid);
  const sent = generatedImage
    ? await sendSock.sendMessage(
        remoteJid,
        { image: generatedImage.data, mimetype: generatedImage.mimeType, caption: responseText, mentions },
        quoted ? { quoted } : undefined,
      )
    : await sendSock.sendMessage(remoteJid, { text: responseText, mentions }, quoted ? { quoted } : undefined);
  if (generatedImage) {
    recordSentImage(remoteJid);
    console.log(`[chat] Sent image reply to ${remoteJid}: messageId=${sent?.key?.id ?? 'unknown'}, caption="${responseText.slice(0, 160)}${responseText.length > 160 ? '...' : ''}"`);
  } else {
    console.log(`[chat] Sent text reply to ${remoteJid}: messageId=${sent?.key?.id ?? 'unknown'}, text="${responseText.slice(0, 160)}${responseText.length > 160 ? '...' : ''}"`);
  }

  addMessage(remoteJid, {
    senderName: primaryBotName,
    senderJid: sendSock.user?.id ?? currentSock.user?.id ?? '',
    text: response.text,
    fromBot: true,
    messageId: sent?.key?.id ?? undefined,
    ...(generatedImage && {
      imageData: generatedImage.data.toString('base64'),
      imageMimeType: generatedImage.mimeType,
    }),
  });

  maybeRefreshProfiles(configHolder.current, remoteJid);
}

async function sendGeneratedVideoReply(
  configHolder: ConfigHolder,
  groupConfig: GroupConfig,
  remoteJid: string,
  primaryBotName: string,
  triggerSenderName: string,
  latestUserText: string,
  reactionTargetKey: WAMessageKey,
  quoted?: any,
): Promise<void> {
  let generatedVideo: Awaited<ReturnType<typeof generateVideo>> = null;
  const stopReactionAnimation = startReactionAnimation(remoteJid, reactionTargetKey);
  try {
    const response = await generateResponse(configHolder.current, groupConfig, remoteJid, {
      expectsVideo: true,
      latestUserText,
      triggerSenderName,
    });
    const resolved = resolveMentions(remoteJid, response.text);
    const mentions = resolved.mentions;
    let responseText = sanitizeReplyTextForDelivery(resolved.responseText);
    if (!responseText) {
      responseText = 'Aí tens.';
    }

    const videoPlan = await generateVideoPromptForDirectRequest(
      configHolder.current,
      groupConfig,
      remoteJid,
      latestUserText,
      responseText,
    );
    if (!videoPlan?.prompt) {
      throw new Error('Direct video request produced no usable video prompt.');
    }

    console.log(`[chat] Generating Gemini video for ${remoteJid} with model ${configHolder.current.global.geminiVideoModel}`);
    console.log(`[chat] Gemini video plan for ${remoteJid}: ${JSON.stringify(videoPlan)}`);
    const videoStartedAt = Date.now();
    generatedVideo = await generateVideo(configHolder.current.global, videoPlan.prompt, {
      aspectRatio: videoPlan.aspectRatio,
      durationSeconds: videoPlan.durationSeconds,
      resolution: videoPlan.resolution,
    });
    if (!generatedVideo) {
      throw new Error('Gemini returned no video.');
    }

    await waitForConnectionWithTimeout(30_000);
    const sendSock = getSocket();
    const sent = await sendSock.sendMessage(
      remoteJid,
      {
        video: { url: generatedVideo.filePath },
        mimetype: generatedVideo.mimeType,
        caption: responseText,
        mentions,
      },
      quoted ? { quoted } : undefined,
    );
    stopReactionAnimation();
    if (response.reactionEmoji) {
      recordRecentReactionEmoji(remoteJid, response.reactionEmoji);
    }
    await sendFinalVideoReaction(remoteJid, reactionTargetKey, response.reactionEmoji ?? '✅');
    console.log(
      `[chat] Sent video reply to ${remoteJid} after ${Date.now() - videoStartedAt}ms ` +
      `messageId=${sent?.key?.id ?? 'unknown'}, caption="${responseText.slice(0, 160)}${responseText.length > 160 ? '...' : ''}"`,
    );

    addMessage(remoteJid, {
      senderName: primaryBotName,
      senderJid: sendSock.user?.id ?? '',
      text: response.text,
      fromBot: true,
      messageId: sent?.key?.id ?? undefined,
    });

    maybeRefreshProfiles(configHolder.current, remoteJid);
  } catch (err) {
    console.error('Failed to generate/send video response:', err);
    stopReactionAnimation();
    try {
      await sendFinalVideoReaction(remoteJid, reactionTargetKey, '❌');
    } catch (reactionErr) {
      console.error(`Failed to send video failure reaction to ${remoteJid}:`, reactionErr);
    }
  } finally {
    stopReactionAnimation();
    await cleanupGeneratedVideo(generatedVideo);
  }
}

async function sendRateLimitWarning(remoteJid: string, text: string, quoted?: any): Promise<void> {
  await waitForConnectionWithTimeout(30_000);
  const sendSock = getSocket();
  await sendSock.sendMessage(remoteJid, { text }, quoted ? { quoted } : undefined);
}

async function getCachedRateLimitWarning(
  configHolder: ConfigHolder,
  groupConfig: GroupConfig,
  remoteJid: string,
): Promise<string> {
  const state = getGroupRateLimitState(remoteJid);
  if (state.warningText) {
    return state.warningText;
  }

  try {
    const warningText = await generateRateLimitWarning(configHolder.current, groupConfig, remoteJid);
    state.warningText = warningText;
    return warningText;
  } catch (err) {
    console.error('Failed to generate persona rate limit warning:', err);
    const fallback = 'Cooling down a bit. Try again in a moment.';
    state.warningText = fallback;
    return fallback;
  }
}

export function setupChatHandler(configHolder: ConfigHolder): void {
  onConnectionReady((sock: WASocket) => {
    const allJids = configHolder.current.groups.map((g) => g.jid);
    const chatbotJids = configHolder.current.groups
      .filter((g) => g.chatbot && g.chatbot.enabled !== false)
      .map((g) => g.jid);
    console.log(`Message recorder registered for groups: ${allJids.join(', ')}`);
    console.log(`Chat replies enabled for groups: ${chatbotJids.join(', ') || '(none)'}`);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      console.log(`[chat] messages.upsert: type=${type}, count=${messages.length}`);
      reportTraffic();

      if (type !== 'notify') return;

      for (const msg of messages) {
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) continue;

        const rawSender = msg.pushName ?? msg.key.participant ?? msg.key.remoteJid ?? '?';
        const rawText = extractText(msg);
        console.log(`[chat] MSG from=${rawSender} jid=${remoteJid} participant=${msg.key.participant ?? 'N/A'} text=${rawText ? `"${rawText.slice(0, 80)}"` : '(no text)'}`);

        const config = configHolder.current;
        const groupEntry = config.groups.find((g) => g.jid === remoteJid);
        if (!groupEntry) continue;
        const groupConfig = groupEntry.chatbot && groupEntry.chatbot.enabled !== false ? groupEntry : null;
        const botAliases = groupConfig ? parseBotAliases(groupConfig.chatbot!.botName) : [];
        const primaryBotName = groupConfig ? (botAliases[0] ?? groupConfig.chatbot!.botName) : '';

        // Handle emoji reactions
        const reaction = msg.message?.reactionMessage;
        if (reaction) {
          const emoji = reaction.text;
          if (!emoji) continue; // reaction removed
          const reactorJid = msg.key.participant ?? msg.key.remoteJid ?? '';
          const reactorName = msg.pushName ?? reactorJid;
          const targetId = reaction.key?.id;
          const targetMsg = targetId ? findMessageById(remoteJid, targetId) : undefined;
          const targetLabel = targetMsg
            ? (targetMsg.fromBot ? 'the bot\'s message' : `${targetMsg.senderName}'s message`)
              + (targetMsg.text ? `: "${targetMsg.text.slice(0, 60)}"` : '')
            : 'a message';
          const fromBot = msg.key.fromMe === true || isMessageFromBot(sock, { key: { participant: reactorJid, remoteJid, fromMe: msg.key.fromMe } });
          addMessage(remoteJid, {
            senderName: reactorName,
            senderJid: reactorJid,
            text: `[reacted ${emoji} to ${targetLabel}]`,
            fromBot,
          });
          if (!fromBot) {
            maybeRefreshProfiles(config, remoteJid);
          }
          console.log(`[chat] Reaction ${emoji} from ${reactorName} to ${targetLabel}`);
          continue;
        }

        const image = await extractImage(msg);
        const text = extractText(msg);
        console.log(`[chat] extractedText=${text ? `"${text}"` : 'null'}, hasImage=${!!image}, messageKeys=${Object.keys(msg.message ?? {}).join(', ')}`);
        if (!text && !image) continue;
        const enrichedText = text ? await enrichTextWithTweets(text, config.global) : null;

        const senderJid = msg.key.participant ?? msg.key.remoteJid ?? '';
        const senderName = msg.pushName ?? senderJid;
        const botJid = sock.user?.id;
        const botLid = sock.user?.lid;
        console.log(`[chat] sender=${senderName} (${senderJid}), botJid=${botJid}, botLid=${botLid}, fromMe=${msg.key.fromMe === true}`);
        const fromBot = isMessageFromBot(sock, msg as any);

        // Record every message in history (including image-only messages)
        addMessage(remoteJid, {
          senderName,
          senderJid,
          text: enrichedText ?? '',
          fromBot,
          messageId: msg.key.id ?? undefined,
          ...(image && { imageData: image.data, imageMimeType: image.mimeType }),
        });

        if (!fromBot) {
          maybeRefreshProfiles(config, remoteJid);
        }

        // Skip trigger check for bot's own messages
        if (fromBot) continue;
        if (!groupConfig) continue;
        recordInboundTriggerRateMessage(remoteJid, groupConfig, msg.key.id ?? undefined);

        // Image-only messages (no text) are recorded but don't trigger a response
        if (!text) continue;

        // Check triggers: @mention, keyword prefix, or reply to bot message
        const mentionedJids = extractMentionedJids(msg);
        console.log(`[chat] mentionedJids=${JSON.stringify(mentionedJids)}, botJid=${botJid}, botLid=${botLid}`);
        const mentionTriggered = mentionedJids.some((jid) =>
          (botJid && areJidsSameUser(jid, botJid)) ||
          (botLid && areJidsSameUser(jid, botLid))
        );
        const prefixTriggered = isPrefixTrigger(text, botAliases);

        const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant
          ?? msg.message?.imageMessage?.contextInfo?.participant
          ?? msg.message?.videoMessage?.contextInfo?.participant;
        const replyTriggered = !!quotedParticipant && (
          (!!botJid && areJidsSameUser(quotedParticipant, botJid)) ||
          (!!botLid && areJidsSameUser(quotedParticipant, botLid))
        );

        const deterministicTriggered = mentionTriggered || prefixTriggered || replyTriggered;
        const contextualTriggered = deterministicTriggered
          ? false
          : await evaluateContextualTrigger(configHolder, groupConfig, remoteJid, text, senderName);
        if (!deterministicTriggered && !contextualTriggered) continue;
        const explicitImageRequest = isExplicitImageRequest(text);
        const explicitVideoRequest = isExplicitVideoRequest(text);
        const modelCommand = parseModelCommand(text);

        if (modelCommand) {
          console.log(`[chat] Model command triggered for ${remoteJid}: ${text}`);
          const triggerRate = markTriggerRateMessage(remoteJid, groupConfig, msg.key.id ?? undefined, 'direct');
          console.log(`[chat] Trigger share for ${remoteJid}: ${formatTriggerRate(triggerRate)}`);
          withGroupLock(remoteJid, async () => {
            try {
              await handleModelCommand(configHolder, groupConfig, remoteJid, text, msg);
            } catch (err) {
              console.error('Failed to handle model command:', err);
            }
          });
          continue;
        }

        const limitDecision = admitTriggeredReply(remoteJid, groupConfig);
        if (!limitDecision.allowed) {
          console.log(`[chat] Rate limit denied for ${remoteJid}: ${limitDecision.count}/${limitDecision.limit} replies in ${Math.round(limitDecision.windowMs / 1000)}s`);
          if (claimRateLimitWarning(remoteJid, groupConfig)) {
            void (async () => {
              const warningText = await getCachedRateLimitWarning(configHolder, groupConfig, remoteJid);
              await sendRateLimitWarning(remoteJid, warningText, msg);
            })().catch((err) => {
              console.error('Failed to send rate limit warning:', err);
            });
          }
          continue;
        }

        if (msg.key.id) trackTriggered(msg.key.id);
        const triggerRate = markTriggerRateMessage(
          remoteJid,
          groupConfig,
          msg.key.id ?? undefined,
          deterministicTriggered ? 'direct' : 'context',
        );
        if (contextualTriggered) {
          recordContextualTriggerCooldown(remoteJid);
        }
        console.log(`Chat triggered by ${senderName} (${deterministicTriggered ? 'direct' : 'context'}): ${text}`);
        console.log(`[chat] Trigger share for ${remoteJid}: ${formatTriggerRate(triggerRate)}`);
        console.log(`[chat] Rate limit admitted for ${remoteJid}: ${limitDecision.count}/${limitDecision.limit} replies in ${Math.round(limitDecision.windowMs / 1000)}s`);

        const canGenerateDirectVideos = !!configHolder.current.global.geminiApiKey
          && groupConfig.chatbot?.enableVideoGeneration === true;
        if (explicitVideoRequest && canGenerateDirectVideos) {
          console.log(`[chat] Video generation triggered by ${senderName}: ${text}`);
          void sendGeneratedVideoReply(
            configHolder,
            groupConfig,
            remoteJid,
            primaryBotName,
            senderName,
            text,
            msg.key,
            msg,
          );
          continue;
        }

        withGroupLock(remoteJid, async () => {
          try {
            await sendGeneratedReply(
              configHolder,
              groupConfig,
              remoteJid,
              primaryBotName,
              senderName,
              text,
              explicitImageRequest,
              msg.key,
              msg,
            );
          } catch (err) {
            console.error('Failed to generate/send chat response:', err);
          }
        });

      }
    });

    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        const remoteJid = update.key.remoteJid;
        if (!remoteJid) continue;

        const config = configHolder.current;
        const groupEntry = config.groups.find((g) => g.jid === remoteJid);
        if (!groupEntry) continue;
        const groupConfig = groupEntry.chatbot && groupEntry.chatbot.enabled !== false ? groupEntry : null;
        const botAliases = groupConfig ? parseBotAliases(groupConfig.chatbot!.botName) : [];
        const primaryBotName = groupConfig ? (botAliases[0] ?? groupConfig.chatbot!.botName) : '';

        const editedMessage = (update.update as any)?.message?.editedMessage?.message;
        if (!editedMessage) continue;

        const text = extractText({ message: editedMessage });
        if (!text) continue;
        const enrichedText = await enrichTextWithTweets(text, config.global);

        const messageId = update.key.id;
        if (messageId && triggeredMessageIds.has(messageId)) {
          console.log(`[chat] Edit ignored — message ${messageId} already triggered`);
          continue;
        }

        // Update chat history with edited text
        if (messageId) updateMessageText(remoteJid, messageId, enrichedText);
        maybeRefreshProfiles(config, remoteJid);
        if (!groupConfig) continue;
        recordInboundTriggerRateMessage(remoteJid, groupConfig, messageId ?? undefined);

        const senderJid = update.key.participant ?? update.key.remoteJid ?? '';
        const triggerSenderName = senderJid;

        // Check triggers: prefix, @mention, or contextual classifier (no reply check for edits)
        const mentionedJids = extractMentionedJids({ message: editedMessage });
        const botJid = sock.user?.id;
        const botLid = sock.user?.lid;
        const mentionTriggered = mentionedJids.some((jid) =>
          (botJid && areJidsSameUser(jid, botJid)) ||
          (botLid && areJidsSameUser(jid, botLid))
        );
        const prefixTriggered = isPrefixTrigger(text, botAliases);

        const deterministicTriggered = mentionTriggered || prefixTriggered;
        const contextualTriggered = deterministicTriggered
          ? false
          : await evaluateContextualTrigger(configHolder, groupConfig, remoteJid, text, triggerSenderName, ' (edit)');
        if (!deterministicTriggered && !contextualTriggered) continue;
        const explicitImageRequest = isExplicitImageRequest(text);
        const explicitVideoRequest = isExplicitVideoRequest(text);
        const modelCommand = parseModelCommand(text);

        if (modelCommand) {
          console.log(`[chat] Model command triggered for ${remoteJid} (edit): ${text}`);
          const triggerRate = markTriggerRateMessage(remoteJid, groupConfig, messageId ?? undefined, 'direct');
          console.log(`[chat] Trigger share for ${remoteJid} (edit): ${formatTriggerRate(triggerRate)}`);
          withGroupLock(remoteJid, async () => {
            try {
              await handleModelCommand(configHolder, groupConfig, remoteJid, text);
            } catch (err) {
              console.error('Failed to handle model command (edit):', err);
            }
          });
          continue;
        }

        const limitDecision = admitTriggeredReply(remoteJid, groupConfig);
        if (!limitDecision.allowed) {
          console.log(`[chat] Rate limit denied for ${remoteJid} (edit): ${limitDecision.count}/${limitDecision.limit} replies in ${Math.round(limitDecision.windowMs / 1000)}s`);
          if (claimRateLimitWarning(remoteJid, groupConfig)) {
            void (async () => {
              const warningText = await getCachedRateLimitWarning(configHolder, groupConfig, remoteJid);
              await sendRateLimitWarning(remoteJid, warningText);
            })().catch((err) => {
              console.error('Failed to send rate limit warning (edit):', err);
            });
          }
          continue;
        }

        if (messageId) trackTriggered(messageId);
        const triggerRate = markTriggerRateMessage(
          remoteJid,
          groupConfig,
          messageId ?? undefined,
          deterministicTriggered ? 'direct' : 'context',
        );
        if (contextualTriggered) {
          recordContextualTriggerCooldown(remoteJid);
        }
        console.log(`[chat] Edit triggered by ${senderJid} (${deterministicTriggered ? 'direct' : 'context'}): ${text}`);
        console.log(`[chat] Trigger share for ${remoteJid} (edit): ${formatTriggerRate(triggerRate)}`);
        console.log(`[chat] Rate limit admitted for ${remoteJid} (edit): ${limitDecision.count}/${limitDecision.limit} replies in ${Math.round(limitDecision.windowMs / 1000)}s`);

        const canGenerateDirectVideos = !!configHolder.current.global.geminiApiKey
          && groupConfig.chatbot?.enableVideoGeneration === true;
        if (explicitVideoRequest && canGenerateDirectVideos) {
          console.log(`[chat] Video generation triggered by edit ${senderJid}: ${text}`);
          void sendGeneratedVideoReply(
            configHolder,
            groupConfig,
            remoteJid,
            primaryBotName,
            triggerSenderName,
            text,
            update.key,
          );
          continue;
        }

        withGroupLock(remoteJid, async () => {
          try {
            await sendGeneratedReply(
              configHolder,
              groupConfig,
              remoteJid,
              primaryBotName,
              triggerSenderName,
              text,
              explicitImageRequest,
              update.key,
            );
          } catch (err) {
            console.error('Failed to generate/send chat response (edit):', err);
          }
        });
      }
    });
  });
}
