import { syncGroups } from './config.js';
import { connectToWhatsApp, listGroups } from './whatsapp.js';
import { fetchBirthdays } from './sheets.js';
import { startBirthdayCrons, checkAllBirthdays } from './cron.js';
import { setupChatHandler } from './chat-handler.js';

async function main() {
  const configPath = process.env['CONFIG_FILE'] || './groups.json';

  console.log('Connecting to WhatsApp...');
  await connectToWhatsApp();

  const whatsappGroups = await listGroups();
  const config = syncGroups(configPath, whatsappGroups);

  const birthdayGroups = config.groups.filter((g) => g.birthday);
  const chatbotGroups = config.groups.filter((g) => g.chatbot);

  console.log(`Loaded ${config.groups.length} group(s): ${birthdayGroups.length} with birthday, ${chatbotGroups.length} with chatbot`);

  if (chatbotGroups.length > 0) {
    const names = chatbotGroups.map((g) => `${g.name ?? g.jid} (${g.chatbot!.botName})`);
    console.log(`Chatbot enabled for: ${names.join(', ')}`);
    setupChatHandler(config);
  } else {
    console.log('No groups with chatbot configured.');
  }

  for (const group of birthdayGroups) {
    const label = group.name ?? group.jid;
    try {
      const rows = await fetchBirthdays(config.global, group.birthday!);
      console.log(`\n--- Spreadsheet Entries for "${label}" (${rows.length}) ---`);
      for (const row of rows) {
        console.log(`  ${row.name} → ${row.date}`);
      }
      console.log('--- End Entries ---\n');
    } catch (error) {
      console.error(`Failed to fetch birthdays for "${label}":`, error);
    }
  }

  if (birthdayGroups.length > 0) {
    await checkAllBirthdays(config);
    startBirthdayCrons(config);
  } else {
    console.log('No groups with birthday configured.');
  }

  console.log('Bot is running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
