import { loadConfig } from './config.js';
import { connectToWhatsApp, listGroups } from './whatsapp.js';
import { startBirthdayCron, checkBirthdays } from './cron.js';

async function main() {
  const config = loadConfig();

  console.log('Connecting to WhatsApp...');
  const sock = await connectToWhatsApp();

  await listGroups(sock);

  console.log(`Target group: ${config.whatsappGroupJid}`);
  console.log(`Cron schedule: ${config.cronSchedule}`);

  // Run an immediate birthday check on startup
  await checkBirthdays(sock, config);

  // Start the daily cron job
  startBirthdayCron(sock, config);

  console.log('Bot is running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
