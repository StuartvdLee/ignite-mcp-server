import { describe, expect, it } from 'vitest';
import type { AgendaItem, Alternative, SkippedSession } from '../src/catalog/agenda';
import type { SearchHit } from '../src/catalog/catalog';
import type { InterestMatch, ScoredSession } from '../src/catalog/interests';
import type { LiveItem } from '../src/catalog/live';
import type { Conflict, ScheduleEntry } from '../src/catalog/schedule';
import type { StoreStatus } from '../src/catalog/store';
import type { Session } from '../src/catalog/types';
import {
  agendaItemView,
  alternativeView,
  conflictMessage,
  conflictView,
  hitView,
  levelLabel,
  liveView,
  matchedOn,
  overviewView,
  placeOf,
  reasonFor,
  recommendationView,
  relatedView,
  scheduleView,
  sessionDetailView,
  skippedView,
  slotView,
  summaryView,
} from '../src/mcp/present';
import { fixtureCatalog, makeSession, makeSlot, sessionOf, syntheticCatalog } from './helpers';

// Facts about test/fixtures/feed.json: 34 sessions (29 scheduled, 5 on demand), 18 recorded, 15 live streamed, 58 speakers.
// BRK217 is a Breakout on Thu Nov 19, 4:00-4:45 PM. LAB652 and LAB711 are labs with four time slots. BRK316 links to
// BRK323 and BRK320. LAB711D is on demand.

const DAY = '2026-11-17';
const catalog = fixtureCatalog();

const entryOf = (session: Session, fixed = true, index = 0): ScheduleEntry => {
  const occurrence = session.occurrences[index]!;
  return { session, occurrence, otherSlots: session.occurrences.filter((other) => other !== occurrence), fixed };
};

const match = (interest: string, relevance: number, matchedFields: string[] = [], matchedTags: string[] = []): InterestMatch => ({
  interest,
  relevance,
  matchedFields,
  matchedTags,
});

/** Two sessions that run 9:00-10:00 and 9:50-10:30, in Moscone West. */
const pair = (): [Session, Session] => [
  makeSession('AAA', {}, [makeSlot('AAA', DAY, '09:00', '10:00')]),
  makeSession('BBB', {}, [makeSlot('BBB', DAY, '09:50', '10:30')]),
];

const crowded = makeSession(
  'CROWD',
  {
    level: 'Advanced',
    levelNumber: 300,
    topics: ['Security'],
    tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
    speakers: Array.from({ length: 9 }, (_, index) => ({ name: `Speaker ${index + 1}` })),
    description: 'Word '.repeat(120),
  },
  [makeSlot('CROWD', DAY, '09:00', '10:00'), makeSlot('CROWD', DAY, '13:00', '14:00')],
);

describe('levelLabel', () => {
  it.each([
    [{ level: 'Intermediate', levelNumber: 200 }, 'Level 200 (Intermediate)'],
    [{ level: 'Intermediate' }, 'Intermediate'],
    [{ levelNumber: 300 }, 'Level 300'],
    [{}, undefined],
  ])('turns %j into %s', (session, expected) => {
    expect(levelLabel(session)).toBe(expected);
  });
});

describe('placeOf', () => {
  it.each([
    [{ venue: 'Moscone West', room: 'Level 3, Room 3014' }, 'Moscone West, Level 3, Room 3014'],
    [{ venue: 'Chase Center' }, 'Chase Center'],
    [{ room: 'Room 5' }, 'Room 5'],
    [{ location: 'Hall A | Level 2' }, 'Hall A, Level 2'],
    [{ location: 'Hall A|Level 2 |  Seat 3' }, 'Hall A, Level 2, Seat 3'],
    [{ venue: 'Venue', location: 'Other | Place' }, 'Venue'],
    [{}, undefined],
  ])('turns %j into %s', (occurrence, expected) => {
    expect(placeOf(occurrence)).toBe(expected);
  });
});

describe('slotView', () => {
  it('describes a time slot in Pacific Time and in UTC', () => {
    expect(slotView(sessionOf(catalog, 'BRK217').occurrences[0]!)).toEqual({
      slotId: 'BRK217@2026-11-19T16:00',
      day: 'Thu Nov 19',
      date: '2026-11-19',
      startTime: '16:00',
      endTime: '16:45',
      startUtc: '2026-11-20T00:00:00.000Z',
      endUtc: '2026-11-20T00:45:00.000Z',
      durationMinutes: 45,
      venue: 'Moscone West',
      room: 'Level 3, Room 3014',
      label: 'Thu Nov 19, 4:00–4:45 PM · Moscone West, Level 3, Room 3014',
    });
  });

  it('leaves out the venue and room that a slot does not have', () => {
    const view = slotView({ ...makeSlot('AAA', DAY, '09:00', '10:00'), venue: undefined, room: undefined, location: undefined });
    expect(view).not.toHaveProperty('venue');
    expect(view).not.toHaveProperty('room');
    expect(view.label).toBe('Tue Nov 17, 9:00–10:00 AM');
  });

  it('shows a venue without a room', () => {
    const view = slotView({ ...makeSlot('AAA', DAY, '09:00', '10:00', 'Chase Center'), room: undefined });
    expect(view.label).toBe('Tue Nov 17, 9:00–10:00 AM · Chase Center');
    expect(view).not.toHaveProperty('room');
  });

  it('falls back to the raw location when there is no venue', () => {
    const view = slotView({ ...makeSlot('AAA', DAY, '09:00', '10:00'), venue: undefined, room: undefined, location: 'Hall A | Level 2' });
    expect(view.label).toBe('Tue Nov 17, 9:00–10:00 AM · Hall A, Level 2');
  });
});

describe('summaryView', () => {
  it('describes a session', () => {
    const view = summaryView(sessionOf(catalog, 'BRK217'));
    expect(view).toMatchObject({
      code: 'BRK217',
      title: 'Real-World AI Transformation with Copilot in SharePoint',
      type: 'Breakout',
      level: 'Level 200 (Intermediate)',
      topics: ['Copilot'],
      tags: ['SharePoint', 'Microsoft Copilot', 'Microsoft 365'],
      speakers: ['Rk Menon', 'Matt Wolodarsky', 'Amy Curley, PhD'],
      speakerCount: 3,
      delivery: ['In-person', 'Online'],
      recorded: true,
      liveStream: true,
      onDemand: false,
      url: 'https://ignite.microsoft.com/en-US/sessions/1787856605931001EI5K-1791588217922001CW4I?source=sessions',
    });
    expect(view.slots.map((slot) => slot.slotId)).toEqual(['BRK217@2026-11-19T16:00']);
  });

  it('shows at most 6 tags and 6 speakers, and says how many speakers there are', () => {
    const view = summaryView(crowded);
    expect(view.tags).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
    expect(view.speakers).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 3', 'Speaker 4', 'Speaker 5', 'Speaker 6']);
    expect(view.speakerCount).toBe(9);
    expect(view.level).toBe('Level 300 (Advanced)');
  });

  it('puts the preferred tags first, in the order of the session', () => {
    expect(summaryView(crowded, crowded.occurrences, ['t8', 't7']).tags).toEqual(['t7', 't8', 't1', 't2', 't3', 't4']);
    expect(summaryView(crowded, crowded.occurrences, ['unknown']).tags).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
  });

  it('cuts a long description to a short excerpt', () => {
    const { summary } = summaryView(crowded);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(201);
    expect(summary.startsWith('Word Word')).toBe(true);
  });

  it('keeps a short description and tidies its white space', () => {
    expect(summaryView(makeSession('SHORT', { description: '  Line one.\n\nLine two.  ' })).summary).toBe('Line one. Line two.');
  });

  it('lists all slots unless it is told which ones apply', () => {
    expect(summaryView(crowded).slots).toHaveLength(2);
    expect(summaryView(crowded, crowded.occurrences.slice(1)).slots.map((slot) => slot.startTime)).toEqual(['13:00']);
    expect(summaryView(crowded, []).slots).toEqual([]);
  });

  it('has no level key for a session without a level', () => {
    expect(summaryView(makeSession('PLAIN'))).not.toHaveProperty('level');
  });
});

describe('matchedOn', () => {
  it.each([
    [['title', 'description'], [], ['title', 'description']],
    [['title', 'tags', 'topics'], ['A', 'B'], ['title', 'tags: A, B']],
    [['tags', 'title', 'topics'], [], ['title', 'tags', 'topics']],
    [['topics', 'tags'], [], ['topics', 'tags']],
    [[], [], []],
  ])('turns the fields %j and tags %j into %j', (fields, tags, expected) => {
    expect(matchedOn(fields, tags)).toEqual(expected);
  });
});

describe('hitView', () => {
  const lab = sessionOf(catalog, 'LAB711');
  const hit = (overrides: Partial<SearchHit> = {}): SearchHit => ({
    session: lab,
    score: 4.2,
    relevance: 0.5,
    occurrences: lab.occurrences,
    matchedFields: ['title'],
    matchedTags: [],
    ...overrides,
  });

  it('rounds the relevance to two decimals', () => {
    expect(hitView(hit({ relevance: 0.8449 })).relevance).toBe(0.84);
    expect(hitView(hit({ relevance: 0.1251 })).relevance).toBe(0.13);
    expect(hitView(hit({ relevance: 1 })).relevance).toBe(1);
  });

  it('shows only the slots that satisfy the filters', () => {
    expect(lab.occurrences.length).toBeGreaterThan(1);
    expect(hitView(hit({ occurrences: lab.occurrences.slice(1, 2) })).slots.map((slot) => slot.slotId)).toEqual([lab.occurrences[1]!.slotId]);
  });

  it('says what matched', () => {
    expect(hitView(hit({ matchedFields: ['title', 'tags'], matchedTags: ['Zero Trust'] })).matchedOn).toEqual(['title', 'tags: Zero Trust']);
  });
});

describe('reasonFor', () => {
  it('names the interest, how well it matched and where', () => {
    expect(reasonFor([match('AI agents', 0.9, ['title'], ['Agentic AI']), match('zero trust', 0.3, ['description'])])).toBe(
      'Strong match for "AI agents" (title; tags: Agentic AI); partial match for "zero trust" (description).',
    );
  });

  it('starts with the best match', () => {
    expect(reasonFor([match('low', 0.2, ['description']), match('high', 0.8, ['title'])])).toBe(
      'Strong match for "high" (title); partial match for "low" (description).',
    );
  });

  it.each([
    [1, 'Strong'],
    [0.75, 'Strong'],
    [0.7499, 'Good'],
    [0.5, 'Good'],
    [0.4999, 'Partial'],
    [0.01, 'Partial'],
  ])('calls a relevance of %s a %s match', (relevance, word) => {
    expect(reasonFor([match('x', relevance, ['title'])])).toBe(`${word} match for "x" (title).`);
  });

  it('leaves out the brackets when it does not know where the match was', () => {
    expect(reasonFor([match('x', 0.6)])).toBe('Good match for "x".');
  });

  it('does not reorder its argument', () => {
    const matches = [match('low', 0.2), match('high', 0.8)];
    reasonFor(matches);
    expect(matches.map((entry) => entry.interest)).toEqual(['low', 'high']);
  });
});

describe('recommendationView', () => {
  it('adds the relevance, the matched interests and the reason to the summary', () => {
    const session = makeSession('REC', { tags: ['a', 'b', 'c', 'd', 'e', 'f', 'Target'] }, [makeSlot('REC', DAY, '09:00', '10:00')]);
    const scored: ScoredSession = {
      session,
      occurrences: session.occurrences,
      matches: [match('x', 0.9, ['title'], ['Target']), match('y', 0.4, ['description'])],
      total: 1.3049,
      gain: 1,
    };
    const view = recommendationView(scored);
    expect(view.code).toBe('REC');
    expect(view.relevance).toBe(1.3);
    expect(view.matchedInterests).toEqual(['x', 'y']);
    expect(view.why).toBe('Strong match for "x" (title; tags: Target); partial match for "y" (description).');
    expect(view.tags).toEqual(['Target', 'a', 'b', 'c', 'd', 'e']);
  });

  it('lists only the slots that the filters allow', () => {
    const scored: ScoredSession = { session: crowded, occurrences: crowded.occurrences.slice(0, 1), matches: [match('x', 1)], total: 1, gain: 1 };
    expect(recommendationView(scored).slots).toHaveLength(1);
  });
});

describe('relatedView', () => {
  it('gives the code, title, type and the first time slot', () => {
    expect(relatedView(sessionOf(catalog, 'BRK316'))).toEqual({
      code: 'BRK316',
      title: 'Winning the Race Against Time with Autonomous Protection',
      type: 'Breakout',
      when: 'Wed Nov 18, 11:30 AM–12:15 PM · Moscone West, Level 2, Room 2006',
    });
  });

  it('counts the other slots of a session that is offered more than once', () => {
    const lab = sessionOf(catalog, 'LAB652');
    const first = slotView(lab.occurrences[0]!).label;
    expect(lab.occurrences).toHaveLength(4);
    expect(relatedView(lab).when).toBe(`${first} (+3 more)`);
  });

  it('has no time for an on-demand session', () => {
    expect(relatedView(sessionOf(catalog, 'LAB711D'))).not.toHaveProperty('when');
  });
});

describe('liveView', () => {
  const item = (minutes: number, index = 0): LiveItem => ({
    session: crowded,
    occurrence: crowded.occurrences[index]!,
    relevance: 1,
    matchedFields: [],
    matchedTags: ['t8'],
    minutes,
  });

  it('says how many minutes are left for a session in progress', () => {
    const view = liveView(item(35), 'in_progress');
    expect(view.minutesLeft).toBe(35);
    expect(view).not.toHaveProperty('startsInMinutes');
  });

  it('says in how many minutes a session starts', () => {
    const view = liveView(item(25), 'upcoming');
    expect(view.startsInMinutes).toBe(25);
    expect(view).not.toHaveProperty('minutesLeft');
  });

  it('lists only the slot that is running or about to start, and favours the matched tags', () => {
    const view = liveView(item(25, 1), 'upcoming');
    expect(view.slots.map((slot) => slot.startTime)).toEqual(['13:00']);
    expect(view.tags[0]).toBe('t8');
  });
});

describe('alternativeView and skippedView', () => {
  const [first] = pair();

  it('describes a good match that runs at the same time', () => {
    const alternative: Alternative = { session: first, occurrence: first.occurrences[0]!, matches: [match('a', 0.9), match('b', 0.6)] };
    expect(alternativeView(alternative)).toEqual({
      code: 'AAA',
      title: 'AAA',
      slotId: 'AAA@2026-11-17T09:00',
      label: 'Tue Nov 17, 9:00–10:00 AM · Moscone West, Room 1',
      matchedInterests: ['a', 'b'],
    });
  });

  it('describes a good match that did not fit, with the reason', () => {
    const skipped: SkippedSession = { session: first, occurrence: first.occurrences[0]!, matches: [], reason: 'Tue Nov 17 already has 2 sessions' };
    expect(skippedView(skipped)).toEqual({
      code: 'AAA',
      title: 'AAA',
      label: 'Tue Nov 17, 9:00–10:00 AM · Moscone West, Room 1',
      reason: 'Tue Nov 17 already has 2 sessions',
    });
  });
});

describe('agendaItemView', () => {
  const [first, second] = pair();
  const item = (overrides: Partial<AgendaItem> = {}): AgendaItem => ({
    entry: entryOf(first),
    pinned: false,
    matches: [match('security', 0.9, ['title'])],
    alternatives: [],
    ...overrides,
  });

  it('explains why the session was picked', () => {
    const view = agendaItemView(item());
    expect(view.pinned).toBe(false);
    expect(view.matchedInterests).toEqual(['security']);
    expect(view.why).toBe('Strong match for "security" (title).');
  });

  it('says that a session was requested, and keeps the reason', () => {
    expect(agendaItemView(item({ pinned: true })).why).toBe('Included because you asked for it. Strong match for "security" (title).');
  });

  it('says only that a requested session was requested when it matches no interest', () => {
    const view = agendaItemView(item({ pinned: true, matches: [] }));
    expect(view.pinned).toBe(true);
    expect(view.why).toBe('Included because you asked for it.');
    expect(view.matchedInterests).toEqual([]);
  });

  it('has no reason for a session that matches nothing and was not requested', () => {
    expect(agendaItemView(item({ matches: [] })).why).toBe('');
  });

  it('lists the planned slot, the other slots and the alternatives', () => {
    const lab = sessionOf(catalog, 'LAB711');
    const view = agendaItemView(
      item({
        entry: entryOf(lab, false, 1),
        alternatives: [{ session: second, occurrence: second.occurrences[0]!, matches: [match('security', 0.7)] }],
      }),
    );
    expect(view.slots.map((slot) => slot.slotId)).toEqual([lab.occurrences[1]!.slotId]);
    expect(view.otherSlots.map((slot) => slot.slotId)).toEqual(lab.occurrences.filter((_, index) => index !== 1).map((slot) => slot.slotId));
    expect(view.alternatives).toEqual([
      { code: 'BBB', title: 'BBB', slotId: 'BBB@2026-11-17T09:50', label: 'Tue Nov 17, 9:50–10:30 AM · Moscone West, Room 1', matchedInterests: ['security'] },
    ]);
  });
});

describe('scheduleView', () => {
  it('says whether the time slot was picked for the attendee', () => {
    const lab = sessionOf(catalog, 'LAB711');
    const named = scheduleView(entryOf(lab, true));
    const picked = scheduleView(entryOf(lab, false));
    expect(named.slotChosen).toBe(false);
    expect(picked.slotChosen).toBe(true);
    expect(picked.slots).toHaveLength(1);
    expect(picked.otherSlots).toHaveLength(lab.occurrences.length - 1);
  });
});

describe('conflictMessage and conflictView', () => {
  const [first, second] = pair();
  const conflict = (overrides: Partial<Conflict> = {}): Conflict => ({
    kind: 'overlap',
    first: entryOf(first),
    second: entryOf(second),
    minutes: 10,
    requiredGapMinutes: 20,
    ...overrides,
  });

  it('says by how many minutes two sessions overlap', () => {
    expect(conflictMessage(conflict())).toBe('AAA (9:00–10:00 AM, Moscone West) and BBB (9:50–10:30 AM, Moscone West) overlap by 10 minutes.');
    expect(conflictMessage(conflict({ minutes: 1 }))).toContain('overlap by 1 minute.');
    expect(conflictMessage(conflict({ minutes: 90 }))).toContain('overlap by 1 hour 30 minutes.');
  });

  it('says how much time is left between two sessions and how much is needed', () => {
    expect(conflictMessage(conflict({ kind: 'tight', minutes: 5, requiredGapMinutes: 20 }))).toBe(
      'Only 5 minutes between AAA (9:00–10:00 AM, Moscone West) and BBB (9:50–10:30 AM, Moscone West); about 20 minutes are needed.',
    );
    expect(conflictMessage(conflict({ kind: 'tight', minutes: 1, requiredGapMinutes: 10 }))).toMatch(/^Only 1 minute between .*; about 10 minutes are needed\.$/);
  });

  it('says that there is no time at all between two sessions', () => {
    expect(conflictMessage(conflict({ kind: 'tight', minutes: 0, requiredGapMinutes: 10 }))).toMatch(/^No time between AAA .* and BBB .*; about 10 minutes are needed\.$/);
  });

  it('leaves out the venue of a slot that has none', () => {
    const slot = { ...makeSlot('AAA', DAY, '09:00', '10:00'), venue: undefined };
    const noVenue = makeSession('AAA', {}, [slot]);
    expect(conflictMessage(conflict({ first: entryOf(noVenue) }))).toMatch(/^AAA \(9:00–10:00 AM\) and BBB \(9:50–10:30 AM, Moscone West\) overlap/);
  });

  it('describes both sides of a conflict', () => {
    expect(conflictView(conflict())).toEqual({
      kind: 'overlap',
      minutes: 10,
      requiredGapMinutes: 20,
      first: { code: 'AAA', title: 'AAA', slotId: 'AAA@2026-11-17T09:00', label: 'Tue Nov 17, 9:00–10:00 AM · Moscone West, Room 1' },
      second: { code: 'BBB', title: 'BBB', slotId: 'BBB@2026-11-17T09:50', label: 'Tue Nov 17, 9:50–10:30 AM · Moscone West, Room 1' },
      message: conflictMessage(conflict()),
    });
  });
});

describe('sessionDetailView', () => {
  it('gives the whole session', () => {
    const view = sessionDetailView(catalog, sessionOf(catalog, 'BRK217'));
    expect(view).toMatchObject({
      code: 'BRK217',
      type: 'Breakout',
      level: 'Level 200 (Intermediate)',
      topics: ['Copilot'],
      audiences: ['Technical Practitioner'],
      tags: ['SharePoint', 'Microsoft Copilot', 'Microsoft 365'],
      recorded: true,
      liveStream: true,
      onDemand: false,
      speakers: [{ name: 'Rk Menon' }, { name: 'Matt Wolodarsky' }, { name: 'Amy Curley, PhD', role: 'Customer' }],
    });
    expect(view.speakers[0]).not.toHaveProperty('role');
    expect(view.description.length).toBeGreaterThan(200);
    expect(view.slots).toHaveLength(1);
  });

  it('lists the linked sessions, then similar ones that are not linked', () => {
    const session = sessionOf(catalog, 'BRK316');
    const view = sessionDetailView(catalog, session);
    expect(view.related.map((item) => item.code)).toEqual(['BRK323', 'BRK320']);
    const linked = new Set(view.related.map((item) => item.code));
    expect(view.similar).toHaveLength(5);
    expect(view.similar.every((item) => item.code !== 'BRK316' && !linked.has(item.code))).toBe(true);
    expect(view.similar.map((item) => item.code)).toEqual(
      catalog
        .similar(session, 7)
        .filter((item) => !linked.has(item.code))
        .slice(0, 5)
        .map((item) => item.code),
    );
  });

  it('skips linked codes that are not in the catalog, and shows at most 8 linked and 5 similar sessions', () => {
    const linked = Array.from({ length: 10 }, (_, index) => makeSession(`R${index + 1}`, { tags: ['alpha'] }));
    const others = Array.from({ length: 6 }, (_, index) => makeSession(`S${index + 1}`, { tags: ['alpha'] }));
    const main = makeSession('MAIN', { tags: ['alpha'], relatedCodes: ['GHOST', ...linked.map((session) => session.code)] });
    const view = sessionDetailView(syntheticCatalog([...linked, ...others, main]), main);

    expect(view.related.map((item) => item.code)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8']);
    expect(view.similar).toHaveLength(5);
    expect(view.similar.every((item) => item.code !== 'MAIN' && !view.related.some((related) => related.code === item.code))).toBe(true);
  });

  it('keeps the full description, the resources and the flags', () => {
    const session = makeSession('FULL', {
      description: 'Long. '.repeat(200),
      sponsored: true,
      featured: true,
      reservableSeating: true,
      industries: ['Retail'],
      companies: ['Contoso'],
      resources: [{ label: 'Slides', url: 'https://example.test/slides' }],
      speakers: [{ name: 'Sam', id: 'internal-id', role: 'MVP' }],
    });
    const view = sessionDetailView(syntheticCatalog([session]), session);
    expect(view.description).toBe(session.description);
    expect(view).toMatchObject({
      sponsored: true,
      featured: true,
      reservableSeating: true,
      industries: ['Retail'],
      companies: ['Contoso'],
      resources: [{ label: 'Slides', url: 'https://example.test/slides' }],
      speakers: [{ name: 'Sam', role: 'MVP' }],
      slots: [],
      onDemand: true,
    });
    expect(view.speakers[0]).not.toHaveProperty('id');
    expect(view).not.toHaveProperty('level');
  });
});

describe('overviewView', () => {
  const status: StoreStatus = { source: 'live', sessions: 34, dataAsOf: '2026-11-16T12:00:00.000Z', lastCheckedAt: '2026-11-18T16:00:00.000Z', refreshIntervalMinutes: 15 };

  it('describes the event', () => {
    expect(overviewView(catalog, status).event).toEqual({
      name: 'Microsoft Ignite 2026',
      city: 'San Francisco, California',
      timeZone: 'Pacific Time (America/Los_Angeles)',
      firstDay: '2026-11-16',
      lastDay: '2026-11-20',
      sessionsUrl: 'https://ignite.microsoft.com/en-US/sessions',
    });
  });

  it('counts the sessions', () => {
    expect(overviewView(catalog, status).sessions).toEqual({ total: 34, scheduled: 29, onDemand: 5, recorded: 18, liveStream: 15, speakers: 58 });
  });

  it('counts the sessions and slots of each day', () => {
    const days = overviewView(catalog, status).days;
    expect(days.map((day) => [day.date, day.day, day.sessions])).toEqual([
      ['2026-11-16', 'Mon Nov 16', 1],
      ['2026-11-17', 'Tue Nov 17', 13],
      ['2026-11-18', 'Wed Nov 18', 12],
      ['2026-11-19', 'Thu Nov 19', 14],
      ['2026-11-20', 'Fri Nov 20', 1],
    ]);
    expect(days[0]!.slots).toBe(2);
  });

  it('shows the levels the way the sessions do', () => {
    expect(overviewView(catalog, status).levels).toEqual([
      { name: 'Level 100 (Foundational)', count: 5 },
      { name: 'Level 200 (Intermediate)', count: 15 },
      { name: 'Level 300 (Advanced)', count: 10 },
      { name: 'Level 400 (Expert)', count: 2 },
    ]);
  });

  it('passes the other facets on and shows only the most popular tags', () => {
    const view = overviewView(catalog, status);
    expect(view.types).toEqual(catalog.facets.types);
    expect(view.topics).toEqual(catalog.facets.topics);
    expect(view.venues[0]).toEqual({ name: 'Moscone West', count: 28 });
    expect(catalog.facets.tags.length).toBeGreaterThan(25);
    expect(view.topTags).toEqual(catalog.facets.tags.slice(0, 25));
  });

  it('says where the data comes from and when it was checked', () => {
    expect(overviewView(catalog, status).data).toEqual({
      source: 'live',
      asOf: '2026-11-16T12:00:00.000Z',
      lastCheckedAt: '2026-11-18T16:00:00.000Z',
      refreshIntervalMinutes: 15,
    });
  });

  it('leaves out the time of the last check when the store has not checked yet', () => {
    const { lastCheckedAt: _, ...unchecked } = status;
    const data = overviewView(catalog, unchecked).data;
    expect(data).not.toHaveProperty('lastCheckedAt');
    expect(data.refreshIntervalMinutes).toBe(15);
  });

  it('takes the source from the catalog, and does not need a store', () => {
    const data = overviewView(catalog, undefined).data;
    expect(data).toEqual({ source: 'live', asOf: '2026-11-16T12:00:00.000Z', refreshIntervalMinutes: 0 });
  });

  it('copes with an empty catalog', () => {
    const view = overviewView(syntheticCatalog([]), undefined);
    expect(view.sessions).toEqual({ total: 0, scheduled: 0, onDemand: 0, recorded: 0, liveStream: 0, speakers: 0 });
    expect(view.event.firstDay).toBe('');
    expect(view.event.lastDay).toBe('');
    expect(view.days).toEqual([]);
  });
});
