import { describe, expect, it } from 'vitest';
import {
  addDays,
  clock12,
  dayLabel,
  isoDate,
  isValidDate,
  localParts,
  minutesBetween,
  minutesOf,
  minutesToTime,
  parseClock,
  parseDay,
  parseInstant,
  slotLabel,
  timeRangeLabel,
  weekdayIndex,
  zonedToUtcMs,
} from '../src/catalog/time';

const DAYS = ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'];
const WEDNESDAY_NOON_UTC = Date.parse('2026-11-18T20:00:00Z');

describe('Pacific time conversion', () => {
  it('uses standard time in November and daylight saving time in summer', () => {
    expect(zonedToUtcMs('2026-11-18', '10:00')).toBe(Date.parse('2026-11-18T18:00:00Z'));
    expect(zonedToUtcMs('2026-07-01', '10:00')).toBe(Date.parse('2026-07-01T17:00:00Z'));
  });

  it('round-trips through localParts, also across midnight UTC', () => {
    expect(localParts(Date.parse('2026-11-20T00:00:00Z'))).toEqual({ date: '2026-11-19', time: '16:00', minutes: 960 });
    expect(localParts(zonedToUtcMs('2026-11-17', '23:59'))).toEqual({ date: '2026-11-17', time: '23:59', minutes: 1439 });
  });

  it('honours another time zone', () => {
    expect(zonedToUtcMs('2026-11-18', '10:00', 'UTC')).toBe(Date.parse('2026-11-18T10:00:00Z'));
    expect(localParts(Date.parse('2026-11-18T10:00:00Z'), 'Europe/Amsterdam').time).toBe('11:00');
  });
});

describe('dates', () => {
  it('formats and validates', () => {
    expect(isoDate(2026, 3, 7)).toBe('2026-03-07');
    expect(isValidDate('2026-11-18')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('18-11-2026')).toBe(false);
  });

  it('adds days across month ends', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('knows the weekday', () => {
    expect(weekdayIndex('2026-11-17')).toBe(2);
    expect(dayLabel('2026-11-17')).toBe('Tue Nov 17');
    expect(dayLabel('2026-11-20')).toBe('Fri Nov 20');
  });
});

describe('clock labels', () => {
  it('writes 12-hour clocks', () => {
    expect(clock12('13:05')).toBe('1:05 PM');
    expect(clock12('00:00')).toBe('12:00 AM');
    expect(clock12('12:00')).toBe('12:00 PM');
    expect(clock12('09:30')).toBe('9:30 AM');
  });

  it('shares the meridiem only when both ends have the same one', () => {
    expect(timeRangeLabel('10:00', '10:45')).toBe('10:00–10:45 AM');
    expect(timeRangeLabel('11:30', '12:15')).toBe('11:30 AM–12:15 PM');
    expect(slotLabel('2026-11-19', '16:00', '16:45')).toBe('Thu Nov 19, 4:00–4:45 PM');
  });

  it('converts between minutes and HH:mm', () => {
    expect(minutesOf('10:30')).toBe(630);
    expect(minutesToTime(90)).toBe('01:30');
    expect(minutesToTime(0)).toBe('00:00');
    expect(minutesToTime(1440)).toBe('00:00');
    expect(minutesToTime(-5)).toBe('00:00');
    expect(minutesToTime(99_999)).toBe('00:00');
  });
});

describe('parseClock', () => {
  it.each([
    ['14:30', 870],
    ['2:30pm', 870],
    ['2 PM', 840],
    ['2 p.m.', 840],
    ['12am', 0],
    ['12pm', 720],
    ['9', 540],
    ['24:00', 1440],
  ])('reads %s', (input, minutes) => {
    expect(parseClock(input)).toBe(minutes);
  });

  it.each(['25:00', '24:30', '13pm', '0am', '9:60', 'noon', '', '10:5'])('rejects %j', (input) => {
    expect(parseClock(input)).toBeUndefined();
  });
});

describe('parseInstant', () => {
  it('reads wall-clock time as Pacific Time', () => {
    expect(parseInstant('2026-11-18T10:00')).toBe(Date.parse('2026-11-18T18:00:00Z'));
    expect(parseInstant('2026-11-18 10:00')).toBe(Date.parse('2026-11-18T18:00:00Z'));
    expect(parseInstant('2026-11-18')).toBe(Date.parse('2026-11-18T08:00:00Z'));
  });

  it('keeps explicit offsets', () => {
    expect(parseInstant('2026-11-18T10:00:00Z')).toBe(Date.parse('2026-11-18T10:00:00Z'));
    expect(parseInstant('2026-11-18T10:00+01:00')).toBe(Date.parse('2026-11-18T09:00:00Z'));
    expect(parseInstant('2026-11-18T10:00-0800')).toBe(Date.parse('2026-11-18T18:00:00Z'));
  });

  it.each(['banana', '2026-11-18T25:00', '2026-11-18T10:60', '2026-02-30T10:00', '2026-11-18Z', ''])('rejects %j', (input) => {
    expect(parseInstant(input)).toBeUndefined();
  });
});

describe('parseDay', () => {
  const parse = (input: string) => parseDay(input, DAYS, WEDNESDAY_NOON_UTC);

  it('accepts ISO dates and relative days', () => {
    expect(parse('2026-11-20')).toBe('2026-11-20');
    expect(parse('today')).toBe('2026-11-18');
    expect(parse('Tomorrow')).toBe('2026-11-19');
    expect(parse('yesterday')).toBe('2026-11-17');
  });

  it('matches weekday names and prefixes against the event days only', () => {
    expect(parse('Thursday')).toBe('2026-11-19');
    expect(parse('wed')).toBe('2026-11-18');
    expect(parse('TUE.')).toBe('2026-11-17');
    expect(parse('monday')).toBeUndefined();
    expect(parse('we')).toBeUndefined();
  });

  it('reads month names', () => {
    expect(parse('nov 19')).toBe('2026-11-19');
    expect(parse('November 19th')).toBe('2026-11-19');
    expect(parse('19th November')).toBe('2026-11-19');
    expect(parse('20 of nov')).toBe('2026-11-20');
  });

  it.each(['', 'garbage', '2026-02-30', 'nov 40', 'foo 12'])('rejects %j', (input) => {
    expect(parse(input)).toBeUndefined();
  });
});

describe('minutesBetween', () => {
  it('rounds to whole minutes and keeps the sign', () => {
    expect(minutesBetween(0, 10 * 60_000)).toBe(10);
    expect(minutesBetween(10 * 60_000, 0)).toBe(-10);
    expect(minutesBetween(0, 29_000)).toBe(0);
  });
});
