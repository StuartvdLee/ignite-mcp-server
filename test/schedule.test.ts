import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_BREAK_MINUTES,
  OFF_SITE_MINUTES,
  VENUE_CHANGE_MINUTES,
  byStart,
  clashes,
  findConflicts,
  fitsAfter,
  overlaps,
  requiredGap,
  resolveItems,
} from '../src/catalog/schedule';
import type { Conflict, GapRules } from '../src/catalog/schedule';
import { fixtureCatalog, sessionOf, snapshotCatalog } from './helpers';

const catalog = fixtureCatalog();
const RULES: GapRules = { minBreakMinutes: DEFAULT_MIN_BREAK_MINUTES, attendance: 'in_person' };
const ONLINE: GapRules = { minBreakMinutes: DEFAULT_MIN_BREAK_MINUTES, attendance: 'online' };

const slot = (code: string, slotId?: string) => {
  const found = sessionOf(catalog, code).occurrences.find((candidate) => !slotId || candidate.slotId === slotId);
  if (!found) throw new Error(`No slot ${slotId ?? ''} for ${code}`);
  return found;
};
const resolve = (refs: string[], rules: GapRules = RULES) => resolveItems(catalog, refs, rules);
const conflictsOf = (refs: string[], rules: GapRules = RULES) => findConflicts(resolve(refs, rules).entries, rules);
const summarize = (conflicts: Conflict[]) =>
  conflicts.map((conflict) => [conflict.kind, conflict.first.session.code, conflict.second.session.code, conflict.minutes, conflict.requiredGapMinutes]);

// Facts from the fixture (Pacific time):
//   Tue 14:00-15:15 LAB711, LAB723 and LABSP830, all at Moscone West
//   Tue 14:35-15:00 THRSP1050 and 15:05-15:50 TT1692, both at Moscone South; 15:30-15:55 THR978 also there
//   Tue 10:00-12:00 KEY01 at Chase Center, then 12:00-13:00 LIVE50 at Moscone South
//   Wed 10:15-11:00 BRK248 at AMC Metreon, 10:15-11:30 LAB723 and 11:30-12:15 BRK316 at Moscone West
//   Thu 10:15-11:00 BRK318 at Marriott Marquis, then 11:00-11:15 LTG1285 at Moscone South
describe('the gap needed between two sessions', () => {
  const west = slot('LAB711', 'LAB711@2026-11-17T14:00');
  const westLater = slot('LAB724', 'LAB724@2026-11-17T15:45');
  const south = slot('THRSP1050');
  const chase = slot('KEY01');

  it('is the minimum break when the venue stays the same', () => {
    expect(requiredGap(west, westLater, RULES)).toBe(DEFAULT_MIN_BREAK_MINUTES);
    expect(requiredGap(west, westLater, { ...RULES, minBreakMinutes: 25 })).toBe(25);
  });

  it('adds walking time when the venue changes', () => {
    expect(requiredGap(west, south, RULES)).toBe(DEFAULT_MIN_BREAK_MINUTES + VENUE_CHANGE_MINUTES);
    expect(requiredGap(south, west, RULES)).toBe(DEFAULT_MIN_BREAK_MINUTES + VENUE_CHANGE_MINUTES);
  });

  it('adds a long transfer to or from Chase Center, in either direction', () => {
    const expected = DEFAULT_MIN_BREAK_MINUTES + VENUE_CHANGE_MINUTES + OFF_SITE_MINUTES;
    expect(requiredGap(chase, south, RULES)).toBe(expected);
    expect(requiredGap(south, chase, RULES)).toBe(expected);
    expect(requiredGap(chase, south, { ...RULES, minBreakMinutes: 0 })).toBe(VENUE_CHANGE_MINUTES + OFF_SITE_MINUTES);
  });

  it('needs no travel time when attending online', () => {
    expect(requiredGap(west, south, ONLINE)).toBe(DEFAULT_MIN_BREAK_MINUTES);
    expect(requiredGap(chase, south, ONLINE)).toBe(DEFAULT_MIN_BREAK_MINUTES);
    expect(requiredGap(chase, south, { minBreakMinutes: 0, attendance: 'online' })).toBe(0);
  });

  it('assumes no travel when a venue is unknown', () => {
    expect(requiredGap({ ...west, venue: undefined }, south, RULES)).toBe(DEFAULT_MIN_BREAK_MINUTES);
    expect(requiredGap(west, { ...south, venue: undefined }, RULES)).toBe(DEFAULT_MIN_BREAK_MINUTES);
  });
});

describe('overlaps, fitsAfter and clashes', () => {
  const lab711 = slot('LAB711', 'LAB711@2026-11-17T14:00');
  const lab723 = slot('LAB723', 'LAB723@2026-11-17T14:00');
  const labWedMorning = slot('LAB723', 'LAB723@2026-11-18T10:15');
  const brk316 = slot('BRK316');
  const brk248 = slot('BRK248');

  it('sees slots that run at the same time', () => {
    expect(overlaps(lab711, lab723)).toBe(true);
    expect(overlaps(lab723, lab711)).toBe(true);
    expect(clashes(lab711, lab723, RULES)).toBe(true);
    expect(clashes(lab723, lab711, RULES)).toBe(true);
  });

  it('does not call back-to-back slots overlapping, but still wants a break between them', () => {
    expect(labWedMorning.endMs).toBe(brk316.startMs);
    expect(overlaps(labWedMorning, brk316)).toBe(false);
    expect(fitsAfter(labWedMorning, brk316, RULES)).toBe(false);
    expect(clashes(labWedMorning, brk316, RULES)).toBe(true);
    expect(clashes(brk316, labWedMorning, RULES)).toBe(true);
    expect(clashes(labWedMorning, brk316, { ...RULES, minBreakMinutes: 0 })).toBe(false);
  });

  it('accepts a gap that covers the walk', () => {
    expect(brk316.startMs - brk248.endMs).toBe(30 * 60_000);
    expect(fitsAfter(brk248, brk316, RULES)).toBe(true);
    expect(clashes(brk248, brk316, RULES)).toBe(false);
    expect(clashes(brk316, brk248, RULES)).toBe(false);
  });

  it('is stricter about the same gap when more break is asked for, unless attending online', () => {
    expect(clashes(brk248, brk316, { minBreakMinutes: 20, attendance: 'in_person' })).toBe(false);
    expect(clashes(brk248, brk316, { minBreakMinutes: 25, attendance: 'in_person' })).toBe(true);
    expect(clashes(brk248, brk316, { minBreakMinutes: 25, attendance: 'online' })).toBe(false);
  });

  it('never mixes up different days', () => {
    expect(overlaps(lab711, brk316)).toBe(false);
    expect(clashes(lab711, brk316, RULES)).toBe(false);
  });
});

describe('ordering entries', () => {
  it('sorts by start time, then end time, then code', () => {
    const { entries } = resolve(['LABSP830@2026-11-17T14:00', 'LAB723@2026-11-17T14:00', 'BRK323', 'LAB711@2026-11-17T14:00', 'KEY01']);
    expect(entries.map((entry) => entry.session.code)).toEqual(['KEY01', 'BRK323', 'LAB711', 'LAB723', 'LABSP830']);
    const shuffled = [...entries].reverse().sort(byStart);
    expect(shuffled.map((entry) => entry.session.code)).toEqual(entries.map((entry) => entry.session.code));
  });
});

describe('resolving a list of sessions', () => {
  it('turns codes into slots, in time order, and keeps nothing else', () => {
    const result = resolve(['BRK217', 'BRK319', 'KEY01']);
    expect(result.entries.map((entry) => entry.occurrence.slotId)).toEqual(['KEY01@2026-11-17T10:00', 'BRK319@2026-11-17T16:30', 'BRK217@2026-11-19T16:00']);
    expect(result.onDemand).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it('marks a session with a single slot as fixed', () => {
    const [entry] = resolve(['BRK217']).entries;
    expect(entry?.fixed).toBe(true);
    expect(entry?.otherSlots).toEqual([]);
  });

  it('counts a session once however it is referred to', () => {
    const result = resolve(['BRK217', 'brk 217', 'BRK217@2026-11-19T16:00', sessionOf(catalog, 'BRK217').id]);
    expect(result.entries).toHaveLength(1);
    expect(result.unresolved).toEqual([]);
  });

  it('honours a named slot of a session that is offered several times', () => {
    const [entry] = resolve(['LAB652@2026-11-18T08:30']).entries;
    expect(entry?.occurrence.slotId).toBe('LAB652@2026-11-18T08:30');
    expect(entry?.fixed).toBe(true);
    expect(entry?.otherSlots.map((other) => other.slotId)).toEqual(['LAB652@2026-11-17T18:15', 'LAB652@2026-11-19T09:00', 'LAB652@2026-11-19T13:00']);
  });

  it('picks, for a session offered several times, a slot that does not clash', () => {
    const result = resolve(['LAB711@2026-11-17T14:00', 'LAB723']);
    const lab = result.entries.find((entry) => entry.session.code === 'LAB723');
    expect(lab?.fixed).toBe(false);
    expect(lab?.occurrence.slotId).toBe('LAB723@2026-11-18T10:15');
    expect(lab?.otherSlots).toHaveLength(3);
    expect(lab?.otherSlots.map((other) => other.slotId)).not.toContain('LAB723@2026-11-18T10:15');
    expect(findConflicts(result.entries, RULES)).toEqual([]);
  });

  it('avoids a slot that leaves too little time, not just one that overlaps', () => {
    const result = resolve(['BRK316', 'LAB724']);
    const lab = result.entries.find((entry) => entry.session.code === 'LAB724');
    expect(lab?.occurrence.slotId).not.toBe('LAB724@2026-11-18T12:00');
    expect(findConflicts(result.entries, RULES)).toEqual([]);
    const tight = resolve(['LAB723@2026-11-18T10:15', 'LAB724']);
    expect(findConflicts(tight.entries, RULES)).toEqual([]);
  });

  it('lets several multi-slot sessions share out the slots between them', () => {
    const result = resolve(['LAB711', 'LAB723', 'LAB724', 'LABSP830', 'LAB652']);
    expect(result.entries).toHaveLength(5);
    expect(new Set(result.entries.map((entry) => entry.session.code)).size).toBe(5);
    expect(findConflicts(result.entries, RULES)).toEqual([]);
    for (const entry of result.entries) {
      expect(sessionOf(catalog, entry.session.code).occurrences).toContain(entry.occurrence);
      expect(entry.otherSlots).not.toContain(entry.occurrence);
      expect(entry.otherSlots.length).toBe(entry.session.occurrences.length - 1);
    }
  });

  it('chooses the same slots every time, and a clash-free set whatever the order of the list', () => {
    const refs = ['LAB711', 'LAB723', 'LAB724', 'LABSP830', 'LAB652', 'BRK101', 'LTG1356'];
    const first = resolve(refs).entries.map((entry) => entry.occurrence.slotId);
    expect(resolve(refs).entries.map((entry) => entry.occurrence.slotId)).toEqual(first);
    const reversed = resolve([...refs].reverse());
    expect(reversed.entries).toHaveLength(refs.length);
    expect(findConflicts(reversed.entries, RULES)).toEqual([]);
  });

  it('keeps a clash when it cannot be avoided, and reports it', () => {
    const result = resolve(['LAB711@2026-11-17T14:00', 'LAB723@2026-11-17T14:00']);
    expect(result.entries).toHaveLength(2);
    expect(summarize(findConflicts(result.entries, RULES))).toEqual([['overlap', 'LAB711', 'LAB723', 75, 10]]);
  });

  it('separates on-demand sessions, which have no time', () => {
    const result = resolve(['LAB711D', 'KEY01', 'OD1930', 'od1930']);
    expect(result.onDemand.map((session) => session.code)).toEqual(['LAB711D', 'OD1930']);
    expect(result.entries.map((entry) => entry.session.code)).toEqual(['KEY01']);
    expect(result.unresolved).toEqual([]);
  });

  it('explains what could not be found', () => {
    const result = resolve([
      'zzzzqqq',
      'BRK217@2026-11-19T17:00',
      'LAB711D@2026-11-19T10:00',
      'copilot sharepoint',
      'BRK217',
    ]);
    expect(result.entries.map((entry) => entry.session.code)).toEqual(['BRK217']);
    expect(result.unresolved.map((item) => item.ref)).toEqual(['zzzzqqq', 'BRK217@2026-11-19T17:00', 'LAB711D@2026-11-19T10:00', 'copilot sharepoint']);
    const reasons = result.unresolved.map((item) => item.reason);
    expect(reasons[0]).toBe('No session has that code or id');
    expect(reasons[1]).toBe('BRK217 has no slot "2026-11-19T17:00". Its slots: BRK217@2026-11-19T16:00');
    expect(reasons[2]).toBe('LAB711D is on demand and has no scheduled slot');
    expect(reasons[3]).toBe('No session has that code or id. Closest matches: BRK217 (Real-World AI Transformation with Copilot in SharePoint)');
  });

  it('suggests no matches for a reference that is blank', () => {
    const [item] = resolve(['   ']).unresolved;
    expect(item?.reason).toBe('No session has that code or id');
  });

  it('copes with an empty list', () => {
    expect(resolve([])).toEqual({ entries: [], onDemand: [], unresolved: [] });
  });

  it('copes with every multi-slot session at once', async () => {
    const full = await snapshotCatalog();
    const multi = full.sessions.filter((session) => session.occurrences.length > 1);
    expect(multi.length).toBeGreaterThan(50);
    const started = Date.now();
    const result = resolveItems(
      full,
      multi.map((session) => session.code),
      RULES,
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.entries).toHaveLength(multi.length);
    expect(result.unresolved).toEqual([]);
    for (const entry of result.entries) expect(entry.session.occurrences).toContain(entry.occurrence);
  });
});

describe('finding conflicts', () => {
  it('finds nothing in a schedule that works', () => {
    expect(conflictsOf(['KEY01', 'BRK323', 'LAB724@2026-11-17T15:45'])).toEqual([]);
    expect(conflictsOf(['BRK248', 'BRK316'])).toEqual([]);
    expect(conflictsOf([])).toEqual([]);
  });

  it('reports sessions that run at the same time, with the length of the overlap', () => {
    expect(summarize(conflictsOf(['BRK323', 'THRSP1050']))).toEqual([['overlap', 'BRK323', 'THRSP1050', 10, 20]]);
    expect(summarize(conflictsOf(['TT1692', 'THR978']))).toEqual([['overlap', 'TT1692', 'THR978', 20, 10]]);
  });

  it('reports every pair when several sessions overlap', () => {
    const conflicts = conflictsOf(['LABSP830@2026-11-17T14:00', 'LAB711@2026-11-17T14:00', 'LAB723@2026-11-17T14:00']);
    expect(summarize(conflicts)).toEqual([
      ['overlap', 'LAB711', 'LAB723', 75, 10],
      ['overlap', 'LAB711', 'LABSP830', 75, 10],
      ['overlap', 'LAB723', 'LABSP830', 75, 10],
    ]);
  });

  it('reports a break that is too short, with the time actually left', () => {
    expect(summarize(conflictsOf(['THRSP1050', 'TT1692']))).toEqual([['tight', 'THRSP1050', 'TT1692', 5, 10]]);
    expect(summarize(conflictsOf(['LAB723@2026-11-18T10:15', 'BRK316']))).toEqual([['tight', 'LAB723', 'BRK316', 0, 10]]);
  });

  it('asks for more time between venues than within one', () => {
    expect(summarize(conflictsOf(['BRK318', 'LTG1285']))).toEqual([['tight', 'BRK318', 'LTG1285', 0, 20]]);
    expect(summarize(conflictsOf(['LTG1285', 'BRK341']))).toEqual([['tight', 'LTG1285', 'BRK341', 15, 20]]);
    expect(summarize(conflictsOf(['LTG1285', 'BRK341'], ONLINE))).toEqual([]);
  });

  it('allows extra time for Chase Center', () => {
    expect(summarize(conflictsOf(['KEY01', 'LIVE50']))).toEqual([['tight', 'KEY01', 'LIVE50', 0, 50]]);
    expect(summarize(conflictsOf(['KEY01', 'LIVE50'], { minBreakMinutes: 0, attendance: 'online' }))).toEqual([]);
  });

  it('can be told that no break is needed', () => {
    const none: GapRules = { minBreakMinutes: 0, attendance: 'online' };
    expect(conflictsOf(['LAB723@2026-11-18T10:15', 'BRK316'], none)).toEqual([]);
    expect(summarize(conflictsOf(['BRK323', 'THRSP1050'], none))).toEqual([['overlap', 'BRK323', 'THRSP1050', 10, 0]]);
  });

  it('lists the earlier session first, whatever the order it was given in', () => {
    const forwards = findConflicts(resolve(['THRSP1050', 'TT1692']).entries, RULES);
    const backwards = findConflicts([...resolve(['THRSP1050', 'TT1692']).entries].reverse(), RULES);
    expect(summarize(backwards)).toEqual(summarize(forwards));
    expect(forwards[0]?.first.session.code).toBe('THRSP1050');
  });

  it('does not change the list it is given', () => {
    const { entries } = resolve(['TT1692', 'THRSP1050', 'KEY01']);
    const before = entries.map((entry) => entry.session.code);
    findConflicts(entries, RULES);
    expect(entries.map((entry) => entry.session.code)).toEqual(before);
  });
});
