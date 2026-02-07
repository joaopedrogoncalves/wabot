import { areJidsSameUser, downloadMediaMessage, type WASocket } from '@whiskeysockets/baileys';
import type { AppConfig, GroupConfig } from './config.js';
import { addMessage } from './chat-history.js';
import { generateResponse } from './llm.js';
import { onConnectionReady } from './whatsapp.js';

function extractText(msg: { message?: Record<string, any> | null }): string | null {
  const m = msg.message;
  if (!m) return null;
  return (
    (m.conversation as string) ??
    (m.extendedTextMessage?.text as string) ??
    (m.imageMessage?.caption as string) ??
    (m.videoMessage?.caption as string) ??
    null
  );
}

async function extractImage(
  msg: any,
): Promise<{ data: string; mimeType: string } | null> {
  const imageMessage = msg.message?.imageMessage;
  if (!imageMessage) return null;
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    return {
      data: (buffer as Buffer).toString('base64'),
      mimeType: imageMessage.mimetype ?? 'image/jpeg',
    };
  } catch (err) {
    console.error('Failed to download image:', err);
    return null;
  }
}

function extractMentionedJids(msg: { message?: Record<string, any> | null }): string[] {
  const m = msg.message;
  if (!m) return [];
  const ctx =
    m.extendedTextMessage?.contextInfo ??
    m.imageMessage?.contextInfo ??
    m.videoMessage?.contextInfo;
  return ctx?.mentionedJid ?? [];
}

export function setupChatHandler(config: AppConfig): void {
  const chatGroups = new Map<string, GroupConfig>();
  for (const group of config.groups) {
    if (group.chatbot) {
      chatGroups.set(group.jid, group);
    }
  }

  onConnectionReady((sock: WASocket) => {
    const jids = [...chatGroups.keys()];
    console.log(`Chat handler registered for groups: ${jids.join(', ')}`);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      console.log(`[chat] messages.upsert: type=${type}, count=${messages.length}`);

      if (type !== 'notify') return;

      for (const msg of messages) {
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) continue;

        const groupConfig = chatGroups.get(remoteJid);
        if (!groupConfig) continue;

        const image = await extractImage(msg);
        const text = extractText(msg);
        console.log(`[chat] extractedText=${text ? `"${text}"` : 'null'}, hasImage=${!!image}, messageKeys=${Object.keys(msg.message ?? {}).join(', ')}`);
        if (!text && !image) continue;

        const senderJid = msg.key.participant ?? msg.key.remoteJid ?? '';
        const senderName = msg.pushName ?? senderJid;
        const botJid = sock.user?.id;
        console.log(`[chat] sender=${senderName} (${senderJid}), botJid=${botJid}`);
        const fromBot = !!botJid && areJidsSameUser(senderJid, botJid);

        // Record every message in history (including image-only messages)
        addMessage(remoteJid, {
          senderName,
          senderJid,
          text: text ?? '',
          fromBot,
          ...(image && { imageData: image.data, imageMimeType: image.mimeType }),
        });

        // Skip trigger check for bot's own messages
        if (fromBot) continue;

        // Image-only messages (no text) are recorded but don't trigger a response
        if (!text) continue;

        // Check triggers: @mention, keyword prefix, or reply to bot message
        const mentionedJids = extractMentionedJids(msg);
        const botLid = sock.user?.lid;
        console.log(`[chat] mentionedJids=${JSON.stringify(mentionedJids)}, botJid=${botJid}, botLid=${botLid}`);
        const mentionTriggered = mentionedJids.some((jid) =>
          (botJid && areJidsSameUser(jid, botJid)) ||
          (botLid && areJidsSameUser(jid, botLid))
        );
        const prefixTriggered = text
          .toLowerCase()
          .startsWith(groupConfig.chatbot!.botName.toLowerCase());

        const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant
          ?? msg.message?.imageMessage?.contextInfo?.participant
          ?? msg.message?.videoMessage?.contextInfo?.participant;
        const replyTriggered = !!quotedParticipant && (
          (!!botJid && areJidsSameUser(quotedParticipant, botJid)) ||
          (!!botLid && areJidsSameUser(quotedParticipant, botLid))
        );

        if (!mentionTriggered && !prefixTriggered && !replyTriggered) continue;

        console.log(`Chat triggered by ${senderName}: ${text}`);

        try {
          const response = await generateResponse(config, groupConfig, remoteJid);

          await sock.sendMessage(remoteJid, { text: response }, { quoted: msg });

          addMessage(remoteJid, {
            senderName: groupConfig.chatbot!.botName,
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
