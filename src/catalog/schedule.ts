import type { Catalog } from './catalog';
import type { Occurrence, Session } from './types';

export type Attendance = 'in_person' | 'online' | 'either';

export interface GapRules {
  /** Minimum minutes between the end of one session and the start of the next. */
  minBreakMinutes: number;
  /** Online attendees do not travel between venues. */
  attendance: Attendance;
}

export const DEFAULT_MIN_BREAK_MINUTES = 10;

export const VENUE_CHANGE_MINUTES = 10;
export const OFF_SITE_MINUTES = 30;
const OFF_SITE_VENUES = new Set(['chase center']);
const MS_PER_MINUTE = 60_000;

/**
 * Minutes needed between the end of one session and the start of the next: a short break, a little
 * walking time when the venue changes, and a long transfer to or from Chase Center.
 * This is a rule of thumb, not routing data.
 */
export function requiredGap(from: Occurrence, to: Occurrence, rules: GapRules): number {
  if (rules.attendance === 'online' || !from.venue || !to.venue || from.venue === to.venue) return rules.minBreakMinutes;
  const offSite = OFF_SITE_VENUES.has(from.venue.toLowerCase()) || OFF_SITE_VENUES.has(to.venue.toLowerCase());
  return rules.minBreakMinutes + VENUE_CHANGE_MINUTES + (offSite ? OFF_SITE_MINUTES : 0);
}

/** True when `later` can still be reached after `earlier` (which must not start after it). */
export function fitsAfter(earlier: Occurrence, later: Occurrence, rules: GapRules): boolean {
  return later.startMs - earlier.endMs >= requiredGap(earlier, later, rules) * MS_PER_MINUTE;
}

/** True when the two slots cannot both be attended: they overlap or leave too little time in between. */
export function clashes(a: Occurrence, b: Occurrence, rules: GapRules): boolean {
  return a.startMs <= b.startMs ? !fitsAfter(a, b, rules) : !fitsAfter(b, a, rules);
}

export function overlaps(a: Occurrence, b: Occurrence): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

export interface ScheduleEntry {
  session: Session;
  occurrence: Occurrence;
  /** The session's other time slots when it is offered more than once. */
  otherSlots: Occurrence[];
  /** True when the slot was named by the caller or is the session's only one. */
  fixed: boolean;
}

export interface Unresolved {
  ref: string;
  reason: string;
}

export interface ResolvedItems {
  /** Sorted by start time. */
  entries: ScheduleEntry[];
  /** Sessions without a fixed time. */
  onDemand: Session[];
  unresolved: Unresolved[];
}

export interface Conflict {
  kind: 'overlap' | 'tight';
  first: ScheduleEntry;
  second: ScheduleEntry;
  /** Minutes the sessions run at the same time (overlap), or minutes left between them (tight). */
  minutes: number;
  requiredGapMinutes: number;
}

export const byStart = (a: ScheduleEntry, b: ScheduleEntry): number =>
  a.occurrence.startMs - b.occurrence.startMs ||
  a.occurrence.endMs - b.occurrence.endMs ||
  a.session.code.localeCompare(b.session.code, 'en', { numeric: true });

function describeMissing(catalog: Catalog, ref: string): string {
  const text = ref.trim();
  const at = text.indexOf('@');
  if (at > 0) {
    const session = catalog.find(text.slice(0, at));
    if (session) {
      return session.occurrences.length > 0
        ? `${session.code} has no slot "${text.slice(at + 1)}". Its slots: ${session.occurrences.map((slot) => slot.slotId).join(', ')}`
        : `${session.code} is on demand and has no scheduled slot`;
    }
  }
  // A blank query browses the whole catalog, which would make for meaningless "closest matches".
  const closest = text
    ? catalog.search({ query: text, limit: 3 }).hits.map((hit) => `${hit.session.code} (${hit.session.title})`)
    : [];
  return closest.length > 0 ? `No session has that code or id. Closest matches: ${closest.join('; ')}` : 'No session has that code or id';
}

function pairCost(a: Occurrence, b: Occurrence, rules: GapRules): number {
  const [first, second] = a.startMs <= b.startMs ? [a, b] : [b, a];
  const overlap = (Math.min(first.endMs, second.endMs) - second.startMs) / MS_PER_MINUTE;
  if (overlap > 0) return 1000 + overlap;
  const shortfall = requiredGap(first, second, rules) - (second.startMs - first.endMs) / MS_PER_MINUTE;
  return shortfall > 0 ? 10 + shortfall : 0;
}

const SEARCH_NODE_LIMIT = 50_000;

/** Picks one slot for every session that is offered more than once, minimizing clashes with everything else. */
function chooseSlots(fixed: readonly Occurrence[], flexible: readonly (readonly Occurrence[])[], rules: GapRules): Occurrence[] {
  const order = flexible.map((_, index) => index).sort((a, b) => (flexible[a]?.length ?? 0) - (flexible[b]?.length ?? 0));
  const placed = [...fixed];
  const current: Occurrence[] = [];
  let best = flexible.map((options) => options[0] as Occurrence);
  let bestCost = Number.POSITIVE_INFINITY;
  let nodes = 0;

  const visit = (depth: number, cost: number): void => {
    if (cost >= bestCost || nodes++ > SEARCH_NODE_LIMIT) return;
    if (depth === order.length) {
      bestCost = cost;
      best = [...current];
      return;
    }
    const index = order[depth] ?? 0;
    const ranked = (flexible[index] ?? [])
      .map((option) => ({ option, cost: placed.reduce((sum, other) => sum + pairCost(option, other, rules), 0) }))
      .sort((a, b) => a.cost - b.cost || a.option.startMs - b.option.startMs);
    for (const candidate of ranked) {
      placed.push(candidate.option);
      current[index] = candidate.option;
      visit(depth + 1, cost + candidate.cost);
      placed.pop();
    }
  };
  visit(0, 0);
  return best;
}

/**
 * Resolves session codes, ids and slot ids (`CODE@YYYY-MM-DDTHH:mm`). A code that is offered several times
 * gets the slot that clashes least with the rest of the list.
 */
export function resolveItems(catalog: Catalog, refs: readonly string[], rules: GapRules): ResolvedItems {
  const fixed: ScheduleEntry[] = [];
  const flexible: Session[] = [];
  const onDemand: Session[] = [];
  const unresolved: Unresolved[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    const resolved = catalog.resolveRef(ref);
    if (!resolved) {
      unresolved.push({ ref, reason: describeMissing(catalog, ref) });
      continue;
    }
    const { session, occurrence } = resolved;
    if (seen.has(session.code)) continue;
    seen.add(session.code);
    if (occurrence) {
      fixed.push({ session, occurrence, fixed: true, otherSlots: session.occurrences.filter((slot) => slot !== occurrence) });
    } else if (session.occurrences.length === 0) {
      onDemand.push(session);
    } else {
      flexible.push(session);
    }
  }

  const chosen = chooseSlots(
    fixed.map((entry) => entry.occurrence),
    flexible.map((session) => session.occurrences),
    rules,
  );
  const placed = flexible.map((session, index): ScheduleEntry => {
    const occurrence = chosen[index] ?? (session.occurrences[0] as Occurrence);
    return { session, occurrence, fixed: false, otherSlots: session.occurrences.filter((slot) => slot !== occurrence) };
  });
  return { entries: [...fixed, ...placed].sort(byStart), onDemand, unresolved };
}

/** Every pair of entries that overlap or leave less than the required gap. */
export function findConflicts(entries: readonly ScheduleEntry[], rules: GapRules): Conflict[] {
  const sorted = [...entries].sort(byStart);
  const conflicts: Conflict[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const first = sorted[i];
      const second = sorted[j];
      if (!first || !second) continue;
      const a = first.occurrence;
      const b = second.occurrence;
      const required = requiredGap(a, b, rules);
      if (b.startMs < a.endMs) {
        const minutes = (Math.min(a.endMs, b.endMs) - b.startMs) / MS_PER_MINUTE;
        conflicts.push({ kind: 'overlap', first, second, minutes, requiredGapMinutes: required });
      } else {
        const gap = (b.startMs - a.endMs) / MS_PER_MINUTE;
        if (gap < required) conflicts.push({ kind: 'tight', first, second, minutes: gap, requiredGapMinutes: required });
      }
    }
  }
  return conflicts;
}
