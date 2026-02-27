import { areJidsSameUser, downloadMediaMessage, type WASocket } from '@whiskeysockets/baileys';
import type { ConfigHolder } from './config.js';
import { addMessage, findMessageById, getNameToJidMap, updateMessageText } from './chat-history.js';
import { generateResponse } from './llm.js';
import { maybeRefreshProfiles } from './group-profiles.js';
import { enrichTextWithTweets } from './twitter.js';
import { getSocket, onConnectionReady, reportTraffic, waitForConnectionWithTimeout } from './whatsapp.js';

const GREETING_PREFIXES = [
  'hey',
  'hi',
  'hello',
  'yo',
  'oi',
  'ola',
  'olá',
];

function parseBotAliases(botName: string): string[] {
  const aliases = botName
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return aliases.length > 0 ? aliases : [botName.trim()].filter(Boolean);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPrefixTrigger(text: string, aliases: string[]): boolean {
  if (aliases.length === 0) return false;
  const aliasPattern = aliases.map((a) => escapeRegex(a)).join('|');
  const greetingPattern = GREETING_PREFIXES.map((g) => escapeRegex(g)).join('|');
  const re = new RegExp(
    `^\\s*(?:(?:${greetingPattern})[\\s,!.?:;_-]+)?(?:@)?(?:${aliasPattern})(?=$|[\\s,!.?:;_-])`,
    'iu',
  );
  return re.test(text);
}

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

const MAX_TRIGGERED_IDS = 200;
const triggeredMessageIds = new Set<string>();

function trackTriggered(id: string): void {
  triggeredMessageIds.add(id);
  if (triggeredMessageIds.size > MAX_TRIGGERED_IDS) {
    const first = triggeredMessageIds.values().next().value!;
    triggeredMessageIds.delete(first);
  }
}

const groupLocks = new Map<string, Promise<void>>();

function withGroupLock<T>(groupJid: string, fn: () => Promise<T>): Promise<T> {
  const prev = groupLocks.get(groupJid) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  groupLocks.set(groupJid, next.then(() => {}, () => {}));
  return next;
}

export function setupChatHandler(configHolder: ConfigHolder): void {
  onConnectionReady((sock: WASocket) => {
    const jids = configHolder.current.groups
      .filter((g) => g.chatbot && g.chatbot.enabled !== false)
      .map((g) => g.jid);
    console.log(`Chat handler registered for groups: ${jids.join(', ')}`);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      console.log(`[chat] messages.upsert: type=${type}, count=${messages.length}`);
      reportTraffic();

      if (type !== 'notify') return;

      for (const msg of messages) {
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) continue;

        const rawSender = msg.pushName ?? msg.key.participant ?? msg.key.remoteJid ?? '?';
        const rawText = extractText(msg);
        console.log(`[chat] MSG from=${rawSender} jid=${remoteJid} participant=${msg.key.participant ?? 'N/A'} text=${rawText ? `"${rawText.slice(0, 80)}"` : '(no text)'}`);

        const config = configHolder.current;
        const groupConfig = config.groups.find((g) => g.jid === remoteJid && g.chatbot && g.chatbot.enabled !== false);
        if (!groupConfig) continue;
        const botAliases = parseBotAliases(groupConfig.chatbot!.botName);
        const primaryBotName = botAliases[0] ?? groupConfig.chatbot!.botName;

        // Handle emoji reactions
        const reaction = msg.message?.reactionMessage;
        if (reaction) {
          const emoji = reaction.text;
          if (!emoji) continue; // reaction removed
          const reactorJid = msg.key.participant ?? msg.key.remoteJid ?? '';
          const reactorName = msg.pushName ?? reactorJid;
          const targetId = reaction.key?.id;
          const targetMsg = targetId ? findMessageById(remoteJid, targetId) : undefined;
          const targetLabel = targetMsg
            ? (targetMsg.fromBot ? 'the bot\'s message' : `${targetMsg.senderName}'s message`)
              + (targetMsg.text ? `: "${targetMsg.text.slice(0, 60)}"` : '')
            : 'a message';
          const botJid = sock.user?.id;
          const fromBot = !!botJid && areJidsSameUser(reactorJid, botJid);
          addMessage(remoteJid, {
            senderName: reactorName,
            senderJid: reactorJid,
            text: `[reacted ${emoji} to ${targetLabel}]`,
            fromBot,
          });
          console.log(`[chat] Reaction ${emoji} from ${reactorName} to ${targetLabel}`);
          continue;
        }

        const image = await extractImage(msg);
        const text = extractText(msg);
        console.log(`[chat] extractedText=${text ? `"${text}"` : 'null'}, hasImage=${!!image}, messageKeys=${Object.keys(msg.message ?? {}).join(', ')}`);
        if (!text && !image) continue;
        const enrichedText = text ? await enrichTextWithTweets(text, config.global) : null;

        const senderJid = msg.key.participant ?? msg.key.remoteJid ?? '';
        const senderName = msg.pushName ?? senderJid;
        const botJid = sock.user?.id;
        console.log(`[chat] sender=${senderName} (${senderJid}), botJid=${botJid}`);
        const fromBot = !!botJid && areJidsSameUser(senderJid, botJid);

        // Record every message in history (including image-only messages)
        addMessage(remoteJid, {
          senderName,
          senderJid,
          text: enrichedText ?? '',
          fromBot,
          messageId: msg.key.id ?? undefined,
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
        const prefixTriggered = isPrefixTrigger(text, botAliases);

        const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant
          ?? msg.message?.imageMessage?.contextInfo?.participant
          ?? msg.message?.videoMessage?.contextInfo?.participant;
        const replyTriggered = !!quotedParticipant && (
          (!!botJid && areJidsSameUser(quotedParticipant, botJid)) ||
          (!!botLid && areJidsSameUser(quotedParticipant, botLid))
        );

        if (!mentionTriggered && !prefixTriggered && !replyTriggered) continue;

        if (msg.key.id) trackTriggered(msg.key.id);
        console.log(`Chat triggered by ${senderName}: ${text}`);

        withGroupLock(remoteJid, async () => {
          try {
            // Get fresh socket (may have reconnected since trigger)
            const currentSock = getSocket();
            await currentSock.sendPresenceUpdate('composing', remoteJid);

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

            // Re-fetch socket in case of reconnect during LLM call
            await waitForConnectionWithTimeout(30_000);
            const sendSock = getSocket();
            await sendSock.sendPresenceUpdate('paused', remoteJid);
            const sent = await sendSock.sendMessage(remoteJid, { text: responseText, mentions }, { quoted: msg });

            addMessage(remoteJid, {
              senderName: primaryBotName,
              senderJid: sendSock.user?.id ?? botJid ?? '',
              text: response,
              fromBot: true,
              messageId: sent?.key?.id ?? undefined,
            });

            maybeRefreshProfiles(configHolder.current, remoteJid);
          } catch (err) {
            console.error('Failed to generate/send chat response:', err);
          }
        });

      }
    });

    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        const remoteJid = update.key.remoteJid;
        if (!remoteJid) continue;

        const config = configHolder.current;
        const groupConfig = config.groups.find((g) => g.jid === remoteJid && g.chatbot && g.chatbot.enabled !== false);
        if (!groupConfig) continue;
        const botAliases = parseBotAliases(groupConfig.chatbot!.botName);
        const primaryBotName = botAliases[0] ?? groupConfig.chatbot!.botName;

        const editedMessage = (update.update as any)?.message?.editedMessage?.message;
        if (!editedMessage) continue;

        const text = extractText({ message: editedMessage });
        if (!text) continue;
        const enrichedText = await enrichTextWithTweets(text, config.global);

        const messageId = update.key.id;
        if (messageId && triggeredMessageIds.has(messageId)) {
          console.log(`[chat] Edit ignored — message ${messageId} already triggered`);
          continue;
        }

        // Update chat history with edited text
        if (messageId) updateMessageText(remoteJid, messageId, enrichedText);

        // Check triggers: prefix or @mention (no reply check for edits)
        const mentionedJids = extractMentionedJids({ message: editedMessage });
        const botJid = sock.user?.id;
        const botLid = sock.user?.lid;
        const mentionTriggered = mentionedJids.some((jid) =>
          (botJid && areJidsSameUser(jid, botJid)) ||
          (botLid && areJidsSameUser(jid, botLid))
        );
        const prefixTriggered = isPrefixTrigger(text, botAliases);

        if (!mentionTriggered && !prefixTriggered) continue;

        if (messageId) trackTriggered(messageId);
        const senderJid = update.key.participant ?? update.key.remoteJid ?? '';
        console.log(`[chat] Edit triggered by ${senderJid}: ${text}`);

        withGroupLock(remoteJid, async () => {
          try {
            const currentSock = getSocket();
            await currentSock.sendPresenceUpdate('composing', remoteJid);

            const response = await generateResponse(configHolder.current, groupConfig, remoteJid);

            const nameToJid = getNameToJidMap(remoteJid);
            const numberToJid = new Map<string, string>();
            for (const jid of nameToJid.values()) {
              const num = jid.replace(/[:@].+$/, '');
              numberToJid.set(num, jid);
            }

            const mentions: string[] = [];
            const mentionRegex = /@([\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} ]*[\p{L}\p{M}\p{N}]|[\p{L}\p{M}\p{N}]+)/gu;
            let responseText = response;
            const matches = [...response.matchAll(mentionRegex)].reverse();
            for (const match of matches) {
              const captured = match[1];
              const jid = nameToJid.get(captured.toLowerCase()) ?? numberToJid.get(captured);
              if (jid && !mentions.includes(jid)) {
                mentions.push(jid);
              }
              if (jid) {
                const num = jid.replace(/[:@].+$/, '');
                responseText = responseText.slice(0, match.index!) + '@' + num + responseText.slice(match.index! + match[0].length);
              }
            }
            if (mentions.length > 0) {
              console.log(`[chat] Resolved ${mentions.length} mention(s): ${mentions.join(', ')}`);
            }

            await waitForConnectionWithTimeout(30_000);
            const sendSock = getSocket();
            await sendSock.sendPresenceUpdate('paused', remoteJid);
            const sent = await sendSock.sendMessage(remoteJid, { text: responseText, mentions });

            addMessage(remoteJid, {
              senderName: primaryBotName,
              senderJid: sendSock.user?.id ?? botJid ?? '',
              text: response,
              fromBot: true,
              messageId: sent?.key?.id ?? undefined,
            });

            maybeRefreshProfiles(configHolder.current, remoteJid);
          } catch (err) {
            console.error('Failed to generate/send chat response (edit):', err);
          }
        });
      }
    });
  });
}
