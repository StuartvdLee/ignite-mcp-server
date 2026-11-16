import { stemmer } from 'stemmer';

/**
 * Porter merges some unrelated words ("responsible" and "response" both become "respons"), which
 * floods common queries such as "responsible AI" with noise. These families get stems of their own.
 * The `#` marker keeps them from being reached by prefix or fuzzy matching of the Porter stems.
 */
const SEPARATE_FAMILIES: Record<string, string[]> = {
  '#responsible': ['responsible', 'responsibly', 'responsibility', 'responsibilities'],
  '#government': ['government', 'governments', 'governmental'],
  '#production': ['production', 'productions'],
  '#productivity': ['productivity', 'productive', 'productively'],
  '#executive': ['executive', 'executives'],
  '#engine': ['engine', 'engines'],
  '#customer': ['customer', 'customers'],
  '#general': ['general', 'generally', 'generalized', 'generic', 'generics'],
  '#generative': ['generative'],
};

const OVERRIDES = new Map<string, string>(
  Object.entries(SEPARATE_FAMILIES).flatMap(([family, words]) => words.map((word): [string, string] => [word, family])),
);

/** Porter stemmer that leaves short words and alphanumeric identifiers (`brk217`, `m365`) alone. */
export function stem(word: string): string {
  if (word.length < 4 || /\d/.test(word)) return word;
  return OVERRIDES.get(word) ?? stemmer(word);
}
