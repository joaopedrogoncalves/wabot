import { loadConfig, loadChatConfig } from './config.js';
import { connectToWhatsApp, listGroups } from './whatsapp.js';
import { fetchBirthdays } from './sheets.js';
import { startBirthdayCron, checkBirthdays } from './cron.js';
import { setupChatHandler } from './chat-handler.js';

async function main() {
  const config = loadConfig();
  const chatConfig = loadChatConfig();

  if (chatConfig) {
    console.log(`Chatbot enabled for ${chatConfig.chatGroupJids.length} group(s): ${chatConfig.chatGroupJids.join(', ')}`);
    setupChatHandler(chatConfig);
  } else {
    console.log('Chatbot disabled (CHAT_GROUP_JID or ANTHROPIC_API_KEY not set)');
  }

  console.log('Connecting to WhatsApp...');
  await connectToWhatsApp();

  await listGroups();

  console.log(`Target group: ${config.whatsappGroupJid}`);
  console.log(`Cron schedule: ${config.cronSchedule}`);

  // Print all spreadsheet entries for verification
  const rows = await fetchBirthdays(config);
  console.log(`\n--- Spreadsheet Entries (${rows.length}) ---`);
  for (const row of rows) {
    console.log(`  ${row.name} → ${row.date}`);
  }
  console.log('--- End Entries ---\n');

  // Run an immediate birthday check on startup
  await checkBirthdays(config);

  // Start the daily cron job
  startBirthdayCron(config);

  console.log('Bot is running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
