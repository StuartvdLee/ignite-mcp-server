import MiniSearch from 'minisearch';
import type { SearchResult } from 'minisearch';
import { resolveFilters } from './filters';
import type { FacetUniverse, ResolvedFilters, SessionFilters } from './filters';
import { stem } from './stem';
import { expandQuery, isAliasTerm, splitWords, tokenizeWords, wordRuns } from './synonyms';
import { splitSentences, stripUrls } from './text';
import { dayLabel, weekdayIndex } from './time';
import type { CatalogMeta, DayInfo, FacetCount, Occurrence, Session } from './types';

const STOP_WORDS = new Set(
  (
    'a an and are as at be been by for from has have had how i in is its of on or that the this to was were what which ' +
    'who with you your we our about can do does into my me will would should could than then there these those they their ' +
    'not so also just some such all any more most get using'
  ).split(' '),
);

/** Filler that is meaningless in a search box but common in natural-language questions. */
const QUERY_STOP_WORDS = new Set(
  'session sessions talk talks ignite show find want looking interested interesting learn recommend please tell give list'.split(' '),
);

const FIELD_BOOST = {
  code: 8,
  title: 4,
  tags: 3,
  speakers: 3,
  topics: 2,
  companies: 2,
  type: 1.5,
  audiences: 1,
  description: 1,
} as const;

/** Abbreviations such as "MCP" or "AKS" are far more specific than the words around them. */
const ALIAS_TERM_BOOST = 2;

/** Relevance is relative to the average of this many best hits, so one outlier cannot dwarf the rest. */
const RELEVANCE_REFERENCE_HITS = 5;

/**
 * Query terms are weighted by how rare they are relative to the rarest term of the query, so that a word
 * found in most sessions ("AI") cannot outvote the word that actually says what the query is about.
 */
const MIN_TERM_WEIGHT = 0.25;

/** Sessions that contain neighbouring query words side by side gain this fraction of the best score. */
const PHRASE_BONUS = 0.5;

/** Words of an alias phrase ("model context protocol") count for little next to its abbreviation ("MCP"). */
const PHRASE_WORD_WEIGHT = 0.3;

const INDEX_FIELDS = Object.keys(FIELD_BOOST) as Array<keyof typeof FIELD_BOOST>;

const FIELD_LABELS: Record<string, string> = {
  code: 'session code',
  title: 'title',
  tags: 'tags',
  speakers: 'speakers',
  topics: 'topics',
  companies: 'companies',
  type: 'session type',
  audiences: 'audience',
  description: 'description',
};

interface IndexDoc {
  id: string;
  code: string;
  title: string;
  tags: string;
  topics: string;
  speakers: string;
  companies: string;
  type: string;
  audiences: string;
  description: string;
}

function indexTerm(term: string): string | null {
  const word = term.toLowerCase();
  if (STOP_WORDS.has(word) || (word.length < 2 && !/\d/.test(word))) return null;
  return stem(word);
}

function queryTerm(term: string): string | null {
  return QUERY_STOP_WORDS.has(term.toLowerCase()) ? null : indexTerm(term);
}

export interface SearchParams {
  query?: string | undefined;
  filters?: SessionFilters | undefined;
  limit?: number;
  offset?: number;
  sort?: 'relevance' | 'time';
  nowMs?: number;
  excludeCodes?: ReadonlySet<string> | undefined;
}

export interface SearchHit {
  session: Session;
  /** Raw BM25-style score; 0 when browsing without a query. */
  score: number;
  /** Score relative to the best hit of this search, in (0, 1]. */
  relevance: number;
  /** Occurrences that satisfy the time and place filters (all of them when none are set). */
  occurrences: Occurrence[];
  matchedFields: string[];
  matchedTags: string[];
}

export interface SearchOutcome {
  total: number;
  hits: SearchHit[];
  warnings: string[];
  filters: string[];
  query: string;
  expansions: string[];
}

export interface RankOptions {
  /** Drop hits scoring below this fraction of the best hit. */
  minRelativeScore?: number;
  excludeCodes?: ReadonlySet<string> | undefined;
}

const CODE_QUERY = /^([a-z]{2,6})\s?-?\s?(\d{1,4})$/i;

function countBy(values: Iterable<string>): FacetCount[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Sentences that recur across many descriptions ("Seating is first-come, first-served.") say nothing about a session. */
function findBoilerplate(sessions: Session[]): Set<string> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    for (const sentence of new Set(splitSentences(session.description))) {
      if (sentence.length > 12) counts.set(sentence, (counts.get(sentence) ?? 0) + 1);
    }
  }
  const minimum = Math.max(8, Math.ceil(sessions.length * 0.005));
  return new Set([...counts].filter(([, count]) => count >= minimum).map(([sentence]) => sentence));
}

function nonNull<T>(value: T | null): value is T {
  return value !== null;
}

/** Stems of every sentence, `|`-delimited, so that a query phrase can be looked up without spanning two sentences. */
function phraseText(parts: string[]): string {
  const runs = parts
    .flatMap(splitSentences)
    .map((sentence) => splitWords(sentence).map(indexTerm).filter(nonNull).join(' '))
    .filter(Boolean);
  return ` | ${runs.join(' | ')} | `;
}

export class Catalog {
  readonly sessions: Session[];
  readonly meta: CatalogMeta;
  readonly facets: {
    types: FacetCount[];
    topics: FacetCount[];
    levels: FacetCount[];
    audiences: FacetCount[];
    industries: FacetCount[];
    delivery: FacetCount[];
    tags: FacetCount[];
    venues: FacetCount[];
  };
  readonly days: DayInfo[];
  readonly speakerCount: number;

  private readonly byCode = new Map<string, Session>();
  private readonly byId = new Map<string, Session>();
  private readonly byInstance = new Map<string, { session: Session; occurrence: Occurrence }>();
  private readonly index: MiniSearch<IndexDoc>;
  private readonly universe: FacetUniverse;
  /** Number of sessions containing each indexed term, in any field. */
  private readonly docFrequency = new Map<string, number>();
  private readonly phrases = new Map<string, string>();

  constructor(sessions: Session[], meta: CatalogMeta) {
    this.sessions = sessions;
    this.meta = meta;
    for (const session of sessions) {
      this.byCode.set(session.code, session);
      this.byId.set(session.id.toLowerCase(), session);
      for (const occurrence of session.occurrences) this.byInstance.set(occurrence.instanceId.toLowerCase(), { session, occurrence });
    }

    const venueNames: string[] = [];
    for (const session of sessions) for (const occurrence of session.occurrences) if (occurrence.venue) venueNames.push(occurrence.venue);
    this.facets = {
      types: countBy(sessions.map((session) => session.type)),
      topics: countBy(sessions.flatMap((session) => session.topics)),
      levels: countBy(sessions.flatMap((session) => (session.levelNumber ? [`${session.levelNumber} ${session.level ?? ''}`.trim()] : []))),
      audiences: countBy(sessions.flatMap((session) => session.audiences)),
      industries: countBy(sessions.flatMap((session) => session.industries)),
      delivery: countBy(sessions.flatMap((session) => session.delivery)),
      tags: countBy(sessions.flatMap((session) => session.tags)),
      venues: countBy(venueNames),
    };
    this.facets.levels.sort((a, b) => a.name.localeCompare(b.name));

    const dayMap = new Map<string, { sessions: Set<string>; occurrences: number }>();
    for (const session of sessions) {
      for (const occurrence of session.occurrences) {
        const entry = dayMap.get(occurrence.date) ?? { sessions: new Set<string>(), occurrences: 0 };
        entry.sessions.add(session.code);
        entry.occurrences++;
        dayMap.set(occurrence.date, entry);
      }
    }
    this.days = [...dayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, entry]) => ({
        date,
        weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][weekdayIndex(date)] ?? '',
        label: dayLabel(date),
        sessions: entry.sessions.size,
        occurrences: entry.occurrences,
      }));

    this.speakerCount = new Set(sessions.flatMap((session) => session.speakers.map((speaker) => speaker.name))).size;
    this.universe = {
      topics: this.facets.topics.map((facet) => facet.name),
      types: this.facets.types.map((facet) => facet.name),
      audiences: this.facets.audiences.map((facet) => facet.name),
      industries: this.facets.industries.map((facet) => facet.name),
      tags: this.facets.tags.map((facet) => facet.name),
      days: this.days.map((day) => day.date),
    };

    const boilerplate = findBoilerplate(sessions);
    this.index = new MiniSearch<IndexDoc>({
      fields: Object.keys(FIELD_BOOST),
      idField: 'id',
      tokenize: tokenizeWords,
      processTerm: indexTerm,
      searchOptions: {
        boost: FIELD_BOOST,
        combineWith: 'OR',
        prefix: (term) => term.length >= 3,
        fuzzy: (term) => (term.length > 4 && !/\d/.test(term) ? 1 : false),
        boostTerm: (term) => (isAliasTerm(term) ? ALIAS_TERM_BOOST : 1),
        processTerm: queryTerm,
      },
    });
    const docs: IndexDoc[] = [];
    for (const session of sessions) {
      const description = stripUrls(splitSentences(session.description).filter((sentence) => !boilerplate.has(sentence)).join(' '));
      const doc: IndexDoc = {
        id: session.code,
        code: session.code,
        title: session.title,
        tags: session.tags.join(' '),
        topics: session.topics.join(' '),
        speakers: session.speakers.map((speaker) => speaker.name).join(' '),
        companies: session.companies.join(' '),
        type: session.type,
        audiences: session.audiences.join(' '),
        description,
      };
      docs.push(doc);
      this.phrases.set(session.code, phraseText([session.title, ...session.tags, description]));
      const seen = new Set<string>();
      for (const field of INDEX_FIELDS) {
        for (const word of tokenizeWords(doc[field])) {
          const term = indexTerm(word);
          if (term) seen.add(term);
        }
      }
      for (const term of seen) this.docFrequency.set(term, (this.docFrequency.get(term) ?? 0) + 1);
    }
    this.index.addAll(docs);
  }

  get(code: string): Session | undefined {
    return this.byCode.get(code.trim().toUpperCase());
  }

  /** Resolves a session code, session id or instance id (`code` lookups are case-insensitive). */
  find(ref: string): Session | undefined {
    const text = ref.trim();
    const direct = this.byCode.get(text.toUpperCase());
    if (direct) return direct;
    const compact = CODE_QUERY.exec(text);
    if (compact) {
      const byCompact = this.byCode.get(`${compact[1]}${compact[2]}`.toUpperCase());
      if (byCompact) return byCompact;
    }
    const lower = text.toLowerCase();
    return this.byId.get(lower) ?? this.byInstance.get(lower)?.session ?? this.byId.get(lower.split('-')[0] ?? '');
  }

  /**
   * Resolves `CODE`, `CODE@YYYY-MM-DDTHH:mm` (a specific time slot) or an instance id.
   * `occurrence` is only set when the reference identifies a single slot.
   */
  resolveRef(ref: string): { session: Session; occurrence?: Occurrence } | undefined {
    const text = ref.trim();
    const at = text.indexOf('@');
    if (at > 0) {
      const session = this.find(text.slice(0, at));
      if (!session) return undefined;
      const slot = text.slice(at + 1).replace(' ', 'T');
      const occurrence = session.occurrences.find((candidate) => `${candidate.date}T${candidate.startTime}` === slot);
      return occurrence ? { session, occurrence } : undefined;
    }
    const instance = this.byInstance.get(text.toLowerCase());
    if (instance) return instance;
    const session = this.find(text);
    if (!session) return undefined;
    return session.occurrences.length === 1 && session.occurrences[0]
      ? { session, occurrence: session.occurrences[0] }
      : { session };
  }

  resolve(filters: SessionFilters | undefined, nowMs: number): ResolvedFilters {
    return resolveFilters(filters, this.universe, nowMs);
  }

  /** Weight per stemmed query term: 1 for the most specific term, down to MIN_TERM_WEIGHT for very common ones. */
  private termWeights(stems: string[]): Map<string, number> {
    const total = this.sessions.length;
    const idf = (term: string): number => {
      const count = this.docFrequency.get(term) ?? 0;
      return Math.log(1 + (total - count + 0.5) / (count + 0.5));
    };
    const known = stems.filter((term) => this.docFrequency.has(term));
    const rarest = known.length > 0 ? Math.max(...known.map(idf)) : 1;
    return new Map(known.map((term) => [term, Math.max(MIN_TERM_WEIGHT, idf(term) / rarest)]));
  }

  /** Every hit that passes the filters, best first (browse mode: all sessions in time order). */
  rank(query: string | undefined, resolved: ResolvedFilters, options: RankOptions = {}): { hits: SearchHit[]; expansions: string[] } {
    const text = (query ?? '').trim();
    const exclude = options.excludeCodes;

    if (!text) {
      const hits: SearchHit[] = [];
      for (const session of this.sessions) {
        if (exclude?.has(session.code)) continue;
        const occurrences = resolved.apply(session);
        if (occurrences) hits.push({ session, score: 0, relevance: 1, occurrences, matchedFields: [], matchedTags: [] });
      }
      return { hits: sortByTime(hits), expansions: [] };
    }

    const compact = CODE_QUERY.exec(text);
    const effective = compact && this.byCode.has(`${compact[1]}${compact[2]}`.toUpperCase()) ? `${compact[1]}${compact[2]}` : text;
    const { query: expanded, expansions, terms, phraseWords } = expandQuery(effective, (word) => queryTerm(word) !== null);
    const stemmedWords = [...new Set(terms.map(queryTerm).filter(nonNull))];
    const weights = this.termWeights(stemmedWords);
    for (const word of phraseWords) {
      const term = queryTerm(word);
      if (term) weights.set(term, (weights.get(term) ?? 1) * PHRASE_WORD_WEIGHT);
    }
    const phrasePairs: string[] = [];
    for (const run of wordRuns(effective)) {
      const stems = run.map(queryTerm).filter(nonNull);
      for (let position = 0; position + 1 < stems.length; position++) phrasePairs.push(`${stems[position]} ${stems[position + 1]}`);
    }
    const occurrencesByCode = new Map<string, Occurrence[]>();
    const results = this.index.search(expanded, {
      boostTerm: (term) => (weights.get(term) ?? 1) * (isAliasTerm(term) ? ALIAS_TERM_BOOST : 1),
      filter: (result: SearchResult) => {
        const session = this.byCode.get(result.id as string);
        if (!session || exclude?.has(session.code)) return false;
        const occurrences = resolved.apply(session);
        if (!occurrences) return false;
        occurrencesByCode.set(session.code, occurrences);
        return true;
      },
    });

    if (phrasePairs.length > 0 && results.length > 0) {
      const best = results[0]?.score ?? 0;
      for (const result of results) {
        const text = this.phrases.get(result.id as string) ?? '';
        const found = phrasePairs.filter((pair) => text.includes(` ${pair} `)).length;
        if (found > 0) result.score += (PHRASE_BONUS * best * found) / phrasePairs.length;
      }
      results.sort((a, b) => b.score - a.score);
    }

    const top = results[0]?.score ?? 0;
    const threshold = top * (options.minRelativeScore ?? 0.1);
    // A lone outlier (a session that spells out an abbreviation and uses it) must not flatten everyone else's relevance.
    const leaders = results.slice(0, RELEVANCE_REFERENCE_HITS);
    const reference = leaders.length > 0 ? leaders.reduce((sum, result) => sum + result.score, 0) / leaders.length : top;
    const hits: SearchHit[] = [];
    for (const result of results) {
      if (result.score < threshold) break;
      const session = this.byCode.get(result.id as string);
      const occurrences = occurrencesByCode.get(result.id as string);
      if (!session || !occurrences) continue;
      hits.push({
        session,
        score: result.score,
        relevance: reference > 0 ? Math.min(1, result.score / reference) : 1,
        occurrences,
        matchedFields: matchedFields(result),
        matchedTags: stemmedWords.length > 0 ? matchedTags(session, stemmedWords) : [],
      });
    }
    return { hits, expansions };
  }

  search(params: SearchParams): SearchOutcome {
    const nowMs = params.nowMs ?? Date.now();
    const resolved = this.resolve(params.filters, nowMs);
    const query = (params.query ?? '').trim();
    const { hits: ranked, expansions } = this.rank(query, resolved, { excludeCodes: params.excludeCodes });
    const sort = params.sort ?? (query ? 'relevance' : 'time');
    const ordered = sort === 'time' && query ? sortByTime(ranked) : ranked;
    const offset = Math.max(0, params.offset ?? 0);
    const limit = Math.max(1, params.limit ?? 10);
    return {
      total: ordered.length,
      hits: ordered.slice(offset, offset + limit),
      warnings: resolved.warnings,
      filters: resolved.summary,
      query,
      expansions,
    };
  }

  /** Sessions with overlapping tags and topics, best first. */
  similar(session: Session, limit = 5): Session[] {
    const terms = [...session.tags, ...session.topics];
    const text = terms.length > 0 ? terms.join(' ') : session.title;
    const results = this.index.search(text, {
      fields: terms.length > 0 ? ['tags', 'topics'] : ['title'],
      boost: { tags: 3, topics: 1 },
      prefix: false,
      fuzzy: false,
      filter: (result: SearchResult) => result.id !== session.code,
    });
    const out: Session[] = [];
    for (const result of results) {
      const candidate = this.byCode.get(result.id as string);
      if (candidate) out.push(candidate);
      if (out.length >= limit) break;
    }
    return out;
  }
}

function sortByTime(hits: SearchHit[]): SearchHit[] {
  const firstStart = (hit: SearchHit): number => hit.occurrences[0]?.startMs ?? Number.POSITIVE_INFINITY;
  return [...hits].sort(
    (a, b) => firstStart(a) - firstStart(b) || b.score - a.score || a.session.code.localeCompare(b.session.code, 'en', { numeric: true }),
  );
}

function matchedFields(result: SearchResult): string[] {
  const fields = new Set<string>();
  for (const list of Object.values(result.match as Record<string, string[]>)) for (const field of list) fields.add(field);
  return [...fields].map((field) => FIELD_LABELS[field] ?? field);
}

function matchedTags(session: Session, stemmedWords: string[]): string[] {
  const matches = [...session.tags, ...session.topics].filter((label) => {
    const stems = tokenizeWords(label).map(indexTerm);
    return stemmedWords.some((word) => stems.some((candidate) => candidate === word || (candidate !== null && word.length >= 3 && candidate.startsWith(word))));
  });
  return [...new Set(matches)].slice(0, 4);
}
