import type { EventRow } from './sheets.js';

export function getTodaysEvents(rows: EventRow[]): string[] {
  const now = new Date();
  const todayDay = now.getDate();
  const todayMonth = now.getMonth() + 1; // 1-indexed

  return rows
    .filter((row) => {
      let day: number, month: number;

      if (row.date.includes('-')) {
        // yyyy-mm-dd
        const parts = row.date.split('-');
        if (parts.length < 3) return false;
        month = parseInt(parts[1]!, 10);
        day = parseInt(parts[2]!, 10);
      } else {
        // dd/mm/yyyy
        const parts = row.date.split('/');
        if (parts.length < 2) return false;
        day = parseInt(parts[0]!, 10);
        month = parseInt(parts[1]!, 10);
      }

      return day === todayDay && month === todayMonth;
    })
    .map((row) => row.name);
}

export function formatEventMessage(name: string, template: string): string {
  return template.replace(/\{name\}/g, name);
}
