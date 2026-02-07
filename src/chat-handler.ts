import { areJidsSameUser, type WASocket } from '@whiskeysockets/baileys';
import type { ChatConfig } from './config.js';
import { addMessage } from './chat-history.js';
import { generateResponse } from './llm.js';
import { onConnectionReady } from './whatsapp.js';

function extractText(msg: { message?: Record<string, any> | null }): string | null {
  const m = msg.message;
  if (!m) return null;
  return (m.conversation as string) ?? (m.extendedTextMessage?.text as string) ?? null;
}

function extractMentionedJids(msg: { message?: Record<string, any> | null }): string[] {
  const m = msg.message;
  if (!m) return [];
  const ctx = m.extendedTextMessage?.contextInfo;
  return ctx?.mentionedJid ?? [];
}

export function setupChatHandler(chatConfig: ChatConfig): void {
  const chatGroupSet = new Set(chatConfig.chatGroupJids);

  onConnectionReady((sock: WASocket) => {
    console.log(`Chat handler registered for groups: ${chatConfig.chatGroupJids.join(', ')}`);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      console.log(`[chat] messages.upsert: type=${type}, count=${messages.length}`);

      if (type !== 'notify') return;

      for (const msg of messages) {
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || !chatGroupSet.has(remoteJid)) continue;

        const text = extractText(msg);
        console.log(`[chat] extractedText=${text ? `"${text}"` : 'null'}, messageKeys=${Object.keys(msg.message ?? {}).join(', ')}`);
        if (!text) continue;

        const senderJid = msg.key.participant ?? msg.key.remoteJid ?? '';
        const senderName = msg.pushName ?? senderJid;
        const botJid = sock.user?.id;
        console.log(`[chat] sender=${senderName} (${senderJid}), botJid=${botJid}`);
        const fromBot = !!botJid && areJidsSameUser(senderJid, botJid);

        // Record every message in history
        addMessage(remoteJid, { senderName, senderJid, text, fromBot });

        // Skip trigger check for bot's own messages
        if (fromBot) continue;

        // Check triggers: @mention or keyword prefix
        const mentionedJids = extractMentionedJids(msg);
        const botLid = sock.user?.lid;
        console.log(`[chat] mentionedJids=${JSON.stringify(mentionedJids)}, botJid=${botJid}, botLid=${botLid}`);
        const mentionTriggered = mentionedJids.some((jid) =>
          (botJid && areJidsSameUser(jid, botJid)) ||
          (botLid && areJidsSameUser(jid, botLid))
        );
        const prefixTriggered = text
          .toLowerCase()
          .startsWith(chatConfig.botName.toLowerCase());

        if (!mentionTriggered && !prefixTriggered) continue;

        console.log(`Chat triggered by ${senderName}: ${text}`);

        try {
          const response = await generateResponse(chatConfig, remoteJid);

          await sock.sendMessage(remoteJid, { text: response });

          addMessage(remoteJid, {
            senderName: chatConfig.botName,
            senderJid: botJid ?? '',
            text: response,
            fromBot: true,
          });
        } catch (err) {
          console.error('Failed to generate/send chat response:', err);
        }
      }
    });
  });
}
