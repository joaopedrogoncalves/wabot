import type { MessageParam, ImageBlockParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js';

export type GooglePart = {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
};

export type GoogleContent = {
  role: 'user' | 'model';
  parts: GooglePart[];
};

export interface ChatMessage {
  senderName: string;
  senderJid: string;
  text: string;
  fromBot: boolean;
  imageData?: string;
  imageMimeType?: string;
  timestamp?: number;
  messageId?: string;
}

const DEFAULT_MAX_HISTORY = 400;
const configuredMaxHistory = Number(process.env['CHAT_HISTORY_MAX'] ?? DEFAULT_MAX_HISTORY);
const MAX_HISTORY = Number.isFinite(configuredMaxHistory) && configuredMaxHistory > 0
  ? Math.floor(configuredMaxHistory)
  : DEFAULT_MAX_HISTORY;
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
  if (msg.timestamp == null) msg.timestamp = Date.now();
  messages.push(msg);
  if (messages.length > MAX_HISTORY) {
    messages.splice(0, messages.length - MAX_HISTORY);
  }
}

export function getHistory(groupJid: string): readonly ChatMessage[] {
  return historyByGroup.get(groupJid) ?? [];
}

export function getHistorySince(
  groupJid: string,
  since: number,
  limit?: number,
): readonly ChatMessage[] {
  const messages = (historyByGroup.get(groupJid) ?? []).filter((msg) => (msg.timestamp ?? 0) >= since);
  if (limit == null || limit <= 0 || messages.length <= limit) {
    return messages;
  }
  return messages.slice(-limit);
}

export function getRecentBotMessages(groupJid: string, limit = 8): readonly ChatMessage[] {
  if (limit <= 0) return [];
  const messages = historyByGroup.get(groupJid) ?? [];
  const botMessages = messages.filter((msg) => msg.fromBot);
  return botMessages.slice(-limit);
}

export function clearHistory(groupJid: string): void {
  historyByGroup.delete(groupJid);
}

/**
 * Returns a map of lowercase sender name → senderJid for a group,
 * using the most recent JID seen for each name.
 */
export function getNameToJidMap(groupJid: string): Map<string, string> {
  const messages = historyByGroup.get(groupJid) ?? [];
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (!msg.fromBot && msg.senderName && msg.senderJid) {
      map.set(msg.senderName.toLowerCase(), msg.senderJid);
    }
  }
  return map;
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
    const textContent = msg.fromBot ? msg.text : `[${msg.senderName}]: ${msg.text}`;

    const hasImage = !msg.fromBot && msg.imageData && msg.imageMimeType;

    if (hasImage) {
      const blocks: ContentBlockParam[] = [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: msg.imageMimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: msg.imageData!,
          },
        } satisfies ImageBlockParam,
      ];
      if (msg.text) {
        blocks.push({ type: 'text', text: textContent });
      }

      const last = result[result.length - 1];
      if (last && last.role === role) {
        // Merge: convert existing content to array form if needed, then append
        const existing = typeof last.content === 'string'
          ? [{ type: 'text' as const, text: last.content }]
          : (last.content as ContentBlockParam[]);
        last.content = [...existing, ...blocks];
      } else {
        result.push({ role, content: blocks });
      }
    } else {
      const last = result[result.length - 1];
      if (last && last.role === role) {
        // Merge consecutive same-role text messages
        if (typeof last.content === 'string') {
          last.content = last.content + '\n' + textContent;
        } else {
          (last.content as ContentBlockParam[]).push({ type: 'text', text: textContent });
        }
      } else {
        result.push({ role, content: textContent });
      }
    }
  }

  return result;
}

export function toGoogleContents(groupJid: string): GoogleContent[] {
  const messages = historyByGroup.get(groupJid) ?? [];
  const result: GoogleContent[] = [];

  for (const msg of messages) {
    const role: 'user' | 'model' = msg.fromBot ? 'model' : 'user';
    const textContent = msg.fromBot ? msg.text : `[${msg.senderName}]: ${msg.text}`;
    const parts: GooglePart[] = [];

    if (!msg.fromBot && msg.imageData && msg.imageMimeType) {
      parts.push({
        inlineData: {
          mimeType: msg.imageMimeType,
          data: msg.imageData,
        },
      });
    }

    if (msg.text) {
      parts.push({ text: textContent });
    } else if (parts.length === 0) {
      parts.push({ text: textContent });
    }

    const last = result[result.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      result.push({ role, parts });
    }
  }

  return result;
}

export function findMessageById(groupJid: string, messageId: string): ChatMessage | undefined {
  const messages = historyByGroup.get(groupJid) ?? [];
  return messages.find((m) => m.messageId === messageId);
}

export function updateMessageText(groupJid: string, messageId: string, newText: string): void {
  const messages = historyByGroup.get(groupJid);
  if (!messages) return;
  const msg = messages.find((m) => m.messageId === messageId);
  if (msg) msg.text = newText;
}

export function getMessageCountSince(groupJid: string, since: number): number {
  const messages = historyByGroup.get(groupJid) ?? [];
  return messages.filter((m) => (m.timestamp ?? 0) > since).length;
}
