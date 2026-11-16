import { describe, expect, it } from 'vitest';
import { MIN_INTEREST_RELEVANCE, diversify, scoreInterests } from '../src/catalog/interests';
import type { InterestMatch, ScoreOptions, ScoredSession } from '../src/catalog/interests';
import { fixtureCatalog, makeSession, makeSlot, pacific, syntheticCatalog } from './helpers';

const catalog = fixtureCatalog();
const NOW = pacific('2026-11-16', '12:00');
const NO_FILTERS = catalog.resolve(undefined, NOW);

const score = (interests: string[], options: ScoreOptions = {}) => scoreInterests(catalog, interests, NO_FILTERS, options);

const MCP_SESSIONS = ['LAB724', 'LAB724D', 'LTG1192', 'LTG1285', 'LTG1356', 'THR859', 'THR978', 'TT1692', 'TT1767'];

describe('scoring sessions against interests', () => {
  it('finds the sessions for each interest, best first', () => {
    const { sessions, interests } = score(['MCP']);
    expect(sessions.map((scored) => scored.session.code).sort()).toEqual(MCP_SESSIONS);
    expect(interests).toEqual([{ interest: 'MCP', matches: MCP_SESSIONS.length, expansions: ['mcp = model context protocol'] }]);
    for (let index = 1; index < sessions.length; index++) expect(sessions[index - 1]!.total).toBeGreaterThanOrEqual(sessions[index]!.total);
    for (const scored of sessions) {
      expect(scored.matches).toHaveLength(1);
      expect(scored.matches[0]?.interest).toBe('MCP');
      expect(scored.total).toBeCloseTo(scored.matches[0]!.relevance, 10);
      expect(scored.gain).toBe(scored.total);
    }
  });

  it('adds up the relevance of every interest a session matches', () => {
    const { sessions, interests } = score(['MCP', 'security']);
    const both = sessions.find((scored) => scored.session.code === 'THR978');
    expect(both?.matches.map((match) => match.interest)).toEqual(['MCP', 'security']);
    expect(both?.total).toBeCloseTo(both!.matches.reduce((sum, match) => sum + match.relevance, 0), 10);
    expect(both!.total).toBeGreaterThan(1);
    expect(sessions[0]?.session.code).toBe('THR978');
    expect(interests.map((summary) => summary.interest)).toEqual(['MCP', 'security']);
    for (const summary of interests) {
      const matching = sessions.filter((scored) => scored.matches.some((match) => match.interest === summary.interest));
      expect(summary.matches).toBe(matching.length);
    }
  });

  it('keeps only matches that are strong enough', () => {
    const { sessions } = score(['security']);
    expect(sessions.length).toBeGreaterThan(5);
    for (const scored of sessions) for (const match of scored.matches) expect(match.relevance).toBeGreaterThanOrEqual(MIN_INTEREST_RELEVANCE);
    const strict = score(['security'], { minRelevance: 1 });
    expect(strict.sessions.length).toBeGreaterThan(0);
    expect(strict.sessions.length).toBeLessThan(sessions.length);
    for (const scored of strict.sessions) expect(scored.matches[0]?.relevance).toBe(1);
    expect(strict.interests[0]?.matches).toBe(strict.sessions.length);
  });

  it('says where each match came from', () => {
    const { sessions } = score(['copilot sharepoint']);
    const [top] = sessions;
    expect(top?.session.code).toBe('BRK217');
    expect(top?.matches[0]?.matchedFields).toEqual(expect.arrayContaining(['title', 'tags']));
    expect(top?.matches[0]?.matchedTags).toEqual(expect.arrayContaining(['SharePoint']));
  });

  it('ignores blank and repeated interests', () => {
    const { interests } = score(['MCP', ' MCP ', '', '   ', 'MCP']);
    expect(interests.map((summary) => summary.interest)).toEqual(['MCP']);
  });

  it('reports an interest nothing matches without failing', () => {
    const { sessions, interests } = score(['zzzzqqq']);
    expect(sessions).toEqual([]);
    expect(interests).toEqual([{ interest: 'zzzzqqq', matches: 0, expansions: [] }]);
    expect(score([]).sessions).toEqual([]);
  });

  it('leaves out excluded sessions', () => {
    const { sessions, interests } = score(['MCP'], { exclude: new Set(['THR978', 'LAB724']) });
    expect(sessions.map((scored) => scored.session.code)).not.toContain('THR978');
    expect(sessions).toHaveLength(MCP_SESSIONS.length - 2);
    expect(interests[0]?.matches).toBe(MCP_SESSIONS.length - 2);
  });

  it('honours the filters, and only offers the slots they allow', () => {
    const filters = catalog.resolve({ days: ['Thursday'] }, NOW);
    const { sessions } = scoreInterests(catalog, ['MCP'], filters);
    expect(sessions.map((scored) => scored.session.code).sort()).toEqual(['LAB724', 'LTG1192', 'LTG1285', 'LTG1356', 'THR859']);
    for (const scored of sessions) for (const slot of scored.occurrences) expect(slot.date).toBe('2026-11-19');
    const talk = sessions.find((scored) => scored.session.code === 'LTG1356');
    expect(talk?.occurrences.map((slot) => slot.slotId)).toEqual(['LTG1356@2026-11-19T09:25']);
  });

  it('offers no slots for on-demand sessions', () => {
    const { sessions } = score(['MCP']);
    const digital = sessions.find((scored) => scored.session.code === 'LAB724D');
    expect(digital?.occurrences).toEqual([]);
  });

  it('breaks ties by session code', () => {
    const twins = syntheticCatalog(
      ['C10', 'C9', 'C2'].map((code) => makeSession(code, { title: 'Zebra' }, [makeSlot(code, '2026-11-17', '09:00', '10:00')])),
    );
    const { sessions } = scoreInterests(twins, ['zebra'], twins.resolve(undefined, NOW));
    expect(sessions.map((scored) => scored.session.code)).toEqual(['C2', 'C9', 'C10']);
  });
});

describe('diversifying a list of sessions', () => {
  const scored = (code: string, relevance: Record<string, number>, featured = false): ScoredSession => {
    const matches: InterestMatch[] = Object.entries(relevance).map(([interest, value]) => ({ interest, relevance: value, matchedFields: ['title'], matchedTags: [] }));
    return {
      session: makeSession(code, { featured }),
      occurrences: [],
      matches,
      total: matches.reduce((sum, match) => sum + match.relevance, 0),
      gain: 0,
    };
  };
  const codes = (list: ScoredSession[]) => list.map((item) => item.session.code);

  it('keeps the order when nothing is discounted', () => {
    const list = [scored('A', { x: 1 }), scored('B', { x: 0.9 }), scored('C', { y: 0.8 })];
    expect(codes(diversify(list, 1))).toEqual(['A', 'B', 'C']);
  });

  it('lets a narrow interest get a place before a broad one repeats itself', () => {
    const list = [scored('A', { x: 1 }), scored('B', { x: 0.9 }), scored('C', { y: 0.8 })];
    const picked = diversify(list, 0.5);
    expect(codes(picked)).toEqual(['A', 'C', 'B']);
    expect(picked.map((item) => item.gain)).toEqual([1, 0.8, 0.9 * 0.5]);
  });

  it('discounts in proportion to how well a pick covers an interest', () => {
    const strong = diversify([scored('A', { x: 1 }), scored('B', { x: 1 })], 0.5);
    expect(strong[1]?.gain).toBeCloseTo(0.5, 10);
    const weak = diversify([scored('A', { x: 0.2 }), scored('B', { x: 1 })], 0.5);
    expect(codes(weak)).toEqual(['B', 'A']);
    expect(weak[1]?.gain).toBeCloseTo(0.2 * 0.5, 10);
  });

  it('stops at the limit', () => {
    const list = [scored('A', { x: 1 }), scored('B', { x: 0.9 }), scored('C', { x: 0.8 })];
    expect(codes(diversify(list, 0.9, { limit: 2 }))).toEqual(['A', 'B']);
    expect(diversify(list, 0.9, { limit: 0 })).toEqual([]);
  });

  it('treats the seed as already picked, without returning it', () => {
    const first = scored('A', { x: 1 });
    const list = [scored('B', { x: 0.9 }), scored('C', { y: 0.8 })];
    expect(codes(diversify(list, 0.5, { seed: [first] }))).toEqual(['C', 'B']);
    expect(codes(diversify(list, 0.5))).toEqual(['B', 'C']);
  });

  it('gives featured sessions a small edge', () => {
    const picked = diversify([scored('A', { x: 1 }), scored('Z', { y: 1 }, true)], 0.9);
    expect(codes(picked)).toEqual(['Z', 'A']);
    expect(picked[0]?.gain).toBeCloseTo(1.05, 10);
    const noEdge = diversify([scored('A', { x: 1 }), scored('Z', { y: 0.9 }, true)], 0.9);
    expect(codes(noEdge)).toEqual(['A', 'Z']);
  });

  it('breaks ties in favour of the better overall match, then the lower code', () => {
    const picked = diversify([scored('B', { x: 1 }), scored('C', { x: 1, y: 0 }), scored('A', { x: 1 })], 1);
    expect(codes(picked)).toEqual(['A', 'B', 'C']);
    const richer = diversify([scored('A', { x: 1 }), scored('B', { x: 0.5, y: 0.5 })], 1);
    expect(codes(richer)).toEqual(['A', 'B']);
    const better = diversify([scored('A', { x: 0.5 }), scored('B', { x: 0.5, y: 0 })], 1);
    expect(codes(better)).toEqual(['A', 'B']);
  });

  it('leaves the list it is given alone, apart from recording each gain', () => {
    const list = [scored('A', { x: 1 }), scored('B', { x: 0.9 }), scored('C', { y: 0.8 })];
    const before = codes(list);
    const picked = diversify(list, 0.5);
    expect(codes(list)).toEqual(before);
    expect(list.find((item) => item.session.code === 'B')?.gain).toBe(picked.find((item) => item.session.code === 'B')?.gain);
  });

  it('copes with an empty list', () => {
    expect(diversify([], 0.9)).toEqual([]);
  });

  it('spreads real sessions across interests', () => {
    const { sessions } = score(['MCP', 'Windows']);
    const ordered = diversify(sessions, 0.5, { limit: 4 });
    const interests = new Set(ordered.flatMap((item) => item.matches.map((match) => match.interest)));
    expect(interests).toEqual(new Set(['MCP', 'Windows']));
  });
});
