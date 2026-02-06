import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import type { Config } from './config.js';

export interface BirthdayRow {
  name: string;
  date: string;
}

export async function fetchBirthdays(config: Config): Promise<BirthdayRow[]> {
  const auth = new JWT({
    email: config.googleServiceAccountEmail,
    key: config.googlePrivateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const doc = new GoogleSpreadsheet(config.spreadsheetId, auth);
  await doc.loadInfo();

  const sheet = doc.sheetsByTitle[config.sheetName];
  if (!sheet) {
    throw new Error(`Sheet "${config.sheetName}" not found in spreadsheet`);
  }

  const rows = await sheet.getRows();

  return rows
    .map((row) => ({
      name: (row.get('Name') || '').trim(),
      date: (row.get('Date') || '').trim(),
    }))
    .filter((r) => r.name && r.date);
}
