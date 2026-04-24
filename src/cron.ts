import cron, { type ScheduledTask } from 'node-cron';
import type { AppConfig, ConfigHolder, GroupConfig, ScheduledPostJobConfig } from './config.js';
import { getHistorySince } from './chat-history.js';
import { fetchEventRows } from './sheets.js';
import { getNextEvent, getTodaysEvents, formatEventMessage } from './events.js';
import { sendGroupImageMessage, sendGroupMessage } from './whatsapp.js';
import { generateEventAnnouncementPost, generateScheduledImagePost } from './llm.js';
import { generateImage } from './gemini.js';
import { loadLatestNewsDigest } from './news.js';

async function sendEventAnnouncement(
  config: AppConfig,
  group: GroupConfig,
  name: string,
  templateMessage: string,
  eventsLabel: string,
): Promise<boolean> {
  const groupLabel = group.name ?? group.jid;
  let caption = templateMessage;
  let imagePlan: Awaited<ReturnType<typeof generateEventAnnouncementPost>>['image'] = null;

  if (config.global.anthropicApiKey) {
    try {
      const post = await generateEventAnnouncementPost(config, group, group.jid, name, templateMessage, eventsLabel);
      caption = post.caption;
      imagePlan = post.image;
    } catch (err) {
      console.error(`[events] Persona announcement generation failed for "${name}" in "${groupLabel}":`, err);
    }
  } else {
    console.warn(`[events] ANTHROPIC_API_KEY is not set; using template caption for "${name}" in "${groupLabel}".`);
  }

  const fallbackPrompt = [
    `A fun celebratory WhatsApp announcement image for ${eventsLabel}.`,
    `Event name: ${name}.`,
    'Make it playful, warm, expressive, and visually led.',
    'Do not include readable text, signs, posters, captions, chat bubbles, or UI.',
    'Do not depict an identifiable private person from only the name; use a symbolic or generic celebratory scene.',
  ].join(' ');
  const imagePrompt = imagePlan?.prompt || fallbackPrompt;
  let generatedImage: Awaited<ReturnType<typeof generateImage>> = null;

  try {
    generatedImage = await generateImage(config.global, imagePrompt, {
      latestUserText: `Scheduled ${eventsLabel} announcement for ${name}`,
      replyText: caption,
      visualBrief: imagePrompt,
      reason: `event announcement "${eventsLabel}" for "${name}"`,
      literalness: imagePlan?.literalness ?? 'vibe',
      mood: imagePlan?.mood,
      style: imagePlan?.style,
      keySubjects: imagePlan?.keySubjects ?? [name, eventsLabel],
      mustAvoid: imagePlan?.mustAvoid ?? ['readable text', 'identifiable private-person likeness'],
      textInImage: imagePlan?.textInImage ?? 'none',
    });
  } catch (err) {
    console.error(`[events] Gemini image generation failed for "${name}" in "${groupLabel}":`, err);
  }

  if (generatedImage) {
    await sendGroupImageMessage(group.jid, generatedImage.data, generatedImage.mimeType, caption);
    console.log(`[events] Sent image announcement for ${name} to "${groupLabel}"`);
    return true;
  } else {
    await sendGroupMessage(group.jid, caption);
    console.log(`[events] Sent caption-only announcement for ${name} to "${groupLabel}"`);
    return false;
  }
}

export async function sendNextEventMessageNow(
  config: AppConfig,
  group: GroupConfig,
): Promise<{ name: string; date: string; sentWithImage: boolean }> {
  const events = group.events;
  if (!events) {
    throw new Error(`Group "${group.name ?? group.jid}" does not have events configured.`);
  }

  const groupLabel = group.name ?? group.jid;
  const eventsLabel = events.label ?? 'events';
  console.log(`[events] Manual test requested for next ${eventsLabel} in "${groupLabel}"`);
  const rows = await fetchEventRows(config.global, events);
  const nextEvent = getNextEvent(rows);
  if (!nextEvent) {
    throw new Error(`No valid ${eventsLabel} rows found for "${groupLabel}".`);
  }

  const message = formatEventMessage(nextEvent.name, events.messageTemplate);
  let sentWithImage = false;
  if (events.enableImageAnnouncements) {
    sentWithImage = await sendEventAnnouncement(config, group, nextEvent.name, message, eventsLabel);
  } else {
    await sendGroupMessage(group.jid, message);
  }

  console.log(`[events] Manual test sent ${eventsLabel} message for ${nextEvent.name} to "${groupLabel}"`);
  return {
    name: nextEvent.name,
    date: nextEvent.date,
    sentWithImage,
  };
}

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
      if (events.enableImageAnnouncements) {
        await sendEventAnnouncement(config, group, name, message, eventsLabel);
      } else {
        await sendGroupMessage(group.jid, message);
      }
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

let eventCronTasks: ScheduledTask[] = [];
let scheduledPostCronTasks: ScheduledTask[] = [];

async function stopCronTasks(tasks: ScheduledTask[], label: string): Promise<void> {
  for (const task of tasks) {
    try {
      await task.stop();
      await task.destroy();
    } catch (error) {
      console.error(`[cron] Failed to stop ${label} task ${task.id}:`, error);
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

export async function startEventCrons(configHolder: ConfigHolder): Promise<void> {
  await stopCronTasks(eventCronTasks, 'event');
  eventCronTasks = [];

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

    const task = cron.schedule(schedule, () => {
      const currentConfig = configHolder.current;
      for (const jid of jids) {
        const group = currentConfig.groups.find((g) => g.jid === jid);
        if (group?.events) {
          void checkEventsForGroup(currentConfig, group);
        }
      }
    });
    eventCronTasks.push(task);
  }
}

export async function startScheduledPostCrons(configHolder: ConfigHolder): Promise<void> {
  await stopCronTasks(scheduledPostCronTasks, 'scheduled post');
  scheduledPostCronTasks = [];

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

    const task = cron.schedule(job.cronSchedule, () => {
      const currentConfig = configHolder.current;
      const currentGroup = currentConfig.groups.find((entry) => entry.jid === groupJid);
      const currentJob = currentGroup?.scheduledPosts?.[jobIndex];
      if (!currentGroup || !currentJob || currentJob.enabled === false) {
        return;
      }
      void runScheduledPostJob(currentConfig, currentGroup, currentJob);
    });
    scheduledPostCronTasks.push(task);
  }
}
