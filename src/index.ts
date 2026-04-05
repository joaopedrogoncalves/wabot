import './log.js';
import { syncGroups } from './config.js';
import type { ConfigHolder } from './config.js';
import { connectToWhatsApp, listGroups } from './whatsapp.js';
import { fetchEventRows } from './sheets.js';
import { startEventCrons, startScheduledPostCrons } from './cron.js';
import { setupChatHandler } from './chat-handler.js';
import { logTwitterConfigStatus } from './twitter.js';
import { startWebServer } from './web/server.js';

async function main() {
  const configPath = process.env['CONFIG_FILE'] || './groups.json';

  console.log('Connecting to WhatsApp...');
  await connectToWhatsApp();

  const whatsappGroups = await listGroups();
  const config = syncGroups(configPath, whatsappGroups);

  const configHolder: ConfigHolder = { current: config };

  const eventGroups = config.groups.filter((g) => g.events);
  const chatbotGroups = config.groups.filter((g) => g.chatbot && g.chatbot.enabled !== false);
  const scheduledPostGroups = config.groups.filter((g) => (g.scheduledPosts?.some((job) => job.enabled !== false)));
  const scheduledPostCount = scheduledPostGroups.reduce(
    (count, group) => count + (group.scheduledPosts?.filter((job) => job.enabled !== false).length ?? 0),
    0,
  );

  console.log(
    `Loaded ${config.groups.length} group(s): ${eventGroups.length} with events, ` +
    `${chatbotGroups.length} with chatbot, ${scheduledPostCount} scheduled post job(s)`,
  );
  logTwitterConfigStatus(config.global);

  if (config.groups.length > 0) {
    if (chatbotGroups.length > 0) {
      const names = chatbotGroups.map((g) => `${g.name ?? g.jid} (${g.chatbot!.botName})`);
      console.log(`Chatbot enabled for: ${names.join(', ')}`);
    } else {
      console.log('No groups with chatbot configured; running passive message recording only.');
    }
    setupChatHandler(configHolder);
  } else {
    console.log('No groups configured.');
  }

  for (const group of eventGroups) {
    const label = group.name ?? group.jid;
    try {
      const rows = await fetchEventRows(config.global, group.events!);
      console.log(`\n--- Spreadsheet Entries for "${label}" (${rows.length}) ---`);
      for (const row of rows) {
        console.log(`  ${row.name} → ${row.date}`);
      }
      console.log('--- End Entries ---\n');
    } catch (error) {
      console.error(`Failed to fetch events for "${label}":`, error);
    }
  }

  if (eventGroups.length > 0) {
    await startEventCrons(configHolder);
  } else {
    console.log('No groups with events configured.');
  }

  if (scheduledPostCount > 0) {
    await startScheduledPostCrons(configHolder);
  } else {
    console.log('No scheduled post jobs configured.');
  }

  // Start web admin if ADMIN_TOKEN is set
  const adminToken = process.env['ADMIN_TOKEN'];
  if (adminToken) {
    const port = parseInt(process.env['WEB_PORT'] ?? '3000', 10);
    startWebServer(configHolder, configPath, port, adminToken);
  }

  console.log('Bot is running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
