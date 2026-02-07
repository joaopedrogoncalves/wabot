import Anthropic from '@anthropic-ai/sdk';
import type { ChatConfig } from './config.js';
import { toAnthropicMessages } from './chat-history.js';

let client: Anthropic | null = null;

function getClient(apiKey: string): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey });
  }
  return client;
}

export async function generateResponse(chatConfig: ChatConfig, groupJid: string): Promise<string> {
  const anthropic = getClient(chatConfig.anthropicApiKey);
  const messages = toAnthropicMessages(groupJid);

  if (messages.length === 0) {
    return "I don't have any context yet. How can I help you?";
  }

  const response = await anthropic.messages.create({
    model: chatConfig.claudeModel,
    max_tokens: chatConfig.claudeMaxTokens,
    system: chatConfig.systemPrompt,
    messages,
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock ? textBlock.text : 'Sorry, I could not generate a response.';
}
