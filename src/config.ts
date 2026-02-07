import 'dotenv/config';

export interface Config {
  whatsappGroupJid: string;
  googleServiceAccountEmail: string;
  googlePrivateKey: string;
  spreadsheetId: string;
  sheetName: string;
  birthdayMessageTemplate: string;
  cronSchedule: string;
}

export interface ChatConfig {
  chatGroupJid: string;
  anthropicApiKey: string;
  systemPrompt: string;
  botName: string;
  claudeModel: string;
  claudeMaxTokens: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    whatsappGroupJid: requireEnv('WHATSAPP_GROUP_JID'),
    googleServiceAccountEmail: requireEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    googlePrivateKey: requireEnv('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    spreadsheetId: requireEnv('SPREADSHEET_ID'),
    sheetName: process.env['SHEET_NAME'] || 'Sheet1',
    birthdayMessageTemplate:
      process.env['BIRTHDAY_MESSAGE_TEMPLATE'] ||
      '🎂 Happy Birthday, {name}! 🎉 Wishing you an amazing day!',
    cronSchedule: process.env['CRON_SCHEDULE'] || '* * * * *',
  };
}

export function loadChatConfig(): ChatConfig | null {
  const chatGroupJid = process.env['CHAT_GROUP_JID'];
  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];

  if (!chatGroupJid || !anthropicApiKey) {
    return null;
  }

  return {
    chatGroupJid,
    anthropicApiKey,
    systemPrompt:
      process.env['SYSTEM_PROMPT'] ||
      'You are a helpful assistant in a WhatsApp group chat. Be concise and friendly.',
    botName: process.env['BOT_NAME'] || 'openclaw',
    claudeModel: process.env['CLAUDE_MODEL'] || 'claude-sonnet-4-5-20250929',
    claudeMaxTokens: parseInt(process.env['CLAUDE_MAX_TOKENS'] || '1024', 10),
  };
}
