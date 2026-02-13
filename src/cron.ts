import cron from 'node-cron';
import type { AppConfig, ConfigHolder, GroupConfig } from './config.js';
import { fetchEventRows } from './sheets.js';
import { getTodaysEvents, formatEventMessage } from './events.js';
import { sendGroupMessage } from './whatsapp.js';

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
