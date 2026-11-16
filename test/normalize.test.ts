import { describe, expect, it } from 'vitest';
import { NO_TIME_ID, sessionUrl } from '../src/event';
import { normalizeCatalog } from '../src/catalog/normalize';
import { fixtureCatalog, readFeed, sessionOf } from './helpers';

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD]/;

/** A minimal raw feed record; every test overrides what it cares about. */
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionCode: 'BRK900',
    title: 'Synthetic session',
    sessionId: 'sid900',
    sessionInstanceId: 'sid900-time1',
    sessionTimeId: 'time1',
    lastUpdate: '2026-11-01T00:00:00Z',
    startDateTime: '2026-11-18T18:00:00Z',
    endDateTime: '2026-11-18T18:45:00Z',
    durationInMinutes: 45,
    description: '<p>Hello</p>',
    ...overrides,
  };
}

const only = (feed: unknown[]) => {
  const { sessions } = normalizeCatalog(feed);
  expect(sessions).toHaveLength(1);
  return sessions[0]!;
};

describe('normalizeCatalog on the feed fixture', () => {
  const catalog = fixtureCatalog();

  it('turns the raw records into one session per code, sorted with numeric collation', () => {
    const result = normalizeCatalog(readFeed());
    expect(readFeed().length).toBeGreaterThan(result.sessions.length);
    expect(result.sessions).toHaveLength(34);
    expect(result.skipped).toBe(0);
    const codes = result.sessions.map((session) => session.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.indexOf('LAB724')).toBe(codes.indexOf('LAB724D') - 1);
    expect(codes.indexOf('BRK101')).toBeLessThan(codes.indexOf('BRK217'));
  });

  it('reads a typical breakout', () => {
    const session = sessionOf(catalog, 'BRK217');
    expect(session).toMatchObject({
      title: 'Real-World AI Transformation with Copilot in SharePoint',
      type: 'Breakout',
      level: 'Intermediate',
      levelNumber: 200,
      topics: ['Copilot'],
      audiences: ['Technical Practitioner'],
      delivery: ['In-person', 'Online'],
      recorded: true,
      liveStream: true,
      sponsored: false,
      featured: false,
      reservableSeating: false,
      onDemand: false,
    });
    expect(session.tags).toContain('Microsoft Copilot');
    expect(session.description.startsWith('Organizations are moving beyond AI experiments')).toBe(true);
    expect(session.url).toBe('https://ignite.microsoft.com/en-US/sessions/1787856605931001EI5K-1791588217922001CW4I?source=sessions');
  });

  it('links to the first time slot of a repeated session, and to the time-less instance of on-demand content', () => {
    const catalog = fixtureCatalog();
    const lab = sessionOf(catalog, 'LAB652');
    expect(lab.occurrences.length).toBeGreaterThan(1);
    expect(lab.url).toBe(sessionUrl(lab.occurrences[0]!.instanceId));
    expect(sessionOf(catalog, 'LAB711D').url).toBe(sessionUrl(`1792444320801001wekP-${NO_TIME_ID}`));
  });

  it('strips zero-width characters that the feed puts into titles', () => {
    const record = readFeed().find((entry) => entry.sessionCode === 'BRK217');
    expect(String(record?.title)).toMatch(ZERO_WIDTH);
    expect(sessionOf(catalog, 'BRK217').title).not.toMatch(ZERO_WIDTH);
  });

  it('converts the slot to Pacific Time and splits venue and room', () => {
    const [slot, ...rest] = sessionOf(catalog, 'BRK217').occurrences;
    expect(rest).toEqual([]);
    expect(slot).toMatchObject({
      slotId: 'BRK217@2026-11-19T16:00',
      start: '2026-11-20T00:00:00.000Z',
      end: '2026-11-20T00:45:00.000Z',
      durationMinutes: 45,
      date: '2026-11-19',
      startTime: '16:00',
      endTime: '16:45',
      venue: 'Moscone West',
      room: 'Level 3, Room 3014',
      location: 'Moscone West | Level 3, Room 3014',
    });
    expect(slot?.instanceId).toBe('1787856605931001EI5K-1791588217922001CW4I');
  });

  it('keeps a credential with the speaker it belongs to', () => {
    const names = sessionOf(catalog, 'BRK217').speakers.map((speaker) => speaker.name);
    expect(names).toEqual(['Rk Menon', 'Matt Wolodarsky', 'Amy Curley, PhD']);
  });

  it('reads speaker roles from the speaker types', () => {
    expect(sessionOf(catalog, 'KEY01').speakers[0]).toMatchObject({ name: 'Satya Nadella', role: 'Executive' });
    expect(sessionOf(catalog, 'BRK217').speakers.map((speaker) => speaker.role)).toEqual([undefined, undefined, 'Customer']);
  });

  it('merges the records of a session that runs several times', () => {
    const lab = sessionOf(catalog, 'LAB652');
    expect(lab.occurrences.map((slot) => slot.slotId)).toEqual([
      'LAB652@2026-11-17T18:15',
      'LAB652@2026-11-18T08:30',
      'LAB652@2026-11-19T09:00',
      'LAB652@2026-11-19T13:00',
    ]);
    expect(new Set(lab.occurrences.map((slot) => slot.instanceId)).size).toBe(4);
    expect(lab.reservableSeating).toBe(true);
    expect(lab.recorded).toBe(false);
    expect(sessionOf(catalog, 'BRK101').occurrences).toHaveLength(2);
  });

  it('marks content without a scheduled time as on demand', () => {
    for (const code of ['LAB711D', 'LAB724D', 'OD1930', 'OD1950', 'ODSP2100']) {
      const session = sessionOf(catalog, code);
      expect(session.onDemand, code).toBe(true);
      expect(session.occurrences, code).toEqual([]);
    }
    expect(sessionOf(catalog, 'BRK217').onDemand).toBe(false);
  });

  it('recognises sponsor sessions by their code', () => {
    const sponsored = catalog.sessions.filter((session) => session.sponsored).map((session) => session.code);
    expect(sponsored.sort()).toEqual(['BRKSP590', 'LABSP830', 'ODSP2100', 'THRSP1050']);
  });

  it('reads the hero flag as featured', () => {
    const featured = catalog.sessions.filter((session) => session.featured).map((session) => session.code);
    expect(featured.sort()).toEqual(['BRK341', 'INV640', 'KEY01', 'LIVE50']);
  });

  it('resolves related session ids to codes, in both directions of the data', () => {
    expect(sessionOf(catalog, 'BRK316').relatedCodes.sort()).toEqual(['BRK320', 'BRK323']);
    expect(sessionOf(catalog, 'BRK318').relatedCodes).toEqual(['BRK323']);
    expect(sessionOf(catalog, 'LAB711').relatedCodes).toEqual(['LAB711D']);
    for (const session of catalog.sessions) {
      for (const code of session.relatedCodes) {
        expect(catalog.get(code), `${session.code} -> ${code}`).toBeDefined();
        expect(code).not.toBe(session.code);
      }
    }
  });

  it('reads resources with readable labels and web links only', () => {
    const resources = sessionOf(catalog, 'BRK316').resources;
    expect(resources.length).toBeGreaterThan(1);
    for (const resource of resources) {
      expect(resource.label).not.toBe('');
      expect(resource.url).toMatch(/^https?:\/\//);
    }
  });

  it('does not carry the embedding vectors of the raw feed', () => {
    expect(JSON.stringify(catalog.sessions)).not.toContain('embeddingContent');
  });
});

describe('normalizeCatalog input handling', () => {
  it('rejects anything but an array', () => {
    expect(() => normalizeCatalog({ sessions: [] })).toThrow('Expected the session feed to be a JSON array');
    expect(() => normalizeCatalog(null)).toThrow('JSON array');
  });

  it('skips records that cannot be identified and counts them', () => {
    const result = normalizeCatalog([
      raw(),
      null,
      'text',
      [],
      raw({ sessionCode: '' }),
      raw({ sessionCode: 'BRK901', title: '  ' }),
      raw({ sessionCode: 'BRK902', sessionId: undefined }),
    ]);
    expect(result.sessions.map((session) => session.code)).toEqual(['BRK900']);
    expect(result.skipped).toBe(6);
  });

  it('upper-cases the session code', () => {
    expect(only([raw({ sessionCode: ' brk900 ' })]).code).toBe('BRK900');
  });

  it('takes the details from the most recently updated record and lists every slot once', () => {
    const session = only([
      raw({ title: 'Old title', lastUpdate: '2026-10-01T00:00:00Z', startDateTime: '2026-11-18T18:00:00Z', sessionInstanceId: 'a' }),
      raw({ title: 'New title', lastUpdate: '2026-11-01T00:00:00Z', startDateTime: '2026-11-19T18:00:00Z', endDateTime: '2026-11-19T18:45:00Z', sessionInstanceId: 'b' }),
      raw({ title: 'Duplicate slot', lastUpdate: '2026-09-01T00:00:00Z', startDateTime: '2026-11-19T18:00:00Z', endDateTime: '2026-11-19T18:45:00Z', sessionInstanceId: 'c' }),
    ]);
    expect(session.title).toBe('New title');
    expect(session.occurrences.map((slot) => slot.slotId)).toEqual(['BRK900@2026-11-18T10:00', 'BRK900@2026-11-19T10:00']);
  });

  it('derives a missing or impossible end time from the duration', () => {
    expect(only([raw({ endDateTime: undefined, durationInMinutes: 30 })]).occurrences[0]).toMatchObject({ endTime: '10:30', durationMinutes: 30 });
    expect(only([raw({ endDateTime: '2026-11-18T17:00:00Z', durationInMinutes: 20 })]).occurrences[0]).toMatchObject({ endTime: '10:20', durationMinutes: 20 });
    expect(only([raw({ endDateTime: undefined, durationInMinutes: undefined })]).occurrences[0]?.durationMinutes).toBe(30);
  });

  it('treats a record without a usable start as on demand', () => {
    const session = only([raw({ startDateTime: 'soon' })]);
    expect(session.onDemand).toBe(true);
    expect(session.occurrences).toEqual([]);
  });

  it('handles a location without a room', () => {
    const slot = only([raw({ location: { displayValue: 'The Aviary' } })]).occurrences[0];
    expect(slot).toMatchObject({ venue: 'The Aviary', location: 'The Aviary' });
    expect(slot?.room).toBeUndefined();
    const none = only([raw({ location: undefined })]).occurrences[0];
    expect(none?.venue).toBeUndefined();
    expect(none?.location).toBeUndefined();
  });

  it.each([
    [[{ displayValue: '(200) Intermediate' }], 'Intermediate', 200],
    [[{ displayValue: '400 - Expert' }], 'Expert', 400],
    [[{ displayValue: 'All levels' }], 'All levels', undefined],
    [[], undefined, undefined],
  ])('parses the level %j', (sessionLevel, level, levelNumber) => {
    const session = only([raw({ sessionLevel })]);
    expect(session.level).toBe(level);
    expect(session.levelNumber).toBe(levelNumber);
  });

  it('reads facets given as one object, as a list or as plain strings', () => {
    const session = only([
      raw({ topic: { displayValue: 'Security' }, tags: ['AI', { logicalValue: 'Azure' }, 'AI', ''], sessionType: [{ displayValue: 'Lab' }] }),
    ]);
    expect(session.topics).toEqual(['Security']);
    expect(session.tags).toEqual(['AI', 'Azure']);
    expect(session.type).toBe('Lab');
    expect(only([raw({ sessionType: undefined })]).type).toBe('Session');
  });

  it('detects recording, live streaming and seating from the descriptive fields', () => {
    const recorded = only([raw({ viewingOptions: [{ displayValue: 'This session will be recorded' }], hasLiveStream: true, seatingExperience: 'Reservable seating' })]);
    expect(recorded).toMatchObject({ recorded: true, liveStream: true, reservableSeating: true });
    const plain = only([raw({ viewingOptions: [{ displayValue: 'Not recorded' }], seatingExperience: 'First-come, first-served' })]);
    expect(plain).toMatchObject({ recorded: false, liveStream: false, reservableSeating: false });
  });

  it('only attaches speaker ids when they line up with the names', () => {
    const aligned = only([raw({ speakerNames: 'Ann One, Bob Two', speakerIds: ['a1', 'b2'] })]);
    expect(aligned.speakers).toEqual([
      { name: 'Ann One', id: 'a1' },
      { name: 'Bob Two', id: 'b2' },
    ]);
    const misaligned = only([raw({ speakerNames: 'Ann One, Bob Two', speakerIds: ['a1'] })]);
    expect(misaligned.speakers).toEqual([{ name: 'Ann One' }, { name: 'Bob Two' }]);
  });

  describe('resources', () => {
    const resourcesOf = (relatedResources: unknown) => only([raw({ relatedResources })]).resources;

    it('unwraps Safe Links, adds a scheme and drops duplicates', () => {
      const wrapped = 'https://nam06.safelinks.protection.outlook.com/?url=https%3A%2F%2Flearn.microsoft.com%2Fazure&data=05%7C01';
      expect(
        resourcesOf([
          { label: 'Docs', link: wrapped },
          { label: 'Docs again', link: 'https://learn.microsoft.com/azure' },
          { label: 'Bare', link: 'aka.ms/ignite' },
          { link: 'https://example.com/page' },
        ]),
      ).toEqual([
        { label: 'Docs', url: 'https://learn.microsoft.com/azure' },
        { label: 'Bare', url: 'https://aka.ms/ignite' },
        { label: 'example.com', url: 'https://example.com/page' },
      ]);
    });

    it('drops links that are not web links', () => {
      expect(resourcesOf([{ label: 'x', link: 'javascript:alert(1)' }, { label: 'y', link: 'ftp://example.com/file' }, { label: 'z', link: '' }, 'text', null])).toEqual([]);
      expect(resourcesOf('not a list')).toEqual([]);
    });
  });
});
