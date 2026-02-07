import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';

export interface ChatMessage {
  senderName: string;
  senderJid: string;
  text: string;
  fromBot: boolean;
}

const MAX_HISTORY = 50;
const historyByGroup = new Map<string, ChatMessage[]>();

function getOrCreateGroup(groupJid: string): ChatMessage[] {
  let msgs = historyByGroup.get(groupJid);
  if (!msgs) {
    msgs = [];
    historyByGroup.set(groupJid, msgs);
  }
  return msgs;
}

export function addMessage(groupJid: string, msg: ChatMessage): void {
  const messages = getOrCreateGroup(groupJid);
  messages.push(msg);
  if (messages.length > MAX_HISTORY) {
    messages.splice(0, messages.length - MAX_HISTORY);
  }
}

export function getHistory(groupJid: string): readonly ChatMessage[] {
  return historyByGroup.get(groupJid) ?? [];
}

export function clearHistory(groupJid: string): void {
  historyByGroup.delete(groupJid);
}

/**
 * Converts the chat history for a group into Anthropic's alternating user/assistant format.
 * Consecutive messages with the same role are grouped together with sender prefixes.
 */
export function toAnthropicMessages(groupJid: string): MessageParam[] {
  const messages = historyByGroup.get(groupJid) ?? [];
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
