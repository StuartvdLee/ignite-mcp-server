import type { Catalog } from './catalog';
import type { ResolvedFilters } from './filters';
import type { Occurrence, Session } from './types';

/** Hits scoring below this share of an interest's best matches are noise for recommendations. */
export const MIN_INTEREST_RELEVANCE = 0.35;

export interface InterestMatch {
  interest: string;
  /** 0–1, relative to the best matches for that interest. */
  relevance: number;
  matchedFields: string[];
  matchedTags: string[];
}

export interface ScoredSession {
  session: Session;
  /** Occurrences allowed by the filters; empty for on-demand sessions. */
  occurrences: Occurrence[];
  matches: InterestMatch[];
  /** Sum of the relevance over all matched interests. */
  total: number;
  /** `total` after discounting interests that better sessions already cover; set by `diversify`. */
  gain: number;
}

export interface InterestSummary {
  interest: string;
  /** Sessions that matched this interest well enough. */
  matches: number;
  /** Synonyms and expansions applied to the interest text. */
  expansions: string[];
}

export interface ScoreOptions {
  exclude?: ReadonlySet<string> | undefined;
  minRelevance?: number | undefined;
}

const byCode = (a: ScoredSession, b: ScoredSession): number =>
  a.session.code.localeCompare(b.session.code, 'en', { numeric: true });

/** Scores every session against each interest separately and merges the results, best total first. */
export function scoreInterests(
  catalog: Catalog,
  interests: readonly string[],
  resolved: ResolvedFilters,
  options: ScoreOptions = {},
): { sessions: ScoredSession[]; interests: InterestSummary[] } {
  const minRelevance = options.minRelevance ?? MIN_INTEREST_RELEVANCE;
  const sessions = new Map<string, ScoredSession>();
  const summaries: InterestSummary[] = [];

  for (const interest of new Set(interests.map((value) => value.trim()).filter(Boolean))) {
    const { hits, expansions } = catalog.rank(interest, resolved, { excludeCodes: options.exclude });
    let matches = 0;
    for (const hit of hits) {
      if (hit.relevance < minRelevance) continue;
      matches++;
      let scored = sessions.get(hit.session.code);
      if (!scored) {
        scored = { session: hit.session, occurrences: hit.occurrences, matches: [], total: 0, gain: 0 };
        sessions.set(hit.session.code, scored);
      }
      scored.matches.push({ interest, relevance: hit.relevance, matchedFields: hit.matchedFields, matchedTags: hit.matchedTags });
      scored.total += hit.relevance;
    }
    summaries.push({ interest, matches, expansions });
  }

  const ordered = [...sessions.values()].sort((a, b) => b.total - a.total || byCode(a, b));
  for (const scored of ordered) scored.gain = scored.total;
  return { sessions: ordered, interests: summaries };
}

const FEATURED_BOOST = 1.05;

/**
 * Orders sessions so that every interest gets its share: each pick makes the interests it covers a little
 * less valuable, so a broad interest cannot crowd out a narrow one. `gain` becomes the marginal value of the
 * session at its position. Sessions in `seed` count as already picked.
 */
export function diversify(
  sessions: readonly ScoredSession[],
  decay: number,
  options: { limit?: number; seed?: readonly ScoredSession[] } = {},
): ScoredSession[] {
  const weights = new Map<string, number>();
  const discount = (scored: ScoredSession): void => {
    for (const match of scored.matches) weights.set(match.interest, (weights.get(match.interest) ?? 1) * decay ** match.relevance);
  };
  for (const seeded of options.seed ?? []) discount(seeded);

  const remaining = [...sessions];
  const picked: ScoredSession[] = [];
  const limit = options.limit ?? remaining.length;
  while (remaining.length > 0 && picked.length < limit) {
    let bestIndex = -1;
    let bestGain = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index++) {
      const candidate = remaining[index];
      if (!candidate) continue;
      let gain = 0;
      for (const match of candidate.matches) gain += (weights.get(match.interest) ?? 1) * match.relevance;
      if (candidate.session.featured) gain *= FEATURED_BOOST;
      const best = bestIndex >= 0 ? remaining[bestIndex] : undefined;
      if (gain > bestGain + 1e-9 || (Math.abs(gain - bestGain) <= 1e-9 && best && (candidate.total > best.total || (candidate.total === best.total && byCode(candidate, best) < 0)))) {
        bestIndex = index;
        bestGain = gain;
      }
    }
    const [next] = remaining.splice(bestIndex, 1);
    if (!next) break;
    next.gain = bestGain;
    discount(next);
    picked.push(next);
  }
  return picked;
}
