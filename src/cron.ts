import cron from 'node-cron';
import type { AppConfig, ConfigHolder, GroupConfig } from './config.js';
import { fetchBirthdays } from './sheets.js';
import { getTodaysBirthdays, formatBirthdayMessage } from './birthday.js';
import { sendGroupMessage } from './whatsapp.js';

export async function checkBirthdaysForGroup(config: AppConfig, group: GroupConfig): Promise<void> {
  const birthday = group.birthday;
  if (!birthday) return;

  const label = group.name ?? group.jid;
  try {
    console.log(`Checking birthdays for "${label}"...`);
    const rows = await fetchBirthdays(config.global, birthday);
    console.log(`Fetched ${rows.length} entries from spreadsheet for "${label}"`);

    const names = getTodaysBirthdays(rows);

    if (names.length === 0) {
      console.log(`No birthdays today for "${label}".`);
      return;
    }

    console.log(`Found ${names.length} birthday(s) today for "${label}": ${names.join(', ')}`);

    for (const name of names) {
      const message = formatBirthdayMessage(name, birthday.messageTemplate);
      await sendGroupMessage(group.jid, message);
      console.log(`Sent birthday message for ${name} to "${label}"`);
    }
  } catch (error) {
    console.error(`Error during birthday check for "${label}":`, error);
  }
}

export async function checkAllBirthdays(configHolder: ConfigHolder): Promise<void> {
  const config = configHolder.current;
  for (const group of config.groups) {
    if (group.birthday) {
      await checkBirthdaysForGroup(config, group);
    }
  }
}

export function startBirthdayCrons(configHolder: ConfigHolder): void {
  const config = configHolder.current;
  const bySchedule = new Map<string, string[]>();

  for (const group of config.groups) {
    if (!group.birthday) continue;
    const schedule = group.birthday.cronSchedule;
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
    console.log(`Scheduling birthday cron "${schedule}" for: ${names}`);

    cron.schedule(schedule, () => {
      const currentConfig = configHolder.current;
      for (const jid of jids) {
        const group = currentConfig.groups.find((g) => g.jid === jid);
        if (group?.birthday) {
          checkBirthdaysForGroup(currentConfig, group);
        }
      }
    });
  }
}
