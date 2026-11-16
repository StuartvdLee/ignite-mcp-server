import type { AgendaItem, Alternative, SkippedSession } from '../catalog/agenda';
import type { Catalog, SearchHit } from '../catalog/catalog';
import type { InterestMatch, ScoredSession } from '../catalog/interests';
import type { LiveItem } from '../catalog/live';
import type { Conflict, ScheduleEntry } from '../catalog/schedule';
import type { StoreStatus } from '../catalog/store';
import { truncate } from '../catalog/text';
import { dayLabel, slotLabel, timeRangeLabel } from '../catalog/time';
import type { Occurrence, Session } from '../catalog/types';
import { EVENT } from '../event';
import { minutesLabel } from './format';
import type {
  AgendaSession,
  ConflictView,
  LiveSession,
  OverviewOutput,
  Recommendation,
  SearchHitView,
  SessionDetailOutput,
  SessionSummary,
  Slot,
} from './schemas';

const MAX_TAGS = 6;
const MAX_SPEAKERS = 6;
const SUMMARY_CHARS = 200;
const RELATED_LIMIT = 8;
const SIMILAR_LIMIT = 5;
const TOP_TAGS = 25;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** `Level 200 (Intermediate)` */
export function levelLabel(session: Pick<Session, 'level' | 'levelNumber'>): string | undefined {
  if (session.level && session.levelNumber) return `Level ${session.levelNumber} (${session.level})`;
  if (session.level) return session.level;
  return session.levelNumber ? `Level ${session.levelNumber}` : undefined;
}

/** `Moscone West, Level 3, Room 3014` */
export function placeOf(occurrence: Pick<Occurrence, 'venue' | 'room' | 'location'>): string | undefined {
  const place = [occurrence.venue, occurrence.room].filter(Boolean).join(', ');
  if (place) return place;
  return occurrence.location ? occurrence.location.replace(/\s*\|\s*/g, ', ') : undefined;
}

export function slotView(occurrence: Occurrence): Slot {
  const place = placeOf(occurrence);
  const when = slotLabel(occurrence.date, occurrence.startTime, occurrence.endTime);
  return {
    slotId: occurrence.slotId,
    day: dayLabel(occurrence.date),
    date: occurrence.date,
    startTime: occurrence.startTime,
    endTime: occurrence.endTime,
    startUtc: new Date(occurrence.startMs).toISOString(),
    endUtc: new Date(occurrence.endMs).toISOString(),
    durationMinutes: occurrence.durationMinutes,
    ...(occurrence.venue ? { venue: occurrence.venue } : {}),
    ...(occurrence.room ? { room: occurrence.room } : {}),
    label: place ? `${when} · ${place}` : when,
  };
}

/** Tags that matched the search come first, so that the ones shown explain the match. */
function pickTags(tags: readonly string[], preferred: readonly string[]): string[] {
  const first = tags.filter((tag) => preferred.includes(tag));
  const rest = tags.filter((tag) => !preferred.includes(tag));
  return [...first, ...rest].slice(0, MAX_TAGS);
}

export function summaryView(
  session: Session,
  occurrences: readonly Occurrence[] = session.occurrences,
  preferredTags: readonly string[] = [],
): SessionSummary {
  const level = levelLabel(session);
  return {
    code: session.code,
    title: session.title,
    type: session.type,
    ...(level ? { level } : {}),
    topics: session.topics,
    tags: pickTags(session.tags, preferredTags),
    speakers: session.speakers.slice(0, MAX_SPEAKERS).map((speaker) => speaker.name),
    speakerCount: session.speakers.length,
    delivery: session.delivery,
    recorded: session.recorded,
    liveStream: session.liveStream,
    onDemand: session.onDemand,
    slots: occurrences.map(slotView),
    summary: truncate(session.description, SUMMARY_CHARS),
    url: session.url,
  };
}

/** `title`, `tags: AI Agents, Copilot` */
export function matchedOn(fields: readonly string[], tags: readonly string[]): string[] {
  const plain = fields.filter((field) => field !== 'tags' && field !== 'topics');
  if (tags.length > 0) return [...plain, `tags: ${tags.join(', ')}`];
  return [...plain, ...fields.filter((field) => field === 'tags' || field === 'topics')];
}

export function hitView(hit: SearchHit): SearchHitView {
  return {
    ...summaryView(hit.session, hit.occurrences, hit.matchedTags),
    relevance: round2(hit.relevance),
    matchedOn: matchedOn(hit.matchedFields, hit.matchedTags),
  };
}

const strength = (relevance: number): string => (relevance >= 0.75 ? 'strong' : relevance >= 0.5 ? 'good' : 'partial');

/** `Strong match for "AI agents" (title; tags: Agentic AI); partial match for "zero trust" (description).` */
export function reasonFor(matches: readonly InterestMatch[]): string {
  const ordered = [...matches].sort((a, b) => b.relevance - a.relevance);
  const parts = ordered.map((match) => {
    const where = matchedOn(match.matchedFields, match.matchedTags);
    return `${strength(match.relevance)} match for "${match.interest}"${where.length > 0 ? ` (${where.join('; ')})` : ''}`;
  });
  const text = `${parts.join('; ')}.`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const preferredTagsOf = (matches: readonly InterestMatch[]): string[] => matches.flatMap((match) => match.matchedTags);

export function recommendationView(scored: ScoredSession): Recommendation {
  return {
    ...summaryView(scored.session, scored.occurrences, preferredTagsOf(scored.matches)),
    relevance: round2(scored.total),
    matchedInterests: scored.matches.map((match) => match.interest),
    why: reasonFor(scored.matches),
  };
}

/** Sessions the organizers link to, or that share tags; `when` is the first time slot. */
export function relatedView(session: Session): { code: string; title: string; type: string; when?: string } {
  const [first, ...more] = session.occurrences;
  const when = first ? `${slotView(first).label}${more.length > 0 ? ` (+${more.length} more)` : ''}` : undefined;
  return { code: session.code, title: session.title, type: session.type, ...(when ? { when } : {}) };
}

export function liveView(item: LiveItem, kind: 'in_progress' | 'upcoming'): LiveSession {
  return {
    ...summaryView(item.session, [item.occurrence], item.matchedTags),
    ...(kind === 'in_progress' ? { minutesLeft: item.minutes } : { startsInMinutes: item.minutes }),
  };
}

export function alternativeView(alternative: Alternative): AgendaSession['alternatives'][number] {
  const slot = slotView(alternative.occurrence);
  return {
    code: alternative.session.code,
    title: alternative.session.title,
    slotId: slot.slotId,
    label: slot.label,
    matchedInterests: alternative.matches.map((match) => match.interest),
  };
}

export function skippedView(skipped: SkippedSession): { code: string; title: string; label: string; reason: string } {
  return { code: skipped.session.code, title: skipped.session.title, label: slotView(skipped.occurrence).label, reason: skipped.reason };
}

export function agendaItemView(item: AgendaItem): AgendaSession {
  const { session, occurrence, otherSlots } = item.entry;
  const reason = item.matches.length > 0 ? reasonFor(item.matches) : '';
  return {
    ...summaryView(session, [occurrence], preferredTagsOf(item.matches)),
    pinned: item.pinned,
    matchedInterests: item.matches.map((match) => match.interest),
    why: item.pinned ? `Included because you asked for it.${reason ? ` ${reason}` : ''}` : reason,
    otherSlots: otherSlots.map(slotView),
    alternatives: item.alternatives.map(alternativeView),
  };
}

export function scheduleView(entry: ScheduleEntry): SessionSummary & { slotChosen: boolean; otherSlots: Slot[] } {
  return {
    ...summaryView(entry.session, [entry.occurrence]),
    slotChosen: !entry.fixed,
    otherSlots: entry.otherSlots.map(slotView),
  };
}

function conflictSide(entry: ScheduleEntry): ConflictView['first'] {
  const slot = slotView(entry.occurrence);
  return { code: entry.session.code, title: entry.session.title, slotId: slot.slotId, label: slot.label };
}

const briefEntry = (entry: ScheduleEntry): string => {
  const { occurrence } = entry;
  const place = occurrence.venue ? `, ${occurrence.venue}` : '';
  return `${entry.session.code} (${timeRangeLabel(occurrence.startTime, occurrence.endTime)}${place})`;
};

export function conflictMessage(conflict: Conflict): string {
  const first = briefEntry(conflict.first);
  const second = briefEntry(conflict.second);
  if (conflict.kind === 'overlap') return `${first} and ${second} overlap by ${minutesLabel(conflict.minutes)}.`;
  const gap = conflict.minutes <= 0 ? 'No time' : `Only ${minutesLabel(conflict.minutes)}`;
  return `${gap} between ${first} and ${second}; about ${minutesLabel(conflict.requiredGapMinutes)} are needed.`;
}

export function conflictView(conflict: Conflict): ConflictView {
  return {
    kind: conflict.kind,
    minutes: conflict.minutes,
    requiredGapMinutes: conflict.requiredGapMinutes,
    first: conflictSide(conflict.first),
    second: conflictSide(conflict.second),
    message: conflictMessage(conflict),
  };
}

export function sessionDetailView(catalog: Catalog, session: Session): SessionDetailOutput {
  const related = session.relatedCodes
    .map((code) => catalog.get(code))
    .filter((candidate) => candidate !== undefined)
    .slice(0, RELATED_LIMIT);
  const relatedCodes = new Set(related.map((candidate) => candidate.code));
  const similar = catalog
    .similar(session, SIMILAR_LIMIT + related.length)
    .filter((candidate) => !relatedCodes.has(candidate.code))
    .slice(0, SIMILAR_LIMIT);
  const level = levelLabel(session);
  return {
    code: session.code,
    title: session.title,
    type: session.type,
    ...(level ? { level } : {}),
    description: session.description,
    topics: session.topics,
    audiences: session.audiences,
    industries: session.industries,
    tags: session.tags,
    delivery: session.delivery,
    speakers: session.speakers.map((speaker) => ({ name: speaker.name, ...(speaker.role ? { role: speaker.role } : {}) })),
    companies: session.companies,
    recorded: session.recorded,
    liveStream: session.liveStream,
    sponsored: session.sponsored,
    featured: session.featured,
    reservableSeating: session.reservableSeating,
    onDemand: session.onDemand,
    slots: session.occurrences.map(slotView),
    resources: session.resources.map((resource) => ({ label: resource.label, url: resource.url })),
    url: session.url,
    related: related.map(relatedView),
    similar: similar.map(relatedView),
  };
}

/** `200 Intermediate` becomes `Level 200 (Intermediate)`. */
const levelFacetName = (name: string): string => name.replace(/^(\d{3}) (.+)$/, 'Level $1 ($2)');

export function overviewView(catalog: Catalog, status: StoreStatus | undefined): OverviewOutput {
  const { sessions, days, facets } = catalog;
  return {
    event: {
      name: EVENT.name,
      city: EVENT.city,
      timeZone: `${EVENT.timeZoneLabel} (${EVENT.timeZone})`,
      firstDay: days[0]?.date ?? '',
      lastDay: days.at(-1)?.date ?? '',
      sessionsUrl: EVENT.sessionsUrl,
    },
    sessions: {
      total: sessions.length,
      scheduled: sessions.filter((session) => session.occurrences.length > 0).length,
      onDemand: sessions.filter((session) => session.onDemand).length,
      recorded: sessions.filter((session) => session.recorded).length,
      liveStream: sessions.filter((session) => session.liveStream).length,
      speakers: catalog.speakerCount,
    },
    days: days.map((day) => ({ date: day.date, day: day.label, sessions: day.sessions, slots: day.occurrences })),
    venues: facets.venues,
    types: facets.types,
    topics: facets.topics,
    levels: facets.levels.map((facet) => ({ name: levelFacetName(facet.name), count: facet.count })),
    audiences: facets.audiences,
    industries: facets.industries,
    delivery: facets.delivery,
    topTags: facets.tags.slice(0, TOP_TAGS),
    data: {
      source: catalog.meta.source,
      asOf: catalog.meta.dataAsOf,
      ...(status?.lastCheckedAt ? { lastCheckedAt: status.lastCheckedAt } : {}),
      refreshIntervalMinutes: status?.refreshIntervalMinutes ?? 0,
    },
  };
}
