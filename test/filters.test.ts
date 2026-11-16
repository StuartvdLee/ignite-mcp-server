import { describe, expect, it } from 'vitest';
import type { SessionFilters } from '../src/catalog/filters';
import { fixtureCatalog, pacific } from './helpers';

const catalog = fixtureCatalog();
const NOW = pacific('2026-11-16', '12:00');

function run(filters: SessionFilters, nowMs = NOW) {
  const resolved = catalog.resolve(filters, nowMs);
  const matched = catalog.sessions.filter((session) => resolved.apply(session) !== null);
  return { resolved, matched, codes: matched.map((session) => session.code).sort() };
}

const codesWhere = (predicate: (session: (typeof catalog.sessions)[number]) => boolean) =>
  catalog.sessions.filter(predicate).map((session) => session.code).sort();

describe('resolveFilters without constraints', () => {
  it('lets every session through and reports nothing', () => {
    for (const filters of [{}, undefined as unknown as SessionFilters]) {
      const { resolved, matched } = run(filters);
      expect(matched).toHaveLength(catalog.sessions.length);
      expect(resolved.warnings).toEqual([]);
      expect(resolved.summary).toEqual([]);
      expect(resolved.hasOccurrenceConstraint).toBe(false);
    }
  });

  it('ignores blank values', () => {
    const { resolved, matched } = run({ topics: [], speaker: '  ', company: '', location: '', days: [] });
    expect(matched).toHaveLength(catalog.sessions.length);
    expect(resolved.summary).toEqual([]);
  });
});

describe('facet filters', () => {
  it('matches topics case-insensitively and by a distinctive word', () => {
    const security = codesWhere((session) => session.topics.includes('Security'));
    expect(security.length).toBeGreaterThan(5);
    expect(run({ topics: ['security'] }).codes).toEqual(security);
    expect(run({ topics: ['AI'] }).codes).toEqual(codesWhere((session) => session.topics.includes('Cloud & AI')));
    expect(run({ topics: ['business'] }).codes).toEqual(codesWhere((session) => session.topics.includes('Agentic Business Applications')));
    expect(run({ topics: ['security'] }).resolved.summary).toEqual(['topics: Security']);
  });

  it('combines several values of one facet as alternatives', () => {
    const wanted = codesWhere((session) => session.topics.includes('Windows') || session.topics.includes('Copilot'));
    expect(run({ topics: ['windows', 'copilot'] }).codes).toEqual(wanted);
  });

  it('combines different facets as restrictions', () => {
    const wanted = codesWhere((session) => session.topics.includes('Security') && session.levelNumber === 200);
    expect(wanted.length).toBeGreaterThan(0);
    expect(run({ topics: ['security'], levels: ['200'] }).codes).toEqual(wanted);
  });

  it('prefers an exact type over looser matches', () => {
    expect(run({ types: ['lab'] }).codes).toEqual(['LAB652', 'LAB711', 'LAB723', 'LAB724', 'LABSP830']);
    expect(run({ types: ['digital lab'] }).codes).toEqual(['LAB711D', 'LAB724D']);
    expect(run({ types: ['breakouts'] }).codes).toEqual(codesWhere((session) => session.type === 'Breakout'));
    expect(run({ types: ['talk'] }).codes).toEqual(codesWhere((session) => session.type === 'Lightning Talk' || session.type === 'Table Talk'));
  });

  it('matches tags exactly, ignoring case', () => {
    expect(run({ tags: ['agents'] }).codes).toEqual(codesWhere((session) => session.tags.includes('Agents')));
    expect(run({ tags: ['Azure Container Apps'] }).codes).toEqual(codesWhere((session) => session.tags.includes('Azure Container Apps')));
  });

  it('matches industries and audiences', () => {
    expect(run({ industries: ['financial'] }).codes).toEqual(codesWhere((session) => session.industries.includes('Financial Services')));
    expect(run({ audiences: ['business decision maker'] }).codes).toEqual(
      codesWhere((session) => session.audiences.includes('Business Decision Maker')),
    );
  });

  it('warns about unknown values, suggests close ones and then matches nothing', () => {
    const topic = run({ topics: ['quantum computing'] });
    expect(topic.codes).toEqual([]);
    expect(topic.resolved.warnings).toHaveLength(1);
    expect(topic.resolved.warnings[0]).toMatch(/^Unknown topic "quantum computing"\./);
    expect(topic.resolved.warnings[0]).toContain('Valid values: Security');
    expect(topic.resolved.summary).toEqual(['topics: (none matched)']);

    const tag = run({ tags: ['azure cont'] });
    expect(tag.resolved.warnings[0]).toContain('Unknown tag "azure cont". Did you mean: Azure Container Apps');
    expect(tag.resolved.warnings[0]).not.toContain('Valid values');
  });

  it('keeps the valid part of a mixed list', () => {
    const { resolved, codes } = run({ topics: ['security', 'nonsense'] });
    expect(codes).toEqual(codesWhere((session) => session.topics.includes('Security')));
    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toContain('Unknown topic "nonsense"');
  });
});

describe('level filter', () => {
  const at = (level: number) => codesWhere((session) => session.levelNumber === level);

  it.each([
    ['200', 200],
    ['L200', 200],
    ['level 300', 300],
    ['Intermediate', 200],
    ['advanced', 300],
    ['EXPERT', 400],
  ])('understands %s', (input, level) => {
    const { codes, resolved } = run({ levels: [input] });
    expect(codes).toEqual(at(level));
    expect(resolved.warnings).toEqual([]);
  });

  it('accepts several levels and leaves out sessions without one', () => {
    const { codes } = run({ levels: ['100', '400'] });
    expect(codes).toEqual([...at(100), ...at(400)].sort());
    expect(codes).not.toContain('KEY01');
  });

  it('warns about an unknown level', () => {
    const { codes, resolved } = run({ levels: ['500'] });
    expect(codes).toEqual([]);
    expect(resolved.warnings).toEqual(['Unknown level "500". Valid values: 100, 200, 300, 400 (Foundational, Intermediate, Advanced, Expert).']);
  });

  it('does not mistake longer numbers for a level', () => {
    for (const input of ['2000', '1200', 'L2000']) {
      expect(run({ levels: [input] }).resolved.warnings, input).toHaveLength(1);
    }
  });
});

describe('delivery filter', () => {
  const inPerson = codesWhere((session) => session.delivery.includes('In-person'));
  const online = codesWhere((session) => session.delivery.includes('Online'));

  it.each(['in-person', 'In person', 'onsite', 'on site'])('maps %s to in-person', (input) => {
    expect(run({ delivery: [input] }).codes).toEqual(inPerson);
  });

  it.each(['online', 'virtual', 'digital', 'remote'])('maps %s to online', (input) => {
    expect(run({ delivery: [input] }).codes).toEqual(online);
  });

  it('warns about anything else', () => {
    const { resolved, codes } = run({ delivery: ['hybrid'] });
    expect(codes).toEqual([]);
    expect(resolved.warnings).toEqual(['Unknown delivery "hybrid". Valid values: In-person, Online.']);
  });
});

describe('speaker and company filters', () => {
  it('matches speaker names by whole or partial words, in any order', () => {
    expect(run({ speaker: 'nadella' }).codes).toEqual(['KEY01']);
    expect(run({ speaker: 'Satya Nadella' }).codes).toEqual(['KEY01']);
    expect(run({ speaker: 'nadella satya' }).codes).toEqual(['KEY01']);
    expect(run({ speaker: 'satya nad' }).codes).toEqual(['KEY01']);
    expect(run({ speaker: 'zzzz' }).codes).toEqual([]);
    expect(run({ speaker: 'satya' }).resolved.summary).toEqual(['speaker: satya']);
  });

  it('does not treat very short fragments as prefixes', () => {
    expect(run({ speaker: 'na' }).codes).toEqual([]);
  });

  it('requires every word to belong to the same speaker', () => {
    expect(run({ speaker: 'satya althoff' }).codes).toEqual([]);
  });

  it('matches companies by substring', () => {
    expect(run({ company: 'ntt' }).codes).toEqual(['THR978']);
    expect(run({ company: 'Pax8' }).codes).toEqual(['BRKSP590']);
    expect(run({ company: 'ntt' }).resolved.summary).toEqual(['company: ntt']);
  });
});

describe('boolean filters', () => {
  it('filters on recording, sponsorship and scheduling', () => {
    expect(run({ recorded: true }).codes).toEqual(codesWhere((session) => session.recorded));
    expect(run({ recorded: false }).codes).toEqual(codesWhere((session) => !session.recorded));
    expect(run({ sponsored: true }).codes).toEqual(['BRKSP590', 'LABSP830', 'ODSP2100', 'THRSP1050']);
    expect(run({ sponsored: false }).matched).toHaveLength(catalog.sessions.length - 4);
    expect(run({ scheduled: false }).codes).toEqual(['LAB711D', 'LAB724D', 'OD1930', 'OD1950', 'ODSP2100']);
    expect(run({ scheduled: true }).codes).toEqual(codesWhere((session) => !session.onDemand));
  });

  it('describes them in the summary', () => {
    expect(run({ recorded: true }).resolved.summary).toEqual(['recorded only']);
    expect(run({ recorded: false }).resolved.summary).toEqual(['not recorded']);
    expect(run({ sponsored: true }).resolved.summary).toEqual(['sponsored only']);
    expect(run({ sponsored: false }).resolved.summary).toEqual(['excluding sponsored']);
    expect(run({ scheduled: true }).resolved.summary).toEqual(['scheduled only']);
    expect(run({ scheduled: false }).resolved.summary).toEqual(['on-demand (unscheduled) only']);
  });

  it('treats only scheduled=true as a time constraint', () => {
    expect(run({ scheduled: true }).resolved.hasOccurrenceConstraint).toBe(true);
    expect(run({ scheduled: false }).resolved.hasOccurrenceConstraint).toBe(false);
  });
});

describe('time filters', () => {
  it('filters by day name, abbreviation, date and relative day', () => {
    const wednesday = codesWhere((session) => session.occurrences.some((slot) => slot.date === '2026-11-18'));
    expect(wednesday).toHaveLength(12);
    expect(run({ days: ['Wednesday'] }).codes).toEqual(wednesday);
    expect(run({ days: ['wed'] }).codes).toEqual(wednesday);
    expect(run({ days: ['2026-11-18'] }).codes).toEqual(wednesday);
    expect(run({ days: ['Nov 18'] }).codes).toEqual(wednesday);
    expect(run({ days: ['today'] }, pacific('2026-11-18', '09:00')).codes).toEqual(wednesday);
    expect(run({ days: ['tomorrow'] }, pacific('2026-11-17', '09:00')).codes).toEqual(wednesday);
    expect(run({ days: ['Wednesday'] }).resolved.summary).toEqual(['days: 2026-11-18']);
  });

  it('accepts several days', () => {
    expect(run({ days: ['Mon', 'Fri'] }).codes).toEqual(['BRK101', 'LAB724']);
  });

  it('leaves out on-demand sessions once a time constraint applies', () => {
    const { codes, resolved } = run({ days: ['Tuesday'] });
    expect(resolved.hasOccurrenceConstraint).toBe(true);
    expect(codes).toHaveLength(13);
    for (const code of ['LAB711D', 'LAB724D', 'OD1930', 'OD1950', 'ODSP2100']) expect(codes).not.toContain(code);
  });

  it('warns about a day it does not understand and then matches nothing', () => {
    const { resolved, codes } = run({ days: ['someday'] });
    expect(codes).toEqual([]);
    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toMatch(/^Could not understand day "someday"\./);
    expect(resolved.warnings[0]).toContain('2026-11-17');
    expect(resolved.summary).toEqual(['days: (none matched)']);
  });

  it('bounds the start time with a time of day on every selected day', () => {
    const afternoon = run({ days: ['Tuesday'], startAfter: '15:00', startBefore: '4pm' });
    expect(afternoon.codes).toEqual(['LAB724', 'THR978', 'TT1692']);
    expect(afternoon.resolved.summary).toEqual(['days: 2026-11-17', 'start at or after 15:00', 'start before 4pm']);
  });

  it('includes the start boundary and excludes the end boundary', () => {
    expect(run({ days: ['Tuesday'], startAfter: '16:00', startBefore: '16:30' }).codes).toEqual(['INV640']);
    expect(run({ days: ['Tuesday'], startAfter: '16:01', startBefore: '16:30' }).codes).toEqual([]);
  });

  it('bounds the start time with an absolute moment', () => {
    const { codes } = run({ startAfter: '2026-11-17T15:00', startBefore: '2026-11-17T16:00' });
    expect(codes).toEqual(['LAB724', 'THR978', 'TT1692']);
  });

  it('reports only the matching slots of a session that runs several times', () => {
    const resolved = catalog.resolve({ days: ['Thursday'], startBefore: '10:00' }, NOW);
    const lab = catalog.sessions.find((session) => session.code === 'LAB652');
    expect(resolved.apply(lab!)?.map((slot) => slot.slotId)).toEqual(['LAB652@2026-11-19T09:00']);
  });

  it('ignores a time bound it does not understand but says so', () => {
    const { resolved, matched } = run({ startAfter: 'whenever', startBefore: '25:99' });
    expect(resolved.warnings).toHaveLength(2);
    expect(resolved.warnings[0]).toMatch(/^Could not understand startAfter "whenever"\./);
    expect(resolved.warnings[1]).toMatch(/^Could not understand startBefore "25:99"\./);
    expect(resolved.hasOccurrenceConstraint).toBe(false);
    expect(matched).toHaveLength(catalog.sessions.length);
  });

  it('filters on the venue or room', () => {
    expect(run({ location: 'metreon' }).codes).toEqual(['BRK248', 'BRK323']);
    expect(run({ location: 'Theater 14' }).codes).toEqual(['BRK248']);
    expect(run({ location: 'chase center' }).codes).toEqual(['KEY01']);
    expect(run({ location: 'metreon' }).resolved.summary).toEqual(['location contains: metreon']);
  });
});
