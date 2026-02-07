import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';

export interface ChatMessage {
  senderName: string;
  senderJid: string;
  text: string;
  fromBot: boolean;
}

const MAX_HISTORY = 50;
const messages: ChatMessage[] = [];

export function addMessage(msg: ChatMessage): void {
  messages.push(msg);
  if (messages.length > MAX_HISTORY) {
    messages.splice(0, messages.length - MAX_HISTORY);
  }
}

export function getHistory(): readonly ChatMessage[] {
  return messages;
}

export function clearHistory(): void {
  messages.length = 0;
}

/**
 * Converts the chat history into Anthropic's alternating user/assistant format.
 * Consecutive messages with the same role are grouped together with sender prefixes.
 */
export function toAnthropicMessages(): MessageParam[] {
  const result: MessageParam[] = [];

  for (const msg of messages) {
    const role: 'user' | 'assistant' = msg.fromBot ? 'assistant' : 'user';
    const content = msg.fromBot ? msg.text : `[${msg.senderName}]: ${msg.text}`;

    const last = result[result.length - 1];
    if (last && last.role === role) {
      // Merge consecutive same-role messages
      last.content = (last.content as string) + '\n' + content;
    } else {
      result.push({ role, content });
    }
  }

  return result;
}
