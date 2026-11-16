import { EVENT } from '../event';

export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEKDAYS_LONG = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTHS_LONG = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function zonedFields(ms: number, timeZone: string) {
  const parts = zonedFormatter(timeZone).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** Offset of `timeZone` from UTC at the instant `ms`, in milliseconds. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const f = zonedFields(ms, timeZone);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - Math.floor(ms / 1000) * 1000;
}

export interface LocalParts {
  date: string;
  time: string;
  minutes: number;
}

export function localParts(ms: number, timeZone: string = EVENT.timeZone): LocalParts {
  const f = zonedFields(ms, timeZone);
  return {
    date: isoDate(f.year, f.month, f.day),
    time: `${pad2(f.hour)}:${pad2(f.minute)}`,
    minutes: f.hour * 60 + f.minute,
  };
}

/** Converts a wall-clock date and time in `timeZone` to a UTC timestamp. */
export function zonedToUtcMs(date: string, time: string, timeZone: string = EVENT.timeZone): number {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffsetMs(guess, timeZone);
  return guess - zoneOffsetMs(first, timeZone);
}

export function isValidDate(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

export function addDays(date: string, days: number): string {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const moved = new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY);
  return isoDate(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

export function weekdayIndex(date: string): number {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** `Tue Nov 17` */
export function dayLabel(date: string): string {
  const [, month = 1, day = 1] = date.split('-').map(Number);
  return `${WEEKDAYS_SHORT[weekdayIndex(date)]} ${MONTHS_SHORT[month - 1]} ${day}`;
}

export function minutesOf(time: string): number {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  return hour * 60 + minute;
}

/** `13:05` becomes `1:05 PM`. */
export function clock12(time: string): string {
  const total = minutesOf(time);
  const hour = Math.floor(total / 60) % 24;
  const minute = total % 60;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return `${hour % 12 === 0 ? 12 : hour % 12}:${pad2(minute)} ${suffix}`;
}

/** `10:00–10:45 AM`, or `11:30 AM–12:15 PM` when the meridiem changes. */
export function timeRangeLabel(startTime: string, endTime: string): string {
  const start = clock12(startTime);
  const end = clock12(endTime);
  const startMeridiem = start.slice(-2);
  return startMeridiem === end.slice(-2) ? `${start.slice(0, -3)}–${end}` : `${start}–${end}`;
}

export function slotLabel(date: string, startTime: string, endTime: string): string {
  return `${dayLabel(date)}, ${timeRangeLabel(startTime, endTime)}`;
}

/** Parses `14:30`, `2:30pm`, `2 PM`. Returns minutes since midnight. */
export function parseClock(input: string): number | undefined {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*$/i.exec(input);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.[0]?.toLowerCase();
  if (minute > 59) return undefined;
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
  } else if (hour > 24 || (hour === 24 && minute > 0)) {
    return undefined;
  }
  return hour * 60 + minute;
}

export function minutesToTime(minutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(minutes)));
  return `${pad2(Math.floor(clamped / 60) % 24)}:${pad2(clamped % 60)}`;
}

/**
 * Parses an instant. Strings with an explicit offset (`Z`, `-08:00`) are absolute;
 * everything else is interpreted as wall-clock time in the event time zone.
 */
export function parseInstant(input: string, timeZone: string = EVENT.timeZone): number | undefined {
  const text = input.trim();
  const match =
    /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(text);
  if (!match) return undefined;
  const [, date, hour, minute, , offset] = match;
  if (!date || !isValidDate(date)) return undefined;
  if (offset) {
    if (hour === undefined) return undefined;
    const normalized = offset.toUpperCase() === 'Z' ? 'Z' : offset.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
    const ms = Date.parse(`${date}T${pad2(Number(hour))}:${minute}:${match[4] ?? '00'}${normalized}`);
    return Number.isNaN(ms) ? undefined : ms;
  }
  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59)) return undefined;
  return zonedToUtcMs(date, `${pad2(Number(hour ?? 0))}:${minute ?? '00'}`, timeZone);
}

/**
 * Resolves a day expression to `YYYY-MM-DD`: ISO dates, `today`/`tomorrow`/`yesterday`,
 * weekday names (matched against `knownDays`) and `Nov 18` / `18 November`.
 */
export function parseDay(
  input: string,
  knownDays: readonly string[],
  nowMs: number,
  timeZone: string = EVENT.timeZone,
): string | undefined {
  const text = input.trim().toLowerCase().replace(/[,.]/g, '');
  if (!text) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return isValidDate(text) ? text : undefined;

  const today = localParts(nowMs, timeZone).date;
  if (text === 'today') return today;
  if (text === 'tomorrow') return addDays(today, 1);
  if (text === 'yesterday') return addDays(today, -1);

  const weekday = WEEKDAYS_LONG.findIndex((name) => text === name || (text.length >= 3 && name.startsWith(text)));
  if (weekday >= 0 && /^[a-z]+$/.test(text)) {
    return knownDays.find((day) => weekdayIndex(day) === weekday);
  }

  const referenceYear = Number((knownDays[0] ?? today).slice(0, 4));
  const monthIndex = (name: string): number =>
    MONTHS_LONG.findIndex((month) => name.length >= 3 && month.startsWith(name));
  let month = -1;
  let day = 0;
  let match = /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(text);
  if (match) {
    month = monthIndex(match[1] ?? '');
    day = Number(match[2]);
  } else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)$/.exec(text))) {
    month = monthIndex(match[2] ?? '');
    day = Number(match[1]);
  }
  if (month < 0) return undefined;
  const date = isoDate(referenceYear, month + 1, day);
  return isValidDate(date) ? date : undefined;
}

export function minutesBetween(fromMs: number, toMs: number): number {
  return Math.round((toMs - fromMs) / MS_PER_MINUTE);
}
