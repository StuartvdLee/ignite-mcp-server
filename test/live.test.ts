import { beforeAll, describe, expect, it } from 'vitest';
import type { Catalog } from '../src/catalog/catalog';
import type { SessionFilters } from '../src/catalog/filters';
import { DEFAULT_WINDOW_MINUTES, eventWindow, resolveAt, whatsOn } from '../src/catalog/live';
import type { LiveGroup, WhatsOnOptions } from '../src/catalog/live';
import { fixtureCatalog, makeSession, makeSlot, pacific, snapshotCatalog, syntheticCatalog } from './helpers';

const TUE = '2026-11-17';
const WED = '2026-11-18';
const THU = '2026-11-19';

function run(catalog: Catalog, atMs: number, extra: Partial<WhatsOnOptions> & { filters?: SessionFilters } = {}) {
  const { filters, ...options } = extra;
  return whatsOn(catalog, { resolved: catalog.resolve(filters, atMs), atMs, limit: 10, ...options });
}
const codes = (group: LiveGroup) => group.items.map((item) => item.session.code);
const minutes = (group: LiveGroup) => group.items.map((item) => item.minutes);

describe('the event window', () => {
  it('runs from the first start to the last end', () => {
    expect(eventWindow(fixtureCatalog())).toEqual({ startMs: pacific('2026-11-16', '13:30'), endMs: pacific('2026-11-20', '10:15') });
  });

  it('is unknown when nothing is scheduled', () => {
    expect(eventWindow(syntheticCatalog([]))).toBeUndefined();
    expect(eventWindow(syntheticCatalog([makeSession('D1')]))).toBeUndefined();
  });

  it('covers the whole real schedule', async () => {
    const window = eventWindow(await snapshotCatalog());
    expect(window?.startMs).toBe(pacific('2026-11-16', '13:30'));
    expect(window?.endMs).toBeGreaterThan(pacific('2026-11-20', '08:00'));
    expect(window?.endMs).toBeLessThan(pacific('2026-11-21', '00:00'));
  });
});

describe('reading the time to look at', () => {
  const now = pacific('2026-11-18', '08:00');

  it('uses now when nothing is given', () => {
    expect(resolveAt(undefined, now)).toEqual({ ms: now });
    expect(resolveAt('', now)).toEqual({ ms: now });
    expect(resolveAt('   ', now)).toEqual({ ms: now });
  });

  it('reads a date and time as Pacific Time', () => {
    expect(resolveAt('2026-11-18T14:00', now)).toEqual({ ms: pacific(WED, '14:00') });
    expect(resolveAt(' 2026-11-19T09:30 ', now)).toEqual({ ms: pacific(THU, '09:30') });
  });

  it('reads a clock time as today at the event', () => {
    expect(resolveAt('2pm', now)).toEqual({ ms: pacific(WED, '14:00') });
    expect(resolveAt(' 14:30 ', now)).toEqual({ ms: pacific(WED, '14:30') });
    expect(resolveAt('9:05am', now)).toEqual({ ms: pacific(WED, '09:05') });
  });

  it('takes "today" from Pacific Time, even when it is already tomorrow in UTC', () => {
    const lateEvening = pacific(WED, '23:30');
    expect(new Date(lateEvening).toISOString().slice(0, 10)).toBe(THU);
    expect(resolveAt('2pm', lateEvening)).toEqual({ ms: pacific(WED, '14:00') });
  });

  it('reads 24:00 as the start of the next day', () => {
    expect(resolveAt('24:00', now)).toEqual({ ms: pacific(THU, '00:00') });
  });

  it('explains what it can accept when it cannot read the text', () => {
    const result = resolveAt('  banana ', now);
    expect(result).toEqual({
      error: 'Could not understand at="banana". Use an ISO date-time such as 2026-11-18T14:00 (Pacific Time), or a clock time such as "2pm" (today).',
    });
    expect('ms' in result).toBe(false);
    expect('error' in resolveAt('2026-13-45T10:00', now)).toBe(true);
  });
});

describe("what's on at the real event", () => {
  const catalog = fixtureCatalog();

  it('tells before, during and after the event apart', () => {
    expect(run(catalog, pacific('2026-11-16', '12:00')).phase).toBe('before_event');
    expect(run(catalog, pacific('2026-11-16', '13:29')).phase).toBe('before_event');
    expect(run(catalog, pacific('2026-11-16', '13:30')).phase).toBe('during_event');
    expect(run(catalog, pacific(TUE, '07:00')).phase).toBe('during_event');
    expect(run(catalog, pacific('2026-11-20', '10:14')).phase).toBe('during_event');
    expect(run(catalog, pacific('2026-11-20', '10:15')).phase).toBe('after_event');
    expect(run(catalog, pacific('2026-11-20', '20:00')).phase).toBe('after_event');
  });

  it('repeats the window it looked at', () => {
    const at = pacific(TUE, '10:30');
    const result = run(catalog, at);
    expect(result.atMs).toBe(at);
    expect(result.windowMinutes).toBe(DEFAULT_WINDOW_MINUTES);
    expect(result.eventStartMs).toBe(pacific('2026-11-16', '13:30'));
    expect(result.eventEndMs).toBe(pacific('2026-11-20', '10:15'));
    expect(run(catalog, at, { windowMinutes: 15 }).windowMinutes).toBe(15);
  });

  it('shows what is on now, with the minutes left', () => {
    const result = run(catalog, pacific(TUE, '10:30'));
    expect(codes(result.inProgress)).toEqual(['KEY01']);
    expect(minutes(result.inProgress)).toEqual([90]);
    expect(result.inProgress.total).toBe(1);
    expect(result.startingSoon).toEqual({ total: 0, items: [] });
    expect(result.next).toEqual({ total: 0, items: [] });
  });

  it('shows what starts soon, with the minutes to wait', () => {
    const result = run(catalog, pacific(TUE, '11:55'));
    expect(codes(result.inProgress)).toEqual(['KEY01']);
    expect(minutes(result.inProgress)).toEqual([5]);
    expect(codes(result.startingSoon)).toEqual(['LIVE50']);
    expect(minutes(result.startingSoon)).toEqual([5]);
    expect(result.startingSoon.items[0]?.occurrence.slotId).toBe(`LIVE50@${TUE}T12:00`);
  });

  it('only looks as far ahead as the window', () => {
    const at = pacific(TUE, '14:10');
    const wide = run(catalog, at);
    expect(codes(wide.startingSoon)).toEqual(['THRSP1050', 'TT1692']);
    expect(minutes(wide.startingSoon)).toEqual([25, 55]);
    const narrow = run(catalog, at, { windowMinutes: 30 });
    expect(codes(narrow.startingSoon)).toEqual(['THRSP1050']);
    expect(run(catalog, at, { windowMinutes: 15 }).startingSoon.total).toBe(0);
    expect(codes(narrow.inProgress)).toEqual(codes(wide.inProgress));
  });

  it('lists several sessions at once in time order', () => {
    const result = run(catalog, pacific(TUE, '14:10'));
    expect(result.inProgress.total).toBe(4);
    expect(codes(result.inProgress)).toEqual(['BRK323', 'LAB711', 'LAB723', 'LABSP830']);
    expect(minutes(result.inProgress)).toEqual([35, 65, 65, 65]);
    for (const item of result.inProgress.items) {
      expect(item.session.occurrences).toContain(item.occurrence);
      expect(item.relevance).toBe(1);
      expect(item.matchedFields).toEqual([]);
    }
  });

  it('keeps the best few and still counts them all', () => {
    const result = run(catalog, pacific(TUE, '14:10'), { limit: 2 });
    expect(result.inProgress.total).toBe(4);
    expect(codes(result.inProgress)).toEqual(['BRK323', 'LAB711']);
    expect(result.startingSoon.total).toBe(2);
    expect(codes(run(catalog, pacific(TUE, '14:10'), { limit: 1 }).startingSoon)).toEqual(['THRSP1050']);
  });

  it('shows the next sessions to start when nothing is on or about to start', () => {
    const before = run(catalog, pacific('2026-11-16', '12:00'));
    expect(before.inProgress.total + before.startingSoon.total).toBe(0);
    expect(codes(before.next)).toEqual(['BRK101']);
    expect(minutes(before.next)).toEqual([90]);

    const early = run(catalog, pacific(TUE, '07:00'));
    expect(codes(early.next)).toEqual(['KEY01']);
    expect(minutes(early.next)).toEqual([180]);
  });

  it('groups the next sessions that start within half an hour of the first', () => {
    const result = run(catalog, pacific(WED, '17:30'));
    expect(result.inProgress.total + result.startingSoon.total).toBe(0);
    expect(codes(result.next)).toEqual(['LAB652', 'LAB711', 'LTG1356']);
    expect(result.next.items.map((item) => item.occurrence.slotId)).toEqual([`LAB652@${THU}T09:00`, `LAB711@${THU}T09:00`, `LTG1356@${THU}T09:25`]);
    expect(minutes(result.next)).toEqual([930, 930, 955]);
    expect(result.next.total).toBe(3);
  });

  it('does not suggest what is next while something is on or about to start', () => {
    const running = run(catalog, pacific(TUE, '10:30'));
    expect(running.inProgress.total).toBe(1);
    expect(running.next).toEqual({ total: 0, items: [] });
    const aboutToStart = run(catalog, pacific(TUE, '09:30'));
    expect(codes(aboutToStart.startingSoon)).toEqual(['KEY01']);
    expect(aboutToStart.next).toEqual({ total: 0, items: [] });
  });

  it('has nothing to show once the event is over', () => {
    const result = run(catalog, pacific('2026-11-20', '20:00'));
    expect(result.phase).toBe('after_event');
    for (const group of [result.inProgress, result.startingSoon, result.next]) expect(group).toEqual({ total: 0, items: [] });
  });

  it('shows the last sessions of the event while they run', () => {
    const result = run(catalog, pacific('2026-11-20', '09:30'));
    expect(codes(result.inProgress)).toEqual(['LAB724']);
    expect(minutes(result.inProgress)).toEqual([45]);
  });

  it('shows a session that repeats only for the time it is on', () => {
    const result = run(catalog, pacific(TUE, '14:10'));
    const lab = result.inProgress.items.find((item) => item.session.code === 'LAB711');
    expect(lab?.occurrence.slotId).toBe(`LAB711@${TUE}T14:00`);
    expect(result.inProgress.items.filter((item) => item.session.code === 'LAB711')).toHaveLength(1);
  });

  describe('narrowed down by a query or filters', () => {
    const at = pacific(TUE, '14:10');

    it('keeps only what matches the query, best match first when it has to choose', () => {
      const all = run(catalog, at);
      const matching = run(catalog, at, { query: 'cloud' });
      expect(matching.inProgress.total).toBeGreaterThan(0);
      expect(matching.inProgress.total).toBeLessThan(all.inProgress.total);
      for (const group of [matching.inProgress, matching.startingSoon]) {
        for (const item of group.items) {
          expect(item.relevance).toBeGreaterThan(0);
          expect(item.matchedFields.length).toBeGreaterThan(0);
        }
      }
      const everything = run(catalog, at, { query: 'cloud', limit: 25 }).inProgress.items;
      const best = run(catalog, at, { query: 'cloud', limit: 1 }).inProgress;
      expect(best.total).toBe(everything.length);
      expect(best.items[0]?.relevance).toBe(Math.max(...everything.map((item) => item.relevance)));
    });

    it('reports how it understood the query', () => {
      expect(run(catalog, at, { query: 'MCP' }).expansions).toEqual(['mcp = model context protocol']);
      expect(run(catalog, at).expansions).toEqual([]);
    });

    it('finds nothing for a query that matches nothing', () => {
      const result = run(catalog, at, { query: 'zzzzqqq' });
      for (const group of [result.inProgress, result.startingSoon, result.next]) expect(group).toEqual({ total: 0, items: [] });
    });

    it('applies the filters to the sessions', () => {
      const result = run(catalog, at, { filters: { topics: ['Cloud & AI'] } });
      expect(codes(result.inProgress)).toEqual(['LAB723', 'LABSP830']);
      expect(codes(result.startingSoon)).toEqual(['TT1692']);
      const online = run(catalog, pacific(TUE, '11:55'), { filters: { delivery: ['Online'] } });
      expect(codes(online.startingSoon)).toEqual(['LIVE50']);
      for (const item of [...online.inProgress.items, ...online.startingSoon.items]) expect(item.session.delivery).toContain('Online');
    });

    it('looks for the next sessions within the filters only', () => {
      const result = run(catalog, pacific(TUE, '11:55'), { filters: { topics: ['Windows'] } });
      expect(result.inProgress.total + result.startingSoon.total).toBe(0);
      expect(result.next.items.length).toBeGreaterThan(0);
      for (const item of result.next.items) expect(item.session.topics).toContain('Windows');
    });
  });
});

describe('the edges of a session', () => {
  const catalog = syntheticCatalog([
    makeSession('P1', { title: 'Alpha' }, [makeSlot('P1', TUE, '09:00', '10:00')]),
    makeSession('P2', { title: 'Beta', featured: true }, [makeSlot('P2', TUE, '09:30', '10:30')]),
    makeSession('P3', { title: 'Gamma' }, [makeSlot('P3', TUE, '09:45', '10:15')]),
    makeSession('Q1', { title: 'Delta' }, [makeSlot('Q1', TUE, '10:30', '11:00')]),
    makeSession('Q2', { title: 'Epsilon' }, [makeSlot('Q2', TUE, '11:00', '12:00')]),
    makeSession('Q3', { title: 'Zeta' }, [makeSlot('Q3', TUE, '11:01', '12:00')]),
    makeSession('R1', { title: 'Eta' }, [makeSlot('R1', WED, '09:00', '10:00')]),
    makeSession('R2', { title: 'Theta' }, [makeSlot('R2', WED, '09:30', '10:00')]),
    makeSession('R3', { title: 'Iota' }, [makeSlot('R3', WED, '09:31', '10:00')]),
    makeSession('D1', { title: 'Kappa' }),
  ]);

  it('counts a session as on from its first minute until just before its end', () => {
    expect(codes(run(catalog, pacific(TUE, '09:00')).inProgress)).toEqual(['P1']);
    expect(codes(run(catalog, pacific(TUE, '08:59')).inProgress)).toEqual([]);
    expect(codes(run(catalog, pacific(TUE, '09:59')).inProgress)).toEqual(['P1', 'P2', 'P3']);
    expect(codes(run(catalog, pacific(TUE, '10:00')).inProgress)).toEqual(['P2', 'P3']);
  });

  it('counts a session as starting soon up to and including the end of the window', () => {
    const atTen = run(catalog, pacific(TUE, '10:00'));
    expect(codes(atTen.startingSoon)).toEqual(['Q1', 'Q2']);
    expect(minutes(atTen.startingSoon)).toEqual([30, 60]);
    expect(codes(run(catalog, pacific(TUE, '10:00'), { windowMinutes: 59 }).startingSoon)).toEqual(['Q1']);
    expect(codes(run(catalog, pacific(TUE, '10:01')).startingSoon)).toEqual(['Q1', 'Q2', 'Q3']);
  });

  it('does not call a session that has just started "starting soon"', () => {
    const result = run(catalog, pacific(TUE, '10:30'));
    expect(codes(result.inProgress)).toEqual(['Q1']);
    expect(codes(result.startingSoon)).toEqual(['Q2', 'Q3']);
  });

  it('shows featured sessions first when it has to choose without a query', () => {
    const at = pacific(TUE, '09:50');
    const result = run(catalog, at, { limit: 1 });
    expect(result.inProgress.total).toBe(3);
    expect(codes(result.inProgress)).toEqual(['P2']);
    expect(minutes(result.inProgress)).toEqual([40]);
    const two = run(catalog, at, { limit: 2 });
    expect(codes(two.inProgress)).toEqual(['P1', 'P2']);
  });

  it('chooses by relevance with a query, then shows the choice in time order', () => {
    const result = run(catalog, pacific(TUE, '09:40'), { query: 'alpha' });
    expect(codes(result.inProgress)).toEqual(['P1']);
    expect(result.inProgress.total).toBe(1);
    expect(result.inProgress.items[0]?.matchedFields).toContain('title');
  });

  it('groups the next sessions by how close they start to the first one', () => {
    const result = run(catalog, pacific(TUE, '12:30'));
    expect(codes(result.next)).toEqual(['R1', 'R2']);
    expect(result.next.total).toBe(2);
    expect(minutes(result.next)).toEqual([20 * 60 + 30, 21 * 60]);
  });

  it('keeps the whole count of the next group when it has to cut it short', () => {
    const result = run(catalog, pacific(TUE, '12:30'), { limit: 1 });
    expect(result.next.total).toBe(2);
    expect(result.next.items).toHaveLength(1);
  });

  it('never shows on-demand sessions', () => {
    for (const hour of ['08:00', '09:40', '12:30']) {
      const result = run(catalog, pacific(TUE, hour));
      for (const group of [result.inProgress, result.startingSoon, result.next]) expect(codes(group)).not.toContain('D1');
    }
  });

  it('can be before the event, during it or after it', () => {
    expect(run(catalog, pacific(TUE, '08:59')).phase).toBe('before_event');
    expect(run(catalog, pacific(TUE, '09:00')).phase).toBe('during_event');
    expect(run(catalog, pacific(WED, '09:59')).phase).toBe('during_event');
    expect(run(catalog, pacific(WED, '10:00')).phase).toBe('after_event');
  });

  it('copes with a catalog that has nothing scheduled', () => {
    const result = run(syntheticCatalog([makeSession('D1')]), pacific(TUE, '09:00'));
    for (const group of [result.inProgress, result.startingSoon, result.next]) expect(group).toEqual({ total: 0, items: [] });
  });
});

describe("what's on across the whole real schedule", () => {
  let catalog: Catalog;
  beforeAll(async () => {
    catalog = await snapshotCatalog();
  });

  // An independent, deliberately plain version of the same rules.
  const expectedSlots = (atMs: number, windowMinutes: number) => {
    const horizon = atMs + windowMinutes * 60_000;
    const slots = catalog.sessions.flatMap((session) => session.occurrences);
    const inProgress = slots.filter((slot) => slot.startMs <= atMs && atMs < slot.endMs);
    const soon = slots.filter((slot) => slot.startMs > atMs && slot.startMs <= horizon);
    const later = slots.filter((slot) => slot.startMs > horizon);
    const first = Math.min(...later.map((slot) => slot.startMs));
    const next = inProgress.length === 0 && soon.length === 0 ? later.filter((slot) => slot.startMs <= first + 30 * 60_000) : [];
    return { inProgress, soon, next };
  };
  const slotIds = (group: LiveGroup) => group.items.map((item) => item.occurrence.slotId).sort();

  it('agrees with a plain scan of the schedule at any time of the event', () => {
    const start = pacific('2026-11-16', '00:00');
    const end = pacific('2026-11-21', '00:00');
    let checked = 0;
    let busiest = 0;
    for (let atMs = start; atMs < end; atMs += 37 * 60_000) {
      const windowMinutes = [15, 60, 120][checked % 3] ?? 60;
      const result = run(catalog, atMs, { limit: 100_000, windowMinutes });
      const expected = expectedSlots(atMs, windowMinutes);
      expect(slotIds(result.inProgress)).toEqual(expected.inProgress.map((slot) => slot.slotId).sort());
      expect(slotIds(result.startingSoon)).toEqual(expected.soon.map((slot) => slot.slotId).sort());
      expect(slotIds(result.next)).toEqual(expected.next.map((slot) => slot.slotId).sort());
      expect(result.inProgress.total).toBe(expected.inProgress.length);
      busiest = Math.max(busiest, result.inProgress.total);
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
    expect(busiest).toBeGreaterThan(20);
  });

  it('shows who is on stage during the opening keynote', () => {
    const result = run(catalog, pacific(TUE, '10:30'), { query: 'keynote' });
    expect(codes(result.inProgress)).toContain('KEY01');
  });
});
