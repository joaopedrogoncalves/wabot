import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from './config.js';
import { getHistory, getMessageCountSince } from './chat-history.js';

const PROFILES_DIR = './group_profiles';
const REFRESH_MESSAGE_THRESHOLD = 50;
const REFRESH_TIME_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours

interface MemberProfile {
  name: string;
  jid: string;
  summary: string;
  lastUpdated: number;
  messagesSeen: number;
}

interface GroupProfiles {
  members: Record<string, MemberProfile>;
  lastSummaryAt: number;
}

function profilePath(groupJid: string): string {
  return `${PROFILES_DIR}/${groupJid}.json`;
}

function loadProfiles(groupJid: string): GroupProfiles {
  try {
    const content = readFileSync(profilePath(groupJid), 'utf-8');
    return JSON.parse(content);
  } catch {
    return { members: {}, lastSummaryAt: 0 };
  }
}

function saveProfiles(groupJid: string, profiles: GroupProfiles): void {
  mkdirSync(PROFILES_DIR, { recursive: true });
  writeFileSync(profilePath(groupJid), JSON.stringify(profiles, null, 2), 'utf-8');
}

export function getProfilesPrompt(groupJid: string): string {
  const profiles = loadProfiles(groupJid);
  const entries = Object.values(profiles.members).filter((m) => m.summary);
  if (entries.length === 0) return '';

  const lines = entries.map((m) => `- **${m.name}**: ${m.summary}`);
  return `\n\n## Group Members\n${lines.join('\n')}`;
}

export function maybeRefreshProfiles(config: AppConfig, groupJid: string): void {
  const profiles = loadProfiles(groupJid);
  const now = Date.now();
  const timeSince = now - profiles.lastSummaryAt;
  const msgsSince = getMessageCountSince(groupJid, profiles.lastSummaryAt);

  if (msgsSince < REFRESH_MESSAGE_THRESHOLD && timeSince < REFRESH_TIME_THRESHOLD) return;

  console.log(`[profiles] Refreshing profiles for ${groupJid} (${msgsSince} msgs, ${Math.round(timeSince / 3600000)}h since last)`);
  refreshProfiles(config, groupJid).catch((err) => {
    console.error('[profiles] Failed to refresh profiles:', err);
  });
}

const SUMMARIZE_PROMPT = `You are analyzing a WhatsApp group chat. Based on the messages below, write a brief personality/interest profile for each person.

For each person, include:
- Communication style (verbose, terse, emoji-heavy, etc.)
- Interests and topics they discuss
- Personality traits observed
- Notable opinions or recurring themes
- Relationships with other group members

Keep each profile to 2-3 sentences. Be objective and factual based on what you observe. Update existing profiles with new information rather than rewriting from scratch.

Respond with a JSON object where keys are the person's name and values are their profile summary string. Only include non-bot participants. Example:
{"Alice": "Enthusiastic and emoji-heavy communicator. Loves discussing cooking and travel.", "Bob": "Terse and direct. Mostly talks about tech and gaming."}`;

async function refreshProfiles(config: AppConfig, groupJid: string): Promise<void> {
  const history = getHistory(groupJid);
  if (history.length === 0) return;

  const profiles = loadProfiles(groupJid);

  // Build message text for the LLM
  const chatLines = history
    .filter((m) => !m.fromBot && m.text)
    .map((m) => `[${m.senderName}]: ${m.text}`);

  if (chatLines.length === 0) return;

  // Include existing profiles for context
  let existingContext = '';
  const existingEntries = Object.values(profiles.members).filter((m) => m.summary);
  if (existingEntries.length > 0) {
    existingContext = '\n\nExisting profiles (update with new information):\n' +
      existingEntries.map((m) => `- ${m.name}: ${m.summary}`).join('\n');
  }

  const anthropic = new Anthropic({ apiKey: config.global.anthropicApiKey });
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SUMMARIZE_PROMPT + existingContext,
    messages: [{ role: 'user', content: chatLines.join('\n') }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  // Parse the JSON response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('[profiles] Could not parse LLM response as JSON');
    return;
  }

  let summaries: Record<string, string>;
  try {
    summaries = JSON.parse(jsonMatch[0]);
  } catch {
    console.error('[profiles] Invalid JSON in LLM response');
    return;
  }

  // Build a name→jid map from history
  const nameToJid = new Map<string, string>();
  for (const msg of history) {
    if (!msg.fromBot && msg.senderName && msg.senderJid) {
      nameToJid.set(msg.senderName, msg.senderJid);
    }
  }

  // Count messages per sender
  const msgCounts = new Map<string, number>();
  for (const msg of history) {
    if (!msg.fromBot) {
      msgCounts.set(msg.senderName, (msgCounts.get(msg.senderName) ?? 0) + 1);
    }
  }

  const now = Date.now();
  for (const [name, summary] of Object.entries(summaries)) {
    const jid = nameToJid.get(name) ?? '';
    const existing = profiles.members[name];
    profiles.members[name] = {
      name,
      jid: jid || existing?.jid || '',
      summary,
      lastUpdated: now,
      messagesSeen: (existing?.messagesSeen ?? 0) + (msgCounts.get(name) ?? 0),
    };
  }

  profiles.lastSummaryAt = now;
  saveProfiles(groupJid, profiles);
  console.log(`[profiles] Updated profiles for ${Object.keys(summaries).length} member(s) in ${groupJid}`);
}
