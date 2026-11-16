import type { Catalog } from './catalog';
import type { ResolvedFilters } from './filters';
import { diversify, scoreInterests } from './interests';
import type { InterestMatch, InterestSummary, ScoredSession } from './interests';
import { byStart, clashes, findConflicts, fitsAfter, overlaps } from './schedule';
import type { Conflict, GapRules, ScheduleEntry } from './schedule';
import { dayLabel } from './time';
import type { Occurrence, Session } from './types';

/** An agenda should not be padded with weak matches, so it is stricter than a recommendation list. */
const AGENDA_MIN_RELEVANCE = 0.5;
/** How much an interest loses value each time a session covers it: gentle, so a broad interest still fills most slots. */
const AGENDA_DECAY = 0.9;
const POOL_SIZE = 300;
const MAX_ALTERNATIVES = 2;
const MAX_SKIPPED = 8;

export interface AgendaOptions {
  interests: readonly string[];
  /** Filters (days, delivery, levels, …) that candidate sessions must satisfy. */
  resolved: ResolvedFilters;
  rules: GapRules;
  maxPerDay: number;
  /** Sessions the attendee insists on; they are placed first and everything else is planned around them. */
  mustInclude: readonly ScheduleEntry[];
  /** Session codes that must not be suggested. */
  avoid: ReadonlySet<string>;
}

export interface Alternative {
  session: Session;
  occurrence: Occurrence;
  matches: InterestMatch[];
}

export interface AgendaItem {
  entry: ScheduleEntry;
  pinned: boolean;
  matches: InterestMatch[];
  /** Other good matches that run at the same time. */
  alternatives: Alternative[];
}

export interface AgendaDay {
  date: string;
  items: AgendaItem[];
}

export interface SkippedSession extends Alternative {
  reason: string;
}

export interface Agenda {
  days: AgendaDay[];
  skipped: SkippedSession[];
  interests: InterestSummary[];
  /** Planned sessions per interest. */
  coverage: { interest: string; sessions: number }[];
  /** Clashes between sessions the attendee pinned; the planner cannot resolve those. */
  pinnedConflicts: Conflict[];
}

interface Candidate {
  scored: ScoredSession;
  /** Slots that do not clash with pinned sessions. */
  options: Occurrence[];
  /** The slot used for planning. */
  occurrence: Occurrence;
  value: number;
}

const codeOrder = (a: Candidate, b: Candidate): number =>
  a.scored.session.code.localeCompare(b.scored.session.code, 'en', { numeric: true });

/**
 * Best set of at most `capacity` sessions that can all be attended, found with dynamic programming:
 * `total[c][i]` is the best value of a chain of c + 1 sessions that ends with session i (sorted by start).
 */
function planDay(candidates: readonly Candidate[], capacity: number, rules: GapRules): Candidate[] {
  const sorted = [...candidates].sort(
    (a, b) => a.occurrence.startMs - b.occurrence.startMs || a.occurrence.endMs - b.occurrence.endMs || codeOrder(a, b),
  );
  const count = sorted.length;
  const maxChain = Math.min(capacity, count);
  if (maxChain <= 0) return [];

  const total: number[][] = [sorted.map((candidate) => candidate.value)];
  const previous: number[][] = [sorted.map(() => -1)];
  for (let length = 1; length < maxChain; length++) {
    const row: number[] = new Array<number>(count).fill(Number.NEGATIVE_INFINITY);
    const link: number[] = new Array<number>(count).fill(-1);
    const before = total[length - 1] ?? [];
    for (let i = 0; i < count; i++) {
      const current = sorted[i];
      if (!current) continue;
      for (let j = 0; j < i; j++) {
        const base = before[j] ?? Number.NEGATIVE_INFINITY;
        const earlier = sorted[j];
        if (base === Number.NEGATIVE_INFINITY || !earlier || !fitsAfter(earlier.occurrence, current.occurrence, rules)) continue;
        if (base + current.value > (row[i] ?? Number.NEGATIVE_INFINITY)) {
          row[i] = base + current.value;
          link[i] = j;
        }
      }
    }
    total.push(row);
    previous.push(link);
  }

  let bestTotal = Number.NEGATIVE_INFINITY;
  let bestLength = -1;
  let bestEnd = -1;
  for (let length = 0; length < maxChain; length++) {
    const row = total[length] ?? [];
    for (let i = 0; i < count; i++) {
      const value = row[i] ?? Number.NEGATIVE_INFINITY;
      if (value > bestTotal + 1e-9) {
        bestTotal = value;
        bestLength = length;
        bestEnd = i;
      }
    }
  }

  const chain: Candidate[] = [];
  for (let length = bestLength, index = bestEnd; length >= 0 && index >= 0; length--) {
    const candidate = sorted[index];
    if (candidate) chain.unshift(candidate);
    index = previous[length]?.[index] ?? -1;
  }
  return chain;
}

/** Of a session's slots, the one that competes with the fewest (and least valuable) other candidates. */
function leastCongestedSlot(candidate: Candidate, all: readonly Candidate[], rules: GapRules): Occurrence {
  let best = candidate.options[0] as Occurrence;
  let bestCongestion = Number.POSITIVE_INFINITY;
  for (const option of candidate.options) {
    let congestion = 0;
    for (const other of all) {
      if (other === candidate) continue;
      const blocked = other.options.filter((slot) => clashes(option, slot, rules)).length;
      congestion += (other.value * blocked) / other.options.length;
    }
    if (congestion < bestCongestion - 1e-9) {
      bestCongestion = congestion;
      best = option;
    }
  }
  return best;
}

function skipReason(candidate: Candidate, items: readonly AgendaItem[], maxPerDay: number, rules: GapRules): string {
  const blocker = items.find((item) => clashes(item.entry.occurrence, candidate.occurrence, rules));
  if (blocker) {
    return `${overlaps(blocker.entry.occurrence, candidate.occurrence) ? 'overlaps' : 'is too close to'} ${blocker.entry.session.code}`;
  }
  return `${dayLabel(candidate.occurrence.date)} already has ${maxPerDay} ${maxPerDay === 1 ? 'session' : 'sessions'}`;
}

/**
 * Builds a conflict-free agenda: for every day the highest-value set of sessions that can all be attended,
 * given the break and travel time between them. Interests share the slots fairly (see `diversify`).
 */
export function buildAgenda(catalog: Catalog, options: AgendaOptions): Agenda {
  const { rules, maxPerDay } = options;
  const pinned = [...options.mustInclude].sort(byStart);
  const pinnedCodes = new Set(pinned.map((entry) => entry.session.code));

  const { sessions, interests } = scoreInterests(catalog, options.interests, options.resolved, {
    exclude: options.avoid,
    minRelevance: AGENDA_MIN_RELEVANCE,
  });
  const pinnedScores = new Map(sessions.filter((scored) => pinnedCodes.has(scored.session.code)).map((scored) => [scored.session.code, scored]));
  const pool = sessions.filter((scored) => scored.occurrences.length > 0 && !pinnedCodes.has(scored.session.code)).slice(0, POOL_SIZE);
  const ranked = diversify(pool, AGENDA_DECAY, { seed: [...pinnedScores.values()] });

  const skipped: SkippedSession[] = [];
  const candidates: Candidate[] = [];
  for (const scored of ranked) {
    const slots = scored.occurrences.filter((slot) => !pinned.some((entry) => clashes(entry.occurrence, slot, rules)));
    const first = slots[0];
    if (!first) {
      const blocker = pinned.find((entry) => clashes(entry.occurrence, scored.occurrences[0] as Occurrence, rules));
      skipped.push({
        session: scored.session,
        occurrence: scored.occurrences[0] as Occurrence,
        matches: scored.matches,
        reason: `clashes with ${blocker?.session.code ?? 'a pinned session'}, which you asked to include`,
      });
      continue;
    }
    candidates.push({ scored, options: slots, occurrence: first, value: scored.gain });
  }
  for (const candidate of candidates) {
    if (candidate.options.length > 1) candidate.occurrence = leastCongestedSlot(candidate, candidates, rules);
  }

  const candidatesByDay = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const list = candidatesByDay.get(candidate.occurrence.date) ?? [];
    list.push(candidate);
    candidatesByDay.set(candidate.occurrence.date, list);
  }
  const pinnedByDay = new Map<string, ScheduleEntry[]>();
  for (const entry of pinned) {
    const list = pinnedByDay.get(entry.occurrence.date) ?? [];
    list.push(entry);
    pinnedByDay.set(entry.occurrence.date, list);
  }

  const chosen = new Set<string>();
  const days: AgendaDay[] = [];
  for (const date of [...new Set([...candidatesByDay.keys(), ...pinnedByDay.keys()])].sort()) {
    const fixed = pinnedByDay.get(date) ?? [];
    const plan = planDay(candidatesByDay.get(date) ?? [], Math.max(0, maxPerDay - fixed.length), rules);
    const items: AgendaItem[] = [
      ...fixed.map((entry): AgendaItem => ({ entry, pinned: true, matches: pinnedScores.get(entry.session.code)?.matches ?? [], alternatives: [] })),
      ...plan.map((candidate): AgendaItem => {
        const { session } = candidate.scored;
        const { occurrence } = candidate;
        chosen.add(session.code);
        return {
          entry: { session, occurrence, fixed: false, otherSlots: session.occurrences.filter((slot) => slot !== occurrence) },
          pinned: false,
          matches: candidate.scored.matches,
          alternatives: [],
        };
      }),
    ].sort((a, b) => byStart(a.entry, b.entry));
    days.push({ date, items });
  }

  const unchosen = candidates.filter((candidate) => !chosen.has(candidate.scored.session.code));
  const alternativeCodes = new Set<string>();
  for (const day of days) {
    for (const item of day.items) {
      const found: Alternative[] = [];
      for (const candidate of unchosen) {
        const slot = candidate.options.find((option) => overlaps(option, item.entry.occurrence));
        if (!slot) continue;
        found.push({ session: candidate.scored.session, occurrence: slot, matches: candidate.scored.matches });
        if (found.length >= MAX_ALTERNATIVES) break;
      }
      item.alternatives = found;
      for (const alternative of found) alternativeCodes.add(alternative.session.code);
    }
  }

  const allItems = days.flatMap((day) => day.items);
  for (const candidate of unchosen) {
    if (alternativeCodes.has(candidate.scored.session.code)) continue;
    skipped.push({
      session: candidate.scored.session,
      occurrence: candidate.occurrence,
      matches: candidate.scored.matches,
      reason: skipReason(candidate, allItems.filter((item) => item.entry.occurrence.date === candidate.occurrence.date), maxPerDay, rules),
    });
  }

  const strength = (matches: readonly InterestMatch[]): number => matches.reduce((sum, match) => sum + match.relevance, 0);
  skipped.sort((a, b) => strength(b.matches) - strength(a.matches) || a.session.code.localeCompare(b.session.code, 'en', { numeric: true }));

  return {
    days,
    skipped: skipped.slice(0, MAX_SKIPPED),
    interests,
    coverage: interests.map(({ interest }) => ({
      interest,
      sessions: allItems.filter((item) => item.matches.some((match) => match.interest === interest)).length,
    })),
    pinnedConflicts: findConflicts(pinned, rules),
  };
}
