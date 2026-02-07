import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

export interface GlobalConfig {
  anthropicApiKey: string;
  googleServiceAccountEmail: string;
  googlePrivateKey: string;
  claudeModel: string;
  claudeMaxTokens: number;
}

export interface BirthdayGroupConfig {
  spreadsheetId: string;
  sheetName: string;
  messageTemplate: string;
  cronSchedule: string;
}

export interface ChatbotGroupConfig {
  botName: string;
  systemPrompt: string;
  enableThinking?: boolean;
  thinkingBudget?: number;
  enableWebSearch?: boolean;
  maxSearches?: number;
}

export interface GroupConfig {
  jid: string;
  name?: string;
  webToken?: string;
  birthday?: BirthdayGroupConfig;
  chatbot?: ChatbotGroupConfig;
}

export interface AppConfig {
  global: GlobalConfig;
  groups: GroupConfig[];
}

export type ConfigHolder = { current: AppConfig };

export function loadAppConfig(): AppConfig {
  const configPath = process.env['CONFIG_FILE'] || './groups.json';

  let rawJson: any;
  try {
    const content = readFileSync(configPath, 'utf-8');
    rawJson = JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to read config file "${configPath}": ${err}`);
  }

  const globalJson = rawJson.global ?? {};
  const groupsJson: any[] = rawJson.groups ?? [];

  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  const googleServiceAccountEmail = process.env['GOOGLE_SERVICE_ACCOUNT_EMAIL'] ?? '';
  const googlePrivateKey = (process.env['GOOGLE_PRIVATE_KEY'] ?? '').replace(/\\n/g, '\n');

  const global: GlobalConfig = {
    anthropicApiKey,
    googleServiceAccountEmail,
    googlePrivateKey,
    claudeModel: globalJson.claudeModel ?? 'claude-sonnet-4-5-20250929',
    claudeMaxTokens: globalJson.claudeMaxTokens ?? 1024,
  };

  const groups: GroupConfig[] = groupsJson.map((g: any, i: number) => {
    if (!g.jid) {
      throw new Error(`Group at index ${i} is missing required field "jid"`);
    }

    const group: GroupConfig = {
      jid: g.jid,
      name: g.name,
      webToken: g.webToken,
    };

    if (g.birthday) {
      if (!g.birthday.spreadsheetId) {
        throw new Error(`Group "${g.name ?? g.jid}" has birthday config but missing "spreadsheetId"`);
      }
      if (!googleServiceAccountEmail || !googlePrivateKey) {
        throw new Error(
          `Group "${g.name ?? g.jid}" has birthday config but GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY is not set`,
        );
      }
      group.birthday = {
        spreadsheetId: g.birthday.spreadsheetId,
        sheetName: g.birthday.sheetName ?? 'Sheet1',
        messageTemplate:
          g.birthday.messageTemplate ??
          '🎂 Happy Birthday, {name}! 🎉 Wishing you an amazing day!',
        cronSchedule: g.birthday.cronSchedule ?? '0 8 * * *',
      };
    }

    if (g.chatbot) {
      if (!g.chatbot.botName) {
        throw new Error(`Group "${g.name ?? g.jid}" has chatbot config but missing "botName"`);
      }
      if (!anthropicApiKey) {
        throw new Error(
          `Group "${g.name ?? g.jid}" has chatbot config but ANTHROPIC_API_KEY is not set`,
        );
      }
      group.chatbot = {
        botName: g.chatbot.botName,
        systemPrompt:
          g.chatbot.systemPrompt ??
          'You are a helpful assistant in a WhatsApp group chat. Be concise and friendly.',
        enableThinking: g.chatbot.enableThinking ?? false,
        thinkingBudget: g.chatbot.thinkingBudget ?? 2000,
        enableWebSearch: g.chatbot.enableWebSearch ?? false,
        maxSearches: g.chatbot.maxSearches ?? 3,
      };
    }

    return group;
  });

  return { global, groups };
}

export function syncGroups(
  configPath: string,
  whatsappGroups: Record<string, string>,
): AppConfig {
  let rawJson: any;
  try {
    const content = readFileSync(configPath, 'utf-8');
    rawJson = JSON.parse(content);
  } catch {
    rawJson = {};
  }

  const groups: any[] = rawJson.groups ?? [];
  const existingJids = new Set(groups.map((g: any) => g.jid));

  // Update names and ensure webTokens exist
  for (const group of groups) {
    if (whatsappGroups[group.jid]) {
      group.name = whatsappGroups[group.jid];
    }
    if (!group.webToken) {
      group.webToken = randomUUID();
    }
  }

  // Append new groups not yet in config
  for (const [jid, name] of Object.entries(whatsappGroups)) {
    if (!existingJids.has(jid)) {
      groups.push({ jid, name, webToken: randomUUID() });
      console.log(`Added new group to config: "${name}" (${jid})`);
    }
  }

  rawJson.groups = groups;
  writeFileSync(configPath, JSON.stringify(rawJson, null, 2) + '\n', 'utf-8');
  console.log('Synced group names from WhatsApp into config.');

  return loadAppConfig();
}

export function updateConfigFile(
  configPath: string,
  configHolder: ConfigHolder,
  updater: (rawJson: any) => void,
): void {
  const backup = readFileSync(configPath, 'utf-8');
  try {
    const rawJson = JSON.parse(backup);
    updater(rawJson);
    writeFileSync(configPath, JSON.stringify(rawJson, null, 2) + '\n', 'utf-8');
    configHolder.current = loadAppConfig();
  } catch (err) {
    writeFileSync(configPath, backup, 'utf-8');
    throw err;
  }
}
