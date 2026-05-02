import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig, ChatModelConfig, GroupConfig, ScheduledPostJobConfig } from './config.js';
import { resolveGroupChatModel, resolveTriggerChatModel } from './config.js';
import type { ChatMessage } from './chat-history.js';
import { getHistory, getRecentBotMessages, toAnthropicMessages, toGoogleContents } from './chat-history.js';
import { getProfilesPrompt } from './group-profiles.js';
import type { LatestNewsDigest } from './news.js';

let client: Anthropic | null = null;

type ResponseGenerationOptions = {
  expectsImage?: boolean;
  expectsVideo?: boolean;
  latestUserText?: string;
  triggerSenderName?: string;
};

export type GeneratedReply = {
  text: string;
  reactionEmoji?: string;
};

export type TriggerDecision = {
  shouldRespond: boolean;
  confidence?: number;
  reason?: string;
};

export type ImageLiteralness = 'vibe' | 'balanced' | 'literal';
export type ImageTextPolicy = 'none' | 'minimal' | 'allowed';

export type GeneratedImagePlan = {
  prompt?: string;
  mood?: string;
  style?: string;
  keySubjects?: string[];
  mustAvoid?: string[];
  textInImage?: ImageTextPolicy;
  literalness?: ImageLiteralness;
};

export type GeneratedVideoPlan = {
  prompt?: string;
  aspectRatio?: '16:9' | '9:16';
  durationSeconds?: 4 | 6 | 8;
  resolution?: '720p' | '1080p' | '4k';
};

type JsonImageDecision = {
  shouldGenerate?: boolean;
  image?: GeneratedImagePlan;
};

type JsonScheduledPost = {
  caption?: string;
  image?: GeneratedImagePlan;
};

type JsonEventAnnouncement = {
  caption?: string;
  image?: GeneratedImagePlan;
};

type JsonTriggerDecision = {
  shouldRespond?: boolean;
  confidence?: number;
  reason?: string;
};

type JsonManualVideoPost = {
  caption?: string;
  video?: GeneratedVideoPlan;
};

type GoogleGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    finishReason?: string;
    groundingMetadata?: unknown;
  }>;
};

const REACTION_TRAILER_RE = /\n?\s*\[\[reaction:([^\]\r\n]{0,32})\]\]\s*$/u;
const GOOGLE_REASONING_LEAK_PATTERNS = [
  /^\s*[*-]\s*User:/imu,
  /\bOption\s+\d+\b/iu,
  /\bDraft:/iu,
  /\bCharacter count\b/iu,
  /\bTranslation:\b/iu,
  /\bPersona:\b/iu,
  /\bLet's go with\b/iu,
  /\bAlternative Draft\b/iu,
  /\bNeed to\b/iu,
];
const MAX_RECENT_REACTION_EMOJIS = 8;
const IMAGE_PLAN_MAX_TOKENS = 900;
const TRIGGER_CONTEXT_MESSAGE_LIMIT = 18;
const TRIGGER_CONTEXT_MESSAGE_MAX_CHARS = 420;
const TRIGGER_MIN_CONFIDENCE = 0.72;
const recentReactionEmojisByGroup = new Map<string, string[]>();
const REACTION_EMOJI_MOOD_GUIDE = [
  'mocking laughter / absurdity: 😂 🤣 😹 😭',
  'smug / dismissive / bored superiority: 😏 🙄 😌 🤭 🫤',
  'cringe / awkward / second-hand pain: 😬 🫠 😵‍💫 🥴',
  'watching / suspicious / skeptical: 👀 🤨 🧐 🧪',
  'hype / applause / clean win: 🔥 👏 ⚡ 😎 🫡',
  'chaos / menace / cursed energy: 😈 🤡 💀 ☠️ 🚨',
  'robot / brain / tech / scheming: 🤖 🧠 ⚙️ 🛰️ 🔌',
  'collapse / disaster / trainwreck: 🫥 📉 💥 🪦',
  'popcorn / spectator drama: 🍿',
  'money / greed / market vibes: 💸 📈',
];

function isClaude46Model(model: string): boolean {
  return /\bclaude-(?:sonnet|opus)-4-6\b/.test(model);
}

function getAdaptiveThinkingEffort(thinkingBudget: number | undefined): 'low' | 'medium' {
  return (thinkingBudget ?? 2000) >= 4000 ? 'medium' : 'low';
}

function getClient(apiKey: string): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey, maxRetries: 3 });
  }
  return client;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function sampleGaussian(mean: number, stddev: number): number {
  let u1 = 0;
  let u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  const mag = Math.sqrt(-2 * Math.log(u1));
  const z0 = mag * Math.cos(2 * Math.PI * u2);
  return mean + z0 * stddev;
}

type ToneBand = {
  label: string;
  guidance: string;
};

function getToneBand(intensity: number): ToneBand {
  if (intensity <= 0.2) {
    return {
      label: 'restrained',
      guidance: 'Keep the tone dry and human. Use little to no insult language, light humor, and only a faint edge of sarcasm.',
    };
  }
  if (intensity <= 0.4) {
    return {
      label: 'mild',
      guidance: 'Be mildly snarky. A small jab is fine, but keep the reply more conversational than hostile.',
    };
  }
  if (intensity <= 0.6) {
    return {
      label: 'playful',
      guidance: 'Use a playful roast with moderate sarcasm and humor. Be witty, not repetitive, and not relentlessly mean.',
    };
  }
  if (intensity <= 0.8) {
    return {
      label: 'hot',
      guidance: 'Be sharp and funny. Roast more directly, but vary the joke angle and avoid leaning on the same insult pattern.',
    };
  }
  return {
    label: 'spicy',
    guidance: 'Use a rare high-heat reply: sharper mockery and stronger humor are allowed, but still avoid repeating recent insults or turning every sentence into abuse.',
  };
}

function buildDynamicStyleInstruction(groupConfig: GroupConfig): { intensity: number; baseline: number; band: string; instruction: string } {
  const hotness = groupConfig.chatbot?.hotness ?? 35;
  const baseline = clamp01(hotness / 100);
  const intensity = clamp01(sampleGaussian(baseline, 0.12));
  const band = getToneBand(intensity);

  const instruction = [
    'Dynamic tone guidance for this single reply:',
    `- Target hotness baseline: ${Math.round(baseline * 100)}/100.`,
    `- Current sampled tone: ${band.label} (${intensity.toFixed(2)}).`,
    `- ${band.guidance}`,
    '- Not every reply needs an insult.',
    '- Keep some humanity and spontaneity so the bot sounds like a person, not a catchphrase machine.',
    '- If you make a joke, use a fresh image, angle, or vocabulary choice.',
  ].join('\n');

  return { intensity, baseline, band: band.label, instruction };
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !/^\d+$/.test(word));
}

function buildAntiRepetitionInstruction(groupJid: string): string {
  const recentBotMessages = getRecentBotMessages(groupJid, 8);
  if (recentBotMessages.length === 0) return '';

  const tokenCounts = new Map<string, number>();
  const bigramCounts = new Map<string, number>();

  for (const msg of recentBotMessages) {
    const words = normalizeWords(msg.text);
    for (const word of words) {
      tokenCounts.set(word, (tokenCounts.get(word) ?? 0) + 1);
    }
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = `${words[i]} ${words[i + 1]}`;
      bigramCounts.set(bigram, (bigramCounts.get(bigram) ?? 0) + 1);
    }
  }

  const repeatedWords = [...tokenCounts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([word]) => word);
  const repeatedBigrams = [...bigramCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([bigram]) => bigram);

  const lines = [
    'Anti-repetition guidance:',
    '- Avoid reusing the same insult framing, punchline structure, or metaphor from your recent replies.',
    '- Prefer a different comedic angle, target, or sentence rhythm than the last few messages.',
  ];

  if (repeatedWords.length > 0) {
    lines.push(`- Try not to lean again on these repeated words: ${repeatedWords.join(', ')}.`);
  }
  if (repeatedBigrams.length > 0) {
    lines.push(`- Avoid repeating these recent phrase fragments: ${repeatedBigrams.join('; ')}.`);
  }

  return lines.join('\n');
}

function extractTextResponse(response: { content: Array<{ type: string; text?: string }> }): string {
  const textParts: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text' && block.text) {
      textParts.push(block.text);
    }
  }
  return textParts.join('');
}

function extractGoogleTextResponse(response: GoogleGenerateContentResponse): string {
  const textParts = (response.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text?.trim() ?? '')
    .filter(Boolean);
  return textParts[textParts.length - 1] ?? '';
}

function getGroupSystemPrompt(groupConfig: GroupConfig): string {
  return groupConfig.chatbot?.systemPrompt?.trim()
    || 'You are a helpful assistant in a WhatsApp group chat. Be concise and friendly.';
}

function formatHistoryWindow(messages: readonly ChatMessage[]): string {
  if (messages.length === 0) {
    return '[no recent discussion]';
  }

  return messages.map((msg) => {
    const timestamp = new Date(msg.timestamp ?? Date.now()).toISOString();
    const speaker = msg.fromBot ? `${msg.senderName || 'Bot'} (bot)` : msg.senderName;
    const parts: string[] = [];
    if (msg.imageData) {
      parts.push('[image]');
    }
    if (msg.text?.trim()) {
      parts.push(msg.text.trim());
    }
    if (parts.length === 0) {
      parts.push('[no text]');
    }
    return `[${timestamp}] ${speaker}: ${parts.join(' ')}`;
  }).join('\n');
}

function truncateForClassifier(text: string, maxChars = TRIGGER_CONTEXT_MESSAGE_MAX_CHARS): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function formatTriggerHistoryWindow(groupJid: string): string {
  const messages = getHistory(groupJid).slice(-TRIGGER_CONTEXT_MESSAGE_LIMIT);
  if (messages.length === 0) {
    return '[no recent discussion]';
  }

  return messages.map((msg) => {
    const speaker = msg.fromBot ? `${msg.senderName || 'Bot'} (bot)` : msg.senderName;
    const parts: string[] = [];
    if (msg.imageData) parts.push('[image]');
    if (msg.text?.trim()) parts.push(truncateForClassifier(msg.text));
    if (parts.length === 0) parts.push('[no text]');
    return `${speaker}: ${parts.join(' ')}`;
  }).join('\n');
}

function buildReactionVarietyInstruction(groupJid: string): string {
  const recent = recentReactionEmojisByGroup.get(groupJid) ?? [];
  const lines = [
    'Reaction emoji guidance:',
    `- Prefer fitting the mood using these buckets: ${REACTION_EMOJI_MOOD_GUIDE.join('; ')}.`,
    '- Choose one emoji that feels fresh for the current tone, semantic content, and persona.',
    '- Do not default to laughing faces when a smug, awkward, skeptical, robotic, market, chaos, or popcorn emoji fits better.',
    '- Prefer non-face emoji when they reflect the subject better, for example AI/robotics -> 🤖 🧠 ⚙️, market/money -> 📈 📉 💸, drama -> 🍿 🚨, collapse -> 💀 🪦 💥.',
    '- The emoji should react to what is being said, not just signal generic positivity or laughter.',
    '- Match the persona energy of the bot. If the persona is bored, superior, technical, or menacing, a smug or machine-like emoji is often better than 😂.',
    '- Use 😂 or 🤣 only when the situation is genuinely laugh-out-loud absurd, not as the default for all jokes.',
  ];
  if (recent.length > 0) {
    lines.push(`- Avoid reusing these recent reaction emojis unless absolutely necessary: ${recent.join(' ')}`);
  }
  return lines.join('\n');
}

function buildReplyPromptBlocks(groupJid: string, options: { expectsImage?: boolean; expectsVideo?: boolean }): string[] {
  const mediaBlocks = [
    ...(options.expectsImage
      ? [
        [
          'The user explicitly asked for an image and you can accompany this reply with one.',
          'Write a short caption or companion line that works naturally alongside an image.',
          'Do not claim you cannot generate images.',
          'Do not output markdown image syntax, image URLs, or external image links.',
          'Never use ![alt](url) formatting.',
          'Do not include bracketed image descriptions such as [Imagem: ...], [Image: ...], or similar prompt annotations.',
        ].join('\n'),
      ]
      : []),
    ...(options.expectsVideo
      ? [
        [
          'The user explicitly asked for a video and you can accompany this reply with one.',
          'Write a short caption or companion line that works naturally alongside a generated video.',
          'Do not claim you cannot generate videos.',
          'Do not output markdown video syntax, video URLs, or external video links.',
          'Do not include bracketed video descriptions such as [Video: ...], [Vídeo: ...], or similar prompt annotations.',
        ].join('\n'),
      ]
      : []),
  ];

  return mediaBlocks.concat([
    [
      'Return only the final user-visible reply.',
      'Never reveal reasoning, analysis, notes, options, drafts, translations, constraints, character counts, or self-evaluation.',
      'Never include labels such as "User:", "Option 1", "Draft:", "Persona:", "Translation:", or "Let\'s go with".',
      'Do not narrate your process or explain why you chose the answer.',
      'After the visible reply, append exactly one final trailer in this format: [[reaction:EMOJI]] or [[reaction:none]].',
      'The trailer must be the last thing in the final text.',
      'For this testing phase, bias toward using an emoji whenever the message or your reply has any noticeable snark, roast, teasing, hype, disbelief, suspense, applause, or playful energy.',
      'Use [[reaction:none]] only for clearly plain, mild, or purely informational triggers with little emotional tone.',
      'If your visible reply contains even mild sarcasm, mockery, or playful dismissal, prefer using an emoji instead of none.',
      'If you choose an emoji, output exactly one emoji and no explanation.',
      'Do not mention the trailer or explain your reaction choice.',
    ].join('\n'),
    buildReactionVarietyInstruction(groupJid),
  ]);
}

function looksLikeGoogleReasoningLeak(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const hits = GOOGLE_REASONING_LEAK_PATTERNS.filter((pattern) => pattern.test(trimmed)).length;
  return hits >= 2 || (hits >= 1 && trimmed.length >= 500);
}

function extractLikelyFinalReplyFromLeak(text: string, reactionEmoji?: string): GeneratedReply | null {
  const withoutTrailer = text.replace(REACTION_TRAILER_RE, '').trim();
  const quotedCandidates = [...withoutTrailer.matchAll(/["“]([^"”\n]{20,500})["”]/gu)]
    .map((match) => match[1]?.trim() ?? '')
    .filter((candidate) =>
      candidate
      && !GOOGLE_REASONING_LEAK_PATTERNS.some((pattern) => pattern.test(candidate))
      && !/\[\[reaction:/iu.test(candidate));

  if (quotedCandidates.length > 0) {
    return {
      text: quotedCandidates[quotedCandidates.length - 1]!,
      ...(reactionEmoji ? { reactionEmoji } : {}),
    };
  }

  const lineCandidates = withoutTrailer
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter((line) =>
      line.length >= 20
      && !GOOGLE_REASONING_LEAK_PATTERNS.some((pattern) => pattern.test(line))
      && !/^\*+\s*/u.test(line)
      && !/\[\[reaction:/iu.test(line));

  if (lineCandidates.length > 0) {
    return {
      text: lineCandidates[lineCandidates.length - 1]!,
      ...(reactionEmoji ? { reactionEmoji } : {}),
    };
  }

  return null;
}

function buildSyntheticFinalUserPrompt(triggerSenderName: string, latestUserText: string): string {
  return [
    `Respond now to this specific message from [${triggerSenderName}].`,
    `Target message:\n[${triggerSenderName}]: ${latestUserText}`,
    'Use the full conversation above as context, including any newer assistant replies, but make this target message the one you answer now.',
  ].join('\n\n');
}

function buildAnthropicReplyMessages(groupJid: string, triggerSenderName: string, latestUserText?: string): any[] {
  const historyMessages = toAnthropicMessages(groupJid);
  if (!latestUserText) {
    return historyMessages;
  }
  return [
    ...historyMessages,
    {
      role: 'user',
      content: buildSyntheticFinalUserPrompt(triggerSenderName, latestUserText),
    },
  ];
}

function buildGoogleReplyContents(groupJid: string, triggerSenderName: string, latestUserText?: string): Array<Record<string, unknown>> {
  const contents = toGoogleContents(groupJid).map((entry) => ({ role: entry.role, parts: entry.parts }));
  if (!latestUserText) {
    return contents;
  }
  return [
    ...contents,
    {
      role: 'user',
      parts: [{ text: buildSyntheticFinalUserPrompt(triggerSenderName, latestUserText) }],
    },
  ];
}

async function generateAnthropicReply(
  config: AppConfig,
  groupConfig: GroupConfig,
  groupJid: string,
  chatModel: ChatModelConfig,
  systemPrompt: string,
  latestUserText: string | undefined,
  triggerSenderName: string,
  dynamicStyle: { intensity: number; baseline: number; band: string; instruction: string },
): Promise<GeneratedReply> {
  const anthropic = getClient(config.global.anthropicApiKey);
  const chatbot = groupConfig.chatbot!;
  const messages = buildAnthropicReplyMessages(groupJid, triggerSenderName, latestUserText);

  if (messages.length === 0) {
    return { text: "I don't have any context yet. How can I help you?" };
  }

  const params: Record<string, any> = {
    model: chatModel.apiModel,
    max_tokens: config.global.chatMaxOutputTokens,
    system: systemPrompt,
    messages,
  };

  if (chatbot.enableThinking && chatModel.supportsThinking) {
    const budget = chatbot.thinkingBudget ?? 2000;
    if (isClaude46Model(chatModel.apiModel)) {
      params.thinking = { type: 'adaptive' };
      params.output_config = {
        effort: getAdaptiveThinkingEffort(chatbot.thinkingBudget),
      };
    } else {
      params.thinking = { type: 'enabled', budget_tokens: budget };
      params.max_tokens = config.global.chatMaxOutputTokens + budget;
    }
  }

  if (chatbot.enableWebSearch && chatModel.supportsWebSearch) {
    params.tools = [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: chatbot.maxSearches ?? 3,
    }];
  }

  const groupLabel = groupConfig.name ?? groupJid;
  console.log(`[llm] Request for "${groupLabel}":`);
  console.log(`[llm]   provider=anthropic model=${params.model}, max_tokens=${params.max_tokens}, modelId=${chatModel.id}`);
  console.log(`[llm]   hotness=${chatbot.hotness ?? 35}, sampledTone=${dynamicStyle.band} (${dynamicStyle.intensity.toFixed(2)})`);
  const systemPreview = getGroupSystemPrompt(groupConfig);
  console.log(`[llm]   system="${systemPreview.substring(0, 120)}${systemPreview.length > 120 ? '...' : ''}"`);
  console.log(`[llm]   messages=${messages.length}, syntheticFinalUser=${latestUserText ? 'yes' : 'no'}, thinking=${chatbot.enableThinking && chatModel.supportsThinking}${params.output_config ? ` (${JSON.stringify(params.output_config)})` : ''}, webSearch=${chatbot.enableWebSearch && chatModel.supportsWebSearch}${chatbot.enableWebSearch && chatModel.supportsWebSearch ? ` (max ${chatbot.maxSearches ?? 3})` : ''}`);
  if (params.tools) {
    console.log(`[llm]   tools=${JSON.stringify(params.tools)}`);
  }

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('LLM request timed out after 2 minutes')), 120_000),
  );
  const response = await Promise.race([
    anthropic.messages.create(params as any),
    timeout,
  ]);

  console.log(`[llm] Response for "${groupLabel}": stop_reason=${response.stop_reason}, blocks=${response.content.length}`);
  for (const block of response.content) {
    if (block.type === 'text') {
      console.log(`[llm]   [text] ${block.text.substring(0, 150)}${block.text.length > 150 ? '...' : ''}`);
    } else if (block.type === 'web_search_tool_result' || block.type === 'server_tool_use') {
      console.log(`[llm]   [${block.type}] ${JSON.stringify(block).substring(0, 200)}...`);
    } else {
      console.log(`[llm]   [${block.type}]`);
    }
  }

  const reply = extractReplyAndReaction(extractTextResponse(response));
  if (reply.text) {
    console.log(`[llm] Parsed reaction hint for "${groupLabel}": ${reply.reactionEmoji ?? 'none'}`);
    return reply;
  }

  return { text: '' };
}

async function generateGoogleReply(
  config: AppConfig,
  groupConfig: GroupConfig,
  groupJid: string,
  chatModel: ChatModelConfig,
  systemPrompt: string,
  latestUserText: string | undefined,
  triggerSenderName: string,
  dynamicStyle: { intensity: number; baseline: number; band: string; instruction: string },
): Promise<GeneratedReply> {
  const chatbot = groupConfig.chatbot!;
  const contents = buildGoogleReplyContents(groupJid, triggerSenderName, latestUserText);

  if (contents.length === 0) {
    return { text: "I don't have any context yet. How can I help you?" };
  }

  const payload: Record<string, any> = {
    system_instruction: {
      parts: [{ text: systemPrompt }],
    },
    contents,
    generationConfig: {
      responseMimeType: 'text/plain',
      maxOutputTokens: config.global.chatMaxOutputTokens,
    },
  };

  if (chatbot.enableThinking && chatModel.supportsThinkingConfig) {
    payload.generationConfig.thinkingConfig = {
      thinkingLevel: getAdaptiveThinkingEffort(chatbot.thinkingBudget),
    };
  }

  if (chatbot.enableWebSearch && chatModel.supportsWebSearch) {
    payload.tools = [{ google_search: {} }];
  }

  const groupLabel = groupConfig.name ?? groupJid;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(chatModel.apiModel)}:generateContent`;
  console.log(`[llm] Request for "${groupLabel}":`);
  console.log(`[llm]   provider=google model=${chatModel.apiModel}, maxOutputTokens=${payload.generationConfig.maxOutputTokens}, modelId=${chatModel.id}`);
  console.log(`[llm]   hotness=${chatbot.hotness ?? 35}, sampledTone=${dynamicStyle.band} (${dynamicStyle.intensity.toFixed(2)})`);
  const systemPreview = getGroupSystemPrompt(groupConfig);
  console.log(`[llm]   system="${systemPreview.substring(0, 120)}${systemPreview.length > 120 ? '...' : ''}"`);
  console.log(`[llm]   messages=${contents.length}, syntheticFinalUser=${latestUserText ? 'yes' : 'no'}, thinking=${chatbot.enableThinking && chatModel.supportsThinkingConfig}, webSearch=${chatbot.enableWebSearch && chatModel.supportsWebSearch}`);
  if (payload.tools) {
    console.log(`[llm]   tools=${JSON.stringify(payload.tools)}`);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': config.global.geminiApiKey ?? '',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Google model request failed (${response.status}): ${bodyText.slice(0, 500)}`);
  }

  const json = await response.json() as GoogleGenerateContentResponse;
  console.log(`[llm] Response for "${groupLabel}": candidates=${json.candidates?.length ?? 0}`);
  const rawText = extractGoogleTextResponse(json);
  let reply = extractReplyAndReaction(rawText);
  if (looksLikeGoogleReasoningLeak(reply.text)) {
    console.warn(`[llm] Google model ${chatModel.apiModel} leaked reasoning-style text; attempting cleanup.`);
    console.warn(`[llm] Google raw response preview for "${groupLabel}": ${rawText.slice(0, 800)}`);
    try {
      const cleaned = await cleanupGoogleReply(
        config,
        chatModel,
        groupLabel,
        latestUserText,
        systemPrompt,
        rawText,
        reply.reactionEmoji,
      );
      if (cleaned.text && !looksLikeGoogleReasoningLeak(cleaned.text)) {
        reply = cleaned;
      } else {
        const salvaged = extractLikelyFinalReplyFromLeak(rawText, reply.reactionEmoji);
        if (salvaged?.text) {
          console.warn(`[llm] Google reasoning leak for ${chatModel.apiModel} salvaged heuristically.`);
          reply = salvaged;
        }
      }
    } catch (error) {
      console.error(`[llm] Failed to clean up Google reasoning leak for ${chatModel.apiModel}:`, error);
      const salvaged = extractLikelyFinalReplyFromLeak(rawText, reply.reactionEmoji);
      if (salvaged?.text) {
        console.warn(`[llm] Google reasoning leak for ${chatModel.apiModel} salvaged heuristically after cleanup failure.`);
        reply = salvaged;
      }
    }
  }
  if (reply.text) {
    console.log(`[llm] Parsed reaction hint for "${groupLabel}": ${reply.reactionEmoji ?? 'none'}`);
    return reply;
  }

  return { text: '' };
}

async function cleanupGoogleReply(
  config: AppConfig,
  chatModel: ChatModelConfig,
  groupLabel: string,
  latestUserText: string | undefined,
  systemPrompt: string,
  leakedText: string,
  reactionEmoji?: string,
): Promise<GeneratedReply> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(chatModel.apiModel)}:generateContent`;
  const cleanupInstruction = [
    'Rewrite the provided leaked scratchpad into one final user-visible reply only.',
    'Do not include analysis, bullets, labels, options, drafts, translations, constraints, or commentary.',
    'Keep the language, persona, and tone intended by the original answer.',
    'Keep it under 400 characters.',
    `Append exactly one final trailer: [[reaction:${reactionEmoji ?? 'none'}]]`,
    'That trailer must be the last thing in the text.',
  ].join('\n');

  const payload: Record<string, any> = {
    system_instruction: {
      parts: [{ text: `${systemPrompt}\n\n${cleanupInstruction}` }],
    },
    contents: [{
      role: 'user',
      parts: [{
        text: [
          latestUserText ? `Original user message:\n${latestUserText}` : '',
          `Leaked output to clean:\n${leakedText}`,
          'Return the clean final reply now.',
        ].filter(Boolean).join('\n\n'),
      }],
    }],
    generationConfig: {
      responseMimeType: 'text/plain',
      maxOutputTokens: 220,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': config.global.geminiApiKey ?? '',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Google cleanup request failed (${response.status}): ${bodyText.slice(0, 500)}`);
  }

  const json = await response.json() as GoogleGenerateContentResponse;
  return extractReplyAndReaction(extractGoogleTextResponse(json));
}

export function recordRecentReactionEmoji(groupJid: string, emoji: string): void {
  const trimmed = emoji.trim();
  if (!trimmed) return;
  const recent = recentReactionEmojisByGroup.get(groupJid) ?? [];
  recent.push(trimmed);
  if (recent.length > MAX_RECENT_REACTION_EMOJIS) {
    recent.splice(0, recent.length - MAX_RECENT_REACTION_EMOJIS);
  }
  recentReactionEmojisByGroup.set(groupJid, recent);
}

function parseReactionEmoji(rawValue: string | undefined): string | undefined {
  const value = rawValue?.trim();
  if (!value || /^none$/iu.test(value)) return undefined;
  if (value.length > 16 || /\s/u.test(value)) return undefined;
  if (Array.from(value).length > 8) return undefined;
  if (!/^[\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Emoji_Component}\u200D\uFE0F\u20E3]+$/u.test(value)) {
    return undefined;
  }
  return value;
}

function extractReplyAndReaction(text: string): GeneratedReply {
  const trimmed = text.trim();
  const match = trimmed.match(REACTION_TRAILER_RE);
  if (!match) {
    return { text: trimmed };
  }

  const reactionEmoji = parseReactionEmoji(match[1]);
  const replyText = trimmed.slice(0, match.index).trimEnd();
  return {
    text: replyText,
    ...(reactionEmoji ? { reactionEmoji } : {}),
  };
}

function buildSystemPrompt(
  groupConfig: GroupConfig,
  groupJid: string,
  extraBlocks: string[] = [],
  options: {
    includeDynamicStyle?: boolean;
    includeAntiRepetition?: boolean;
    dynamicStyleInstruction?: string;
  } = {},
): string {
  const blocks = [getGroupSystemPrompt(groupConfig), getProfilesPrompt(groupJid).trim()];

  if (options.includeDynamicStyle !== false) {
    blocks.push(options.dynamicStyleInstruction ?? buildDynamicStyleInstruction(groupConfig).instruction);
  }
  if (options.includeAntiRepetition !== false) {
    blocks.push(buildAntiRepetitionInstruction(groupJid));
  }

  blocks.push(...extraBlocks);
  return blocks.filter(Boolean).join('\n\n');
}

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/i);
  const candidate = fenced?.[1]?.trim() || text.trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return candidate.slice(start, end + 1);
}

function parseJsonResponse<T>(text: string): T | null {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText) as T;
  } catch {
    return null;
  }
}

function extractLooseJsonStringField(text: string, fieldName: string): string | undefined {
  const field = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'su'));
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

function extractLooseJsonEnumField<T extends string>(
  text: string,
  fieldName: string,
  allowed: readonly T[],
): T | undefined {
  const value = extractLooseJsonStringField(text, fieldName);
  return allowed.includes(value as T) ? value as T : undefined;
}

function hasLooseBooleanField(text: string, fieldName: string, expected: boolean): boolean {
  const field = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`"${field}"\\s*:\\s*${expected ? 'true' : 'false'}\\b`, 'iu').test(text);
}

function extractInlineImagePromptText(text: string): string | null {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const patterns = [
    /(?:^|\n)\s*(?:[*_`#>\- ]*)?(?:imagem gerada|image generated|prompt de imagem|image prompt|imagem|image)\s*:\s*([\s\S]+)$/iu,
    /(?:^|\n)\s*---+\s*(?:\n+)?([\s\S]+)$/u,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const candidate = match?.[1]?.trim();
    if (!candidate) continue;
    const cleaned = candidate
      .replace(/^[-*]\s*/gm, '')
      .replace(/\[\[reaction:[^\]]+\]\]\s*$/iu, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cleaned && cleaned.length >= 16) {
      return cleaned;
    }
  }

  return null;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, 8);
  return items.length > 0 ? items : undefined;
}

function parseImagePlan(value: unknown, defaults?: {
  literalness?: ImageLiteralness;
  textInImage?: ImageTextPolicy;
}): GeneratedImagePlan | null {
  if (!value || typeof value !== 'object') return null;

  const raw = value as Record<string, unknown>;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) return null;

  const literalness = raw.literalness === 'vibe' || raw.literalness === 'balanced' || raw.literalness === 'literal'
    ? raw.literalness
    : (defaults?.literalness ?? 'balanced');
  const textInImage = raw.textInImage === 'none' || raw.textInImage === 'minimal' || raw.textInImage === 'allowed'
    ? raw.textInImage
    : (defaults?.textInImage ?? 'none');

  return {
    prompt,
    mood: typeof raw.mood === 'string' ? raw.mood.trim() || undefined : undefined,
    style: typeof raw.style === 'string' ? raw.style.trim() || undefined : undefined,
    keySubjects: normalizeStringList(raw.keySubjects),
    mustAvoid: normalizeStringList(raw.mustAvoid),
    textInImage,
    literalness,
  };
}

function parseVideoPlan(value: unknown): GeneratedVideoPlan | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) return null;

  const durationSeconds = raw.durationSeconds === 4 || raw.durationSeconds === 6 || raw.durationSeconds === 8
    ? raw.durationSeconds
    : 8;
  const resolution = raw.resolution === '720p' || raw.resolution === '1080p' || raw.resolution === '4k'
    ? raw.resolution
    : '720p';
  const aspectRatio = raw.aspectRatio === '16:9' || raw.aspectRatio === '9:16'
    ? raw.aspectRatio
    : '9:16';
  return {
    prompt,
    aspectRatio,
    durationSeconds,
    resolution,
  };
}

function extractLooseImagePlan(responseText: string, defaults?: {
  literalness?: ImageLiteralness;
  textInImage?: ImageTextPolicy;
}): GeneratedImagePlan | null {
  const prompt = extractLooseJsonStringField(responseText, 'prompt')?.trim();
  if (!prompt) return null;

  const literalness = extractLooseJsonEnumField<ImageLiteralness>(
    responseText,
    'literalness',
    ['vibe', 'balanced', 'literal'],
  ) ?? defaults?.literalness ?? 'balanced';
  const textInImage = extractLooseJsonEnumField<ImageTextPolicy>(
    responseText,
    'textInImage',
    ['none', 'minimal', 'allowed'],
  ) ?? defaults?.textInImage ?? 'none';

  return {
    prompt,
    mood: extractLooseJsonStringField(responseText, 'mood')?.trim() || undefined,
    style: extractLooseJsonStringField(responseText, 'style')?.trim() || undefined,
    literalness,
    textInImage,
  };
}

function parseImagePlanResponse(
  responseText: string,
  logLabel: string,
  defaults?: {
    literalness?: ImageLiteralness;
    textInImage?: ImageTextPolicy;
  },
): GeneratedImagePlan | null {
  const parsed = parseJsonResponse<GeneratedImagePlan | JsonImageDecision | JsonScheduledPost>(responseText);
  const candidate = parsed && typeof parsed === 'object' && 'prompt' in parsed
    ? parsed
    : parsed && typeof parsed === 'object' && 'image' in parsed
      ? parsed.image
      : null;
  const imagePlan = parseImagePlan(candidate, defaults);
  if (imagePlan) {
    return imagePlan;
  }

  const looseImagePlan = extractLooseImagePlan(responseText, defaults);
  if (looseImagePlan) {
    console.warn(`[llm] ${logLabel} returned invalid JSON image content; salvaging loose image plan.`);
    console.warn(`[llm] ${logLabel} raw response preview: ${responseText.slice(0, 500)}`);
    return looseImagePlan;
  }

  const fallbackPrompt = extractInlineImagePromptText(responseText);
  if (fallbackPrompt) {
    console.warn(`[llm] ${logLabel} returned non-JSON image content; salvaging inline image prompt.`);
    console.warn(`[llm] ${logLabel} raw response preview: ${responseText.slice(0, 500)}`);
    return {
      prompt: fallbackPrompt,
      literalness: defaults?.literalness ?? 'balanced',
      textInImage: defaults?.textInImage ?? 'none',
    };
  }

  console.warn(`[llm] ${logLabel} returned no usable image plan.`);
  console.warn(`[llm] ${logLabel} raw response preview: ${responseText.slice(0, 500)}`);
  return null;
}

async function runPlanningPrompt(
  config: AppConfig,
  groupConfig: GroupConfig,
  groupJid: string,
  instruction: string,
  requestText: string,
  maxTokens: number,
): Promise<string> {
  const anthropic = getClient(config.global.anthropicApiKey);
  const response = await anthropic.messages.create({
    model: config.global.claudeModel,
    max_tokens: maxTokens,
    system: buildSystemPrompt(groupConfig, groupJid, [instruction], { includeAntiRepetition: false }),
    messages: [
      ...toAnthropicMessages(groupJid),
      {
        role: 'user',
        content: requestText,
      },
    ],
  } as any);

  return extractTextResponse(response).trim();
}

async function generateShortPersonaLine(
  config: AppConfig,
  groupConfig: GroupConfig,
  groupJid: string,
  instruction: string,
  userPrompt: string,
): Promise<string> {
  const anthropic = getClient(config.global.anthropicApiKey);

  const response = await anthropic.messages.create({
    model: config.global.claudeModel,
    max_tokens: 80,
    system: buildSystemPrompt(groupConfig, groupJid, [instruction], { includeAntiRepetition: false }),
    messages: [{
      role: 'user',
      content: userPrompt,
    }],
  } as any);

  return extractTextResponse(response).trim();
}

function parseTriggerDecision(responseText: string): TriggerDecision {
  const parsed = parseJsonResponse<JsonTriggerDecision>(responseText);
  const looseShouldRespond = hasLooseBooleanField(responseText, 'shouldRespond', true);
  const shouldRespond = parsed?.shouldRespond === true || looseShouldRespond;
  const confidence = typeof parsed?.confidence === 'number'
    ? clamp01(parsed.confidence)
    : undefined;
  const reason = typeof parsed?.reason === 'string'
    ? parsed.reason.trim().slice(0, 240)
    : undefined;

  return {
    shouldRespond: shouldRespond && confidence != null && confidence >= TRIGGER_MIN_CONFIDENCE,
    ...(confidence != null ? { confidence } : {}),
    ...(reason ? { reason } : {}),
  };
}

function buildTriggerClassifierPrompt(groupConfig: GroupConfig, groupJid: string, triggerSenderName: string, latestUserText: string): string {
  const chatbot = groupConfig.chatbot!;
  const aliases = chatbot.botName
    .split(',')
    .map((alias) => alias.trim())
    .filter(Boolean)
    .join(', ') || chatbot.botName;

  return [
    'Decide whether the WhatsApp bot should proactively reply to the latest message based on the conversation context.',
    '',
    'Return JSON only with this exact shape: {"shouldRespond":true|false,"confidence":0.0-1.0,"reason":"short reason"}.',
    '',
    'Reply true when there is strong evidence that the latest message is addressed to the bot, asks for bot/assistant help, asks the bot to judge/summarize/explain/fact-check/generate something, or continues a thread where the bot is clearly an active participant.',
    'Reply true for a rare unsolicited interjection only when the latest message creates an unusually strong opportunity for the bot persona to add clear value, humor, or useful context that the group would likely welcome.',
    'Reply true when the latest message names the bot, refers to "the bot"/"assistant"/"AI" in a way that calls for this bot to answer, or asks a question that no specific human participant is expected to answer and the persona is directly relevant.',
    'Do not reply merely because the topic is mildly interesting, funny, technical, or compatible with the persona.',
    'Do not reply merely because the recent conversation mentioned bots, AI, models, coding, or the configured persona topic.',
    'Reply false for ordinary human-to-human chatter, rhetorical comments, acknowledgements, reactions, private logistics, jokes among humans, or anything where a bot interjection would feel unsolicited.',
    `Be strict: choose true only if confidence is at least ${TRIGGER_MIN_CONFIDENCE.toFixed(2)}. If intent is ambiguous, choose false.`,
    'Do not require the bot name to be present. The bot name is only identity context, not the trigger rule.',
    '',
    `Bot aliases: ${aliases}`,
    `Bot persona:\n${getGroupSystemPrompt(groupConfig)}`,
    `Recent conversation:\n${formatTriggerHistoryWindow(groupJid)}`,
    `Latest message to judge:\n[${triggerSenderName}]: ${latestUserText}`,
    '',
    'Return the JSON now.',
  ].join('\n');
}

export async function decideContextualTrigger(
  config: AppConfig,
  groupConfig: GroupConfig,
  groupJid: string,
  latestUserText: string,
  triggerSenderName: string,
): Promise<TriggerDecision> {
  const triggerModel = resolveTriggerChatModel(config.global);
  const groupLabel = groupConfig.name ?? groupJid;
  if (!triggerModel) {
    console.warn(`[llm] No available trigger model for "${groupLabel}"; contextual trigger skipped.`);
    return { shouldRespond: false, reason: 'no trigger model available' };
  }

  const prompt = buildTriggerClassifierPrompt(groupConfig, groupJid, triggerSenderName, latestUserText);
  console.log(`[llm] Trigger classifier request for "${groupLabel}": provider=${triggerModel.provider} model=${triggerModel.apiModel}, modelId=${triggerModel.id}`);

  if (triggerModel.provider === 'anthropic') {
    const anthropic = getClient(config.global.anthropicApiKey);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Trigger classifier timed out after 30 seconds')), 30_000),
    );
    const response = await Promise.race([
      anthropic.messages.create({
        model: triggerModel.apiModel,
        max_tokens: 120,
        system: 'You are a strict, low-latency routing classifier. Return only compact JSON.',
        messages: [{ role: 'user', content: prompt }],
      } as any),
      timeout,
    ]);
    const decision = parseTriggerDecision(extractTextResponse(response));
    console.log(`[llm] Trigger classifier decision for "${groupLabel}": ${decision.shouldRespond ? 'respond' : 'skip'}${decision.confidence != null ? ` confidence=${decision.confidence.toFixed(2)}` : ''}${decision.reason ? ` reason="${decision.reason}"` : ''}`);
    return decision;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(triggerModel.apiModel)}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': config.global.geminiApiKey ?? '',
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: 'You are a strict, low-latency routing classifier. Return only compact JSON.' }],
      },
      contents: [{
        role: 'user',
        parts: [{ text: prompt }],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens: 120,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Google trigger classifier request failed (${response.status}): ${bodyText.slice(0, 500)}`);
  }

  const json = await response.json() as GoogleGenerateContentResponse;
  const decision = parseTriggerDecision(extractGoogleTextResponse(json));
  console.log(`[llm] Trigger classifier decision for "${groupLabel}": ${decision.shouldRespond ? 'respond' : 'skip'}${decision.confidence != null ? ` confidence=${decision.confidence.toFixed(2)}` : ''}${decision.reason ? ` reason="${decision.reason}"` : ''}`);
  return decision;
}

export async function generateResponse(
  config: AppConfig,
  groupConfig: GroupConfig,
  groupJid: string,
  options: ResponseGenerationOptions = {},
): Promise<GeneratedReply> {
  const groupLabel = groupConfig.name ?? groupJid;
  const latestUserText = options.latestUserText?.trim();
  const triggerSenderName = options.triggerSenderName?.trim() || 'User';
  const chatbot = groupConfig.chatbot!;
  const chatModel = resolveGroupChatModel(config.global, groupConfig);
  const dynamicStyle = buildDynamicStyleInstruction(groupConfig);
  const promptBlocks = buildReplyPromptBlocks(groupJid, {
    expectsImage: options.expectsImage === true,
    expectsVideo: options.expectsVideo === true,
  });
  const systemPrompt = buildSystemPrompt(
    groupConfig,
    groupJid,
    promptBlocks,
    { dynamicStyleInstruction: dynamicStyle.instruction },
  );

  const reply = chatModel.provider === 'anthropic'
    ? await generateAnthropicReply(
        config,
        groupConfig,
        groupJid,
        chatModel,
        systemPrompt,
        latestUserText,
        triggerSenderName,
        dynamicStyle,
      )
    : await generateGoogleReply(
        config,
        groupConfig,
        groupJid,
        chatModel,
        systemPrompt,
        latestUserText,
        triggerSenderName,
        dynamicStyle,
      );
  if (reply.text) {
    return reply;
  }

  try {
    const groupLabel = groupConfig.name ?? groupJid;
    const fallback = await generateShortPersonaLine(
      config,
      groupConfig,
      groupJid,
      [
        'Your previous answer produced no visible text.',
        'Write one very short in-character fallback reply.',
        'Do not mention technical problems, APIs, rate limits, or that anything failed.',
        'Keep it natural, concise, and fully in persona.',
        'Keep it under 160 characters.',
      ].join('\n'),
      'Give the fallback line now.',
    );
    if (fallback) {
      return { text: fallback };
    }
  } catch (err) {
    console.error(`[llm] Failed to generate persona fallback for "${groupLabel}":`, err);
  }

  return { text: '...' };
}

export async function generateRateLimitWarning(config: AppConfig, groupConfig: GroupConfig, groupJid: string): Promise<string> {
  const replyText = await generateShortPersonaLine(
    config,
    groupConfig,
    groupJid,
    [
      'You are sending a cooldown warning because the group triggered you too many times in a short span.',
      'Write one very short in-character reply that says you are cooling down for a bit.',
      'Stay fully in persona, keep it snarky or playful according to the persona, and do not mention APIs, rate limits, tokens, or technical issues.',
      'Do not use lists or multiple paragraphs.',
      'Keep it under 140 characters.',
    ].join('\n'),
    'Give the cooldown line now.',
  );
  return replyText || 'Cooling down a bit. Try again in a moment.';
}

export async function generateImagePromptForDirectRequest(
  config: AppConfig,
  groupConfig: GroupConfig,
  groupJid: string,
  latestUserText: string,
  replyText: string,
): Promise<GeneratedImagePlan | null> {
  const responseText = await runPlanningPrompt(
    config,
    groupConfig,
    groupJid,
    [
      'You are preparing an image-generation prompt for a companion image.',
      'The user directly asked for an image.',
      'Return JSON only with the shape {"prompt":"...","mood":"...","style":"...","keySubjects":["..."],"mustAvoid":["..."],"textInImage":"none|minimal|allowed","literalness":"vibe|balanced|literal"}',
      'Write a single self-contained prompt suitable for a modern text-to-image model.',
      'Keep the image prompt compact: ideally under 90 words.',
      'Carry over the conversation context, the bot persona, and the tone of the reply.',
      'Use literalness="balanced" by default. Only use literalness="literal" when the user clearly wants exact depiction. Use literalness="vibe" when mood matters more than exact scene details.',
      'Default to textInImage="none" unless the user explicitly asked for readable text, a poster, a sign, a screenshot, a headline, or typography as part of the image.',
      'Prefer images that represent the mood, characters, and scene rather than a wall of written content.',
      'Prefer an image prompt in English unless the user explicitly asked for another language in the image.',
      'Avoid asking for text overlays unless the user explicitly requested them.',
      'The bot reply itself must stay as plain text only, never markdown image syntax or image URLs.',
      'Do not include bracketed image descriptions such as [Imagem: ...], [Image: ...], or similar prompt annotations in the bot reply.',
      'If the request is unsafe or you cannot infer a good image, return {"prompt":""}.',
    ].join('\n'),
    [
      `Latest user message:\n${latestUserText}`,
      `Planned bot reply/caption:\n${replyText}`,
      'Return the JSON now.',
    ].join('\n\n'),
    IMAGE_PLAN_MAX_TOKENS,
  );

  return parseImagePlanResponse(
    responseText,
    `Direct image planner for "${groupConfig.name ?? groupJid}"`,
    { literalness: 'balanced', textInImage: 'none' },
  );
}

export async function generateVideoPromptForDirectRequest(
  config: AppConfig,
  groupConfig: GroupConfig,
  groupJid: string,
  latestUserText: string,
  replyText: string,
): Promise<GeneratedVideoPlan | null> {
  const responseText = await runPlanningPrompt(
    config,
    groupConfig,
    groupJid,
    [
      'You are preparing a video-generation prompt for a companion video.',
      'The user directly asked for a video.',
      'Return JSON only with the shape {"prompt":"...","aspectRatio":"9:16|16:9","durationSeconds":4|6|8,"resolution":"720p|1080p|4k"}',
      'Write a single self-contained prompt suitable for Google Veo video generation.',
      'Keep the video prompt compact: ideally under 110 words.',
      'Include motion, action, camera movement, visual style, ambiance, and optional audio cues when useful.',
      'Default to aspectRatio="9:16", durationSeconds=8, and resolution="720p" for a more complete, cinematic clip.',
      'Do not include personGeneration in the JSON; the request layer handles people-generation policy.',
      'Use 720p unless the user explicitly asks for higher resolution.',
      'Use 8 seconds unless the user explicitly asks for a shorter clip.',
      'Prefer prompts in English unless the user explicitly asks for another language in the video.',
      'Avoid asking for readable text, captions, subtitles, signs, UI, or title cards unless explicitly requested.',
      'When people are requested, describe generic adult performers or silhouettes unless the user provided a permitted reference image. Avoid exact likenesses of private people, celebrities, public figures, minors, or named real people.',
      'For person-heavy scenes, emphasize expressive motion, wardrobe, lighting, choreography, camera movement, and atmosphere rather than facial identity.',
      'The bot reply itself must stay as plain text only, never markdown video syntax or video URLs.',
      'If the request is unsafe or you cannot infer a good video, return {"prompt":""}.',
    ].join('\n'),
    [
      `Latest user message:\n${latestUserText}`,
      `Planned bot reply/caption:\n${replyText}`,
      'Return the JSON now.',
    ].join('\n\n'),
    IMAGE_PLAN_MAX_TOKENS,
  );

  const parsed = parseJsonResponse<GeneratedVideoPlan>(responseText);
  const plan = parseVideoPlan(parsed);
  if (plan) {
    return plan;
  }

  console.warn(`[llm] Direct video planner for "${groupConfig.name ?? groupJid}" returned no usable video plan.`);
  console.warn(`[llm] Direct video planner for "${groupConfig.name ?? groupJid}" raw response preview: ${responseText.slice(0, 500)}`);
  return null;
}

export async function decideImageForReply(
  config: AppConfig,
  groupConfig: GroupConfig,
  groupJid: string,
  latestUserText: string,
  replyText: string,
): Promise<{ shouldGenerate: boolean; image: GeneratedImagePlan | null }> {
  const responseText = await runPlanningPrompt(
    config,
    groupConfig,
    groupJid,
    [
      'You are deciding whether the bot should attach an image with its next reply.',
      'Be conservative. Most replies should stay text-only.',
      'Only choose an image when it clearly adds humor, atmosphere, or clarity to the reply.',
      'Return JSON only with the shape {"shouldGenerate":true|false,"image":{"prompt":"...","mood":"...","style":"...","keySubjects":["..."],"mustAvoid":["..."],"textInImage":"none|minimal|allowed","literalness":"vibe|balanced|literal"}}',
      'If shouldGenerate is false, set image to null or an empty prompt.',
      'If shouldGenerate is true, write a self-contained image prompt that reflects the bot persona and the reply.',
      'Keep any image prompt compact: ideally under 90 words.',
      'Default to literalness="balanced". Use literalness="vibe" when the image should mainly convey mood, body language, tension, or comedic atmosphere rather than literal sentence content.',
      'Default to textInImage="none". Only allow readable text if the conversation explicitly calls for it.',
      'Prefer an image prompt in English unless the user explicitly asked for another language in the image.',
      'Avoid text overlays, signs, posters, chat bubbles, captions, screenshots, or headline-style compositions unless explicitly requested.',
      'The bot reply must remain plain text, never markdown image syntax or external image URLs.',
      'Do not include bracketed image descriptions such as [Imagem: ...], [Image: ...], or similar prompt annotations in the bot reply.',
    ].join('\n'),
    [
      `Latest user message:\n${latestUserText}`,
      `Planned bot reply:\n${replyText}`,
      'Return the JSON now.',
    ].join('\n\n'),
    IMAGE_PLAN_MAX_TOKENS,
  );

  const parsed = parseJsonResponse<JsonImageDecision>(responseText);
  const image = parsed?.image
    ? parseImagePlan(parsed.image, { literalness: 'balanced', textInImage: 'none' })
    : null;
  const looseImage = !parsed && hasLooseBooleanField(responseText, 'shouldGenerate', true)
    ? extractLooseImagePlan(responseText, { literalness: 'balanced', textInImage: 'none' })
    : null;
  if (!image && parsed?.shouldGenerate === true) {
    console.warn(`[llm] Auto image decision for "${groupConfig.name ?? groupJid}" requested an image but returned no usable plan.`);
    console.warn(`[llm] Auto image decision raw response preview: ${responseText.slice(0, 500)}`);
  }
  if (looseImage) {
    console.warn(`[llm] Auto image decision for "${groupConfig.name ?? groupJid}" returned invalid JSON; salvaging loose image plan.`);
    console.warn(`[llm] Auto image decision raw response preview: ${responseText.slice(0, 500)}`);
  }
  return {
    shouldGenerate: (parsed?.shouldGenerate === true && !!image) || !!looseImage,
    image: image ?? looseImage,
  };
}

export async function generateImagePromptForReply(
  config: AppConfig,
  groupConfig: GroupConfig,
  groupJid: string,
  latestUserText: string,
  replyText: string,
  reason: string,
): Promise<GeneratedImagePlan | null> {
  const responseText = await runPlanningPrompt(
    config,
    groupConfig,
    groupJid,
    [
      'You are preparing a companion image prompt for the bot reply.',
      `Reason for adding an image: ${reason}.`,
      'Return JSON only with the shape {"prompt":"...","mood":"...","style":"...","keySubjects":["..."],"mustAvoid":["..."],"textInImage":"none|minimal|allowed","literalness":"vibe|balanced|literal"}',
      'Write a single self-contained image prompt suitable for a modern text-to-image model.',
      'Keep the image prompt compact: ideally under 90 words.',
      'Reflect the same persona, joke, atmosphere, and subject matter as the reply.',
      'Default to literalness="balanced". Use literalness="vibe" when the image should mainly capture mood, tension, or the comedic setup rather than literal wording.',
      'Default to textInImage="none". Do not ask for readable text unless the conversation explicitly requested it.',
      'Prefer an image prompt in English unless the user explicitly asked for another language in the image.',
      'Avoid text overlays, posters, signs, labels, subtitles, chat bubbles, or screenshot-style layouts unless explicitly requested.',
      'The bot reply itself must remain plain text only, never markdown image syntax or image URLs.',
      'Do not include bracketed image descriptions such as [Imagem: ...], [Image: ...], or similar prompt annotations in the bot reply.',
      'If you cannot derive a good image, return {"prompt":""}.',
    ].join('\n'),
    [
      `Latest user message:\n${latestUserText}`,
      `Planned bot reply:\n${replyText}`,
      'Return the JSON now.',
    ].join('\n\n'),
    IMAGE_PLAN_MAX_TOKENS,
  );

  return parseImagePlanResponse(
    responseText,
    `Reply image planner for "${groupConfig.name ?? groupJid}"`,
    { literalness: 'balanced', textInImage: 'none' },
  );
}

export async function generateManualImagePost(
  config: AppConfig,
  groupConfig: GroupConfig,
  groupJid: string,
  prompt: string,
): Promise<{ caption: string; image: GeneratedImagePlan | null }> {
  const anthropic = getClient(config.global.anthropicApiKey);
  const systemPrompt = buildSystemPrompt(
    groupConfig,
    groupJid,
    [
      'You are creating a manual WhatsApp group post requested from the web interface.',
      'Return JSON only with the shape {"caption":"...","image":{"prompt":"...","mood":"...","style":"...","keySubjects":["..."],"mustAvoid":["..."],"textInImage":"none|minimal|allowed","literalness":"vibe|balanced|literal"}}',
      'Use the group persona, style, and recent context where relevant.',
      'The caption should read like a natural standalone group post from the bot, not an explanation of the prompt or admin request.',
      'The image plan should be a self-contained visual brief that reflects the caption and requested idea.',
      'Default to literalness="balanced". Use literalness="vibe" when mood matters more than exact details.',
      'Default to textInImage="none". Avoid readable text, signs, posters, headlines, subtitles, chat bubbles, UI, and typography unless the prompt explicitly asks for them.',
      'Do not add markdown image syntax, URLs, or explanatory notes.',
      'If no good image is appropriate, still provide a sensible image prompt that matches the caption.',
    ],
    { includeDynamicStyle: false },
  );

  const response = await Promise.race([
    anthropic.messages.create({
      model: config.global.claudeModel,
      max_tokens: Math.max(config.global.claudeMaxTokens, 1400),
      system: systemPrompt,
      messages: [
        ...toAnthropicMessages(groupJid),
        {
          role: 'user',
          content: [
            `Manual web image prompt:\n${prompt}`,
            'Return the JSON now.',
          ].join('\n\n'),
        },
      ],
    } as any),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Manual image post LLM request timed out after 2 minutes')), 120_000),
    ),
  ]);

  const responseText = extractTextResponse(response).trim();
  const parsed = parseJsonResponse<JsonScheduledPost>(responseText);
  const caption = parsed?.caption?.trim() || '';
  const image = parseImagePlan(parsed?.image, { literalness: 'balanced', textInImage: 'none' });
  if (!caption) {
    throw new Error(`Manual image post generation returned invalid JSON or empty caption: ${responseText.slice(0, 400)}`);
  }

  return { caption, image };
}

export async function generateManualVideoPost(
  config: AppConfig,
  groupConfig: GroupConfig,
  groupJid: string,
  prompt: string,
): Promise<{ caption: string; video: GeneratedVideoPlan | null }> {
  const anthropic = getClient(config.global.anthropicApiKey);
  const systemPrompt = buildSystemPrompt(
    groupConfig,
    groupJid,
    [
      'You are creating a manual WhatsApp group post with a generated video requested from the web interface.',
      'Return JSON only with the shape {"caption":"...","video":{"prompt":"...","aspectRatio":"9:16|16:9","durationSeconds":4|6|8,"resolution":"720p|1080p|4k"}}',
      'Use the group persona, style, and recent context where relevant.',
      'The caption should read like a natural standalone group post from the bot, not an explanation of the prompt or admin request.',
      'The video prompt should be a self-contained brief for Google Veo video generation.',
      'Include motion, action, camera movement, visual style, ambiance, and optional audio cues when useful.',
      'Default to aspectRatio="9:16", durationSeconds=8, and resolution="720p" for a more complete, cinematic clip.',
      'Do not include personGeneration in the JSON; the request layer handles people-generation policy.',
      'Use 720p unless the prompt explicitly asks for higher resolution.',
      'Use 8 seconds unless the prompt explicitly asks for a shorter clip.',
      'Avoid readable text, captions, subtitles, signs, UI, or title cards unless explicitly requested.',
      'When people are requested, describe generic adult performers or silhouettes unless the prompt includes a permitted reference image. Avoid exact likenesses of private people, celebrities, public figures, minors, or named real people.',
      'For person-heavy scenes, emphasize expressive motion, wardrobe, lighting, choreography, camera movement, and atmosphere rather than facial identity.',
      'Do not add markdown video syntax, URLs, or explanatory notes.',
      'If no good video is appropriate, return an empty video prompt.',
    ],
    { includeDynamicStyle: false },
  );

  const response = await Promise.race([
    anthropic.messages.create({
      model: config.global.claudeModel,
      max_tokens: Math.max(config.global.claudeMaxTokens, 1400),
      system: systemPrompt,
      messages: [
        ...toAnthropicMessages(groupJid),
        {
          role: 'user',
          content: [
            `Manual web video prompt:\n${prompt}`,
            'Return the JSON now.',
          ].join('\n\n'),
        },
      ],
    } as any),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Manual video post LLM request timed out after 2 minutes')), 120_000),
    ),
  ]);

  const responseText = extractTextResponse(response).trim();
  const parsed = parseJsonResponse<JsonManualVideoPost>(responseText);
  const caption = parsed?.caption?.trim() || '';
  const video = parseVideoPlan(parsed?.video);
  if (!caption) {
    throw new Error(`Manual video post generation returned invalid JSON or empty caption: ${responseText.slice(0, 400)}`);
  }

  return { caption, video };
}

export async function generateScheduledImagePost(
  config: AppConfig,
  groupConfig: GroupConfig,
  groupJid: string,
  job: ScheduledPostJobConfig,
  historyWindow: readonly ChatMessage[],
  latestNewsDigest?: LatestNewsDigest | null,
): Promise<{ caption: string; image: GeneratedImagePlan | null }> {
  const anthropic = getClient(config.global.anthropicApiKey);
  const systemPrompt = buildSystemPrompt(
    groupConfig,
    groupJid,
    [
      'You are generating a standalone scheduled WhatsApp group post.',
      'Return JSON only with the shape {"caption":"...","image":{"prompt":"...","mood":"...","style":"...","keySubjects":["..."],"mustAvoid":["..."],"textInImage":"none|minimal|allowed","literalness":"vibe|balanced|literal"}}',
      'The caption should read like a natural group post, not a direct reply.',
      'Write the caption fully in the bot persona and voice defined by the system prompt and group profile. Do not switch into neutral newsletter, analyst, or assistant tone.',
      'The image plan should be a self-contained visual brief that reflects the caption.',
      'For scheduled posts, prefer images that capture the vibe, atmosphere, and relationships of the caption rather than literalizing every sentence.',
      'For scheduled posts, default to literalness="vibe" unless the task prompt clearly demands a more exact depiction.',
      'For scheduled posts, default to textInImage="none". Avoid readable text, signs, posters, headlines, newspaper layouts, captions, subtitles, or UI unless the task explicitly asks for them.',
      'Use recent group discussion if relevant. If the group has little recent discussion, rely more on the scheduled task prompt.',
      'If a news digest summary is provided, treat it as external context you can weave into the post when relevant to the task prompt.',
      'If web search is enabled, use it only when it materially improves the post.',
      'Do not add markdown image syntax, URLs, or explanatory notes.',
      'If no good image is appropriate, still provide a sensible imagePrompt that matches the caption.',
    ],
    { includeDynamicStyle: false },
  );

  const params: Record<string, any> = {
    model: config.global.claudeModel,
    max_tokens: Math.max(config.global.claudeMaxTokens, 1400),
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: [
        `Scheduled task label: ${job.label ?? 'scheduled-post'}`,
        `Scheduled task prompt:\n${job.prompt}`,
        `Lookback window (hours): ${job.lookbackHours ?? 24}`,
        `Recent group discussion:\n${formatHistoryWindow(historyWindow)}`,
        latestNewsDigest
          ? [
              `Latest external news digest file: ${latestNewsDigest.path}`,
              `Latest external news digest time: ${new Date(latestNewsDigest.modifiedAt).toISOString()}`,
              `Latest external news digest summary:\n${latestNewsDigest.content}`,
            ].join('\n')
          : 'Latest external news digest summary:\n[none available]',
        'Return the JSON now.',
      ].join('\n\n'),
    }],
  };

  if (job.enableWebSearch) {
    params.tools = [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: job.maxSearches ?? 3,
    }];
  }

  const groupLabel = groupConfig.name ?? groupJid;
  console.log(
    `[llm] Scheduled post request for "${groupLabel}" / "${job.label ?? 'scheduled-post'}": ` +
    `webSearch=${job.enableWebSearch ?? false} historyMessages=${historyWindow.length} ` +
    `newsDigest=${latestNewsDigest ? latestNewsDigest.path : 'none'}`,
  );

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Scheduled post LLM request timed out after 2 minutes')), 120_000),
  );
  const response = await Promise.race([
    anthropic.messages.create(params as any),
    timeout,
  ]);

  const responseText = extractTextResponse(response).trim();
  const parsed = parseJsonResponse<JsonScheduledPost>(responseText);
  const caption = parsed?.caption?.trim() || '';
  const image = parseImagePlan(parsed?.image, { literalness: 'vibe', textInImage: 'none' });
  if (!caption) {
    throw new Error(`Scheduled post generation returned invalid JSON or empty caption: ${responseText.slice(0, 400)}`);
  }

  return {
    caption,
    image,
  };
}

export async function generateEventAnnouncementPost(
  config: AppConfig,
  groupConfig: GroupConfig,
  groupJid: string,
  eventName: string,
  templateMessage: string,
  eventsLabel: string,
): Promise<{ caption: string; image: GeneratedImagePlan | null }> {
  const anthropic = getClient(config.global.anthropicApiKey);
  const systemPrompt = buildSystemPrompt(
    groupConfig,
    groupJid,
    [
      'You are generating a standalone scheduled event announcement for a WhatsApp group.',
      'Return JSON only with the shape {"caption":"...","image":{"prompt":"...","mood":"...","style":"...","keySubjects":["..."],"mustAvoid":["..."],"textInImage":"none|minimal|allowed","literalness":"vibe|balanced|literal"}}',
      'The caption should read like a natural group post, not a direct reply.',
      'Write the caption fully in the bot persona and voice defined by the system prompt and group profile.',
      'Use the provided template message as the announcement intent, but rewrite it only as much as needed to fit the configured persona.',
      'Preserve the event name exactly in the caption.',
      'Keep the caption concise enough for WhatsApp.',
      'The image plan should be a self-contained visual brief for one fun companion image based primarily on the event name and the event type.',
      'Do not make the image a text poster. Prefer a visual scene, character, mascot, object, or atmosphere that fits the event and persona.',
      'Do not invent an identifiable likeness of a private person from just a name; if a person appears, make them generic or symbolic.',
      'Default to literalness="vibe" unless the event name clearly describes a concrete visual subject.',
      'Default to textInImage="none". Avoid readable text, signs, posters, headlines, newspaper layouts, captions, subtitles, chat bubbles, or UI.',
      'Do not add markdown image syntax, URLs, or explanatory notes.',
      'If no good image is appropriate, still provide a playful image prompt that matches the event name and caption.',
    ],
    { includeDynamicStyle: false },
  );

  const groupLabel = groupConfig.name ?? groupJid;
  console.log(`[llm] Event announcement request for "${groupLabel}" / "${eventsLabel}" / "${eventName}"`);

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Event announcement LLM request timed out after 2 minutes')), 120_000),
  );
  const response = await Promise.race([
    anthropic.messages.create({
      model: config.global.claudeModel,
      max_tokens: Math.max(config.global.claudeMaxTokens, 1000),
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          `Event label/type: ${eventsLabel}`,
          `Event name: ${eventName}`,
          `Configured template message:\n${templateMessage}`,
          'Return the JSON now.',
        ].join('\n\n'),
      }],
    } as any),
    timeout,
  ]);

  const responseText = extractTextResponse(response).trim();
  const parsed = parseJsonResponse<JsonEventAnnouncement>(responseText);
  const caption = parsed?.caption?.trim() || '';
  const image = parseImagePlan(parsed?.image, { literalness: 'vibe', textInImage: 'none' });
  if (!caption) {
    throw new Error(`Event announcement generation returned invalid JSON or empty caption: ${responseText.slice(0, 400)}`);
  }

  return {
    caption,
    image,
  };
}
