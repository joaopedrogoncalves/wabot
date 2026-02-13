import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import type { GlobalConfig, EventsConfig } from './config.js';

export interface EventRow {
  name: string;
  date: string;
}

export async function fetchEventRows(global: GlobalConfig, events: EventsConfig): Promise<EventRow[]> {
  const auth = new JWT({
    email: global.googleServiceAccountEmail,
    key: global.googlePrivateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const doc = new GoogleSpreadsheet(events.spreadsheetId, auth);
  await doc.loadInfo();

  const sheet = doc.sheetsByTitle[events.sheetName];
  if (!sheet) {
    throw new Error(`Sheet "${events.sheetName}" not found in spreadsheet`);
  }

  const rows = await sheet.getRows();

  return rows
    .map((row) => ({
      name: (row.get('Name') || '').trim(),
      date: (row.get('Date') || '').trim(),
    }))
    .filter((r) => r.name && r.date);
}
