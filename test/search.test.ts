import { describe, expect, it } from 'vitest';
import { fixtureCatalog, pacific, sessionOf } from './helpers';

const catalog = fixtureCatalog();
const NOW = pacific('2026-11-16', '12:00');

const MCP_SESSIONS = ['LAB724', 'LAB724D', 'LTG1192', 'LTG1285', 'LTG1356', 'THR859', 'THR978', 'TT1692', 'TT1767'];

const search = (query: string | undefined, extra: Omit<Parameters<typeof catalog.search>[0], 'query' | 'nowMs'> = {}) =>
  catalog.search({ query, nowMs: NOW, limit: 100, ...extra });
const codesOf = (outcome: ReturnType<typeof search>) => outcome.hits.map((hit) => hit.session.code);

describe('catalog structure', () => {
  it('counts sessions per day', () => {
    expect(catalog.days.map((day) => [day.label, day.weekday, day.sessions, day.occurrences])).toEqual([
      ['Mon Nov 16', 'Monday', 1, 2],
      ['Tue Nov 17', 'Tuesday', 13, 13],
      ['Wed Nov 18', 'Wednesday', 12, 14],
      ['Thu Nov 19', 'Thursday', 14, 16],
      ['Fri Nov 20', 'Friday', 1, 1],
    ]);
  });

  it('builds facet counts, most common first', () => {
    expect(catalog.facets.types[0]).toEqual({ name: 'Breakout', count: 12 });
    expect(catalog.facets.topics[0]).toEqual({ name: 'Security', count: 13 });
    expect(catalog.facets.levels).toEqual([
      { name: '100 Foundational', count: 5 },
      { name: '200 Intermediate', count: 15 },
      { name: '300 Advanced', count: 10 },
      { name: '400 Expert', count: 2 },
    ]);
    expect(catalog.facets.venues.map((venue) => venue.name)).toEqual(['Moscone West', 'Moscone South', 'Marriott Marquis', 'AMC Metreon', 'Chase Center']);
    expect(catalog.facets.delivery.map((entry) => entry.name).sort()).toEqual(['In-person', 'Online']);
    expect(catalog.speakerCount).toBe(58);
  });
});

describe('looking sessions up', () => {
  const brk217 = sessionOf(catalog, 'BRK217');
  const slot = brk217.occurrences[0]!;

  it('finds a session by code, in any common spelling', () => {
    for (const ref of ['BRK217', 'brk217', ' brk217 ', 'BRK 217', 'brk-217']) expect(catalog.find(ref)?.code, ref).toBe('BRK217');
    expect(catalog.get('brk217')?.code).toBe('BRK217');
  });

  it('finds a session by session id or slot instance id', () => {
    expect(catalog.find(brk217.id)?.code).toBe('BRK217');
    expect(catalog.find(brk217.id.toLowerCase())?.code).toBe('BRK217');
    expect(catalog.find(slot.instanceId)?.code).toBe('BRK217');
    expect(catalog.find(`${brk217.id}-AAAAAAAAAAAAAAAAAAAA`)?.code).toBe('BRK217');
  });

  it('returns nothing for unknown references', () => {
    expect(catalog.find('nope')).toBeUndefined();
    expect(catalog.find('')).toBeUndefined();
    expect(catalog.get('BRK999')).toBeUndefined();
  });

  it('resolves a reference to one slot where it can', () => {
    expect(catalog.resolveRef('BRK217')?.occurrence?.slotId).toBe('BRK217@2026-11-19T16:00');
    expect(catalog.resolveRef('BRK217@2026-11-19T16:00')?.occurrence?.slotId).toBe('BRK217@2026-11-19T16:00');
    expect(catalog.resolveRef('brk217@2026-11-19 16:00')?.occurrence?.slotId).toBe('BRK217@2026-11-19T16:00');
    expect(catalog.resolveRef(slot.instanceId)?.occurrence?.slotId).toBe('BRK217@2026-11-19T16:00');
  });

  it('does not guess between several slots', () => {
    const bare = catalog.resolveRef('LAB652');
    expect(bare?.session.code).toBe('LAB652');
    expect(bare?.occurrence).toBeUndefined();
    const lab = sessionOf(catalog, 'LAB652');
    expect(catalog.resolveRef(lab.occurrences[1]!.instanceId)?.occurrence?.slotId).toBe('LAB652@2026-11-18T08:30');
    expect(catalog.resolveRef('LAB652@2026-11-18T08:30')?.occurrence?.slotId).toBe('LAB652@2026-11-18T08:30');
  });

  it('knows on-demand sessions have no slot and rejects slots that do not exist', () => {
    expect(catalog.resolveRef('LAB711D')?.occurrence).toBeUndefined();
    expect(catalog.resolveRef('BRK217@2026-11-19T17:00')).toBeUndefined();
    expect(catalog.resolveRef('nope')).toBeUndefined();
    expect(catalog.resolveRef('nope@2026-11-19T16:00')).toBeUndefined();
  });
});

describe('searching', () => {
  it('expands an abbreviation to the phrase it stands for, and back', () => {
    const abbreviation = search('MCP');
    expect(codesOf(abbreviation).sort()).toEqual(MCP_SESSIONS);
    expect(abbreviation.expansions).toEqual(['mcp = model context protocol']);
    const phrase = search('model context protocol');
    expect(codesOf(phrase).sort()).toEqual(MCP_SESSIONS);
    expect(phrase.expansions).toEqual(['mcp = model context protocol']);
  });

  it('is case-insensitive and ignores filler words', () => {
    expect(codesOf(search('mcp')).sort()).toEqual(MCP_SESSIONS);
    expect(codesOf(search('Find me sessions about MCP please')).sort()).toEqual(MCP_SESSIONS);
  });

  it('scores hits between 0 and 1, best first', () => {
    const { hits } = search('MCP');
    expect(hits.length).toBeGreaterThan(1);
    for (const hit of hits) {
      expect(hit.relevance).toBeGreaterThan(0);
      expect(hit.relevance).toBeLessThanOrEqual(1);
      expect(hit.score).toBeGreaterThan(0);
    }
    for (let index = 1; index < hits.length; index++) expect(hits[index - 1]!.score).toBeGreaterThanOrEqual(hits[index]!.score);
  });

  it('says where the query matched', () => {
    const [top] = search('MCP').hits;
    expect(top?.matchedFields).toEqual(expect.arrayContaining(['title']));
    const [byTag] = search('copilot sharepoint').hits;
    expect(byTag?.session.code).toBe('BRK217');
    expect(byTag?.matchedTags).toEqual(expect.arrayContaining(['SharePoint']));
  });

  it.each(['BRK217', 'brk217', 'brk 217', 'BRK-217'])('finds a session by its code written as "%s"', (query) => {
    const outcome = search(query);
    expect(codesOf(outcome)).toEqual(['BRK217']);
    expect(outcome.hits[0]?.matchedFields).toEqual(['session code']);
  });

  it('finds sessions by speaker name', () => {
    const outcome = search('Satya Nadella');
    expect(codesOf(outcome)[0]).toBe('KEY01');
    expect(outcome.hits[0]?.matchedFields).toContain('speakers');
  });

  it('matches word forms and is forgiving about small typos', () => {
    expect(codesOf(search('governing'))).toEqual(expect.arrayContaining(['LTG1285', 'LTG1356']));
    expect(codesOf(search('goverance'))).toEqual(expect.arrayContaining(['BRK248']));
  });

  it('returns nothing, without complaint, when nothing matches', () => {
    const outcome = search('zzzzqqq');
    expect(outcome.total).toBe(0);
    expect(outcome.hits).toEqual([]);
    expect(outcome.warnings).toEqual([]);
  });

  it('browses in time order when there is no query', () => {
    const outcome = search(undefined);
    expect(outcome.total).toBe(catalog.sessions.length);
    expect(outcome.hits[0]?.session.code).toBe('BRK101');
    const starts = outcome.hits.map((hit) => hit.occurrences[0]?.startMs ?? Number.POSITIVE_INFINITY);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(codesOf(outcome).slice(-5)).toEqual(['LAB711D', 'LAB724D', 'OD1930', 'OD1950', 'ODSP2100']);
    for (const hit of outcome.hits) expect(hit.relevance).toBe(1);
  });

  it('can order a query by time instead of relevance', () => {
    const outcome = search('MCP', { sort: 'time' });
    const starts = outcome.hits.map((hit) => hit.occurrences[0]?.startMs ?? Number.POSITIVE_INFINITY);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(outcome.total).toBe(MCP_SESSIONS.length);
  });

  it('pages through the results', () => {
    const all = codesOf(search('MCP'));
    const page = search('MCP', { limit: 3, offset: 2 });
    expect(codesOf(page)).toEqual(all.slice(2, 5));
    expect(page.total).toBe(all.length);
    expect(search('MCP', { limit: 3, offset: 100 }).hits).toEqual([]);
  });

  it('keeps the limit and offset within sane bounds', () => {
    expect(search('MCP', { limit: 0 }).hits).toHaveLength(1);
    expect(codesOf(search('MCP', { offset: -4, limit: 2 }))).toEqual(codesOf(search('MCP')).slice(0, 2));
  });

  it('leaves out excluded sessions', () => {
    const outcome = search('MCP', { excludeCodes: new Set(['LAB724', 'LTG1192']) });
    expect(outcome.total).toBe(MCP_SESSIONS.length - 2);
    expect(codesOf(outcome)).not.toContain('LAB724');
  });

  it('applies filters to the slots of a hit as well as to the session', () => {
    const outcome = search('MCP', { filters: { days: ['Thursday'] } });
    expect(codesOf(outcome).sort()).toEqual(['LAB724', 'LTG1192', 'LTG1285', 'LTG1356', 'THR859']);
    const talk = outcome.hits.find((hit) => hit.session.code === 'LTG1356');
    expect(talk?.session.occurrences).toHaveLength(2);
    expect(talk?.occurrences.map((slot) => slot.slotId)).toEqual(['LTG1356@2026-11-19T09:25']);
    expect(outcome.filters).toEqual(['days: 2026-11-19']);
  });

  it('reports what the filters did and why they matched nothing', () => {
    const outcome = search('MCP', { filters: { topics: ['quantum'], levels: ['200'] } });
    expect(outcome.total).toBe(0);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.filters).toEqual(['topics: (none matched)', 'levels: 200']);
  });

  it('browses with filters', () => {
    const outcome = search(undefined, { filters: { types: ['keynote'] } });
    expect(codesOf(outcome)).toEqual(['KEY01', 'KEY02']);
  });
});

describe('similar sessions', () => {
  it('shares tags or topics with the original, and never includes it', () => {
    const original = sessionOf(catalog, 'BRK316');
    const similar = catalog.similar(original, 5);
    expect(similar).toHaveLength(5);
    expect(similar.map((session) => session.code)).not.toContain('BRK316');
    for (const candidate of similar) {
      const shared = candidate.tags.some((tag) => original.tags.includes(tag)) || candidate.topics.some((topic) => original.topics.includes(topic));
      expect(shared, candidate.code).toBe(true);
    }
  });

  it('honours the limit and copes with sessions that have no tags or topics', () => {
    expect(catalog.similar(sessionOf(catalog, 'BRK316'), 2)).toHaveLength(2);
    const bare = sessionOf(catalog, 'LIVE50');
    expect(bare.topics).toEqual([]);
    expect(() => catalog.similar(bare, 3)).not.toThrow();
    expect(catalog.similar(bare, 3).map((session) => session.code)).not.toContain('LIVE50');
  });
});
