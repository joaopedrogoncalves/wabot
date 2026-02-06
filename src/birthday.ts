import type { BirthdayRow } from './sheets.js';

export function getTodaysBirthdays(rows: BirthdayRow[]): string[] {
  const now = new Date();
  const todayDay = now.getDate();
  const todayMonth = now.getMonth() + 1; // 1-indexed

  return rows
    .filter((row) => {
      const parts = row.date.split('/');
      if (parts.length < 2) return false;

      const day = parseInt(parts[0]!, 10);
      const month = parseInt(parts[1]!, 10);

      return day === todayDay && month === todayMonth;
    })
    .map((row) => row.name);
}

export function formatBirthdayMessage(name: string, template: string): string {
  return template.replace(/\{name\}/g, name);
}
