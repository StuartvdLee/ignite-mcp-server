import { describe, expect, it } from 'vitest';
import { completeFromList, completeLastItem, completeSessionCodes, interestCandidates, MAX_COMPLETIONS } from '../src/mcp/complete';
import { fixtureCatalog, snapshotCatalog } from './helpers';

// Facts about test/fixtures/feed.json: LAB711, LAB711D, LAB723, LAB724 and LAB724D are the only codes that start with
// "LAB7"; BRK217 is the only one that starts with "BRK21"; nothing starts with "MCP", but nine sessions have MCP in the title.

const NAMES = ['Security', 'Secure AI', 'AI Security', 'Cloud & AI', 'Zero Trust'];

describe('completeSessionCodes', () => {
  const catalog = fixtureCatalog();

  it('suggests the featured sessions before anything is typed', () => {
    const featured = catalog.sessions.filter((session) => session.featured).map((session) => session.code);
    expect(featured.length).toBeGreaterThan(0);
    expect(completeSessionCodes(catalog, '')).toEqual(featured);
    expect(completeSessionCodes(catalog, '   ')).toEqual(featured);
  });

  it('lists the codes that start with the typed text', () => {
    expect(completeSessionCodes(catalog, 'LAB7').slice(0, 5).sort()).toEqual(['LAB711', 'LAB711D', 'LAB723', 'LAB724', 'LAB724D']);
    expect(completeSessionCodes(catalog, 'BRK21')[0]).toBe('BRK217');
  });

  it('ignores case and spaces inside the code', () => {
    expect(completeSessionCodes(catalog, 'brk 21')[0]).toBe('BRK217');
    expect(completeSessionCodes(catalog, ' lab 724 ')[0]).toBe('LAB724');
  });

  it('puts codes before keyword matches and adds each session only once', () => {
    const codes = completeSessionCodes(catalog, 'LAB7');
    expect(new Set(codes).size).toBe(codes.length);
    const firstOther = codes.findIndex((code) => !code.startsWith('LAB7'));
    if (firstOther !== -1) expect(codes.slice(firstOther).every((code) => !code.startsWith('LAB7'))).toBe(true);
  });

  it('falls back to a keyword search when no code matches', () => {
    const codes = completeSessionCodes(catalog, 'MCP');
    expect(codes.length).toBeGreaterThanOrEqual(9);
    expect(codes).toContain('LTG1285');
    expect(codes.every((code) => catalog.get(code) !== undefined)).toBe(true);
  });

  it('suggests nothing for gibberish', () => {
    expect(completeSessionCodes(catalog, 'zzzzqqq')).toEqual([]);
  });

  it('reads only the first 100 characters of what was typed', () => {
    expect(completeSessionCodes(catalog, 'x'.repeat(100_000))).toEqual([]);
  });

  it('never suggests more than the limit', async () => {
    const everything = await snapshotCatalog();
    expect(completeSessionCodes(everything, 'B')).toHaveLength(MAX_COMPLETIONS);
    expect(completeSessionCodes(everything, 'MCP').length).toBeLessThanOrEqual(MAX_COMPLETIONS);
    expect(completeSessionCodes(everything, '').length).toBeLessThanOrEqual(MAX_COMPLETIONS);
  });
});

describe('completeFromList', () => {
  it('offers the first names when nothing is typed', () => {
    expect(completeFromList(NAMES, '')).toEqual(NAMES);
    expect(completeFromList(NAMES, '  ')).toEqual(NAMES);
  });

  it('puts names that start with the text before names that contain it', () => {
    expect(completeFromList(NAMES, 'sec')).toEqual(['Security', 'Secure AI', 'AI Security']);
  });

  it('ignores case and surrounding blanks', () => {
    expect(completeFromList(NAMES, '  ZERO ')).toEqual(['Zero Trust']);
  });

  it('suggests nothing when nothing matches', () => {
    expect(completeFromList(NAMES, 'quantum')).toEqual([]);
  });

  it('never suggests more than the limit', () => {
    const many = Array.from({ length: 50 }, (_, index) => `Topic ${index}`);
    expect(completeFromList(many, '')).toHaveLength(MAX_COMPLETIONS);
    expect(completeFromList(many, 'topic')).toHaveLength(MAX_COMPLETIONS);
  });
});

describe('completeLastItem', () => {
  it('completes the item being typed and keeps the ones before it', () => {
    expect(completeLastItem(NAMES, 'AI agents, sec')).toEqual(['AI agents, Security', 'AI agents, Secure AI', 'AI agents, AI Security']);
    expect(completeLastItem(NAMES, 'a, b,sec')).toEqual(['a, b, Security', 'a, b, Secure AI', 'a, b, AI Security']);
  });

  it('completes the only item like a plain list', () => {
    expect(completeLastItem(NAMES, 'zer')).toEqual(['Zero Trust']);
  });

  it('offers the first names after a trailing comma', () => {
    expect(completeLastItem(NAMES, 'AI agents,')).toEqual(NAMES.map((name) => `AI agents, ${name}`));
  });

  it('suggests nothing when the last item matches nothing', () => {
    expect(completeLastItem(NAMES, 'AI agents, quantum')).toEqual([]);
  });
});

describe('interestCandidates', () => {
  it('lists the topics, then the tags, each name once', () => {
    const catalog = fixtureCatalog();
    const candidates = interestCandidates(catalog);
    expect(new Set(candidates).size).toBe(candidates.length);
    const topics = catalog.facets.topics.map((facet) => facet.name);
    expect(candidates.slice(0, topics.length)).toEqual(topics);
    expect(candidates).toContain('SharePoint');
    expect(candidates).toContain('Security');
  });
});
