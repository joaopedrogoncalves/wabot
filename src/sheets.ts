import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import type { GlobalConfig, BirthdayGroupConfig } from './config.js';

export interface BirthdayRow {
  name: string;
  date: string;
}

export async function fetchBirthdays(global: GlobalConfig, birthday: BirthdayGroupConfig): Promise<BirthdayRow[]> {
  const auth = new JWT({
    email: global.googleServiceAccountEmail,
    key: global.googlePrivateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const doc = new GoogleSpreadsheet(birthday.spreadsheetId, auth);
  await doc.loadInfo();

  const sheet = doc.sheetsByTitle[birthday.sheetName];
  if (!sheet) {
    throw new Error(`Sheet "${birthday.sheetName}" not found in spreadsheet`);
  }

  const rows = await sheet.getRows();

  return rows
    .map((row) => ({
      name: (row.get('Name') || '').trim(),
      date: (row.get('Date') || '').trim(),
    }))
    .filter((r) => r.name && r.date);
}
