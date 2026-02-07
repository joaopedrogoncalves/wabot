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
