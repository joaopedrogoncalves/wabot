import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig, GroupConfig, ScheduledPostJobConfig } from './config.js';
import type { ChatMessage } from './chat-history.js';
import { getRecentBotMessages, toAnthropicMessages } from './chat-history.js';
import { getProfilesPrompt } from './group-profiles.js';
import type { LatestNewsDigest } from './news.js';

let client: Anthropic | null = null;

type ResponseGenerationOptions = {
  expectsImage?: boolean;
  latestUserText?: string;
  triggerSenderName?: string;
};

export type GeneratedReply = {
  text: string;
  reactionEmoji?: string;
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

type JsonImageDecision = {
  shouldGenerate?: boolean;
  image?: GeneratedImagePlan;
};

type JsonScheduledPost = {
  caption?: string;
  image?: GeneratedImagePlan;
};

const REACTION_TRAILER_RE = /\n?\s*\[\[reaction:([^\]\r\n]{0,32})\]\]\s*$/u;
const MAX_RECENT_REACTION_EMOJIS = 8;
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

export async function generateResponse(
  config: AppConfig,
  groupConfig: GroupConfig,
  groupJid: string,
  options: ResponseGenerationOptions = {},
): Promise<GeneratedReply> {
  const anthropic = getClient(config.global.anthropicApiKey);
  const historyMessages = toAnthropicMessages(groupJid);
  const latestUserText = options.latestUserText?.trim();
  const triggerSenderName = options.triggerSenderName?.trim() || 'User';
  const messages = latestUserText
    ? [
        ...historyMessages,
        {
          role: 'user' as const,
          content: [
            `Respond now to this specific message from [${triggerSenderName}].`,
            `Target message:\n[${triggerSenderName}]: ${latestUserText}`,
            'Use the full conversation above as context, including any newer assistant replies, but make this target message the one you answer now.',
          ].join('\n\n'),
        },
      ]
    : historyMessages;

  if (messages.length === 0) {
    return { text: "I don't have any context yet. How can I help you?" };
  }

  const chatbot = groupConfig.chatbot!;
  const dynamicStyle = buildDynamicStyleInstruction(groupConfig);
  const promptBlocks = (options.expectsImage
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
    : []
  ).concat([
    [
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
  const systemPrompt = buildSystemPrompt(
    groupConfig,
    groupJid,
    promptBlocks,
    { dynamicStyleInstruction: dynamicStyle.instruction },
  );

  const params: Record<string, any> = {
    model: config.global.claudeModel,
    max_tokens: config.global.claudeMaxTokens,
    system: systemPrompt,
    messages,
  };

  if (chatbot.enableThinking) {
    const budget = chatbot.thinkingBudget ?? 2000;
    if (isClaude46Model(config.global.claudeModel)) {
      params.thinking = { type: 'adaptive' };
      params.output_config = {
        effort: getAdaptiveThinkingEffort(chatbot.thinkingBudget),
      };
    } else {
      params.thinking = { type: 'enabled', budget_tokens: budget };
      // max_tokens must cover both thinking and text output
      params.max_tokens = config.global.claudeMaxTokens + budget;
    }
  }

  if (chatbot.enableWebSearch) {
    params.tools = [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: chatbot.maxSearches ?? 3,
    }];
  }

  const groupLabel = groupConfig.name ?? groupJid;
  console.log(`[llm] Request for "${groupLabel}":`);
  console.log(`[llm]   model=${params.model}, max_tokens=${params.max_tokens}`);
  console.log(`[llm]   hotness=${chatbot.hotness ?? 35}, sampledTone=${dynamicStyle.band} (${dynamicStyle.intensity.toFixed(2)})`);
  const systemPreview = getGroupSystemPrompt(groupConfig);
  console.log(`[llm]   system="${systemPreview.substring(0, 120)}${systemPreview.length > 120 ? '...' : ''}"`);
  console.log(`[llm]   messages=${messages.length}, syntheticFinalUser=${latestUserText ? 'yes' : 'no'}, thinking=${chatbot.enableThinking ?? false}${params.output_config ? ` (${JSON.stringify(params.output_config)})` : ''}, webSearch=${chatbot.enableWebSearch ?? false}${chatbot.enableWebSearch ? ` (max ${chatbot.maxSearches ?? 3})` : ''}`);
  if (params.tools) {
    console.log(`[llm]   tools=${JSON.stringify(params.tools)}`);
  }

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('LLM request timed out after 2 minutes')), 120_000)
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

  try {
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
    220,
  );

  return parseImagePlanResponse(
    responseText,
    `Direct image planner for "${groupConfig.name ?? groupJid}"`,
    { literalness: 'balanced', textInImage: 'none' },
  );
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
    220,
  );

  const parsed = parseJsonResponse<JsonImageDecision>(responseText);
  const image = parsed?.image
    ? parseImagePlan(parsed.image, { literalness: 'balanced', textInImage: 'none' })
    : null;
  if (!image && parsed?.shouldGenerate === true) {
    console.warn(`[llm] Auto image decision for "${groupConfig.name ?? groupJid}" requested an image but returned no usable plan.`);
    console.warn(`[llm] Auto image decision raw response preview: ${responseText.slice(0, 500)}`);
  }
  return {
    shouldGenerate: parsed?.shouldGenerate === true && !!image,
    image,
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
    220,
  );

  return parseImagePlanResponse(
    responseText,
    `Reply image planner for "${groupConfig.name ?? groupJid}"`,
    { literalness: 'balanced', textInImage: 'none' },
  );
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
