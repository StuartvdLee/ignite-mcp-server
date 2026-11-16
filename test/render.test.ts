import { describe, expect, it } from 'vitest';
import { agendaText, calendarText, conflictsText, overviewText, recommendText, searchText, sessionDetailText, sessionEntry, whatsOnText } from '../src/mcp/render';
import type {
  AgendaOutput,
  AgendaSession,
  CalendarOutput,
  ConflictsOutput,
  ConflictView,
  LiveSession,
  OverviewOutput,
  Recommendation,
  RecommendOutput,
  SearchHitView,
  SearchOutput,
  SessionDetailOutput,
  SessionSummary,
  Slot,
  WhatsOnOutput,
} from '../src/mcp/schemas';

// The renderers turn the views that the tools return into text. They are tested on handcrafted views, so each
// expectation shows the complete text. The real views come from present.ts (see present.test.ts and mcp.test.ts).

const NOTE = 'All times are Pacific Time (San Francisco).';

const lines = (...rows: string[]): string => rows.join('\n');

const slot = (overrides: Partial<Slot> = {}): Slot => ({
  slotId: 'AAA@2026-11-17T09:00',
  day: 'Tue Nov 17',
  date: '2026-11-17',
  startTime: '09:00',
  endTime: '10:00',
  startUtc: '2026-11-17T17:00:00.000Z',
  endUtc: '2026-11-17T18:00:00.000Z',
  durationMinutes: 60,
  venue: 'Moscone West',
  room: 'Room 1',
  label: 'Tue Nov 17, 9:00–10:00 AM · Moscone West, Room 1',
  ...overrides,
});

const summary = (code = 'AAA', overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  code,
  title: `Title ${code}`,
  type: 'Breakout',
  level: 'Level 200 (Intermediate)',
  topics: [],
  tags: [],
  speakers: [],
  speakerCount: 0,
  delivery: ['In-person'],
  recorded: false,
  liveStream: false,
  onDemand: false,
  slots: [slot({ slotId: `${code}@2026-11-17T09:00` })],
  summary: '',
  url: `https://example.test/${code}`,
  ...overrides,
});

/** The first three lines of an entry for a session from `summary()`. */
const entryLines = (code: string, bullet = '-', indent = '  '): string[] => [
  `${bullet} **${code}** · [Title ${code}](https://example.test/${code})`,
  `${indent}Breakout · Level 200 (Intermediate) · In-person`,
  `${indent}Tue Nov 17, 9:00–10:00 AM · Moscone West, Room 1`,
];

describe('sessionEntry', () => {
  it('shows the title as a link, the facts, and the time and place', () => {
    expect(sessionEntry(summary())).toBe(lines(...entryLines('AAA')));
  });

  it('numbers an entry and indents the other lines under the number', () => {
    expect(sessionEntry(summary(), { index: 3 })).toBe(lines(...entryLines('AAA', '3.', '   ')));
    expect(sessionEntry(summary(), { index: 12 })).toBe(lines(...entryLines('AAA', '12.', '    ')));
  });

  it('escapes the brackets in a title so the link stays intact', () => {
    expect(sessionEntry(summary('AAA', { title: 'Intro [beta] to MCP' })).split('\n')[0]).toBe('- **AAA** · [Intro \\[beta\\] to MCP](https://example.test/AAA)');
  });

  it('adds Recorded or On demand to the facts, and On demand wins', () => {
    const factsOf = (overrides: Partial<SessionSummary>): string => sessionEntry(summary('AAA', overrides)).split('\n')[1]!;
    expect(factsOf({ recorded: true })).toBe('  Breakout · Level 200 (Intermediate) · In-person · Recorded');
    expect(factsOf({ onDemand: true })).toBe('  Breakout · Level 200 (Intermediate) · In-person · On demand');
    expect(factsOf({ onDemand: true, recorded: true })).toBe('  Breakout · Level 200 (Intermediate) · In-person · On demand');
  });

  it('leaves out the facts a session does not have', () => {
    const factsOf = (overrides: Partial<SessionSummary>): string => sessionEntry(summary('AAA', overrides)).split('\n')[1]!;
    expect(factsOf({ level: undefined, delivery: ['In-person', 'Online'] })).toBe('  Breakout · In-person + Online');
    expect(factsOf({ delivery: [] })).toBe('  Breakout · Level 200 (Intermediate)');
  });

  it('lists every time slot on one line', () => {
    const slots = [slot({ label: 'Tue Nov 17, 9:00–10:00 AM' }), slot({ label: 'Wed Nov 18, 1:00–2:00 PM' })];
    expect(sessionEntry(summary('AAA', { slots })).split('\n')[2]).toBe('  Tue Nov 17, 9:00–10:00 AM | Wed Nov 18, 1:00–2:00 PM');
  });

  it('says when there is no time slot', () => {
    expect(sessionEntry(summary('AAA', { slots: [], onDemand: true })).split('\n')[2]).toBe('  No fixed time: watch on demand');
    expect(sessionEntry(summary('AAA', { slots: [] })).split('\n')[2]).toBe('  Time not announced yet');
  });

  it('lists the speakers and counts the ones that are not shown', () => {
    const speakersOf = (overrides: Partial<SessionSummary>): string | undefined =>
      sessionEntry(summary('AAA', overrides))
        .split('\n')
        .find((line) => line.includes('Speakers:'));
    expect(speakersOf({ speakers: ['Ada Lovelace', 'Grace Hopper'], speakerCount: 2 })).toBe('  Speakers: Ada Lovelace, Grace Hopper');
    expect(speakersOf({ speakers: ['Ada Lovelace', 'Grace Hopper'], speakerCount: 5 })).toBe('  Speakers: Ada Lovelace, Grace Hopper (+3 more)');
    expect(speakersOf({ speakers: [], speakerCount: 0 })).toBeUndefined();
  });

  it('puts the extra lines after the speakers and the excerpt last, all indented', () => {
    const text = sessionEntry(summary('AAA', { speakers: ['Ada Lovelace'], speakerCount: 1, summary: 'A short excerpt.' }), {
      index: 1,
      extra: ['Why: it fits.', 'Matched: title'],
    });
    expect(text).toBe(lines(...entryLines('AAA', '1.', '   '), '   Speakers: Ada Lovelace', '   Why: it fits.', '   Matched: title', '   A short excerpt.'));
  });

  it('leaves out an empty excerpt', () => {
    expect(sessionEntry(summary('AAA', { summary: '' }), { extra: [] }).split('\n')).toHaveLength(3);
  });
});

const hit = (code: string, overrides: Partial<SearchHitView> = {}): SearchHitView => ({ ...summary(code), relevance: 1, matchedOn: [], ...overrides });

const search = (overrides: Partial<SearchOutput> = {}): SearchOutput => ({
  total: 0,
  returned: 0,
  offset: 0,
  query: '',
  alsoSearched: [],
  filters: [],
  warnings: [],
  sessions: [],
  ...overrides,
});

describe('searchText', () => {
  it('says that nothing was found, repeats the query and the filters, and points to the overview', () => {
    const out = search({ query: 'zzzz', filters: ['types: Lab', 'days: Tue Nov 17'], warnings: ['Unknown topic "Foo".'] });
    expect(searchText(out)).toBe(
      lines(
        'No sessions found for "zzzz". Filters: types: Lab; days: Tue Nov 17.',
        'Note: Unknown topic "Foo".',
        'Try different keywords or fewer filters. get_catalog_overview lists the topics, session types and popular tags.',
      ),
    );
  });

  it('leaves out the query and the filters when there are none', () => {
    expect(searchText(search()).split('\n')[0]).toBe('No sessions found.');
    expect(searchText(search({ query: 'zzzz' })).split('\n')[0]).toBe('No sessions found for "zzzz".');
    expect(searchText(search({ filters: ['types: Lab'] })).split('\n')[0]).toBe('No sessions found. Filters: types: Lab.');
  });

  it('says when the offset is past the last match', () => {
    expect(searchText(search({ total: 3, returned: 0, offset: 20, query: 'mcp' }))).toBe('Offset 20 is past the end: only 3 sessions matched for "mcp".');
    expect(searchText(search({ total: 1, returned: 0, offset: 5 }))).toBe('Offset 5 is past the end: only 1 session matched.');
  });

  it('lists one page, numbered as in the whole result, with what matched and a hint for the next page', () => {
    const out = search({
      total: 9,
      returned: 2,
      offset: 2,
      nextOffset: 4,
      query: 'mcp security',
      alsoSearched: ['mcp = model context protocol'],
      filters: ['types: Lab'],
      warnings: ['Unknown day "Sunday".'],
      sessions: [hit('AAA', { matchedOn: ['title', 'tags: MCP'] }), hit('BBB')],
    });
    expect(searchText(out)).toBe(
      lines(
        `9 sessions found for "mcp security"; showing 3–4. Filters: types: Lab. ${NOTE}`,
        'Also searched related terms: mcp = model context protocol.',
        'Note: Unknown day "Sunday".',
        '',
        ...entryLines('AAA', '3.', '   '),
        '   Matched: title; tags: MCP',
        ...entryLines('BBB', '4.', '   '),
        '',
        '5 more sessions: call again with offset=4.',
      ),
    );
  });

  it('counts the sessions left in the singular', () => {
    const out = search({ total: 3, returned: 2, nextOffset: 2, sessions: [hit('AAA'), hit('BBB')] });
    expect(searchText(out).split('\n').at(-1)).toBe('1 more session: call again with offset=2.');
  });

  it('does not offer a next page on the last page, and has no query in the header when browsing', () => {
    const text = searchText(search({ total: 1, returned: 1, sessions: [hit('AAA')] }));
    expect(text).toBe(lines(`1 session found; showing 1–1. ${NOTE}`, '', ...entryLines('AAA', '1.', '   ')));
  });
});

const detail = (overrides: Partial<SessionDetailOutput> = {}): SessionDetailOutput => ({
  code: 'AAA',
  title: 'Title AAA',
  type: 'Breakout',
  level: 'Level 200 (Intermediate)',
  description: 'About the session.',
  topics: [],
  audiences: [],
  industries: [],
  tags: [],
  delivery: ['In-person'],
  speakers: [],
  companies: [],
  recorded: false,
  liveStream: false,
  sponsored: false,
  featured: false,
  reservableSeating: false,
  onDemand: false,
  slots: [slot()],
  resources: [],
  url: 'https://example.test/AAA',
  related: [],
  similar: [],
  ...overrides,
});

describe('sessionDetailText', () => {
  it('shows the heading, the facts, the time slots with their ids and the description', () => {
    expect(sessionDetailText(detail())).toBe(
      lines(
        '# AAA: Title AAA',
        'Breakout · Level 200 (Intermediate) · In-person',
        'Catalog page: https://example.test/AAA',
        '',
        'When (Pacific Time (San Francisco)):',
        '- Tue Nov 17, 9:00–10:00 AM · Moscone West, Room 1 [slot id: AAA@2026-11-17T09:00]',
        '',
        'About the session.',
      ),
    );
  });

  it('shows everything a session has', () => {
    const text = sessionDetailText(
      detail({
        delivery: ['In-person', 'Online'],
        slots: [slot(), slot({ slotId: 'AAA@2026-11-18T13:00', label: 'Wed Nov 18, 1:00–2:00 PM · Moscone West, Room 2' })],
        speakers: [{ name: 'Ada Lovelace', role: 'Executive' }, { name: 'Grace Hopper' }],
        companies: ['Contoso', 'Fabrikam'],
        topics: ['Security', 'Copilot'],
        audiences: ['Developer'],
        industries: ['Retail'],
        tags: ['MCP', 'Zero Trust'],
        recorded: true,
        liveStream: true,
        sponsored: true,
        featured: true,
        reservableSeating: true,
        resources: [
          { label: 'Slides', url: 'https://example.test/slides' },
          { label: 'Deck [v2]', url: 'https://example.test/deck' },
        ],
        related: [{ code: 'BBB', title: 'Title BBB', type: 'Lab', when: 'Wed Nov 18, 10:00 AM–11:00 AM · Room 2' }],
        similar: [
          { code: 'CCC', title: 'Title CCC', type: 'Breakout' },
          { code: 'DDD', title: 'Title DDD', type: 'Keynote', when: 'Thu Nov 19, 9:00 AM' },
        ],
      }),
    );
    expect(text).toBe(
      lines(
        '# AAA: Title AAA',
        'Breakout · Level 200 (Intermediate) · In-person + Online',
        'Catalog page: https://example.test/AAA',
        '',
        'When (Pacific Time (San Francisco)):',
        '- Tue Nov 17, 9:00–10:00 AM · Moscone West, Room 1 [slot id: AAA@2026-11-17T09:00]',
        '- Wed Nov 18, 1:00–2:00 PM · Moscone West, Room 2 [slot id: AAA@2026-11-18T13:00]',
        '',
        'Speakers: Ada Lovelace (Executive), Grace Hopper',
        'Companies: Contoso, Fabrikam',
        'Topics: Security, Copilot',
        'Audience: Developer',
        'Industries: Retail',
        'Tags: MCP, Zero Trust',
        'Flags: Recorded, Live stream, Sponsored, Featured, Reservable seating',
        '',
        'About the session.',
        '',
        'Resources:',
        '- [Slides](https://example.test/slides)',
        '- [Deck \\[v2\\]](https://example.test/deck)',
        '',
        'Linked sessions:',
        '- **BBB** Title BBB (Lab; Wed Nov 18, 10:00 AM–11:00 AM · Room 2)',
        '',
        'Similar sessions:',
        '- **CCC** Title CCC (Breakout)',
        '- **DDD** Title DDD (Keynote; Thu Nov 19, 9:00 AM)',
      ),
    );
  });

  it('says what is missing: no time, no description, no level', () => {
    const onDemand = sessionDetailText(detail({ slots: [], onDemand: true, description: '', level: undefined, delivery: [] }));
    expect(onDemand).toBe(lines('# AAA: Title AAA', 'Breakout', 'Catalog page: https://example.test/AAA', '', 'When:', '- On demand: no fixed time', '', 'No description available.'));

    const unscheduled = sessionDetailText(detail({ slots: [] }));
    expect(unscheduled).toContain('When:\n- Not scheduled yet');
  });

  it('lists only the flags that are set', () => {
    expect(sessionDetailText(detail({ liveStream: true, featured: true }))).toContain('\nFlags: Live stream, Featured\n');
    expect(sessionDetailText(detail())).not.toContain('Flags:');
  });

  it('shows only the speakers heading when there are speakers, without a role', () => {
    expect(sessionDetailText(detail({ speakers: [{ name: 'Grace Hopper' }] }))).toContain('\nSpeakers: Grace Hopper\n');
    expect(sessionDetailText(detail())).not.toContain('Speakers:');
  });
});

const recommendation = (code: string, overrides: Partial<Recommendation> = {}): Recommendation => ({
  ...summary(code),
  relevance: 1.25,
  matchedInterests: [],
  why: 'Strong match for "MCP".',
  ...overrides,
});

const recommend = (overrides: Partial<RecommendOutput> = {}): RecommendOutput => ({
  interests: [],
  unmatchedInterests: [],
  returned: 0,
  filters: [],
  warnings: [],
  recommendations: [],
  ...overrides,
});

describe('recommendText', () => {
  it('says that nothing matched and what to try', () => {
    const out = recommend({ filters: ['levels: Level 400'], warnings: ['Unknown level "999".'] });
    expect(recommendText(out)).toBe(
      lines('No sessions matched your interests. Filters: levels: Level 400.', 'Note: Unknown level "999".', 'Try other words, broader topics or fewer filters.'),
    );
    expect(recommendText(recommend())).toBe(lines('No sessions matched your interests.', 'Try other words, broader topics or fewer filters.'));
  });

  it('lists the recommendations with the reason and says how well each interest matched', () => {
    const out = recommend({
      interests: [
        { interest: 'MCP', matches: 9, alsoSearched: [] },
        { interest: 'zero trust', matches: 0, alsoSearched: [] },
      ],
      unmatchedInterests: ['zero trust'],
      returned: 2,
      filters: ['topics: Security'],
      warnings: ['Unknown topic "Foo".'],
      recommendations: [recommendation('AAA'), recommendation('BBB', { why: 'Good match for "MCP".' })],
    });
    expect(recommendText(out)).toBe(
      lines(
        `2 recommendations for "MCP" and "zero trust". Filters: topics: Security. ${NOTE}`,
        'Good matches per interest: "MCP" (9), "zero trust" (0).',
        'No good match for "zero trust": try other words or fewer filters.',
        'Note: Unknown topic "Foo".',
        '',
        ...entryLines('AAA', '1.', '   '),
        '   Why: Strong match for "MCP".',
        ...entryLines('BBB', '2.', '   '),
        '   Why: Good match for "MCP".',
      ),
    );
  });

  it('names one interest, three interests and several unmatched interests', () => {
    const interest = (name: string) => ({ interest: name, matches: 1, alsoSearched: [] });
    const one = recommendText(recommend({ interests: [interest('MCP')], returned: 1, recommendations: [recommendation('AAA')] }));
    expect(one.split('\n')[0]).toBe(`1 recommendation for "MCP". ${NOTE}`);

    const three = recommendText(recommend({ interests: [interest('a'), interest('b'), interest('c')], returned: 1, unmatchedInterests: ['b', 'c'], recommendations: [recommendation('AAA')] }));
    expect(three.split('\n')[0]).toBe(`1 recommendation for "a", "b" and "c". ${NOTE}`);
    expect(three).toContain('\nNo good match for "b" and "c": try other words or fewer filters.\n');
  });
});

const live = (code: string, overrides: Partial<LiveSession> = {}): LiveSession => ({ ...summary(code), ...overrides });

const whatsOn = (overrides: Partial<WhatsOnOutput> = {}): WhatsOnOutput => ({
  phase: 'during_event',
  at: '2026-11-17T22:10:00.000Z',
  atLabel: 'Tue Nov 17, 2:10 PM',
  windowMinutes: 60,
  inProgress: { total: 0, sessions: [] },
  startingSoon: { total: 0, sessions: [] },
  next: { total: 0, sessions: [] },
  filters: [],
  warnings: [],
  message: 'At Tue Nov 17, 2:10 PM: nothing is on.',
  ...overrides,
});

describe('whatsOnText', () => {
  it('is only the message, and the notes, when no session is listed', () => {
    expect(whatsOnText(whatsOn())).toBe('At Tue Nov 17, 2:10 PM: nothing is on.');
    expect(whatsOnText(whatsOn({ warnings: ['Unknown track "x".'] }))).toBe(lines('At Tue Nov 17, 2:10 PM: nothing is on.', 'Note: Unknown track "x".'));
  });

  it('lists the sessions in progress, starting soon and next, with the time left or until the start', () => {
    const out = whatsOn({
      message: 'At Tue Nov 17, 2:10 PM: 2 sessions in progress and 1 session starting within 1 hour 30 minutes.',
      windowMinutes: 90,
      warnings: ['Unknown track "x".'],
      inProgress: { total: 2, sessions: [live('AAA', { minutesLeft: 35 }), live('BBB', { minutesLeft: 65 })] },
      startingSoon: { total: 1, sessions: [live('CCC', { startsInMinutes: 25 })] },
      next: { total: 1, sessions: [live('DDD', { startsInMinutes: 95, slots: [] })] },
    });
    const line = (code: string, rest: string): string => `- **${code}** · [Title ${code}](https://example.test/${code}) · Breakout${rest}`;
    const place = ' · Tue Nov 17, 9:00–10:00 AM · Moscone West, Room 1';
    expect(whatsOnText(out)).toBe(
      lines(
        'At Tue Nov 17, 2:10 PM: 2 sessions in progress and 1 session starting within 1 hour 30 minutes.',
        'Note: Unknown track "x".',
        '',
        'In progress:',
        line('AAA', `${place} · 35 minutes left`),
        line('BBB', `${place} · 1 hour 5 minutes left`),
        '',
        'Starting within 1 hour 30 minutes:',
        line('CCC', `${place} · starts in 25 minutes`),
        '',
        'Next to start:',
        line('DDD', ' · starts in 1 hour 35 minutes'),
      ),
    );
  });

  it('says how many of the sessions in a group are shown', () => {
    const out = whatsOn({
      inProgress: { total: 5, sessions: [live('AAA', { minutesLeft: 10 })] },
      startingSoon: { total: 1, sessions: [live('BBB', { startsInMinutes: 10 })] },
    });
    const text = whatsOnText(out);
    expect(text).toContain('\nIn progress (1 of 5 shown):\n');
    expect(text).toContain('\nStarting within 1 hour:\n');
  });

  it('leaves out the group headings of groups without sessions', () => {
    const text = whatsOnText(whatsOn({ next: { total: 1, sessions: [live('AAA', { startsInMinutes: 600 })] } }));
    expect(text).toContain('\nNext to start:\n');
    expect(text).not.toContain('In progress');
    expect(text).not.toContain('Starting within');
    expect(text).toContain('starts in 10 hours');
  });
});

const agendaSession = (code: string, overrides: Partial<AgendaSession> = {}): AgendaSession => ({
  ...summary(code),
  pinned: false,
  matchedInterests: [],
  why: '',
  otherSlots: [],
  alternatives: [],
  ...overrides,
});

const agenda = (overrides: Partial<AgendaOutput> = {}): AgendaOutput => ({
  assumptions: ['Times are Pacific Time.'],
  totalSessions: 0,
  days: [],
  onDemand: [],
  skipped: [],
  coverage: [],
  uncoveredInterests: [],
  pinnedConflicts: [],
  unresolved: [],
  slotIds: [],
  filters: [],
  warnings: [],
  ...overrides,
});

const side = (code: string): ConflictView['first'] => ({ code, title: `Title ${code}`, slotId: `${code}@2026-11-17T09:00`, label: 'Tue Nov 17, 9:00–10:00 AM' });

const conflict = (message: string, overrides: Partial<ConflictView> = {}): ConflictView => ({
  kind: 'overlap',
  minutes: 10,
  requiredGapMinutes: 20,
  first: side('AAA'),
  second: side('BBB'),
  message,
  ...overrides,
});

describe('agendaText', () => {
  it('says that nothing could be planned, and still lists the assumptions', () => {
    const out = agenda({ warnings: ['Unknown topic "Foo".'], assumptions: ['Times are Pacific Time.', 'At most 2 sessions per day.'] });
    expect(agendaText(out)).toBe(
      lines('No scheduled sessions could be planned.', 'Note: Unknown topic "Foo".', '', 'Assumptions:', '- Times are Pacific Time.', '- At most 2 sessions per day.'),
    );
  });

  it('lays out the days, the on-demand sessions, what did not fit and how to export', () => {
    const out = agenda({
      totalSessions: 3,
      warnings: ['Only 2 sessions matched.'],
      assumptions: ['Times are Pacific Time.', 'At most 2 sessions per day.'],
      days: [
        {
          date: '2026-11-17',
          day: 'Tue Nov 17',
          sessions: [
            agendaSession('AAA', {
              pinned: true,
              why: 'Included because you asked for it.',
              alternatives: [
                { code: 'ALT1', title: 'Other talk', slotId: 'ALT1@2026-11-17T09:00', label: 'Tue Nov 17, 9:00–10:00 AM', matchedInterests: ['x'] },
                { code: 'ALT2', title: 'Another one', slotId: 'ALT2@2026-11-17T09:00', label: 'Tue Nov 17, 9:00–10:00 AM', matchedInterests: ['x'] },
              ],
              otherSlots: [slot({ label: 'Wed Nov 18, 9:00–10:00 AM · Moscone West, Room 1' }), slot({ label: 'Thu Nov 19, 9:00–10:00 AM' })],
            }),
          ],
        },
        {
          date: '2026-11-18',
          day: 'Wed Nov 18',
          sessions: [
            agendaSession('BBB', { why: 'Good match for "x".', recorded: true, slots: [slot({ slotId: 'BBB@2026-11-18T11:30', startTime: '11:30', endTime: '12:15', venue: undefined, room: undefined })] }),
          ],
        },
      ],
      onDemand: [recommendation('OD1', { onDemand: true, slots: [], why: 'Good match for "y".' })],
      skipped: [{ code: 'SKIP', title: 'Skipped talk', label: 'Thu Nov 19, 9:00–10:00 AM', reason: 'Thu Nov 19 already has 2 sessions' }],
      coverage: [
        { interest: 'x', sessions: 4 },
        { interest: 'y', sessions: 1 },
        { interest: 'z', sessions: 0 },
      ],
      uncoveredInterests: ['z'],
      pinnedConflicts: [conflict('AAA (9:00–10:00 AM) and CCC (9:50–10:30 AM) overlap by 10 minutes.')],
      unresolved: [{ ref: 'nope', reason: 'No session found for "nope".' }],
      slotIds: ['AAA@2026-11-17T09:00', 'BBB@2026-11-18T11:30'],
    });
    expect(agendaText(out)).toBe(
      lines(
        `Agenda: 3 sessions on 2 days. ${NOTE}`,
        'Note: Only 2 sessions matched.',
        '',
        'Assumptions:',
        '- Times are Pacific Time.',
        '- At most 2 sessions per day.',
        '',
        '## Tue Nov 17',
        '- 9:00–10:00 AM · **AAA** · [Title AAA](https://example.test/AAA) (requested)',
        '  Breakout · Level 200 (Intermediate) · In-person · Moscone West, Room 1',
        '  Why: Included because you asked for it.',
        '  At the same time: ALT1 Other talk; ALT2 Another one',
        '  Also offered: Wed Nov 18, 9:00–10:00 AM · Moscone West, Room 1 | Thu Nov 19, 9:00–10:00 AM',
        '',
        '## Wed Nov 18',
        '- 11:30 AM–12:15 PM · **BBB** · [Title BBB](https://example.test/BBB)',
        '  Breakout · Level 200 (Intermediate) · In-person · Recorded',
        '  Why: Good match for "x".',
        '',
        '## On demand (watch any time)',
        '- **OD1** · [Title OD1](https://example.test/OD1)',
        '  Breakout · Level 200 (Intermediate) · In-person · On demand',
        '  No fixed time: watch on demand',
        '  Why: Good match for "y".',
        '',
        'Good matches that did not fit:',
        '- **SKIP** Skipped talk (Thu Nov 19, 9:00–10:00 AM): Thu Nov 19 already has 2 sessions',
        '',
        'Sessions per interest: "x" (4), "y" (1), "z" (0).',
        'Not covered: "z". Try other words or relax the filters.',
        '',
        'Clashes between the sessions you asked for:',
        '- AAA (9:00–10:00 AM) and CCC (9:50–10:30 AM) overlap by 10 minutes.',
        '',
        'Could not find:',
        '- "nope": No session found for "nope".',
        '',
        'To add this agenda to a calendar, call export_calendar with items: ["AAA@2026-11-17T09:00","BBB@2026-11-18T11:30"]',
      ),
    );
  });

  it('counts one session on one day in the singular', () => {
    const out = agenda({ totalSessions: 1, days: [{ date: '2026-11-17', day: 'Tue Nov 17', sessions: [agendaSession('AAA')] }] });
    expect(agendaText(out).split('\n')[0]).toBe(`Agenda: 1 session on 1 day. ${NOTE}`);
  });

  it('does not mark a session as requested unless it was pinned, and has no Why line without a reason', () => {
    const out = agenda({ totalSessions: 1, days: [{ date: '2026-11-17', day: 'Tue Nov 17', sessions: [agendaSession('AAA')] }] });
    const text = agendaText(out);
    expect(text).not.toContain('(requested)');
    expect(text).not.toContain('Why:');
    expect(text).not.toContain('At the same time');
    expect(text).not.toContain('Also offered');
  });

  it('shows a session without a time slot as to be announced, without a place', () => {
    const out = agenda({ totalSessions: 1, days: [{ date: '2026-11-17', day: 'Tue Nov 17', sessions: [agendaSession('AAA', { slots: [] })] }] });
    expect(agendaText(out).endsWith('\n- Time to be announced · **AAA** · [Title AAA](https://example.test/AAA)\n  Breakout · Level 200 (Intermediate) · In-person')).toBe(true);
  });

  it('leaves out the sections that are empty', () => {
    const text = agendaText(agenda({ totalSessions: 1, days: [{ date: '2026-11-17', day: 'Tue Nov 17', sessions: [agendaSession('AAA')] }] }));
    for (const heading of ['On demand', 'did not fit', 'Sessions per interest', 'Not covered', 'Clashes', 'Could not find', 'export_calendar']) {
      expect(text).not.toContain(heading);
    }
  });
});

const scheduled = (code: string, overrides: Partial<ConflictsOutput['schedule'][number]> = {}): ConflictsOutput['schedule'][number] => ({
  ...summary(code),
  slotChosen: false,
  otherSlots: [],
  ...overrides,
});

const conflicts = (overrides: Partial<ConflictsOutput> = {}): ConflictsOutput => ({
  ok: true,
  assumptions: ['Times are Pacific Time.'],
  schedule: [],
  conflicts: [],
  onDemand: [],
  unresolved: [],
  suggestions: [],
  ...overrides,
});

const SLOT_LABEL = 'Tue Nov 17, 9:00–10:00 AM · Moscone West, Room 1';

describe('conflictsText', () => {
  it('says that the sessions fit together and shows the schedule', () => {
    const out = conflicts({ schedule: [scheduled('AAA'), scheduled('BBB')] });
    expect(conflictsText(out)).toBe(
      lines(
        `No conflicts: 2 sessions fit together. ${NOTE}`,
        '',
        'Assumptions:',
        '- Times are Pacific Time.',
        '',
        'Schedule:',
        `- ${SLOT_LABEL} · **AAA** · [Title AAA](https://example.test/AAA)`,
        `- ${SLOT_LABEL} · **BBB** · [Title BBB](https://example.test/BBB)`,
      ),
    );
  });

  it('does not say that one session, or none, fits together', () => {
    const one = conflictsText(conflicts({ schedule: [scheduled('AAA')], onDemand: [summary('OD1', { slots: [], onDemand: true })] }));
    expect(one.split('\n')[0]).toBe(`No conflicts: only one session has a fixed time. ${NOTE}`);

    const none = conflictsText(conflicts({ onDemand: [summary('OD1', { slots: [], onDemand: true })] }));
    expect(none.split('\n')[0]).toBe(`No conflicts: none of the sessions has a fixed time. ${NOTE}`);
  });

  it('lists the conflicts and the suggestions', () => {
    const out = conflicts({
      ok: false,
      schedule: [scheduled('AAA'), scheduled('BBB')],
      conflicts: [conflict('AAA and BBB overlap by 10 minutes.'), conflict('BBB and CCC overlap by 5 minutes.')],
      suggestions: ['Move BBB to Wed Nov 18, 9:00–10:00 AM (slot id BBB@2026-11-18T09:00): it fits the rest of the schedule.'],
    });
    const text = conflictsText(out);
    expect(text.split('\n')[0]).toBe(`2 conflicts found. ${NOTE}`);
    expect(text).toContain('\n\nConflicts:\n- AAA and BBB overlap by 10 minutes.\n- BBB and CCC overlap by 5 minutes.\n');
    expect(text.endsWith('\n\nSuggestions:\n- Move BBB to Wed Nov 18, 9:00–10:00 AM (slot id BBB@2026-11-18T09:00): it fits the rest of the schedule.')).toBe(true);
    expect(conflictsText(conflicts({ ok: false, conflicts: [conflict('x')] })).split('\n')[0]).toBe(`1 conflict found. ${NOTE}`);
  });

  it('says which time slot was picked for a session that is offered several times', () => {
    const picked = scheduled('AAA', { slotChosen: true, otherSlots: [slot({ label: 'Wed Nov 18, 9:00–10:00 AM' }), slot({ label: 'Thu Nov 19, 9:00–10:00 AM' })] });
    expect(conflictsText(conflicts({ schedule: [picked, scheduled('BBB')] }))).toContain(
      `- ${SLOT_LABEL} · **AAA** · [Title AAA](https://example.test/AAA) (time slot picked for you; also offered: Wed Nov 18, 9:00–10:00 AM | Thu Nov 19, 9:00–10:00 AM)\n`,
    );
  });

  it('lists the on-demand sessions and the references that were not found', () => {
    const out = conflicts({
      ok: false,
      schedule: [scheduled('AAA'), scheduled('BBB')],
      onDemand: [summary('OD1', { slots: [], onDemand: true })],
      unresolved: [{ ref: 'nope', reason: 'No session found for "nope".' }],
    });
    const text = conflictsText(out);
    expect(text.split('\n')[0]).toBe(`Some references could not be resolved. ${NOTE}`);
    expect(text).toContain('\n\nOn demand (no time to clash):\n- **OD1** · [Title OD1](https://example.test/OD1)\n');
    expect(text.endsWith('\n\nCould not find:\n- "nope": No session found for "nope".')).toBe(true);
  });

  it('puts the conflicts first when references were not found as well', () => {
    const out = conflicts({ ok: false, conflicts: [conflict('x')], unresolved: [{ ref: 'nope', reason: 'Not found.' }] });
    const text = conflictsText(out);
    expect(text.split('\n')[0]).toBe(`1 conflict found. ${NOTE}`);
    expect(text).toContain('Could not find:');
  });

  it('leaves out the sections that are empty', () => {
    const text = conflictsText(conflicts({ schedule: [scheduled('AAA'), scheduled('BBB')] }));
    for (const heading of ['Conflicts:', 'Suggestions:', 'On demand', 'Could not find', 'picked for you']) expect(text).not.toContain(heading);
  });
});

const calendar = (overrides: Partial<CalendarOutput> = {}): CalendarOutput => ({
  filename: 'ignite-2026.ics',
  eventCount: 0,
  events: [],
  ics: '',
  conflicts: [],
  onDemand: [],
  unresolved: [],
  ...overrides,
});

const events = (...codes: string[]): CalendarOutput['events'] =>
  codes.map((code) => ({ code, title: `Title ${code}`, slotId: `${code}@2026-11-17T09:00`, label: 'Tue Nov 17, 9:00–10:00 AM' }));

describe('calendarText', () => {
  it('says that no file was created when no session has a fixed time, and lists what was left out', () => {
    const out = calendar({
      onDemand: [{ code: 'OD1', title: 'Title OD1', url: 'https://example.test/OD1' }],
      unresolved: [{ ref: 'nope', reason: 'No session found for "nope".' }],
    });
    expect(calendarText(out)).toBe(
      lines(
        'No calendar file was created: none of the sessions has a fixed time slot.',
        '',
        'Left out because they have no fixed time (watch on demand):',
        '- **OD1** · [Title OD1](https://example.test/OD1)',
        '',
        'Could not find:',
        '- "nope": No session found for "nope".',
      ),
    );
  });

  it('gives the download link when there is one, instead of the file', () => {
    const out = calendar({ eventCount: 2, events: events('AAA', 'BBB'), downloadUrl: 'https://ignite.example.test/calendar.ics?sessions=AAA', ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' });
    const text = calendarText(out);
    expect(text).toBe(
      lines(
        'Calendar with 2 sessions ready (ignite-2026.ics). Times are stored in UTC, so your calendar shows them in your own time zone.',
        'Download: https://ignite.example.test/calendar.ics?sessions=AAA',
        'Open the link, then import the .ics file into Outlook, Google Calendar or Apple Calendar.',
        '',
        'Sessions:',
        '- **AAA** Title AAA (Tue Nov 17, 9:00–10:00 AM)',
        '- **BBB** Title BBB (Tue Nov 17, 9:00–10:00 AM)',
      ),
    );
    expect(text).not.toContain('BEGIN:VCALENDAR');
  });

  it('includes the file itself when there is no download link', () => {
    const out = calendar({ eventCount: 1, events: events('AAA'), ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' });
    expect(calendarText(out)).toBe(
      lines(
        'Calendar with 1 session ready (ignite-2026.ics). Times are stored in UTC, so your calendar shows them in your own time zone.',
        'Save the text below as ignite-2026.ics and open it with your calendar app.',
        '',
        '```ics',
        'BEGIN:VCALENDAR\r\nEND:VCALENDAR',
        '```',
        '',
        'Sessions:',
        '- **AAA** Title AAA (Tue Nov 17, 9:00–10:00 AM)',
      ),
    );
  });

  it('warns about sessions that clash and about the ones that were left out', () => {
    const out = calendar({
      eventCount: 2,
      events: events('AAA', 'BBB'),
      downloadUrl: 'https://ignite.example.test/calendar.ics?sessions=AAA',
      conflicts: [conflict('AAA and BBB overlap by 10 minutes.')],
      onDemand: [{ code: 'OD1', title: 'Title OD1', url: 'https://example.test/OD1' }],
      unresolved: [{ ref: 'nope', reason: 'Not found.' }],
    });
    const text = calendarText(out);
    expect(text).toContain('\n\nHeads-up, these sessions clash:\n- AAA and BBB overlap by 10 minutes.\n');
    expect(text).toContain('\n\nLeft out because they have no fixed time (watch on demand):\n- **OD1** · [Title OD1](https://example.test/OD1)\n');
    expect(text.endsWith('\n\nCould not find:\n- "nope": Not found.')).toBe(true);
  });
});

const overview = (overrides: Partial<OverviewOutput> = {}): OverviewOutput => ({
  event: {
    name: 'Microsoft Ignite 2026',
    city: 'San Francisco, California',
    timeZone: 'Pacific Time (America/Los_Angeles)',
    firstDay: '2026-11-16',
    lastDay: '2026-11-20',
    sessionsUrl: 'https://ignite.microsoft.com/en-US/sessions',
  },
  sessions: { total: 34, scheduled: 29, onDemand: 5, recorded: 18, liveStream: 15, speakers: 58 },
  days: [
    { date: '2026-11-16', day: 'Mon Nov 16', sessions: 1, slots: 2 },
    { date: '2026-11-17', day: 'Tue Nov 17', sessions: 13, slots: 13 },
  ],
  venues: [
    { name: 'Moscone West', count: 28 },
    { name: 'Chase Center', count: 1 },
  ],
  types: [{ name: 'Breakout', count: 12 }],
  topics: [{ name: 'Security', count: 13 }],
  levels: [{ name: 'Level 100 (Foundational)', count: 5 }],
  audiences: [{ name: 'Developer', count: 7 }],
  industries: [{ name: 'Retail', count: 2 }],
  delivery: [
    { name: 'In-person', count: 29 },
    { name: 'Online', count: 20 },
  ],
  topTags: [{ name: 'AI', count: 9 }],
  data: { source: 'live', asOf: '2026-11-16T12:00:00.000Z', refreshIntervalMinutes: 15 },
  ...overrides,
});

describe('overviewText', () => {
  it('shows the event, the numbers, every facet and where the data comes from', () => {
    expect(overviewText(overview())).toBe(
      lines(
        'Microsoft Ignite 2026: San Francisco, California, 2026-11-16 to 2026-11-20 (Pacific Time (America/Los_Angeles)). Catalog: https://ignite.microsoft.com/en-US/sessions',
        '34 sessions: 29 scheduled and 5 on demand; 18 recorded, 15 live streamed; 58 speakers.',
        '',
        'Days: Mon Nov 16 (1 session), Tue Nov 17 (13 sessions)',
        'Venues: Moscone West (28), Chase Center (1)',
        'Session types: Breakout (12)',
        'Topics: Security (13)',
        'Levels: Level 100 (Foundational) (5)',
        'Audiences: Developer (7)',
        'Industries: Retail (2)',
        'Delivery: In-person (29), Online (20)',
        'Popular tags: AI (9)',
        '',
        'Data: live official feed as of 2026-11-16T12:00:00.000Z; refreshed every 15 minutes.',
      ),
    );
  });

  describe('the data line', () => {
    const dataLine = (data: OverviewOutput['data']): string => overviewText(overview({ data })).split('\n').at(-1)!;

    it('says when the live feed was last checked', () => {
      expect(dataLine({ source: 'live', asOf: '2026-11-16T12:00:00.000Z', lastCheckedAt: '2026-11-16T12:10:00.000Z', refreshIntervalMinutes: 15 })).toBe(
        'Data: live official feed as of 2026-11-16T12:00:00.000Z, last checked 2026-11-16T12:10:00.000Z; refreshed every 15 minutes.',
      );
    });

    it('counts a refresh interval of one minute in the singular', () => {
      expect(dataLine({ source: 'live', asOf: '2026-11-16T12:00:00.000Z', refreshIntervalMinutes: 1 })).toBe('Data: live official feed as of 2026-11-16T12:00:00.000Z; refreshed every 1 minute.');
    });

    it('does not claim a refresh when the data is never refreshed', () => {
      expect(dataLine({ source: 'live', asOf: '2026-11-16T12:00:00.000Z', refreshIntervalMinutes: 0 })).toBe('Data: live official feed as of 2026-11-16T12:00:00.000Z.');
    });

    it('says that the data is the bundled snapshot, whatever else is known', () => {
      expect(dataLine({ source: 'snapshot', asOf: '2026-11-16T04:59:16.356Z', lastCheckedAt: '2026-11-16T12:10:00.000Z', refreshIntervalMinutes: 15 })).toBe(
        'Data: bundled snapshot from 2026-11-16T04:59:16.356Z; the official feed could not be reached yet, so very recent changes may be missing.',
      );
    });
  });
});
