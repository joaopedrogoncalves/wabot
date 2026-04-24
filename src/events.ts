import type { EventRow } from './sheets.js';

type ParsedEventDate = {
  day: number;
  month: number;
};

function parseEventDate(date: string): ParsedEventDate | null {
  let day: number;
  let month: number;

  if (date.includes('-')) {
    // yyyy-mm-dd
    const parts = date.split('-');
    if (parts.length < 3) return null;
    month = parseInt(parts[1]!, 10);
    day = parseInt(parts[2]!, 10);
  } else {
    // dd/mm/yyyy
    const parts = date.split('/');
    if (parts.length < 2) return null;
    day = parseInt(parts[0]!, 10);
    month = parseInt(parts[1]!, 10);
  }

  if (!Number.isInteger(day) || !Number.isInteger(month)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  return { day, month };
}

function eventDateForYear(parsed: ParsedEventDate, year: number): Date | null {
  const date = new Date(year, parsed.month - 1, parsed.day);
  if (date.getMonth() !== parsed.month - 1 || date.getDate() !== parsed.day) {
    return null;
  }
  date.setHours(0, 0, 0, 0);
  return date;
}

export function getTodaysEvents(rows: EventRow[]): string[] {
  const now = new Date();
  const todayDay = now.getDate();
  const todayMonth = now.getMonth() + 1; // 1-indexed

  return rows
    .filter((row) => {
      const parsed = parseEventDate(row.date);
      return parsed?.day === todayDay && parsed.month === todayMonth;
    })
    .map((row) => row.name);
}

export function getNextEvent(rows: EventRow[], now = new Date()): EventRow | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let best: { row: EventRow; occurrence: Date; index: number } | null = null;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const parsed = parseEventDate(row.date);
    if (!parsed) continue;

    const thisYear = eventDateForYear(parsed, today.getFullYear());
    const nextOccurrence = thisYear && thisYear >= today
      ? thisYear
      : eventDateForYear(parsed, today.getFullYear() + 1);
    if (!nextOccurrence) continue;

    if (
      !best
      || nextOccurrence < best.occurrence
      || (nextOccurrence.getTime() === best.occurrence.getTime() && index < best.index)
    ) {
      best = { row, occurrence: nextOccurrence, index };
    }
  }

  return best?.row ?? null;
}

export function formatEventMessage(name: string, template: string): string {
  return template.replace(/\{name\}/g, name);
}
