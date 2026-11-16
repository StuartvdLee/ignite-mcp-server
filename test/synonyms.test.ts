import { describe, expect, it } from 'vitest';
import { stem } from '../src/catalog/stem';
import { expandQuery, isAliasTerm, splitWords, tokenizeWords, wordRuns } from '../src/catalog/synonyms';

describe('stem', () => {
  it('reduces inflections to a shared stem', () => {
    expect(stem('agents')).toBe(stem('agent'));
    expect(stem('security')).toBe(stem('secure'));
    expect(stem('labs')).toBe('lab');
    expect(stem('breakouts')).toBe('breakout');
    expect(stem('running')).toBe('run');
  });

  it('keeps unrelated words that Porter would merge apart', () => {
    expect(stem('response')).toBe('respons');
    expect(stem('responsible')).not.toBe(stem('response'));
    expect(stem('responsibility')).toBe(stem('responsible'));
    expect(stem('government')).not.toBe(stem('governance'));
    expect(stem('production')).not.toBe(stem('productive'));
    expect(stem('customers')).toBe(stem('customer'));
  });

  it('leaves short words and identifiers with digits alone', () => {
    for (const word of ['ai', 'ml', 'm365', 'brk217', 'k8s', 'a2a']) expect(stem(word)).toBe(word);
  });
});

describe('splitWords', () => {
  it('lowercases, splits on punctuation and keeps language names intact', () => {
    expect(splitWords('Build C# and .NET apps with Node.js, F# & AI!')).toEqual([
      'build',
      'csharp',
      'and',
      'dotnet',
      'apps',
      'with',
      'nodejs',
      'fsharp',
      'ai',
    ]);
    expect(splitWords('')).toEqual([]);
  });
});

describe('tokenizeWords', () => {
  it('adds the abbreviation of every alias phrase it finds', () => {
    expect(tokenizeWords('Intro to Model Context Protocol servers')).toEqual(['intro', 'to', 'model', 'context', 'protocol', 'servers', 'mcp']);
    expect(tokenizeWords('Agent to agent protocols with Azure Kubernetes Service')).toEqual(
      expect.arrayContaining(['a2a', 'aks']),
    );
  });

  it('recognises inflected forms of the phrase', () => {
    expect(tokenizeWords('Large language models in practice')).toContain('llm');
  });

  it('adds nothing when no phrase is present', () => {
    expect(tokenizeWords('Nothing special here')).toEqual(['nothing', 'special', 'here']);
  });
});

describe('wordRuns', () => {
  it('returns the words around an alias phrase, which its abbreviation stands for', () => {
    expect(wordRuns('Secure the Model Context Protocol with Entra today')).toEqual([
      ['secure', 'the'],
      ['with', 'entra', 'today'],
    ]);
    expect(wordRuns('plain words only')).toEqual([['plain', 'words', 'only']]);
    expect(wordRuns('')).toEqual([]);
  });
});

describe('isAliasTerm', () => {
  it('knows abbreviations and their single-word aliases by stem', () => {
    for (const word of ['mcp', 'k8s', 'kubernetes', 'postgres', 'entra']) expect(isAliasTerm(stem(word)), word).toBe(true);
    expect(isAliasTerm(stem('cloud'))).toBe(false);
  });
});

describe('expandQuery', () => {
  it('expands an abbreviation and requires all words in an extra conjunctive clause', () => {
    const expanded = expandQuery('mcp servers');
    expect(expanded.expansions).toEqual(['mcp = model context protocol']);
    expect(expanded.terms).toEqual(['mcp', 'servers']);
    expect(expanded.phraseWords).toEqual([]);
    expect(expanded.query).toEqual({
      combineWith: 'OR',
      queries: ['mcp', 'servers', { combineWith: 'AND', queries: ['mcp', 'servers'] }],
    });
  });

  it('treats a spelled-out phrase like its abbreviation', () => {
    const expanded = expandQuery('model context protocol');
    expect(expanded.expansions).toEqual(['mcp = model context protocol']);
    expect(expanded.terms).toEqual(['model', 'context', 'protocol', 'mcp']);
    expect(expanded.phraseWords).toEqual(['model', 'context', 'protocol']);
  });

  it('lists every group that applies', () => {
    const expanded = expandQuery('azure kubernetes service security');
    expect(expanded.expansions).toEqual(['k8s = kubernetes', 'aks = azure kubernetes service']);
    expect(expanded.terms).toEqual(expect.arrayContaining(['k8s', 'aks', 'security']));
  });

  it('leaves words that are not significant out of the conjunction', () => {
    const expanded = expandQuery('responsible ai', (word) => word !== 'ai');
    expect(expanded.expansions).toEqual([]);
    expect(expanded.query).toEqual({ combineWith: 'OR', queries: ['responsible', 'ai'] });
  });

  it('turns empty text into an empty query', () => {
    expect(expandQuery('')).toEqual({ query: { combineWith: 'OR', queries: [] }, expansions: [], terms: [], phraseWords: [] });
  });
});
