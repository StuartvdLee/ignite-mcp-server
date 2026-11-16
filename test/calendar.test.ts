import { beforeAll, describe, expect, it } from 'vitest';
import type { Catalog } from '../src/catalog/catalog';
import { DEFAULT_RULES, createCalendarFile } from '../src/catalog/calendar';
import { EVENT } from '../src/event';
import { fixtureCatalog, icsEvents, icsLines, pacific, sessionOf, snapshotCatalog } from './helpers';

const NOW = pacific('2026-11-16', '12:00');
const catalog = fixtureCatalog();
const make = (refs: string[], extra: { name?: string; reminderMinutes?: number } = {}) => createCalendarFile(catalog, refs, { nowMs: NOW, ...extra });
const summaries = (ics: string) => icsEvents(ics).map((item) => item.props.SUMMARY?.split(':')[0]);

describe('a calendar file for a list of sessions', () => {
  it('holds one event for a session with a single time slot', () => {
    const file = make(['BRK217']);
    const session = sessionOf(catalog, 'BRK217');
    expect(file.filename).toBe('ignite-2026-BRK217.ics');
    expect(file.entries.map((entry) => entry.occurrence.slotId)).toEqual(['BRK217@2026-11-19T16:00']);
    expect(file.onDemand).toEqual([]);
    expect(file.unresolved).toEqual([]);
    expect(file.conflicts).toEqual([]);
    const [only, ...rest] = icsEvents(file.ics);
    expect(rest).toEqual([]);
    expect(only?.props).toMatchObject({
      UID: `${session.occurrences[0]?.instanceId}@ignite-mcp`,
      SUMMARY: `BRK217: ${session.title}`,
      DTSTART: '20261120T000000Z',
      DTEND: '20261120T004500Z',
      DTSTAMP: '20261116T200000Z',
      LOCATION: 'Moscone West\\, Level 3\\, Room 3014',
      URL: session.url,
    });
  });

  it('is named after the session only when there is just one', () => {
    expect(make(['BRK217', 'KEY01']).filename).toBe('ignite-2026-agenda.ics');
    expect(make(['KEY01']).filename).toBe('ignite-2026-KEY01.ics');
  });

  it('lists the events in time order, however the sessions were given', () => {
    const file = make(['BRK217', 'KEY01', 'BRK248']);
    expect(file.entries.map((entry) => entry.session.code)).toEqual(['KEY01', 'BRK248', 'BRK217']);
    expect(summaries(file.ics)).toEqual(['KEY01', 'BRK248', 'BRK217']);
  });

  it('understands the different ways to refer to a session, and counts each session once', () => {
    const file = make(['BRK217', ' brk217 ', 'BRK 217', 'brk-217@2026-11-19T16:00']);
    expect(file.entries).toHaveLength(1);
    expect(icsEvents(file.ics)).toHaveLength(1);
    expect(file.unresolved).toEqual([]);
  });

  it('picks a time for a session that is offered several times', () => {
    const file = make(['LAB652']);
    const session = sessionOf(catalog, 'LAB652');
    expect(file.entries).toHaveLength(1);
    expect(session.occurrences.map((slot) => slot.slotId)).toContain(file.entries[0]?.occurrence.slotId);
    expect(file.entries[0]?.fixed).toBe(false);
    expect(icsEvents(file.ics)).toHaveLength(1);
  });

  it('uses the exact time asked for', () => {
    const file = make(['LAB652@2026-11-19T13:00']);
    const slot = sessionOf(catalog, 'LAB652').occurrences.find((candidate) => candidate.slotId === 'LAB652@2026-11-19T13:00');
    expect(file.entries[0]?.occurrence).toBe(slot);
    expect(icsEvents(file.ics)[0]?.props.UID).toBe(`${slot?.instanceId}@ignite-mcp`);
    expect(icsEvents(file.ics)[0]?.props.DTSTART).toBe('20261119T210000Z');
  });

  it('is identical every time for the same request, whatever the order of the list', () => {
    const refs = ['BRK217', 'LAB652', 'KEY01', 'LAB724', 'LTG1356'];
    expect(make(refs)).toEqual(make(refs));
    expect(make([...refs].reverse()).ics).toBe(make(refs).ics);
  });

  it('keeps entries distinct for each slot of a repeated session', () => {
    const uids = sessionOf(catalog, 'LAB652').occurrences.map((slot) => make([slot.slotId]).entries[0]?.occurrence.instanceId);
    expect(new Set(uids).size).toBe(uids.length);
  });
});

describe('what cannot go into the calendar', () => {
  it('reports on-demand sessions instead of adding them', () => {
    const file = make(['BRK217', 'OD1930', 'LAB711D']);
    expect(summaries(file.ics)).toEqual(['BRK217']);
    expect(file.onDemand.map((session) => session.code)).toEqual(['OD1930', 'LAB711D']);
    expect(file.filename).toBe('ignite-2026-BRK217.ics');
  });

  it('reports sessions it cannot find, with a hint', () => {
    const file = make(['BRK217', 'NOPE1', 'BRK217@2026-11-19T17:00']);
    expect(summaries(file.ics)).toEqual(['BRK217']);
    expect(file.unresolved.map((item) => item.ref)).toEqual(['NOPE1', 'BRK217@2026-11-19T17:00']);
    expect(file.unresolved[0]?.reason).toContain('No session has that code or id');
    expect(file.unresolved[1]?.reason).toBe('BRK217 has no slot "2026-11-19T17:00". Its slots: BRK217@2026-11-19T16:00');
  });

  it('gives an empty file when there is nothing to put in it', () => {
    for (const refs of [[], ['NOPE1'], ['OD1930'], ['OD1930', 'NOPE1']]) {
      const file = make(refs);
      expect(file.ics).toBe('');
      expect(file.entries).toEqual([]);
      expect(file.conflicts).toEqual([]);
      expect(file.filename).toBe('ignite-2026-agenda.ics');
    }
    expect(make(['OD1930', 'NOPE1']).onDemand.map((session) => session.code)).toEqual(['OD1930']);
    expect(make(['OD1930', 'NOPE1']).unresolved.map((item) => item.ref)).toEqual(['NOPE1']);
  });
});

describe('the name, the alerts and the stamp', () => {
  it('calls the calendar after the event unless told otherwise', () => {
    expect(icsLines(make(['BRK217']).ics)).toContain(`X-WR-CALNAME:${EVENT.name}`);
    expect(icsLines(make(['BRK217'], { name: 'My plan, v2' }).ics)).toContain('X-WR-CALNAME:My plan\\, v2');
  });

  it('adds an alert to every event when asked to', () => {
    const none = icsEvents(make(['BRK217', 'KEY01']).ics);
    expect(none.every((item) => item.alarm === undefined)).toBe(true);
    const some = icsEvents(make(['BRK217', 'KEY01'], { reminderMinutes: 30 }).ics);
    expect(some.map((item) => item.alarm?.TRIGGER)).toEqual(['-PT30M', '-PT30M']);
    expect(icsEvents(make(['KEY01'], { reminderMinutes: 0 }).ics)[0]?.alarm?.TRIGGER).toBe('PT0S');
  });

  it('stamps the file with the time it was made', () => {
    const later = createCalendarFile(catalog, ['KEY01'], { nowMs: Date.UTC(2026, 10, 17, 1, 2, 3) });
    expect(icsEvents(later.ics)[0]?.props.DTSTAMP).toBe('20261117T010203Z');
  });
});

describe('warning about clashes', () => {
  it('still includes sessions that overlap, and says so', () => {
    const file = make(['BRK323', 'THRSP1050']);
    expect(summaries(file.ics)).toEqual(['BRK323', 'THRSP1050']);
    expect(file.conflicts.map((conflict) => [conflict.kind, conflict.first.session.code, conflict.second.session.code, conflict.minutes])).toEqual([['overlap', 'BRK323', 'THRSP1050', 10]]);
  });

  it('measures breaks the way an attendee on site would', () => {
    expect(DEFAULT_RULES).toEqual({ minBreakMinutes: 10, attendance: 'in_person' });
    const back = make(['KEY01', 'LIVE50']);
    expect(back.conflicts.map((conflict) => [conflict.kind, conflict.minutes, conflict.requiredGapMinutes])).toEqual([['tight', 0, 50]]);
    expect(make(['BRK248', 'BRK316']).conflicts).toEqual([]);
  });
});

describe('a calendar of real sessions', () => {
  let real: Catalog;
  beforeAll(async () => {
    real = await snapshotCatalog();
  });

  it('puts every slot of a long list at the time the session is on', () => {
    const codes = real.sessions
      .filter((session) => !session.onDemand)
      .slice(0, 50)
      .map((session) => session.code);
    const file = createCalendarFile(real, codes, { nowMs: NOW, reminderMinutes: 10 });
    expect(file.entries).toHaveLength(50);
    expect(file.unresolved).toEqual([]);
    const parsed = icsEvents(file.ics);
    expect(parsed).toHaveLength(50);
    file.entries.forEach((entry, index) => {
      const toStamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
      expect(parsed[index]?.props.DTSTART).toBe(toStamp(entry.occurrence.startMs));
      expect(parsed[index]?.props.DTEND).toBe(toStamp(entry.occurrence.endMs));
      expect(parsed[index]?.props.UID).toBe(`${entry.occurrence.instanceId}@ignite-mcp`);
    });
    expect(new Set(parsed.map((item) => item.props.UID)).size).toBe(50);
  });
});
