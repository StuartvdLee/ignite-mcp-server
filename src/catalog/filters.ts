import { stem } from './stem';
import { normalizeForMatch } from './text';
import { localParts, parseClock, parseDay, parseInstant } from './time';
import type { Occurrence, Session } from './types';

export interface SessionFilters {
  topics?: string[] | undefined;
  types?: string[] | undefined;
  levels?: string[] | undefined;
  audiences?: string[] | undefined;
  industries?: string[] | undefined;
  delivery?: string[] | undefined;
  tags?: string[] | undefined;
  speaker?: string | undefined;
  company?: string | undefined;
  days?: string[] | undefined;
  startAfter?: string | undefined;
  startBefore?: string | undefined;
  location?: string | undefined;
  recorded?: boolean | undefined;
  sponsored?: boolean | undefined;
  scheduled?: boolean | undefined;
}

/** The facet values that exist in the catalog; used to resolve loose user input. */
export interface FacetUniverse {
  topics: string[];
  types: string[];
  audiences: string[];
  industries: string[];
  tags: string[];
  days: string[];
}

export interface ResolvedFilters {
  /** Matching occurrences (possibly empty for on-demand sessions), or null when excluded. */
  apply(session: Session): Occurrence[] | null;
  warnings: string[];
  /** Human readable list of the filters that are in effect. */
  summary: string[];
  hasOccurrenceConstraint: boolean;
}

export const LEVEL_NAMES: Record<number, string> = {
  100: 'Foundational',
  200: 'Intermediate',
  300: 'Advanced',
  400: 'Expert',
};

const stemmedForm = (text: string): string =>
  normalizeForMatch(text)
    .split(' ')
    .filter(Boolean)
    .map(stem)
    .join(' ');

function suggest(input: string, known: readonly string[], limit = 6): string[] {
  const tokens = normalizeForMatch(input).split(' ').filter((token) => token.length >= 3);
  if (tokens.length === 0) return [];
  return known
    .map((name) => {
      const form = normalizeForMatch(name);
      const hits = tokens.filter((token) => form.includes(token)).length;
      return { name, hits };
    })
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((entry) => entry.name);
}

interface ResolvedFacet {
  values: Set<string> | undefined;
  warnings: string[];
}

/**
 * Maps loose input ("security", "AI") to canonical facet values. `loose` allows substring
 * matching on the stemmed form (right for small closed sets such as topics and types).
 */
function resolveFacet(label: string, inputs: string[] | undefined, known: readonly string[], loose: boolean): ResolvedFacet {
  if (!inputs || inputs.length === 0) return { values: undefined, warnings: [] };
  const values = new Set<string>();
  const warnings: string[] = [];
  const byNormalized = new Map(known.map((name) => [normalizeForMatch(name), name] as const));
  const byStemmed = new Map(known.map((name) => [stemmedForm(name), name] as const));
  for (const input of inputs) {
    const normalized = normalizeForMatch(input);
    if (!normalized) continue;
    const exact = byNormalized.get(normalized) ?? byStemmed.get(stemmedForm(input));
    if (exact) {
      values.add(exact);
      continue;
    }
    if (loose && normalized.length >= 2) {
      const stemmed = stemmedForm(input);
      const hits = known.filter((name) => {
        const form = stemmedForm(name);
        return ` ${form} `.includes(` ${stemmed} `) || (stemmed.length >= 4 && form.includes(stemmed));
      });
      if (hits.length > 0) {
        for (const hit of hits) values.add(hit);
        continue;
      }
    }
    const hint = suggest(input, known);
    warnings.push(
      `Unknown ${label} "${input}".` +
        (hint.length > 0 ? ` Did you mean: ${hint.join(', ')}?` : '') +
        (known.length <= 15 ? ` Valid values: ${known.join(', ')}.` : ''),
    );
  }
  return { values: values.size > 0 || warnings.length > 0 ? values : undefined, warnings };
}

function resolveLevels(inputs: string[] | undefined): { values: Set<number> | undefined; warnings: string[] } {
  if (!inputs || inputs.length === 0) return { values: undefined, warnings: [] };
  const values = new Set<number>();
  const warnings: string[] = [];
  for (const input of inputs) {
    const text = String(input).trim();
    // Matches "200", "L200" and "level 200", but not "2000" or "1200".
    const number = /(?<!\d)([1-4])00(?!\d)/.exec(text)?.[1];
    if (number) {
      values.add(Number(number) * 100);
      continue;
    }
    const byName = Object.entries(LEVEL_NAMES).find(([, name]) => name.toLowerCase() === text.toLowerCase());
    if (byName) values.add(Number(byName[0]));
    else warnings.push(`Unknown level "${input}". Valid values: 100, 200, 300, 400 (Foundational, Intermediate, Advanced, Expert).`);
  }
  return { values, warnings };
}

function resolveDelivery(inputs: string[] | undefined): { values: Set<string> | undefined; warnings: string[] } {
  if (!inputs || inputs.length === 0) return { values: undefined, warnings: [] };
  const values = new Set<string>();
  const warnings: string[] = [];
  for (const input of inputs) {
    const text = normalizeForMatch(input);
    if (text.includes('person') || text.includes('onsite') || text.includes('on site')) values.add('In-person');
    else if (text.includes('online') || text.includes('virtual') || text.includes('digital') || text.includes('remote')) values.add('Online');
    else warnings.push(`Unknown delivery "${input}". Valid values: In-person, Online.`);
  }
  return { values, warnings };
}

function matchesSpeaker(session: Session, wanted: string[]): boolean {
  return session.speakers.some((speaker) => {
    const tokens = normalizeForMatch(speaker.name).split(' ');
    return wanted.every((token) => tokens.some((candidate) => candidate === token || (token.length >= 3 && candidate.startsWith(token))));
  });
}

/** A start-time bound: a time of day that applies on every selected day, or one absolute moment. */
type TimeBound = { clock: number } | { instant: number };

const BOUND_HELP =
  'Use a time of day such as "14:30" or "2pm", or a date-time such as "2026-11-18T14:30" (Pacific time unless an offset is given).';

function parseBound(input: string): TimeBound | undefined {
  const clock = parseClock(input);
  if (clock !== undefined) return { clock };
  const instant = parseInstant(input);
  return instant === undefined ? undefined : { instant };
}

const startsBefore = (occurrence: Occurrence, bound: TimeBound): boolean =>
  'clock' in bound ? localParts(occurrence.startMs).minutes < bound.clock : occurrence.startMs < bound.instant;

export function resolveFilters(
  filters: SessionFilters | undefined,
  universe: FacetUniverse,
  nowMs: number,
): ResolvedFilters {
  const f = filters ?? {};
  const warnings: string[] = [];
  const summary: string[] = [];

  const topics = resolveFacet('topic', f.topics, universe.topics, true);
  const types = resolveFacet('session type', f.types, universe.types, true);
  const audiences = resolveFacet('audience', f.audiences, universe.audiences, true);
  const industries = resolveFacet('industry', f.industries, universe.industries, true);
  const tags = resolveFacet('tag', f.tags, universe.tags, false);
  const levels = resolveLevels(f.levels);
  const delivery = resolveDelivery(f.delivery);
  warnings.push(...topics.warnings, ...types.warnings, ...audiences.warnings, ...industries.warnings, ...tags.warnings, ...levels.warnings, ...delivery.warnings);

  const describe = (label: string, values: Iterable<string | number> | undefined) => {
    if (values) summary.push(`${label}: ${[...values].join(', ') || '(none matched)'}`);
  };
  describe('topics', topics.values);
  describe('types', types.values);
  describe('levels', levels.values);
  describe('audiences', audiences.values);
  describe('industries', industries.values);
  describe('delivery', delivery.values);
  describe('tags', tags.values);

  const speakerTokens = f.speaker ? normalizeForMatch(f.speaker).split(' ').filter(Boolean) : [];
  if (speakerTokens.length > 0) summary.push(`speaker: ${f.speaker}`);
  const company = f.company ? normalizeForMatch(f.company) : '';
  if (company) summary.push(`company: ${f.company}`);

  let days: Set<string> | undefined;
  if (f.days && f.days.length > 0) {
    days = new Set();
    for (const input of f.days) {
      const day = parseDay(input, universe.days, nowMs);
      if (day) days.add(day);
      else warnings.push(`Could not understand day "${input}". Use YYYY-MM-DD, a weekday name, or a date such as "Nov 18". Event days: ${universe.days.join(', ')}.`);
    }
    summary.push(`days: ${[...days].join(', ') || '(none matched)'}`);
  }

  let startAfter: TimeBound | undefined;
  if (f.startAfter) {
    startAfter = parseBound(f.startAfter);
    if (startAfter === undefined) warnings.push(`Could not understand startAfter "${f.startAfter}". ${BOUND_HELP}`);
    else summary.push(`start at or after ${f.startAfter}`);
  }
  let startBefore: TimeBound | undefined;
  if (f.startBefore) {
    startBefore = parseBound(f.startBefore);
    if (startBefore === undefined) warnings.push(`Could not understand startBefore "${f.startBefore}". ${BOUND_HELP}`);
    else summary.push(`start before ${f.startBefore}`);
  }
  const location = f.location ? normalizeForMatch(f.location) : '';
  if (location) summary.push(`location contains: ${f.location}`);
  if (f.recorded !== undefined) summary.push(f.recorded ? 'recorded only' : 'not recorded');
  if (f.sponsored !== undefined) summary.push(f.sponsored ? 'sponsored only' : 'excluding sponsored');

  const hasOccurrenceConstraint =
    days !== undefined || startAfter !== undefined || startBefore !== undefined || location !== '' || f.scheduled === true;
  if (f.scheduled === false) summary.push('on-demand (unscheduled) only');
  else if (f.scheduled === true) summary.push('scheduled only');

  const matchesOccurrence = (occurrence: Occurrence): boolean => {
    if (days && !days.has(occurrence.date)) return false;
    if (startAfter && startsBefore(occurrence, startAfter)) return false;
    if (startBefore && !startsBefore(occurrence, startBefore)) return false;
    if (location && !normalizeForMatch(occurrence.location ?? '').includes(location)) return false;
    return true;
  };

  const apply = (session: Session): Occurrence[] | null => {
    if (topics.values && !session.topics.some((topic) => topics.values?.has(topic))) return null;
    if (types.values && !types.values.has(session.type)) return null;
    if (levels.values && !(session.levelNumber !== undefined && levels.values.has(session.levelNumber))) return null;
    if (audiences.values && !session.audiences.some((value) => audiences.values?.has(value))) return null;
    if (industries.values && !session.industries.some((value) => industries.values?.has(value))) return null;
    if (delivery.values && !session.delivery.some((value) => delivery.values?.has(value))) return null;
    if (tags.values && !session.tags.some((tag) => tags.values?.has(tag))) return null;
    if (speakerTokens.length > 0 && !matchesSpeaker(session, speakerTokens)) return null;
    if (company && !session.companies.some((name) => normalizeForMatch(name).includes(company))) return null;
    if (f.recorded !== undefined && session.recorded !== f.recorded) return null;
    if (f.sponsored !== undefined && session.sponsored !== f.sponsored) return null;
    if (f.scheduled === false && !session.onDemand) return null;
    if (hasOccurrenceConstraint) {
      const matching = session.occurrences.filter(matchesOccurrence);
      return matching.length > 0 ? matching : null;
    }
    return session.occurrences;
  };

  return { apply, warnings, summary, hasOccurrenceConstraint };
}
