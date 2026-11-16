import type { Query } from 'minisearch';
import { stem } from './stem';

/**
 * Groups of equivalent terms: abbreviations and the phrases they stand for.
 *
 * Phrases are recognised in the text itself and add the group's abbreviation (its first single-word
 * member) as an extra token, so "MCP" also finds "Model Context Protocol" and the other way around.
 * Single-word members are expanded when the query is built.
 */
const GROUPS: string[][] = [
  ['mcp', 'model context protocol'],
  ['a2a', 'agent2agent', 'agent to agent'],
  ['aks', 'azure kubernetes service'],
  ['k8s', 'kubernetes'],
  ['ghcp', 'github copilot'],
  ['gh', 'github'],
  ['m365', 'microsoft 365'],
  ['o365', 'office 365'],
  ['entra', 'azure active directory', 'aad'],
  ['llm', 'large language model'],
  ['slm', 'small language model'],
  ['genai', 'generative ai', 'gen ai'],
  ['rag', 'retrieval augmented generation'],
  ['ml', 'machine learning'],
  ['iac', 'infrastructure as code'],
  ['aoai', 'azure openai'],
  ['ado', 'azure devops'],
  ['pbi', 'power bi'],
  ['avd', 'azure virtual desktop'],
  ['w365', 'windows 365'],
  ['wsl', 'windows subsystem for linux'],
  ['sre', 'site reliability engineering'],
  ['oss', 'open source'],
  ['vm', 'virtual machine'],
  ['xdr', 'extended detection and response'],
  ['siem', 'security information and event management'],
  ['pg', 'postgresql', 'postgres'],
];

export function splitWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\bc#/g, 'csharp')
    .replace(/\bf#/g, 'fsharp')
    .replace(/\.net\b/g, 'dotnet')
    .replace(/\bnode\.js\b/g, 'nodejs')
    .split(/[\n\r\p{Z}\p{P}]+/u)
    .filter(Boolean);
}

interface Phrase {
  stems: string[];
  canonical: string;
}

const phrasesByFirstStem = new Map<string, Phrase[]>();
const groupByStem = new Map<string, number>();

GROUPS.forEach((group, index) => {
  const canonical = group.find((term) => !term.includes(' '));
  if (!canonical) return;
  for (const term of group) {
    if (term.includes(' ')) {
      const stems = splitWords(term).map(stem);
      const first = stems[0] as string;
      phrasesByFirstStem.set(first, [...(phrasesByFirstStem.get(first) ?? []), { stems, canonical }]);
    } else {
      groupByStem.set(stem(term), index);
    }
  }
});

interface Analysis {
  words: string[];
  /** Abbreviations of the alias phrases found in the text. */
  canonicals: string[];
  /** Indexes of the words that belong to an alias phrase. */
  consumed: Set<number>;
}

function analyze(text: string): Analysis {
  const words = splitWords(text);
  const stems = words.map(stem);
  const canonicals: string[] = [];
  const consumed = new Set<number>();
  for (let index = 0; index < words.length; index++) {
    for (const phrase of phrasesByFirstStem.get(stems[index] as string) ?? []) {
      if (!phrase.stems.every((wanted, offset) => stems[index + offset] === wanted)) continue;
      canonicals.push(phrase.canonical);
      phrase.stems.forEach((_, offset) => consumed.add(index + offset));
    }
  }
  return { words, canonicals, consumed };
}

/** Splits text into lowercase words and appends the abbreviation of every known phrase it contains. */
export function tokenizeWords(text: string): string[] {
  const { words, canonicals } = analyze(text);
  return [...words, ...canonicals];
}

/** Runs of consecutive words that are not part of an alias phrase (those are represented by their abbreviation). */
export function wordRuns(text: string): string[][] {
  const { words, consumed } = analyze(text);
  const runs: string[][] = [];
  let run: string[] = [];
  words.forEach((word, index) => {
    if (consumed.has(index)) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else {
      run.push(word);
    }
  });
  if (run.length > 0) runs.push(run);
  return runs;
}

/** True for a stemmed term that is an abbreviation (or its plain-word alias) from the alias groups. */
export function isAliasTerm(stemmedTerm: string): boolean {
  return groupByStem.has(stemmedTerm);
}

export interface ExpandedQuery {
  query: Query;
  /** Alias groups that applied, e.g. `mcp = model context protocol`. */
  expansions: string[];
  /** Every word the query searches for, including aliases. */
  terms: string[];
  /** Words that only occur as part of an alias phrase; the abbreviation already stands for them. */
  phraseWords: string[];
}

/**
 * Builds a MiniSearch query from free text. Words are OR-combined and abbreviations are expanded
 * with their aliases. Sessions that match every significant word also get a second, conjunctive
 * match so they rank above sessions that only match a common word several times.
 *
 * `significant` tells which words survive query stop-word filtering; words of an alias phrase are
 * represented by its abbreviation so that "model context protocol" and "MCP" behave alike.
 */
export function expandQuery(text: string, significant: (word: string) => boolean = () => true): ExpandedQuery {
  const { words, canonicals, consumed } = analyze(text);
  const terms = new Set<string>();
  const groups = new Set<number>();
  const aliasesOf = (token: string): string[] => {
    const group = groupByStem.get(stem(token));
    if (group === undefined) return [];
    groups.add(group);
    return (GROUPS[group] as string[]).filter((alias) => !alias.includes(' '));
  };

  for (const token of [...words, ...canonicals]) {
    terms.add(token);
    for (const alias of aliasesOf(token)) terms.add(alias);
  }

  const required = new Set<string>();
  words.forEach((word, index) => {
    if (!consumed.has(index)) required.add(word);
  });
  for (const canonical of canonicals) required.add(canonical);
  const conjunction: Query[] = [];
  for (const token of required) {
    if (!significant(token)) continue;
    const alternatives = [...new Set([token, ...aliasesOf(token)])];
    conjunction.push(alternatives.length > 1 ? { combineWith: 'OR', queries: alternatives } : token);
  }

  const queries: Query[] = [...terms];
  if (conjunction.length >= 2) queries.push({ combineWith: 'AND', queries: conjunction });
  const loose = new Set(words.filter((_, index) => !consumed.has(index)));
  return {
    query: { combineWith: 'OR', queries },
    expansions: [...groups].map((group) => (GROUPS[group] as string[]).join(' = ')),
    terms: [...terms],
    phraseWords: [...new Set(words.filter((word, index) => consumed.has(index) && !loose.has(word)))],
  };
}
