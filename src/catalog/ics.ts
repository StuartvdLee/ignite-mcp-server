import { Buffer } from 'node:buffer';
import { EVENT, sessionUrl } from '../event';
import { truncate } from './text';
import type { Occurrence, Session } from './types';

const CRLF = '\r\n';
const MAX_LINE_OCTETS = 75;
const DESCRIPTION_CHARS = 600;
const PRODUCT_ID = '-//ignite-mcp-server//Microsoft Ignite 2026 sessions//EN';

export interface CalendarEvent {
  /** Stable, so that importing the same session again updates the calendar entry instead of duplicating it. */
  uid: string;
  summary: string;
  description: string;
  location?: string | undefined;
  startMs: number;
  endMs: number;
  url?: string | undefined;
}

export interface CalendarOptions {
  /** Calendar name shown by clients that support `X-WR-CALNAME`. */
  name: string;
  /** Time stamp of the file, injected for testability. */
  nowMs: number;
  /** Adds a display alert this many minutes before each event. */
  reminderMinutes?: number | undefined;
}

/** RFC 5545 TEXT: backslash, semicolon, comma and line breaks are escaped, control characters dropped. */
export function escapeText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Folds a content line at 75 octets without splitting a UTF-8 character; continuation lines start with a space. */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_OCTETS) return line;
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character, 'utf8');
    // Continuation lines begin with one space, which counts towards the limit.
    const limit = parts.length === 0 ? MAX_LINE_OCTETS : MAX_LINE_OCTETS - 1;
    if (octets + size > limit) {
      parts.push(current);
      current = '';
      octets = 0;
    }
    current += character;
    octets += size;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function property(name: string, value: string): string {
  return foldLine(`${name}:${value}`);
}

function alarmTrigger(minutes: number): string {
  return minutes <= 0 ? 'PT0S' : `-PT${Math.round(minutes)}M`;
}

export function buildCalendar(events: readonly CalendarEvent[], options: CalendarOptions): string {
  const stamp = utcStamp(options.nowMs);
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODUCT_ID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    property('X-WR-CALNAME', escapeText(options.name)),
  ];
  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      property('UID', event.uid.replace(/[\r\n]/g, '')),
      `DTSTAMP:${stamp}`,
      `DTSTART:${utcStamp(event.startMs)}`,
      `DTEND:${utcStamp(event.endMs)}`,
      property('SUMMARY', escapeText(event.summary)),
      property('DESCRIPTION', escapeText(event.description)),
    );
    if (event.location) lines.push(property('LOCATION', escapeText(event.location)));
    if (event.url) lines.push(property('URL', event.url.replace(/[\s\u0000-\u001F]/g, '')));
    if (options.reminderMinutes !== undefined) {
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        property('DESCRIPTION', escapeText(event.summary)),
        `TRIGGER:${alarmTrigger(options.reminderMinutes)}`,
        'END:VALARM',
      );
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join(CRLF) + CRLF;
}

/** The text of an entry's calendar item: key facts first, then a short excerpt and the link. */
export function toCalendarEvent(session: Session, occurrence: Occurrence): CalendarEvent {
  const url = sessionUrl(occurrence.instanceId);
  const facts = [session.type, session.level].filter(Boolean).join(' · ');
  const speakers = session.speakers.map((speaker) => speaker.name).join(', ');
  const description = [
    facts,
    speakers ? `Speakers: ${speakers}` : '',
    occurrence.room && occurrence.venue ? `Where: ${occurrence.venue}, ${occurrence.room} (${EVENT.timeZoneLabel})` : `Times are in ${EVENT.timeZoneLabel}`,
    session.description ? `\n${truncate(session.description, DESCRIPTION_CHARS)}` : '',
    `\n${url}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
  return {
    uid: `${occurrence.instanceId}@ignite-mcp`,
    summary: `${session.code}: ${session.title}`,
    description,
    location: occurrence.location ? occurrence.location.replace(/\s*\|\s*/g, ', ') : undefined,
    startMs: occurrence.startMs,
    endMs: occurrence.endMs,
    url,
  };
}

/** `ignite-2026-BRK217.ics` for one session, `ignite-2026-agenda.ics` otherwise. */
export function calendarFilename(codes: readonly string[]): string {
  const only = codes.length === 1 ? codes[0]?.replace(/[^A-Za-z0-9_-]/g, '') : undefined;
  return only ? `ignite-2026-${only}.ics` : 'ignite-2026-agenda.ics';
}
