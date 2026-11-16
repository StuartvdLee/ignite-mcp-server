import { describe, expect, it } from 'vitest';
import { buildAgenda } from '../src/catalog/agenda';
import type { Agenda, AgendaOptions } from '../src/catalog/agenda';
import type { Catalog } from '../src/catalog/catalog';
import type { SessionFilters } from '../src/catalog/filters';
import { findConflicts, resolveItems } from '../src/catalog/schedule';
import type { GapRules } from '../src/catalog/schedule';
import { fixtureCatalog, makeSession, makeSlot, pacific, syntheticCatalog } from './helpers';

const NOW = pacific('2026-11-16', '12:00');
const RULES: GapRules = { minBreakMinutes: 10, attendance: 'in_person' };
const TUE = '2026-11-17';
const WED = '2026-11-18';

type Slot = [date: string, start: string, end: string, venue?: string];

/** A session whose title is the single word "Zebra", so every one of them matches "zebra" equally well. */
const zebra = (code: string, ...slots: Slot[]) =>
  makeSession(code, { title: 'Zebra' }, slots.map(([date, start, end, venue]) => makeSlot(code, date, start, end, venue)));
const yak = (code: string, ...slots: Slot[]) =>
  makeSession(code, { title: 'Yak' }, slots.map(([date, start, end, venue]) => makeSlot(code, date, start, end, venue)));

function plan(catalog: Catalog, interests: string[], extra: Partial<Omit<AgendaOptions, 'resolved'>> & { filters?: SessionFilters } = {}): Agenda {
  const { filters, ...options } = extra;
  return buildAgenda(catalog, {
    interests,
    resolved: catalog.resolve(filters, NOW),
    rules: RULES,
    maxPerDay: 5,
    mustInclude: [],
    avoid: new Set(),
    ...options,
  });
}

const planned = (agenda: Agenda) => agenda.days.map((day) => day.items.map((item) => item.entry.session.code));
const pin = (catalog: Catalog, ...refs: string[]) => resolveItems(catalog, refs, RULES).entries;

describe('planning a day', () => {
  it('prefers two short sessions to one long session that blocks both', () => {
    const catalog = syntheticCatalog([zebra('A1', [TUE, '09:00', '11:00']), zebra('A2', [TUE, '09:00', '10:00']), zebra('A3', [TUE, '10:10', '11:00'])]);
    const agenda = plan(catalog, ['zebra']);
    expect(planned(agenda)).toEqual([['A2', 'A3']]);
    expect(agenda.days[0]?.items.map((item) => item.alternatives.map((alternative) => alternative.session.code))).toEqual([['A1'], ['A1']]);
    expect(agenda.skipped).toEqual([]);
  });

  it('takes the long session when there is room for only one', () => {
    const catalog = syntheticCatalog([zebra('A1', [TUE, '09:00', '11:00']), zebra('A2', [TUE, '09:00', '10:00']), zebra('A3', [TUE, '10:10', '11:00'])]);
    const agenda = plan(catalog, ['zebra'], { maxPerDay: 1 });
    expect(planned(agenda)).toEqual([['A1']]);
    expect(agenda.days[0]?.items[0]?.alternatives.map((alternative) => alternative.session.code)).toEqual(['A2', 'A3']);
  });

  it('needs the minimum break between sessions, and more when changing venue', () => {
    const catalog = syntheticCatalog([
      zebra('A1', [TUE, '09:00', '10:00', 'Moscone West']),
      zebra('A2', [TUE, '10:10', '11:00', 'Moscone West']),
      zebra('A3', [TUE, '11:15', '12:00', 'Moscone South']),
    ]);
    expect(planned(plan(catalog, ['zebra']))).toEqual([['A1', 'A2']]);
    expect(planned(plan(catalog, ['zebra'], { rules: { minBreakMinutes: 10, attendance: 'online' } }))).toEqual([['A1', 'A2', 'A3']]);
    expect(planned(plan(catalog, ['zebra'], { rules: { minBreakMinutes: 0, attendance: 'in_person' } }))).toEqual([['A1', 'A2', 'A3']]);
    expect(planned(plan(catalog, ['zebra'], { rules: { minBreakMinutes: 11, attendance: 'in_person' } }))).toEqual([['A1', 'A3']]);
  });

  it('plans every day on its own, in date order', () => {
    const catalog = syntheticCatalog([zebra('A1', [WED, '09:00', '10:00']), zebra('A2', [TUE, '09:00', '10:00']), zebra('A3', [WED, '11:00', '12:00'])]);
    const agenda = plan(catalog, ['zebra'], { maxPerDay: 1 });
    expect(agenda.days.map((day) => day.date)).toEqual([TUE, WED]);
    expect(planned(agenda)).toEqual([['A2'], ['A1']]);
  });

  it('lists each day in time order', () => {
    const catalog = syntheticCatalog([zebra('A1', [TUE, '15:00', '16:00']), zebra('A2', [TUE, '09:00', '10:00']), zebra('A3', [TUE, '11:00', '12:00'])]);
    expect(planned(plan(catalog, ['zebra']))).toEqual([['A2', 'A3', 'A1']]);
  });

  it('puts the session slot on each item, and leaves out on-demand sessions', () => {
    const catalog = syntheticCatalog([zebra('A1', [TUE, '09:00', '10:00']), zebra('A2')]);
    const agenda = plan(catalog, ['zebra']);
    expect(planned(agenda)).toEqual([['A1']]);
    expect(agenda.days[0]?.items[0]?.entry.occurrence.slotId).toBe(`A1@${TUE}T09:00`);
    expect(agenda.days[0]?.items[0]?.pinned).toBe(false);
    expect(agenda.skipped).toEqual([]);
  });
});

describe('limits and skipped sessions', () => {
  const crowd = syntheticCatalog(
    ['B1', 'B2', 'B3', 'B4'].map((code, index) => zebra(code, [TUE, `${String(9 + index * 2).padStart(2, '0')}:00`, `${String(10 + index * 2).padStart(2, '0')}:00`])),
  );

  it('never plans more than the daily maximum', () => {
    const agenda = plan(crowd, ['zebra'], { maxPerDay: 2 });
    expect(planned(agenda)).toEqual([['B1', 'B2']]);
    expect(agenda.skipped.map((item) => [item.session.code, item.reason])).toEqual([
      ['B3', 'Tue Nov 17 already has 2 sessions'],
      ['B4', 'Tue Nov 17 already has 2 sessions'],
    ]);
  });

  it('says "session" for a maximum of one', () => {
    const agenda = plan(crowd, ['zebra'], { maxPerDay: 1 });
    expect(agenda.skipped[0]?.reason).toBe('Tue Nov 17 already has 1 session');
  });

  it('explains a session that is too close to a planned one', () => {
    const catalog = syntheticCatalog([zebra('S1', [TUE, '09:00', '10:00']), zebra('S2', [TUE, '10:05', '11:00'])]);
    const agenda = plan(catalog, ['zebra'], { maxPerDay: 1 });
    expect(planned(agenda)).toEqual([['S1']]);
    expect(agenda.skipped.map((item) => [item.session.code, item.reason])).toEqual([['S2', 'is too close to S1']]);
  });

  it('offers up to two overlapping sessions as alternatives and explains the rest', () => {
    const catalog = syntheticCatalog(['A1', 'B1', 'B2', 'B3'].map((code) => zebra(code, [TUE, '09:00', '10:00'])));
    const agenda = plan(catalog, ['zebra'], { maxPerDay: 1 });
    expect(planned(agenda)).toEqual([['A1']]);
    const [item] = agenda.days[0]?.items ?? [];
    expect(item?.alternatives.map((alternative) => alternative.session.code)).toEqual(['B1', 'B2']);
    expect(item?.alternatives[0]?.occurrence.slotId).toBe(`B1@${TUE}T09:00`);
    expect(item?.alternatives[0]?.matches[0]?.interest).toBe('zebra');
    expect(agenda.skipped.map((skipped) => [skipped.session.code, skipped.reason])).toEqual([['B3', 'overlaps A1']]);
  });

  it('lists at most eight skipped sessions', () => {
    const many = syntheticCatalog(
      Array.from({ length: 14 }, (_, index) => zebra(`C${index + 1}`, [TUE, `${String(8 + index).padStart(2, '0')}:00`, `${String(8 + index).padStart(2, '0')}:30`])),
    );
    const agenda = plan(many, ['zebra'], { maxPerDay: 1 });
    expect(planned(agenda)).toEqual([['C1']]);
    expect(agenda.skipped).toHaveLength(8);
    expect(agenda.skipped.map((item) => item.session.code)).toEqual(['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9']);
  });
});

describe('sharing the agenda between interests', () => {
  const catalog = syntheticCatalog([
    zebra('A1', [TUE, '09:00', '10:00']),
    zebra('A2', [TUE, '11:00', '12:00']),
    zebra('A3', [TUE, '13:00', '14:00']),
    yak('B1', [TUE, '15:00', '16:00']),
  ]);

  it('gives a narrow interest a place before a broad one gets a second', () => {
    const agenda = plan(catalog, ['zebra', 'yak'], { maxPerDay: 2 });
    expect(planned(agenda)).toEqual([['A1', 'B1']]);
    expect(agenda.coverage).toEqual([
      { interest: 'zebra', sessions: 1 },
      { interest: 'yak', sessions: 1 },
    ]);
  });

  it('still fills the remaining room with the broader interest', () => {
    const agenda = plan(catalog, ['zebra', 'yak'], { maxPerDay: 3 });
    expect(planned(agenda)).toEqual([['A1', 'A2', 'B1']]);
    expect(agenda.coverage).toEqual([
      { interest: 'zebra', sessions: 2 },
      { interest: 'yak', sessions: 1 },
    ]);
  });

  it('reports how each interest fared, including one that matched nothing', () => {
    const agenda = plan(catalog, ['zebra', 'unicorn']);
    expect(agenda.interests.map((summary) => [summary.interest, summary.matches])).toEqual([
      ['zebra', 3],
      ['unicorn', 0],
    ]);
    expect(agenda.coverage).toEqual([
      { interest: 'zebra', sessions: 3 },
      { interest: 'unicorn', sessions: 0 },
    ]);
  });

  it('records which interests each item answers', () => {
    const agenda = plan(catalog, ['zebra', 'yak']);
    const matched = Object.fromEntries((agenda.days[0]?.items ?? []).map((item) => [item.entry.session.code, item.matches.map((match) => match.interest)]));
    expect(matched).toEqual({ A1: ['zebra'], A2: ['zebra'], A3: ['zebra'], B1: ['yak'] });
  });
});

describe('sessions offered several times', () => {
  it('picks the time that competes least with the other sessions', () => {
    const catalog = syntheticCatalog([zebra('A1', [TUE, '09:00', '10:00']), zebra('A2', [TUE, '09:00', '10:00'], [WED, '09:00', '10:00'])]);
    const agenda = plan(catalog, ['zebra']);
    expect(planned(agenda)).toEqual([['A1'], ['A2']]);
    const [wed] = agenda.days.slice(1);
    const entry = wed?.items[0]?.entry;
    expect(entry?.occurrence.slotId).toBe(`A2@${WED}T09:00`);
    expect(entry?.fixed).toBe(false);
    expect(entry?.otherSlots.map((slot) => slot.slotId)).toEqual([`A2@${TUE}T09:00`]);
  });

  it('only considers the slots the filters allow', () => {
    const catalog = syntheticCatalog([zebra('A1', [TUE, '09:00', '10:00']), zebra('A2', [TUE, '09:00', '10:00'], [WED, '09:00', '10:00'])]);
    const agenda = plan(catalog, ['zebra'], { filters: { days: ['Tuesday'] } });
    expect(agenda.days.map((day) => day.date)).toEqual([TUE]);
    expect(planned(agenda)).toEqual([['A1']]);
    expect(agenda.days[0]?.items[0]?.alternatives.map((alternative) => alternative.session.code)).toEqual(['A2']);
  });
});

describe('sessions the attendee insists on', () => {
  const catalog = syntheticCatalog([
    zebra('A1', [TUE, '09:00', '10:00']),
    zebra('A2', [TUE, '09:30', '10:30']),
    zebra('A3', [TUE, '10:05', '11:00']),
    zebra('A4', [TUE, '11:00', '12:00']),
    makeSession('X1', { title: 'Something else entirely' }, [makeSlot('X1', TUE, '15:00', '16:00')]),
  ]);

  it('places them first and plans everything else around them', () => {
    const agenda = plan(catalog, ['zebra'], { mustInclude: pin(catalog, 'A1') });
    expect(planned(agenda)).toEqual([['A1', 'A4']]);
    expect(agenda.days[0]?.items.map((item) => item.pinned)).toEqual([true, false]);
    expect(agenda.days[0]?.items[0]?.matches.map((match) => match.interest)).toEqual(['zebra']);
    expect(agenda.pinnedConflicts).toEqual([]);
  });

  it('says what a pinned session pushed out', () => {
    const agenda = plan(catalog, ['zebra'], { mustInclude: pin(catalog, 'A1') });
    expect(agenda.skipped.map((item) => [item.session.code, item.reason])).toEqual([
      ['A2', 'clashes with A1, which you asked to include'],
      ['A3', 'clashes with A1, which you asked to include'],
    ]);
  });

  it('counts them towards the daily maximum', () => {
    const agenda = plan(catalog, ['zebra'], { mustInclude: pin(catalog, 'A1', 'A4'), maxPerDay: 2 });
    expect(planned(agenda)).toEqual([['A1', 'A4']]);
    expect(agenda.days[0]?.items.every((item) => item.pinned)).toBe(true);
  });

  it('keeps them even when they match none of the interests', () => {
    const agenda = plan(catalog, ['zebra'], { mustInclude: pin(catalog, 'X1') });
    const pinned = agenda.days[0]?.items.find((item) => item.entry.session.code === 'X1');
    expect(pinned?.pinned).toBe(true);
    expect(pinned?.matches).toEqual([]);
    expect(agenda.coverage).toEqual([{ interest: 'zebra', sessions: 2 }]);
  });

  it('shows days that hold only pinned sessions', () => {
    const extra = syntheticCatalog([zebra('A1', [TUE, '09:00', '10:00']), makeSession('X1', { title: 'Yak' }, [makeSlot('X1', WED, '09:00', '10:00')])]);
    const agenda = plan(extra, ['zebra'], { mustInclude: pin(extra, 'X1') });
    expect(agenda.days.map((day) => day.date)).toEqual([TUE, WED]);
    expect(planned(agenda)).toEqual([['A1'], ['X1']]);
  });

  it('reports pinned sessions that clash with each other, because it cannot fix those', () => {
    const agenda = plan(catalog, ['zebra'], { mustInclude: pin(catalog, 'A1', 'A2') });
    expect(planned(agenda)[0]).toEqual(expect.arrayContaining(['A1', 'A2']));
    expect(agenda.pinnedConflicts.map((conflict) => [conflict.kind, conflict.first.session.code, conflict.second.session.code, conflict.minutes])).toEqual([['overlap', 'A1', 'A2', 30]]);
  });

  it('can leave out sessions the attendee does not want', () => {
    const agenda = plan(catalog, ['zebra'], { avoid: new Set(['A1', 'A4']) });
    const all = [...planned(agenda).flat(), ...agenda.days.flatMap((day) => day.items.flatMap((item) => item.alternatives.map((alternative) => alternative.session.code))), ...agenda.skipped.map((item) => item.session.code)];
    expect(all).not.toContain('A1');
    expect(all).not.toContain('A4');
    expect(all).toContain('A2');
  });
});

describe('filters and empty results', () => {
  const catalog = syntheticCatalog([
    zebra('A1', [TUE, '09:00', '10:00']),
    zebra('A2', [WED, '09:00', '10:00']),
    makeSession('A3', { title: 'Zebra', delivery: ['Online'] }, [makeSlot('A3', WED, '11:00', '12:00')]),
  ]);

  it('plans only the days asked for', () => {
    const agenda = plan(catalog, ['zebra'], { filters: { days: ['Wednesday'] } });
    expect(agenda.days.map((day) => day.date)).toEqual([WED]);
    expect(planned(agenda)).toEqual([['A2', 'A3']]);
  });

  it('plans only sessions that can be attended the way the attendee wants', () => {
    expect(planned(plan(catalog, ['zebra'], { filters: { delivery: ['Online'] } }))).toEqual([['A3']]);
  });

  it('returns an empty plan when nothing matches, rather than failing', () => {
    const agenda = plan(catalog, ['unicorn']);
    expect(agenda.days).toEqual([]);
    expect(agenda.skipped).toEqual([]);
    expect(agenda.pinnedConflicts).toEqual([]);
    expect(agenda.coverage).toEqual([{ interest: 'unicorn', sessions: 0 }]);
    expect(plan(catalog, ['zebra'], { filters: { days: ['Friday'] } }).days).toEqual([]);
  });
});

describe('an agenda for the real schedule', () => {
  const catalog = fixtureCatalog();
  const interests = ['security', 'copilot', 'MCP'];

  const check = (agenda: Agenda, rules: GapRules, maxPerDay: number) => {
    const entries = agenda.days.flatMap((day) => day.items.map((item) => item.entry));
    const codes = entries.map((entry) => entry.session.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(findConflicts(entries, rules)).toEqual([]);
    expect(agenda.days.map((day) => day.date)).toEqual([...agenda.days.map((day) => day.date)].sort());
    for (const day of agenda.days) {
      expect(day.items.length).toBeGreaterThan(0);
      expect(day.items.length).toBeLessThanOrEqual(maxPerDay);
      const starts = day.items.map((item) => item.entry.occurrence.startMs);
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
      for (const item of day.items) {
        expect(item.entry.occurrence.date).toBe(day.date);
        expect(item.entry.session.occurrences).toContain(item.entry.occurrence);
        expect(item.alternatives.length).toBeLessThanOrEqual(2);
        for (const alternative of item.alternatives) {
          expect(alternative.occurrence.startMs).toBeLessThan(item.entry.occurrence.endMs);
          expect(alternative.occurrence.endMs).toBeGreaterThan(item.entry.occurrence.startMs);
          expect(codes).not.toContain(alternative.session.code);
        }
      }
    }
    expect(agenda.skipped.length).toBeLessThanOrEqual(8);
    for (const skipped of agenda.skipped) {
      expect(codes).not.toContain(skipped.session.code);
      expect(skipped.reason).not.toBe('');
    }
    for (const { interest, sessions } of agenda.coverage) {
      expect(sessions).toBe(agenda.days.flatMap((day) => day.items).filter((item) => item.matches.some((match) => match.interest === interest)).length);
    }
    return codes;
  };

  it('has no clashes, respects the daily maximum and explains what it left out', () => {
    for (const maxPerDay of [1, 2, 3, 5]) {
      const agenda = plan(catalog, interests, { maxPerDay });
      const codes = check(agenda, RULES, maxPerDay);
      expect(codes.length).toBeGreaterThan(0);
    }
  });

  it('keeps to a larger break and to online travel rules', () => {
    for (const rules of [{ minBreakMinutes: 60, attendance: 'in_person' }, { minBreakMinutes: 0, attendance: 'online' }] as GapRules[]) {
      check(plan(catalog, interests, { rules, maxPerDay: 4 }), rules, 4);
    }
  });

  it('works around pinned sessions without clashing with them', () => {
    const mustInclude = pin(catalog, 'KEY01', 'LAB652@2026-11-19T09:00');
    const agenda = plan(catalog, interests, { mustInclude, maxPerDay: 4 });
    const codes = check(agenda, RULES, 4);
    expect(codes).toEqual(expect.arrayContaining(['KEY01', 'LAB652']));
    const pinned = agenda.days.flatMap((day) => day.items).filter((item) => item.pinned);
    expect(pinned.map((item) => item.entry.session.code).sort()).toEqual(['KEY01', 'LAB652']);
  });

  it('stays inside the filters', () => {
    const agenda = plan(catalog, interests, { filters: { days: ['Wednesday', 'Thursday'], levels: ['200', '300'] } });
    expect(agenda.days.length).toBeGreaterThan(0);
    for (const day of agenda.days) {
      expect(['2026-11-18', '2026-11-19']).toContain(day.date);
      for (const item of day.items) expect(['200', '300']).toContain(String(item.entry.session.levelNumber));
    }
  });
});
