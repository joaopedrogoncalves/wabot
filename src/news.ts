import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export type LatestNewsDigest = {
  path: string;
  modifiedAt: number;
  content: string;
};

const DEFAULT_NEWS_DIR = process.env['NEWS_DIGEST_DIR'] ?? '/mnt/multimedia/claw/news';
const MAX_NEWS_CONTENT_CHARS = 16_000;

export function loadLatestNewsDigest(newsDir = DEFAULT_NEWS_DIR): LatestNewsDigest | null {
  let names: string[];
  try {
    names = readdirSync(newsDir);
  } catch (err) {
    console.warn(`[news] Failed to list news directory "${newsDir}":`, err);
    return null;
  }

  let latest: { path: string; modifiedAt: number } | null = null;
  for (const name of names) {
    const fullPath = join(newsDir, name);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    if (!latest || stats.mtimeMs > latest.modifiedAt) {
      latest = { path: fullPath, modifiedAt: stats.mtimeMs };
    }
  }

  if (!latest) {
    return null;
  }

  try {
    const content = readFileSync(latest.path, 'utf-8').trim();
    return {
      path: latest.path,
      modifiedAt: latest.modifiedAt,
      content: content.slice(0, MAX_NEWS_CONTENT_CHARS),
    };
  } catch (err) {
    console.warn(`[news] Failed to read latest news digest "${latest.path}":`, err);
    return null;
  }
}
