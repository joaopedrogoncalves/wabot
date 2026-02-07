import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig, GroupConfig } from './config.js';
import { toAnthropicMessages } from './chat-history.js';

let client: Anthropic | null = null;

function getClient(apiKey: string): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey });
  }
  return client;
}

export async function generateResponse(config: AppConfig, groupConfig: GroupConfig, groupJid: string): Promise<string> {
  const anthropic = getClient(config.global.anthropicApiKey);
  const messages = toAnthropicMessages(groupJid);

  if (messages.length === 0) {
    return "I don't have any context yet. How can I help you?";
  }

  const chatbot = groupConfig.chatbot!;

  const params: Record<string, any> = {
    model: config.global.claudeModel,
    max_tokens: config.global.claudeMaxTokens,
    system: chatbot.systemPrompt,
    messages,
  };

  if (chatbot.enableThinking) {
    const budget = chatbot.thinkingBudget ?? 2000;
    params.thinking = { type: 'enabled', budget_tokens: budget };
    // max_tokens must cover both thinking and text output
    params.max_tokens = config.global.claudeMaxTokens + budget;
  }

  if (chatbot.enableWebSearch) {
    params.tools = [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: chatbot.maxSearches ?? 3,
    }];
  }

  const response = await anthropic.messages.create(params as any);

  // Extract all text blocks from the response (skipping thinking/tool blocks)
  const textParts: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    }
  }

  return textParts.join('') || 'Sorry, I could not generate a response.';
}
