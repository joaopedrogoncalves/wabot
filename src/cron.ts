import cron from 'node-cron';
import type { WASocket } from '@whiskeysockets/baileys';
import type { Config } from './config.js';
import { fetchBirthdays } from './sheets.js';
import { getTodaysBirthdays, formatBirthdayMessage } from './birthday.js';
import { sendGroupMessage } from './whatsapp.js';

export async function checkBirthdays(sock: WASocket, config: Config): Promise<void> {
  try {
    console.log('Checking birthdays...');
    const rows = await fetchBirthdays(config);
    console.log(`Fetched ${rows.length} entries from spreadsheet`);

    const names = getTodaysBirthdays(rows);

    if (names.length === 0) {
      console.log('No birthdays today.');
      return;
    }

    console.log(`Found ${names.length} birthday(s) today: ${names.join(', ')}`);

    for (const name of names) {
      const message = formatBirthdayMessage(name, config.birthdayMessageTemplate);
      await sendGroupMessage(sock, config.whatsappGroupJid, message);
      console.log(`Sent birthday message for ${name}`);
    }
  } catch (error) {
    console.error('Error during birthday check:', error);
  }
}

export function startBirthdayCron(sock: WASocket, config: Config): void {
  console.log(`Scheduling birthday cron: "${config.cronSchedule}"`);

  cron.schedule(config.cronSchedule, () => {
    checkBirthdays(sock, config);
  });
}
