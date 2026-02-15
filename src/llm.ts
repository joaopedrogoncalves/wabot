import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig, GroupConfig } from './config.js';
import { toAnthropicMessages } from './chat-history.js';
import { getProfilesPrompt } from './group-profiles.js';

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
  const profileContext = getProfilesPrompt(groupJid);
  const systemPrompt = chatbot.systemPrompt + profileContext;

  const params: Record<string, any> = {
    model: config.global.claudeModel,
    max_tokens: config.global.claudeMaxTokens,
    system: systemPrompt,
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

  const groupLabel = groupConfig.name ?? groupJid;
  console.log(`[llm] Request for "${groupLabel}":`);
  console.log(`[llm]   model=${params.model}, max_tokens=${params.max_tokens}`);
  console.log(`[llm]   system="${chatbot.systemPrompt.substring(0, 120)}${chatbot.systemPrompt.length > 120 ? '...' : ''}"`);
  console.log(`[llm]   messages=${messages.length}, thinking=${chatbot.enableThinking ?? false}, webSearch=${chatbot.enableWebSearch ?? false}${chatbot.enableWebSearch ? ` (max ${chatbot.maxSearches ?? 3})` : ''}`);
  if (params.tools) {
    console.log(`[llm]   tools=${JSON.stringify(params.tools)}`);
  }

  const response = await anthropic.messages.create(params as any);

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

  // Extract all text blocks from the response (skipping thinking/tool blocks)
  const textParts: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    }
  }

  return textParts.join('') || 'Sorry, I could not generate a response.';
}
