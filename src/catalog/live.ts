import type { Catalog } from './catalog';
import type { ResolvedFilters } from './filters';
import { addDays, localParts, minutesBetween, minutesToTime, parseClock, parseInstant, zonedToUtcMs } from './time';
import type { Occurrence, Session } from './types';

export type EventPhase = 'before_event' | 'during_event' | 'after_event';

export const DEFAULT_WINDOW_MINUTES = 60;
/** When nothing is on soon, sessions starting this soon after the next start time are shown together. */
const NEXT_GROUP_SPAN_MINUTES = 30;

export interface LiveItem {
  session: Session;
  occurrence: Occurrence;
  relevance: number;
  matchedFields: string[];
  matchedTags: string[];
  /** Minutes until the slot ends (in progress) or starts (upcoming). */
  minutes: number;
}

export interface LiveGroup {
  /** Everything that matched, before the display limit. */
  total: number;
  items: LiveItem[];
}

export interface WhatsOn {
  phase: EventPhase;
  atMs: number;
  windowMinutes: number;
  eventStartMs: number;
  eventEndMs: number;
  inProgress: LiveGroup;
  startingSoon: LiveGroup;
  /** Only filled when nothing is in progress or starting soon: the next sessions to start. */
  next: LiveGroup;
  expansions: string[];
}

export interface WhatsOnOptions {
  query?: string | undefined;
  resolved: ResolvedFilters;
  atMs: number;
  windowMinutes?: number | undefined;
  limit: number;
}

/** First start and last end across the whole catalog. */
export function eventWindow(catalog: Catalog): { startMs: number; endMs: number } | undefined {
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const session of catalog.sessions) {
    for (const slot of session.occurrences) {
      startMs = Math.min(startMs, slot.startMs);
      endMs = Math.max(endMs, slot.endMs);
    }
  }
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? { startMs, endMs } : undefined;
}

/** `at` is an ISO date-time or a clock time (today), both in event time; blank means now. */
export function resolveAt(input: string | undefined, nowMs: number): { ms: number } | { error: string } {
  const text = input?.trim();
  if (!text) return { ms: nowMs };
  const instant = parseInstant(text);
  if (instant !== undefined) return { ms: instant };
  const minutes = parseClock(text);
  if (minutes !== undefined) {
    const today = localParts(nowMs).date;
    return minutes >= 24 * 60 ? { ms: zonedToUtcMs(addDays(today, 1), '00:00') } : { ms: zonedToUtcMs(today, minutesToTime(minutes)) };
  }
  return { error: `Could not understand at="${text}". Use an ISO date-time such as 2026-11-18T14:00 (Pacific Time), or a clock time such as "2pm" (today).` };
}

const byCode = (a: LiveItem, b: LiveItem): number => a.session.code.localeCompare(b.session.code, 'en', { numeric: true });

/** The best `limit` items (most relevant, or featured sessions when browsing), shown in time order. */
function select(items: LiveItem[], limit: number, ranked: boolean): LiveGroup {
  const priority = (a: LiveItem, b: LiveItem): number =>
    ranked
      ? b.relevance - a.relevance || a.occurrence.startMs - b.occurrence.startMs || byCode(a, b)
      : Number(b.session.featured) - Number(a.session.featured) || a.occurrence.startMs - b.occurrence.startMs || byCode(a, b);
  const chosen = [...items].sort(priority).slice(0, limit);
  chosen.sort((a, b) => a.occurrence.startMs - b.occurrence.startMs || a.occurrence.endMs - b.occurrence.endMs || byCode(a, b));
  return { total: items.length, items: chosen };
}

export function whatsOn(catalog: Catalog, options: WhatsOnOptions): WhatsOn {
  const { atMs, limit } = options;
  const windowMinutes = options.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const bounds = eventWindow(catalog) ?? { startMs: atMs, endMs: atMs };
  const phase: EventPhase = atMs < bounds.startMs ? 'before_event' : atMs >= bounds.endMs ? 'after_event' : 'during_event';
  const ranked = Boolean(options.query?.trim());
  const { hits, expansions } = catalog.rank(options.query, options.resolved);

  const inProgress: LiveItem[] = [];
  const soon: LiveItem[] = [];
  const later: LiveItem[] = [];
  const horizon = atMs + windowMinutes * 60_000;
  for (const hit of hits) {
    for (const occurrence of hit.occurrences) {
      const item = (minutes: number): LiveItem => ({
        session: hit.session,
        occurrence,
        relevance: hit.relevance,
        matchedFields: hit.matchedFields,
        matchedTags: hit.matchedTags,
        minutes,
      });
      if (occurrence.startMs <= atMs && atMs < occurrence.endMs) inProgress.push(item(minutesBetween(atMs, occurrence.endMs)));
      else if (occurrence.startMs > atMs && occurrence.startMs <= horizon) soon.push(item(minutesBetween(atMs, occurrence.startMs)));
      else if (occurrence.startMs > horizon) later.push(item(minutesBetween(atMs, occurrence.startMs)));
    }
  }

  let next: LiveGroup = { total: 0, items: [] };
  if (inProgress.length === 0 && soon.length === 0 && later.length > 0) {
    const first = Math.min(...later.map((item) => item.occurrence.startMs));
    const group = later.filter((item) => item.occurrence.startMs <= first + NEXT_GROUP_SPAN_MINUTES * 60_000);
    next = select(group, limit, ranked);
  }

  return {
    phase,
    atMs,
    windowMinutes,
    eventStartMs: bounds.startMs,
    eventEndMs: bounds.endMs,
    inProgress: select(inProgress, limit, ranked),
    startingSoon: select(soon, limit, ranked),
    next,
    expansions,
  };
}
