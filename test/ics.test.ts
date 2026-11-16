import { Buffer } from 'node:buffer';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCalendar, calendarFilename, escapeText, foldLine, toCalendarEvent } from '../src/catalog/ics';
import type { CalendarEvent } from '../src/catalog/ics';
import { fixtureCatalog, icsEvents, icsLines, makeSession, makeSlot, pacific, sessionOf, snapshotCatalog } from './helpers';
import type { Catalog } from '../src/catalog/catalog';

const NOW = pacific('2026-11-16', '12:00');
const octets = (line: string) => Buffer.byteLength(line, 'utf8');
const unfold = (folded: string) => folded.replace(/\r\n /g, '');

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  uid: 'abc-123@ignite-mcp',
  summary: 'BRK1: A title',
  description: 'A description',
  startMs: Date.UTC(2026, 10, 17, 18, 0),
  endMs: Date.UTC(2026, 10, 17, 18, 45),
  ...overrides,
});

describe('escaping text', () => {
  it('escapes the characters that have a meaning in iCalendar', () => {
    expect(escapeText('a\\b;c,d')).toBe('a\\\\b\\;c\\,d');
    expect(escapeText('one\ntwo\r\nthree\rfour')).toBe('one\\ntwo\\nthree\\nfour');
  });

  it('escapes a backslash only once', () => {
    expect(escapeText('\\n')).toBe('\\\\n');
    expect(escapeText('C:\\temp; "x", y')).toBe('C:\\\\temp\\; "x"\\, y');
  });

  it('drops control characters but keeps tabs and ordinary text', () => {
    expect(escapeText('a\u0000b\u0007c\u001Fd\u007Fe\tf')).toBe('abcde\tf');
    expect(escapeText('Zürich – “quotes” 日本語 😀')).toBe('Zürich – “quotes” 日本語 😀');
  });

  it('leaves plain text alone', () => {
    expect(escapeText('')).toBe('');
    expect(escapeText('Plain text: nothing to do.')).toBe('Plain text: nothing to do.');
  });
});

describe('folding long lines', () => {
  it('leaves a line of up to 75 octets alone', () => {
    expect(foldLine('x'.repeat(75))).toBe('x'.repeat(75));
    expect(foldLine('')).toBe('');
    expect(foldLine('€'.repeat(25))).toBe('€'.repeat(25));
  });

  it('folds a longer line after 75 octets and continues after a space', () => {
    expect(foldLine('x'.repeat(76))).toBe(`${'x'.repeat(75)}\r\n x`);
    const folded = foldLine('x'.repeat(75 + 74 * 2 + 1));
    expect(folded.split('\r\n')).toEqual(['x'.repeat(75), ` ${'x'.repeat(74)}`, ` ${'x'.repeat(74)}`, ' x']);
  });

  it('never makes a physical line longer than 75 octets, and loses nothing', () => {
    for (const sample of ['x', 'é', '€', '😀', 'xé€😀', '日本語']) {
      for (const length of [1, 40, 74, 75, 76, 150, 151, 400]) {
        const line = sample.repeat(length);
        const folded = foldLine(line);
        for (const physical of folded.split('\r\n')) expect(octets(physical)).toBeLessThanOrEqual(75);
        expect(unfold(folded)).toBe(line);
      }
    }
  });

  it('does not cut a multi-byte character in two', () => {
    const folded = foldLine(`${'x'.repeat(73)}€€€`);
    expect(folded.split('\r\n')).toEqual([`${'x'.repeat(73)}`, ' €€€']);
    for (const physical of foldLine('😀'.repeat(60)).split('\r\n')) {
      expect(physical).not.toContain('\uFFFD');
      expect(Buffer.from(physical, 'utf8').toString('utf8')).toBe(physical);
    }
  });
});

describe('building a calendar file', () => {
  it('wraps the events in a calendar with CRLF line endings', () => {
    const ics = buildCalendar([event()], { name: 'My Ignite', nowMs: NOW });
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(icsLines(ics)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//ignite-mcp-server//Microsoft Ignite 2026 sessions//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:My Ignite',
      'BEGIN:VEVENT',
      'UID:abc-123@ignite-mcp',
      'DTSTAMP:20261116T200000Z',
      'DTSTART:20261117T180000Z',
      'DTEND:20261117T184500Z',
      'SUMMARY:BRK1: A title',
      'DESCRIPTION:A description',
      'END:VEVENT',
      'END:VCALENDAR',
    ]);
  });

  it('is still a valid calendar without events', () => {
    expect(icsLines(buildCalendar([], { name: 'Empty', nowMs: NOW }))).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//ignite-mcp-server//Microsoft Ignite 2026 sessions//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Empty',
      'END:VCALENDAR',
    ]);
  });

  it('writes times in UTC and stamps the file with the time it was made', () => {
    const ics = buildCalendar([event({ startMs: Date.UTC(2026, 10, 20, 0, 5, 9), endMs: Date.UTC(2026, 10, 20, 1, 0, 0) })], { name: 'x', nowMs: Date.UTC(2026, 0, 2, 3, 4, 5, 678) });
    const [parsed] = icsEvents(ics);
    expect(parsed?.props).toMatchObject({ DTSTAMP: '20260102T030405Z', DTSTART: '20261120T000509Z', DTEND: '20261120T010000Z' });
  });

  it('escapes the calendar name, the summary, the description and the location', () => {
    const ics = buildCalendar([event({ summary: 'Hello, world; again', description: 'Line one\nLine two, with; punctuation', location: 'Moscone West, Level 2; Room 2006' })], {
      name: 'Plans, ideas; more',
      nowMs: NOW,
    });
    const lines = icsLines(ics);
    expect(lines).toContain('X-WR-CALNAME:Plans\\, ideas\\; more');
    expect(lines).toContain('SUMMARY:Hello\\, world\\; again');
    expect(lines).toContain('DESCRIPTION:Line one\\nLine two\\, with\\; punctuation');
    expect(lines).toContain('LOCATION:Moscone West\\, Level 2\\; Room 2006');
  });

  it('only writes a location and a link when there is one', () => {
    const [bare] = icsEvents(buildCalendar([event()], { name: 'x', nowMs: NOW }));
    expect(Object.keys(bare?.props ?? {})).toEqual(['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'SUMMARY', 'DESCRIPTION']);
    const [full] = icsEvents(buildCalendar([event({ location: 'Room 1', url: 'https://example.test/a?b=c' })], { name: 'x', nowMs: NOW }));
    expect(Object.keys(full?.props ?? {})).toEqual(['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'SUMMARY', 'DESCRIPTION', 'LOCATION', 'URL']);
    expect(full?.props.URL).toBe('https://example.test/a?b=c');
    const [empty] = icsEvents(buildCalendar([event({ location: '', url: '' })], { name: 'x', nowMs: NOW }));
    expect(empty?.props).not.toHaveProperty('LOCATION');
    expect(empty?.props).not.toHaveProperty('URL');
  });

  it('cannot be made to break out of a property by what is in the data', () => {
    const hostile = event({
      uid: 'x@y\r\nEND:VEVENT',
      summary: 'Title\r\nBEGIN:VEVENT\r\nUID:evil',
      description: 'Text\nEND:VCALENDAR\r\nBEGIN:VEVENT',
      location: 'Room\r\nATTENDEE:mailto:evil@example.test',
      url: 'https://example.test/a b\r\nX-EVIL:1',
    });
    const ics = buildCalendar([hostile], { name: 'Name\r\nX-EVIL:1', nowMs: NOW });
    const lines = icsLines(ics);
    expect(lines.filter((line) => line.startsWith('BEGIN:VEVENT'))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('END:VEVENT'))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('END:VCALENDAR'))).toHaveLength(1);
    expect(lines.some((line) => line.startsWith('X-EVIL') || line.startsWith('ATTENDEE') || line.startsWith('UID:evil'))).toBe(false);
    expect(icsEvents(ics)[0]?.props.UID).toBe('x@yEND:VEVENT');
    expect(icsEvents(ics)[0]?.props.URL).toBe('https://example.test/abX-EVIL:1');
  });

  it('adds an alert only when asked to', () => {
    const noAlert = icsEvents(buildCalendar([event()], { name: 'x', nowMs: NOW }));
    expect(noAlert[0]?.alarm).toBeUndefined();
    const withAlert = icsEvents(buildCalendar([event(), event({ uid: 'second@ignite-mcp', summary: 'BRK2: Another, one' })], { name: 'x', nowMs: NOW, reminderMinutes: 15 }));
    expect(withAlert.map((item) => item.alarm)).toEqual([
      { ACTION: 'DISPLAY', DESCRIPTION: 'BRK1: A title', TRIGGER: '-PT15M' },
      { ACTION: 'DISPLAY', DESCRIPTION: 'BRK2: Another\\, one', TRIGGER: '-PT15M' },
    ]);
    expect(withAlert[0]?.props.DESCRIPTION).toBe('A description');
  });

  it('can alert at the start, and rounds a fractional number of minutes', () => {
    const trigger = (reminderMinutes: number) => icsEvents(buildCalendar([event()], { name: 'x', nowMs: NOW, reminderMinutes }))[0]?.alarm?.TRIGGER;
    expect(trigger(0)).toBe('PT0S');
    expect(trigger(-5)).toBe('PT0S');
    expect(trigger(1440)).toBe('-PT1440M');
    expect(trigger(7.6)).toBe('-PT8M');
  });

  it('folds long lines and reads back the same', () => {
    const description = `${'A long sentence, with commas; and semicolons. '.repeat(20)}\nSecond line ${'é'.repeat(100)}`;
    const long = event({ summary: `BRK1: ${'Very long title '.repeat(12)}`, description, location: `Venue, ${'Hall '.repeat(30)}`, url: `https://example.test/${'a'.repeat(200)}` });
    const ics = buildCalendar([long], { name: 'x', nowMs: NOW, reminderMinutes: 10 });
    for (const physical of ics.split('\r\n')) expect(octets(physical)).toBeLessThanOrEqual(75);
    const [parsed] = icsEvents(ics);
    expect(parsed?.props.SUMMARY).toBe(escapeText(long.summary));
    expect(parsed?.props.DESCRIPTION).toBe(escapeText(description));
    expect(parsed?.props.LOCATION).toBe(escapeText(long.location ?? ''));
    expect(parsed?.props.URL).toBe(long.url);
    expect(parsed?.alarm?.DESCRIPTION).toBe(escapeText(long.summary));
  });

  it('writes one event per entry, in the order given', () => {
    const ics = buildCalendar([event({ uid: 'b@x' }), event({ uid: 'a@x' }), event({ uid: 'c@x' })], { name: 'x', nowMs: NOW });
    expect(icsEvents(ics).map((item) => item.props.UID)).toEqual(['b@x', 'a@x', 'c@x']);
  });
});

describe('turning a session into a calendar event', () => {
  const catalog = fixtureCatalog();

  it('describes a session with its slot', () => {
    const session = sessionOf(catalog, 'BRK217');
    const slot = session.occurrences[0]!;
    const calendarEvent = toCalendarEvent(session, slot);
    expect(calendarEvent).toMatchObject({
      uid: `${slot.instanceId}@ignite-mcp`,
      summary: `BRK217: ${session.title}`,
      location: 'Moscone West, Level 3, Room 3014',
      startMs: slot.startMs,
      endMs: slot.endMs,
      url: session.url,
    });
    const lines = calendarEvent.description.split('\n');
    expect(lines.slice(0, 3)).toEqual([
      'Breakout · Intermediate',
      `Speakers: ${session.speakers.map((speaker) => speaker.name).join(', ')}`,
      'Where: Moscone West, Level 3, Room 3014 (Pacific Time)',
    ]);
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe(session.description);
    expect(lines.slice(5)).toEqual(['', session.url]);
  });

  it('copes with a session that has no room, no level and no speakers', () => {
    const slot = { ...makeSlot('Z1', '2026-11-17', '09:00', '10:00', 'Chase Center'), room: undefined, location: undefined };
    const session = makeSession('Z1', { title: 'Opening', type: 'Keynote' }, [slot]);
    const calendarEvent = toCalendarEvent(session, slot);
    expect(calendarEvent.location).toBeUndefined();
    expect(calendarEvent.description).toBe(`Keynote\nTimes are in Pacific Time\n\n${session.url}`);
  });

  it('uses only the venue as the place when there is no room', () => {
    const slot = { ...makeSlot('Z1', '2026-11-17', '09:00', '10:00', 'Chase Center'), room: undefined, location: 'Chase Center' };
    expect(toCalendarEvent(makeSession('Z1', {}, [slot]), slot).location).toBe('Chase Center');
  });

  it('keeps only the start of a very long description', () => {
    const slot = makeSlot('Z1', '2026-11-17', '09:00', '10:00');
    const all = Array.from({ length: 400 }, (_, index) => `word${index}`);
    const calendarEvent = toCalendarEvent(makeSession('Z1', { description: all.join(' ') }, [slot]), slot);
    const excerpt = calendarEvent.description.split('\n')[3] ?? '';
    expect(excerpt.length).toBeLessThanOrEqual(601);
    expect(excerpt.startsWith('word0 word1 ')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(all).toContain(excerpt.slice(0, -1).split(' ').pop());
  });

  it('uses a different calendar entry for each slot, and the same one every time', () => {
    const session = sessionOf(catalog, 'LAB652');
    const [first, second] = session.occurrences.map((slot) => toCalendarEvent(session, slot));
    expect(first?.uid).not.toBe(second?.uid);
    expect(toCalendarEvent(session, session.occurrences[0]!)).toEqual(first);
  });
});

describe('naming the file', () => {
  it('uses the session code for a single session and a general name otherwise', () => {
    expect(calendarFilename(['BRK217'])).toBe('ignite-2026-BRK217.ics');
    expect(calendarFilename(['BRK217', 'LAB650'])).toBe('ignite-2026-agenda.ics');
    expect(calendarFilename([])).toBe('ignite-2026-agenda.ics');
  });

  it('keeps unsafe characters out of the name', () => {
    expect(calendarFilename(['../x y"\r\n'])).toBe('ignite-2026-xy.ics');
    expect(calendarFilename(['LAB-7_1'])).toBe('ignite-2026-LAB-7_1.ics');
    expect(calendarFilename(['***'])).toBe('ignite-2026-agenda.ics');
    expect(calendarFilename([''])).toBe('ignite-2026-agenda.ics');
  });
});

describe('a calendar of the whole real schedule', () => {
  let catalog: Catalog;
  beforeAll(async () => {
    catalog = await snapshotCatalog();
  });

  it('is well formed for every scheduled session', () => {
    const entries = catalog.sessions.flatMap((session) => session.occurrences.map((slot) => toCalendarEvent(session, slot)));
    expect(entries.length).toBeGreaterThan(1300);
    const ics = buildCalendar(entries, { name: 'Everything', nowMs: NOW, reminderMinutes: 15 });

    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    for (const physical of ics.split('\r\n')) {
      expect(octets(physical)).toBeLessThanOrEqual(75);
      expect(physical).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F]/);
    }
    const parsed = icsEvents(ics);
    expect(parsed).toHaveLength(entries.length);
    expect(new Set(parsed.map((item) => item.props.UID)).size).toBe(entries.length);
    parsed.forEach((item, index) => {
      expect(item.props.SUMMARY).toBe(escapeText(entries[index]!.summary));
      expect(item.props.DESCRIPTION).toBe(escapeText(entries[index]!.description));
      expect(item.props.DTSTART! < item.props.DTEND!).toBe(true);
      expect(item.props.DTSTART).toMatch(/^2026111[6-9]T\d{6}Z$|^2026112[01]T\d{6}Z$/);
      expect(item.alarm?.TRIGGER).toBe('-PT15M');
    });
    const begins = icsLines(ics).filter((line) => line.startsWith('BEGIN:'));
    expect(begins.filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(entries.length);
  });
});
