import type { GlobalConfig } from './config.js';

const TWEET_URL_REGEX = /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[A-Za-z0-9_]{1,15}\/status\/(\d+)(?:[/?#][^\s]*)?/giu;
const MAX_TWEETS_PER_MESSAGE = 3;
const REQUEST_TIMEOUT_MS = 10_000;
let startupLogged = false;

type TweetApiResponse = {
  data?: {
    id: string;
    text: string;
    author_id?: string;
    created_at?: string;
    public_metrics?: {
      like_count?: number;
      retweet_count?: number;
      reply_count?: number;
      quote_count?: number;
    };
  };
  includes?: {
    users?: Array<{
      id: string;
      name?: string;
      username?: string;
    }>;
  };
};

function maskToken(token: string): string {
  if (token.length <= 12) return '***';
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

export function logTwitterConfigStatus(globalConfig: GlobalConfig): void {
  if (startupLogged) return;
  startupLogged = true;

  const rawBearerToken = globalConfig.twitterBearerToken ?? '';
  const bearerToken = rawBearerToken;

  if (!bearerToken) {
    console.log('[twitter] Tweet URL enrichment is disabled (TWITTER_BEARER_TOKEN not set).');
    if (process.env['BEARER_TOKEN']) {
      console.warn('[twitter] BEARER_TOKEN is set, but this bot expects TWITTER_BEARER_TOKEN.');
    }
    return;
  }

  console.log('[twitter] Tweet URL enrichment is enabled.');
  console.log(`[twitter] token=${maskToken(bearerToken)} length=${bearerToken.length}`);
}

function extractTweetIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TWEET_URL_REGEX)) {
    const id = match[1];
    if (!id || seen.has(id)) continue;
    ids.push(id);
    seen.add(id);
    if (ids.length >= MAX_TWEETS_PER_MESSAGE) break;
  }
  return ids;
}

function formatTweetSummary(payload: TweetApiResponse): string | null {
  const tweet = payload.data;
  if (!tweet) return null;

  const users = payload.includes?.users ?? [];
  const author = users.find((u) => u.id === tweet.author_id);
  const authorLabel = author?.username
    ? `@${author.username}${author.name ? ` (${author.name})` : ''}`
    : (author?.name ?? 'unknown');
  const metrics = tweet.public_metrics;
  const metricText = metrics
    ? ` likes=${metrics.like_count ?? 0}, retweets=${metrics.retweet_count ?? 0}, replies=${metrics.reply_count ?? 0}, quotes=${metrics.quote_count ?? 0}`
    : '';

  return `[tweet by ${authorLabel}${tweet.created_at ? ` at ${tweet.created_at}` : ''}] ${tweet.text}${metricText}`;
}

async function fetchTweetById(id: string, bearerToken: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = new URL(`https://api.x.com/2/tweets/${id}`);
    url.searchParams.set('expansions', 'author_id');
    url.searchParams.set('tweet.fields', 'created_at,public_metrics');
    url.searchParams.set('user.fields', 'name,username');

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${bearerToken}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.warn(`[twitter] Failed to fetch tweet ${id}: ${response.status} ${response.statusText}; body=${errorBody || '(empty)'}`);
      if (response.status === 401 || response.status === 403) {
        console.warn('[twitter] Authorization failed. Verify TWITTER_BEARER_TOKEN and app read permissions.');
      } else if (response.status === 402) {
        console.warn('[twitter] X API returned 402 (Payment Required). Your plan/app likely lacks access to this endpoint.');
      } else if (response.status === 429) {
        console.warn('[twitter] X API rate limit reached (429).');
      }
      return null;
    }

    const payload = await response.json() as TweetApiResponse;
    return formatTweetSummary(payload);
  } catch (err) {
    console.warn(`[twitter] Failed to fetch tweet ${id}:`, err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function enrichTextWithTweets(text: string, globalConfig: GlobalConfig): Promise<string> {
  const tweetIds = extractTweetIds(text);
  if (tweetIds.length === 0) return text;

  const bearerToken = globalConfig.twitterBearerToken ?? '';
  if (!startupLogged) logTwitterConfigStatus(globalConfig);
  if (!bearerToken) {
    console.warn('[twitter] Tweet URL detected, but TWITTER_BEARER_TOKEN is not configured.');
    return text;
  }

  const summaries = await Promise.all(tweetIds.map((id) => fetchTweetById(id, bearerToken)));
  const valid = summaries.filter((summary): summary is string => !!summary);
  if (valid.length === 0) return text;

  return `${text}\n\n[Tweet context]\n${valid.join('\n')}`;
}
