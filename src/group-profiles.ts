import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
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
  messagesSinceLastSummary?: number;
  firstSeenAt?: number;
  lastSeenAt?: number;
  avgMessageLength?: number;
  emojiCount?: number;
  questionCount?: number;
  linkCount?: number;
  commonWords?: string[];
  recentExamples?: string[];
  activeHours?: number[];
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
  const path = profilePath(groupJid);
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(profiles, null, 2), 'utf-8');
  renameSync(tmpPath, path);
}

export function getProfilesPrompt(groupJid: string): string {
  const profiles = loadProfiles(groupJid);
  const entries = Object.values(profiles.members);
  if (entries.length === 0) return '';

  const lines = entries.map((m) => {
    const stats = [
      `msgs=${m.messagesSeen ?? 0}`,
      `avgLen=${Math.round(m.avgMessageLength ?? 0)}`,
      `questions=${m.questionCount ?? 0}`,
      `links=${m.linkCount ?? 0}`,
      `emoji=${m.emojiCount ?? 0}`,
    ].join(', ');
    const words = (m.commonWords ?? []).length > 0 ? (m.commonWords ?? []).join(', ') : 'n/a';
    const examples = (m.recentExamples ?? []).length > 0
      ? (m.recentExamples ?? []).map((x) => `"${x}"`).join(' | ')
      : 'n/a';
    const summary = m.summary || 'No summary yet.';
    return `- **${m.name}**: ${summary}\n  stats: ${stats}\n  common words: ${words}\n  recent examples: ${examples}`;
  });
  return `\n\n## Group Members\n${lines.join('\n')}`;
}

export function maybeRefreshProfiles(config: AppConfig, groupJid: string): void {
  if (!config.global.anthropicApiKey) return;

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

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'of', 'to', 'in', 'on', 'for', 'at', 'by', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'as', 'from',
  'i', 'you', 'he', 'she', 'we', 'they', 'me', 'my', 'your', 'our', 'their', 'them', 'do', 'does', 'did',
  'de', 'da', 'do', 'dos', 'das', 'e', 'ou', 'mas', 'que', 'se', 'em', 'no', 'na', 'nos', 'nas', 'um', 'uma',
  'uns', 'umas', 'para', 'por', 'com', 'sem', 'ao', 'aos', 'à', 'às', 'o', 'os', 'é', 'ser', 'foi', 'são',
  'eu', 'tu', 'ele', 'ela', 'nós', 'vos', 'vós', 'eles', 'elas', 'meu', 'minha', 'teu', 'tua', 'seu', 'sua',
  'já', 'não', 'sim', 'vai', 'vou', 'está', 'estao', 'estão', 'ta', 'tá', 'lol', 'kkk', 'kkkk', 'haha', 'ahah',
]);

function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) ?? [];
}

function extractCommonWords(texts: string[], limit = 8): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const token of tokenizeWords(text)) {
      if (token.length < 3) continue;
      if (STOPWORDS.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

function extractEmojiCount(text: string): number {
  return text.match(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu)?.length ?? 0;
}

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

  type SenderMetrics = {
    name: string;
    jid: string;
    messageCount: number;
    messageCountSinceLastSummary: number;
    totalTextLength: number;
    emojiCount: number;
    questionCount: number;
    linkCount: number;
    firstSeenAt: number;
    lastSeenAt: number;
    activeHours: Map<number, number>;
    texts: string[];
  };

  const senderMetrics = new Map<string, SenderMetrics>();
  for (const msg of history) {
    if (msg.fromBot) continue;
    const key = msg.senderJid || msg.senderName;
    const ts = msg.timestamp ?? 0;
    const text = msg.text ?? '';

    let metrics = senderMetrics.get(key);
    if (!metrics) {
      metrics = {
        name: msg.senderName,
        jid: msg.senderJid,
        messageCount: 0,
        messageCountSinceLastSummary: 0,
        totalTextLength: 0,
        emojiCount: 0,
        questionCount: 0,
        linkCount: 0,
        firstSeenAt: ts || Date.now(),
        lastSeenAt: ts || Date.now(),
        activeHours: new Map<number, number>(),
        texts: [],
      };
      senderMetrics.set(key, metrics);
    }

    metrics.messageCount += 1;
    if (ts > profiles.lastSummaryAt) {
      metrics.messageCountSinceLastSummary += 1;
    }
    metrics.totalTextLength += text.length;
    metrics.emojiCount += extractEmojiCount(text);
    metrics.questionCount += (text.match(/\?/g) ?? []).length;
    metrics.linkCount += (text.match(/https?:\/\/\S+/gi) ?? []).length;
    metrics.firstSeenAt = Math.min(metrics.firstSeenAt, ts || metrics.firstSeenAt);
    metrics.lastSeenAt = Math.max(metrics.lastSeenAt, ts || metrics.lastSeenAt);
    const hour = new Date(ts || Date.now()).getHours();
    metrics.activeHours.set(hour, (metrics.activeHours.get(hour) ?? 0) + 1);
    if (text.trim()) metrics.texts.push(text.trim());
  }

  const now = Date.now();
  for (const [name, summary] of Object.entries(summaries)) {
    const jid = nameToJid.get(name) ?? '';
    const existing = profiles.members[name];
    const metrics = [...senderMetrics.values()].find((m) => m.name === name);
    const recentExamples = metrics?.texts.slice(-5).map((t) => t.slice(0, 180)) ?? (existing?.recentExamples ?? []);
    const commonWords = metrics ? extractCommonWords(metrics.texts) : (existing?.commonWords ?? []);
    const activeHours = metrics
      ? [...metrics.activeHours.entries()]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, 3)
        .map(([hour]) => hour)
      : (existing?.activeHours ?? []);

    profiles.members[name] = {
      name,
      jid: jid || existing?.jid || '',
      summary,
      lastUpdated: now,
      messagesSeen: Math.max(existing?.messagesSeen ?? 0, metrics?.messageCount ?? 0),
      messagesSinceLastSummary: metrics?.messageCountSinceLastSummary ?? 0,
      firstSeenAt: metrics?.firstSeenAt ?? existing?.firstSeenAt ?? 0,
      lastSeenAt: metrics?.lastSeenAt ?? existing?.lastSeenAt ?? 0,
      avgMessageLength: metrics?.messageCount ? (metrics.totalTextLength / metrics.messageCount) : (existing?.avgMessageLength ?? 0),
      emojiCount: metrics?.emojiCount ?? existing?.emojiCount ?? 0,
      questionCount: metrics?.questionCount ?? existing?.questionCount ?? 0,
      linkCount: metrics?.linkCount ?? existing?.linkCount ?? 0,
      commonWords,
      recentExamples,
      activeHours,
    };
  }

  // Persist metrics for participants even when the summarizer omits them.
  for (const metrics of senderMetrics.values()) {
    if (profiles.members[metrics.name]) continue;
    const existing = profiles.members[metrics.name];
    profiles.members[metrics.name] = {
      name: metrics.name,
      jid: metrics.jid || existing?.jid || '',
      summary: existing?.summary ?? '',
      lastUpdated: existing?.lastUpdated ?? now,
      messagesSeen: Math.max(existing?.messagesSeen ?? 0, metrics.messageCount),
      messagesSinceLastSummary: metrics.messageCountSinceLastSummary,
      firstSeenAt: metrics.firstSeenAt,
      lastSeenAt: metrics.lastSeenAt,
      avgMessageLength: metrics.messageCount ? (metrics.totalTextLength / metrics.messageCount) : 0,
      emojiCount: metrics.emojiCount,
      questionCount: metrics.questionCount,
      linkCount: metrics.linkCount,
      commonWords: extractCommonWords(metrics.texts),
      recentExamples: metrics.texts.slice(-5).map((t) => t.slice(0, 180)),
      activeHours: [...metrics.activeHours.entries()]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, 3)
        .map(([hour]) => hour),
    };
  }

  profiles.lastSummaryAt = now;
  saveProfiles(groupJid, profiles);
  console.log(`[profiles] Updated profiles for ${Object.keys(summaries).length} member(s) in ${groupJid}`);
}
