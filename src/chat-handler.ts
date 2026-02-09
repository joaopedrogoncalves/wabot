import { areJidsSameUser, downloadMediaMessage, type WASocket } from '@whiskeysockets/baileys';
import type { ConfigHolder } from './config.js';
import { addMessage, getNameToJidMap } from './chat-history.js';
import { generateResponse } from './llm.js';
import { getSocket, onConnectionReady, waitForConnection } from './whatsapp.js';

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

export function setupChatHandler(configHolder: ConfigHolder): void {
  onConnectionReady((sock: WASocket) => {
    const jids = configHolder.current.groups
      .filter((g) => g.chatbot)
      .map((g) => g.jid);
    console.log(`Chat handler registered for groups: ${jids.join(', ')}`);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      console.log(`[chat] messages.upsert: type=${type}, count=${messages.length}`);

      if (type !== 'notify') return;

      for (const msg of messages) {
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) continue;

        const rawSender = msg.pushName ?? msg.key.participant ?? msg.key.remoteJid ?? '?';
        const rawText = extractText(msg);
        console.log(`[chat] MSG from=${rawSender} jid=${remoteJid} participant=${msg.key.participant ?? 'N/A'} text=${rawText ? `"${rawText.slice(0, 80)}"` : '(no text)'}`);

        const config = configHolder.current;
        const groupConfig = config.groups.find((g) => g.jid === remoteJid && g.chatbot);
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
          await sock.sendPresenceUpdate('composing', remoteJid);

          const response = await generateResponse(configHolder.current, groupConfig, remoteJid);

          // Resolve @Name or @number mentions in the response to JIDs
          const nameToJid = getNameToJidMap(remoteJid);
          // Also build a number→jid map (e.g. "80033108471912" → "80033108471912:1@lid")
          const numberToJid = new Map<string, string>();
          for (const jid of nameToJid.values()) {
            const num = jid.replace(/[:@].+$/, '');
            numberToJid.set(num, jid);
          }

          const mentions: string[] = [];
          const mentionRegex = /@([\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} ]*[\p{L}\p{M}\p{N}]|[\p{L}\p{M}\p{N}]+)/gu;
          let responseText = response;
          // Process matches in reverse order so replacements don't shift indices
          const matches = [...response.matchAll(mentionRegex)].reverse();
          for (const match of matches) {
            const captured = match[1];
            // Try name lookup first, then number lookup
            const jid = nameToJid.get(captured.toLowerCase()) ?? numberToJid.get(captured);
            if (jid && !mentions.includes(jid)) {
              mentions.push(jid);
            }
            if (jid) {
              // Replace @Name with @number for WhatsApp to render the mention
              const num = jid.replace(/[:@].+$/, '');
              responseText = responseText.slice(0, match.index!) + '@' + num + responseText.slice(match.index! + match[0].length);
            }
          }
          if (mentions.length > 0) {
            console.log(`[chat] Resolved ${mentions.length} mention(s): ${mentions.join(', ')}`);
          }

          // Use the current socket (may have reconnected during LLM call)
          await waitForConnection();
          const currentSock = getSocket();
          await currentSock.sendPresenceUpdate('paused', remoteJid);
          await currentSock.sendMessage(remoteJid, { text: responseText, mentions }, { quoted: msg });

          addMessage(remoteJid, {
            senderName: groupConfig.chatbot!.botName,
            senderJid: currentSock.user?.id ?? botJid ?? '',
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
