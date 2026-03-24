import cron from 'node-cron';
import type { AppConfig, ConfigHolder, GroupConfig, ScheduledPostJobConfig } from './config.js';
import { getHistorySince } from './chat-history.js';
import { fetchEventRows } from './sheets.js';
import { getTodaysEvents, formatEventMessage } from './events.js';
import { sendGroupImageMessage, sendGroupMessage } from './whatsapp.js';
import { generateScheduledImagePost } from './llm.js';
import { generateImage } from './gemini.js';
import { loadLatestNewsDigest } from './news.js';

export async function checkEventsForGroup(config: AppConfig, group: GroupConfig): Promise<void> {
  const events = group.events;
  if (!events) return;

  const groupLabel = group.name ?? group.jid;
  const eventsLabel = events.label ?? 'events';
  try {
    console.log(`Checking ${eventsLabel} for "${groupLabel}"...`);
    const rows = await fetchEventRows(config.global, events);
    console.log(`Fetched ${rows.length} entries from spreadsheet for "${groupLabel}"`);

    const names = getTodaysEvents(rows);

    if (names.length === 0) {
      console.log(`No ${eventsLabel} today for "${groupLabel}".`);
      return;
    }

    console.log(`Found ${names.length} ${eventsLabel} today for "${groupLabel}": ${names.join(', ')}`);

    for (const name of names) {
      const message = formatEventMessage(name, events.messageTemplate);
      await sendGroupMessage(group.jid, message);
      console.log(`Sent ${eventsLabel} message for ${name} to "${groupLabel}"`);
    }
  } catch (error) {
    console.error(`Error during ${eventsLabel} check for "${groupLabel}":`, error);
  }
}

export async function checkAllEvents(configHolder: ConfigHolder): Promise<void> {
  const config = configHolder.current;
  for (const group of config.groups) {
    if (group.events) {
      await checkEventsForGroup(config, group);
    }
  }
}

async function runScheduledPostJob(
  config: AppConfig,
  group: GroupConfig,
  job: ScheduledPostJobConfig,
): Promise<void> {
  const groupLabel = group.name ?? group.jid;
  const jobLabel = job.label ?? 'scheduled-post';
  const lookbackHours = job.lookbackHours ?? 24;
  const since = Date.now() - lookbackHours * 60 * 60 * 1000;
  const historyWindow = getHistorySince(group.jid, since, 150);
  const latestNewsDigest = loadLatestNewsDigest();

  console.log(
    `[scheduled-post] Running "${jobLabel}" for "${groupLabel}" ` +
    `(lookback=${lookbackHours}h, messages=${historyWindow.length}, webSearch=${job.enableWebSearch ?? false}, newsDigest=${latestNewsDigest ? latestNewsDigest.path : 'none'})`,
  );

  try {
    const post = await generateScheduledImagePost(config, group, group.jid, job, historyWindow, latestNewsDigest);
    let generatedImage: Awaited<ReturnType<typeof generateImage>> = null;

    if (post.image?.prompt) {
      try {
        generatedImage = await generateImage(config.global, post.image.prompt, {
          latestUserText: job.prompt,
          replyText: post.caption,
          visualBrief: post.image.prompt,
          reason: `scheduled post "${jobLabel}"`,
          literalness: post.image.literalness,
          mood: post.image.mood,
          style: post.image.style,
          keySubjects: post.image.keySubjects,
          mustAvoid: post.image.mustAvoid,
          textInImage: post.image.textInImage,
        });
      } catch (err) {
        console.error(`[scheduled-post] Gemini image generation failed for "${jobLabel}" in "${groupLabel}":`, err);
      }
    }

    if (generatedImage) {
      await sendGroupImageMessage(group.jid, generatedImage.data, generatedImage.mimeType, post.caption);
      console.log(`[scheduled-post] Sent image post for "${jobLabel}" to "${groupLabel}"`);
    } else {
      await sendGroupMessage(group.jid, post.caption);
      console.log(`[scheduled-post] Sent caption-only post for "${jobLabel}" to "${groupLabel}"`);
    }
  } catch (error) {
    console.error(`[scheduled-post] Failed running "${jobLabel}" for "${groupLabel}":`, error);
  }
}

export function startEventCrons(configHolder: ConfigHolder): void {
  const config = configHolder.current;
  const bySchedule = new Map<string, string[]>();

  for (const group of config.groups) {
    if (!group.events) continue;
    const schedule = group.events.cronSchedule;
    let list = bySchedule.get(schedule);
    if (!list) {
      list = [];
      bySchedule.set(schedule, list);
    }
    list.push(group.jid);
  }

  for (const [schedule, jids] of bySchedule) {
    const names = jids.map((jid) => {
      const g = config.groups.find((gr) => gr.jid === jid);
      return g?.name ?? jid;
    }).join(', ');
    console.log(`Scheduling events cron "${schedule}" for: ${names}`);

    cron.schedule(schedule, () => {
      const currentConfig = configHolder.current;
      for (const jid of jids) {
        const group = currentConfig.groups.find((g) => g.jid === jid);
        if (group?.events) {
          checkEventsForGroup(currentConfig, group);
        }
      }
    });
  }
}

export function startScheduledPostCrons(configHolder: ConfigHolder): void {
  const config = configHolder.current;
  const scheduledJobs = config.groups.flatMap((group) =>
    (group.scheduledPosts ?? []).map((job, index) => ({ groupJid: group.jid, jobIndex: index, job })),
  ).filter(({ job }) => job.enabled !== false);

  for (const { groupJid, jobIndex, job } of scheduledJobs) {
    const group = config.groups.find((entry) => entry.jid === groupJid);
    const groupLabel = group?.name ?? groupJid;
    console.log(
      `Scheduling scheduled post cron "${job.cronSchedule}" for "${groupLabel}" / "${job.label ?? `scheduled-post-${jobIndex + 1}`}"`,
    );

    cron.schedule(job.cronSchedule, () => {
      const currentConfig = configHolder.current;
      const currentGroup = currentConfig.groups.find((entry) => entry.jid === groupJid);
      const currentJob = currentGroup?.scheduledPosts?.[jobIndex];
      if (!currentGroup || !currentJob || currentJob.enabled === false) {
        return;
      }
      void runScheduledPostJob(currentConfig, currentGroup, currentJob);
    });
  }
}
