import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig, GroupConfig } from './config.js';
import { getRecentBotMessages, toAnthropicMessages } from './chat-history.js';
import { getProfilesPrompt } from './group-profiles.js';

let client: Anthropic | null = null;

type ResponseGenerationOptions = {
  expectsImage?: boolean;
};

type JsonImagePrompt = {
  prompt?: string;
};

type JsonImageDecision = {
  shouldGenerate?: boolean;
  prompt?: string;
};

type JsonReplyImagePrompt = {
  prompt?: string;
};

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
  const chatbot = groupConfig.chatbot!;
  const blocks = [chatbot.systemPrompt.trim(), getProfilesPrompt(groupJid).trim()];

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
): Promise<string> {
  const anthropic = getClient(config.global.anthropicApiKey);
  const messages = toAnthropicMessages(groupJid);

  if (messages.length === 0) {
    return "I don't have any context yet. How can I help you?";
  }

  const chatbot = groupConfig.chatbot!;
  const dynamicStyle = buildDynamicStyleInstruction(groupConfig);
  const systemPrompt = buildSystemPrompt(
    groupConfig,
    groupJid,
    options.expectsImage
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
      : [],
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
  console.log(`[llm]   system="${chatbot.systemPrompt.substring(0, 120)}${chatbot.systemPrompt.length > 120 ? '...' : ''}"`);
  console.log(`[llm]   messages=${messages.length}, thinking=${chatbot.enableThinking ?? false}${params.output_config ? ` (${JSON.stringify(params.output_config)})` : ''}, webSearch=${chatbot.enableWebSearch ?? false}${chatbot.enableWebSearch ? ` (max ${chatbot.maxSearches ?? 3})` : ''}`);
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

  const replyText = extractTextResponse(response).trim();
  if (replyText) {
    return replyText;
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
      return fallback;
    }
  } catch (err) {
    console.error(`[llm] Failed to generate persona fallback for "${groupLabel}":`, err);
  }

  return '...';
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
): Promise<string | null> {
  const responseText = await runPlanningPrompt(
    config,
    groupConfig,
    groupJid,
    [
      'You are preparing an image-generation prompt for a companion image.',
      'The user directly asked for an image.',
      'Return JSON only with the shape {"prompt":"..."}',
      'Write a single self-contained prompt suitable for a modern text-to-image model.',
      'Carry over the conversation context, the bot persona, and the tone of the reply.',
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

  const parsed = parseJsonResponse<JsonImagePrompt>(responseText);
  const prompt = parsed?.prompt?.trim();
  return prompt || null;
}

export async function decideImageForReply(
  config: AppConfig,
  groupConfig: GroupConfig,
  groupJid: string,
  latestUserText: string,
  replyText: string,
): Promise<{ shouldGenerate: boolean; prompt: string | null }> {
  const responseText = await runPlanningPrompt(
    config,
    groupConfig,
    groupJid,
    [
      'You are deciding whether the bot should attach an image with its next reply.',
      'Be conservative. Most replies should stay text-only.',
      'Only choose an image when it clearly adds humor, atmosphere, or clarity to the reply.',
      'Return JSON only with the shape {"shouldGenerate":true|false,"prompt":"..."}',
      'If shouldGenerate is false, leave prompt as an empty string.',
      'If shouldGenerate is true, write a self-contained image prompt that reflects the bot persona and the exact reply.',
      'Prefer an image prompt in English unless the user explicitly asked for another language in the image.',
      'Avoid text overlays unless the conversation explicitly calls for them.',
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
  const prompt = parsed?.prompt?.trim() || null;
  return {
    shouldGenerate: parsed?.shouldGenerate === true && !!prompt,
    prompt,
  };
}

export async function generateImagePromptForReply(
  config: AppConfig,
  groupConfig: GroupConfig,
  groupJid: string,
  latestUserText: string,
  replyText: string,
  reason: string,
): Promise<string | null> {
  const responseText = await runPlanningPrompt(
    config,
    groupConfig,
    groupJid,
    [
      'You are preparing a companion image prompt for the bot reply.',
      `Reason for adding an image: ${reason}.`,
      'Return JSON only with the shape {"prompt":"..."}',
      'Write a single self-contained image prompt suitable for a modern text-to-image model.',
      'Reflect the same persona, joke, atmosphere, and subject matter as the reply.',
      'Prefer an image prompt in English unless the user explicitly asked for another language in the image.',
      'Avoid text overlays unless the conversation explicitly asked for them.',
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

  const parsed = parseJsonResponse<JsonReplyImagePrompt>(responseText);
  const prompt = parsed?.prompt?.trim();
  return prompt || null;
}
