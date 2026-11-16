import * as z from 'zod/v4';
import type { SessionFilters } from '../catalog/filters';

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 25;

const name = z.string().trim().min(1).max(100);
const names = (max: number, description: string) => z.array(name).max(max).optional().describe(description);
const sessionRef = z.string().trim().min(1).max(80);

// ---------------------------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------------------------

/** Filters shared by the search-like tools. Flat on purpose: models fill in flat arguments more reliably. */
export const filterShape = {
  topics: names(10, 'Only sessions in these topics, e.g. "Security", "Data", "Copilot", "Agent Platform", "Cloud & AI". Close spellings work.'),
  types: names(
    10,
    'Only these session types: Breakout, Lab, Lightning Talk, Theater, Table Talk, Keynote, Pre-recorded, Digital Lab, Broadcast Stage, Innovation Session.',
  ),
  levels: names(4, 'Technical depth: 100 (Foundational), 200 (Intermediate), 300 (Advanced) or 400 (Expert).'),
  audiences: names(4, 'Target audience: Technical Practitioner, Technical Decision Maker, Business Decision Maker or Partner Business.'),
  industries: names(10, 'Industry focus, e.g. "Financial Services" or "Healthcare and Life Sciences".'),
  delivery: names(2, 'How the session is delivered: "In-person" and/or "Online".'),
  tags: names(10, 'Exact catalog tags, e.g. "Azure AI Foundry". get_catalog_overview lists the most common ones.'),
  speaker: name.optional().describe('Speaker name: first name, last name or both.'),
  company: name.optional().describe('Company of a speaker or sponsor.'),
  days: names(7, 'Event days: ISO dates ("2026-11-18"), weekday names ("Wednesday") or dates like "Nov 18".'),
  startAfter: z
    .string()
    .trim()
    .max(40)
    .optional()
    .describe('Earliest start: a clock time such as "2pm" or "14:30" (applied on every day) or an ISO date-time in Pacific Time.'),
  startBefore: z
    .string()
    .trim()
    .max(40)
    .optional()
    .describe('Start must be before this: a clock time such as "5pm" (applied on every day) or an ISO date-time in Pacific Time.'),
  location: name.optional().describe('Venue or room, e.g. "Moscone West", "Level 3" or "AMC Metreon".'),
  recorded: z.boolean().optional().describe('true: only sessions that will be recorded.'),
  sponsored: z.boolean().optional().describe('true: only sponsor sessions; false: hide them.'),
  scheduled: z
    .boolean()
    .optional()
    .describe('true: only sessions with a fixed time; false: only on-demand content (pre-recorded sessions and digital labs).'),
};

export const FILTER_KEYS = Object.keys(filterShape) as (keyof SessionFilters)[];

/** The subset of the filters that makes sense for "what is on now". */
export const liveFilterShape = {
  topics: filterShape.topics,
  types: filterShape.types,
  levels: filterShape.levels,
  audiences: filterShape.audiences,
  delivery: filterShape.delivery,
  location: filterShape.location,
};

export function filtersFrom(args: Partial<Record<keyof SessionFilters, unknown>>): SessionFilters {
  const filters: Record<string, unknown> = {};
  for (const key of FILTER_KEYS) {
    if (args[key] !== undefined) filters[key] = args[key];
  }
  return filters as SessionFilters;
}

export const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .default(DEFAULT_LIMIT)
  .describe(`How many sessions to return (1–${MAX_LIMIT}).`);

export const attendanceSchema = z
  .enum(['in_person', 'online', 'either'])
  .default('in_person')
  .describe('How the attendee joins: in_person (default; adds walking time between venues), online (no travel time) or either.');

export const minBreakSchema = z
  .number()
  .int()
  .min(0)
  .max(120)
  .default(10)
  .describe('Minimum minutes to keep free between two sessions. Walking time between venues is added on top when attending in person.');

export const interestsSchema = z
  .array(name)
  .min(1)
  .max(10)
  .describe('Topics, technologies or goals, e.g. ["AI agents", "zero trust", "Kubernetes cost optimization"]. One interest per entry.');

export const sessionRefsSchema = (max: number) =>
  z
    .array(sessionRef)
    .min(1)
    .max(max)
    .describe(
      'Session codes such as "BRK217", or a specific time slot such as "LAB650@2026-11-18T14:00" (slot ids are shown in results). ' +
        'A session offered several times without a slot is placed at the time that causes the fewest clashes.',
    );

export const searchInput = z.object({
  query: z
    .string()
    .trim()
    .max(300)
    .optional()
    .describe(
      'Keywords, a topic, a speaker or a session code, e.g. "responsible AI", "Satya Nadella" or "BRK217". Related terms are added automatically. ' +
        'Leave empty to browse everything that matches the filters in time order.',
    ),
  ...filterShape,
  sort: z.enum(['relevance', 'time']).optional().describe('Order of the results. Defaults to relevance when there is a query, otherwise time.'),
  limit: limitSchema,
  offset: z.number().int().min(0).max(2000).default(0).describe('Number of results to skip, for paging.'),
});

export const getSessionInput = z.object({
  code: sessionRef.describe('Session code such as "BRK217". A session id or slot id ("BRK217@2026-11-19T16:00") also works.'),
});

export const recommendInput = z.object({
  interests: interestsSchema,
  ...filterShape,
  excludeCodes: z.array(sessionRef).max(100).optional().describe('Session codes to leave out, e.g. ones the attendee has already seen or picked.'),
  limit: limitSchema,
});

export const whatsOnInput = z.object({
  at: z
    .string()
    .trim()
    .max(40)
    .optional()
    .describe('The moment to check: an ISO date-time in Pacific Time ("2026-11-18T14:00") or a clock time today ("2pm"). Defaults to now.'),
  windowMinutes: z.number().int().min(5).max(240).default(60).describe('How far ahead to look for sessions that are about to start.'),
  query: z.string().trim().max(300).optional().describe('Optional keywords to narrow down, e.g. "security".'),
  ...liveFilterShape,
  limit: limitSchema,
});

export const agendaInput = z.object({
  interests: interestsSchema,
  ...filterShape,
  maxPerDay: z.number().int().min(1).max(10).default(5).describe('Maximum sessions to plan per day.'),
  minBreakMinutes: minBreakSchema,
  attendance: attendanceSchema,
  mustInclude: z.array(sessionRef).max(20).optional().describe('Sessions that must be in the agenda (codes or slot ids). Everything else is planned around them.'),
  avoid: z.array(sessionRef).max(100).optional().describe('Session codes that must not be suggested.'),
});

export const conflictsInput = z.object({
  items: sessionRefsSchema(40),
  minBreakMinutes: minBreakSchema,
  attendance: attendanceSchema,
});

export const calendarInput = z.object({
  items: sessionRefsSchema(50),
  reminderMinutes: z
    .number()
    .int()
    .min(0)
    .max(1440)
    .optional()
    .describe('Add a reminder this many minutes before each session. No reminder when omitted.'),
  calendarName: z.string().trim().min(1).max(80).optional().describe('Name of the calendar. Defaults to "Microsoft Ignite 2026".'),
});

export const overviewInput = z.object({});

// ---------------------------------------------------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------------------------------------------------

// Shapes that repeat inside one tool result carry an `id`, so that they become a single `$defs` entry and `$ref`s in the JSON schema.
// Do not call `.describe()` on them: the copy it makes loses the id and is inlined again.

export const slotSchema = z
  .object({
    slotId: z.string().describe('Id of this time slot, e.g. "BRK217@2026-11-19T16:00". Accepted by check_schedule_conflicts and export_calendar.'),
    day: z.string().describe('e.g. "Thu Nov 19".'),
    date: z.string().describe('ISO date in Pacific Time.'),
    startTime: z.string().describe('HH:mm, Pacific Time.'),
    endTime: z.string().describe('HH:mm, Pacific Time.'),
    startUtc: z.string(),
    endUtc: z.string(),
    durationMinutes: z.number().int(),
    venue: z.string().optional(),
    room: z.string().optional(),
    label: z.string().describe('Readable time and place, e.g. "Thu Nov 19, 4:00–4:45 PM · Moscone West, Level 3, Room 3014".'),
  })
  .meta({ id: 'Slot' });

export const sessionSummarySchema = z
  .object({
    code: z.string().describe('Session code, e.g. "BRK217".'),
    title: z.string(),
    type: z.string().describe('e.g. "Breakout", "Lab" or "Keynote".'),
    level: z.string().optional().describe('e.g. "Level 200 (Intermediate)". Absent for some sessions.'),
    topics: z.array(z.string()),
    tags: z.array(z.string()).describe('Up to 6.'),
    speakers: z.array(z.string()).describe('Names of the first 6 speakers.'),
    speakerCount: z.number().int(),
    delivery: z.array(z.string()).describe('"In-person" and/or "Online".'),
    recorded: z.boolean(),
    liveStream: z.boolean(),
    onDemand: z.boolean().describe('True for content without a fixed time.'),
    slots: z.array(slotSchema).describe('Pacific Time. Empty for on-demand content.'),
    summary: z.string().describe('Short excerpt of the description.'),
    url: z.string().describe('Link to the session in the official Ignite catalog.'),
  })
  .meta({ id: 'SessionSummary' });

export const searchHitSchema = sessionSummarySchema.extend({
  relevance: z.number().describe('0–1: how well it matches compared with the best matches. 1 when browsing without a query.'),
  matchedOn: z.array(z.string()).describe('What matched, e.g. "title" or "tags: AI Agents".'),
});

const interestSummarySchema = z.object({
  interest: z.string(),
  matches: z.number().int().describe('Sessions that matched this interest well.'),
  alsoSearched: z.array(z.string()).describe('Related terms that were searched as well.'),
});

const unresolvedSchema = z.object({ ref: z.string(), reason: z.string() });

const conflictSideSchema = z.object({ code: z.string(), title: z.string(), slotId: z.string(), label: z.string() });

export const conflictSchema = z
  .object({
    kind: z.enum(['overlap', 'tight']).describe('overlap: the sessions run at the same time. tight: not enough time to get from one to the other.'),
    minutes: z.number().int().describe('Minutes of overlap, or minutes left between the sessions.'),
    requiredGapMinutes: z.number().int(),
    first: conflictSideSchema,
    second: conflictSideSchema,
    message: z.string(),
  })
  .meta({ id: 'Conflict' });

export const searchOutput = z.object({
  total: z.number().int().describe('All sessions that matched.'),
  returned: z.number().int(),
  offset: z.number().int(),
  nextOffset: z.number().int().optional().describe('Pass as offset to get the next page. Absent on the last page.'),
  query: z.string(),
  alsoSearched: z.array(z.string()).describe('Related terms that were searched as well.'),
  filters: z.array(z.string()).describe('The filters that were applied.'),
  warnings: z.array(z.string()),
  sessions: z.array(searchHitSchema),
});

const relatedSchema = z.object({ code: z.string(), title: z.string(), type: z.string(), when: z.string().optional() });

export const sessionDetailOutput = z.object({
  code: z.string(),
  title: z.string(),
  type: z.string(),
  level: z.string().optional(),
  description: z.string(),
  topics: z.array(z.string()),
  audiences: z.array(z.string()),
  industries: z.array(z.string()),
  tags: z.array(z.string()),
  delivery: z.array(z.string()),
  speakers: z.array(z.object({ name: z.string(), role: z.string().optional().describe('Customer, MVP, Sponsor or Executive.') })),
  companies: z.array(z.string()),
  recorded: z.boolean(),
  liveStream: z.boolean(),
  sponsored: z.boolean(),
  featured: z.boolean(),
  reservableSeating: z.boolean(),
  onDemand: z.boolean(),
  slots: z.array(slotSchema),
  resources: z.array(z.object({ label: z.string(), url: z.string() })),
  url: z.string(),
  related: z.array(relatedSchema).describe('Sessions the organizers link to this one.'),
  similar: z.array(relatedSchema).describe('Sessions with overlapping tags and topics.'),
});

export const recommendationSchema = sessionSummarySchema.extend({
  relevance: z.number().describe('Sum of the match strengths over the interests the session covers (higher is better).'),
  matchedInterests: z.array(z.string()),
  why: z.string().describe('Why the session was picked.'),
});

export const recommendOutput = z.object({
  interests: z.array(interestSummarySchema),
  unmatchedInterests: z.array(z.string()).describe('Interests without any good match. Try other words or fewer filters.'),
  returned: z.number().int(),
  filters: z.array(z.string()),
  warnings: z.array(z.string()),
  recommendations: z.array(recommendationSchema),
});

const liveSessionSchema = sessionSummarySchema.extend({
  startsInMinutes: z.number().int().optional().describe('Minutes until it starts.'),
  minutesLeft: z.number().int().optional().describe('Minutes until it ends.'),
});

/** `total` is everything that matched, before the limit. `next` is only filled when nothing is in progress or starting soon. */
const liveGroupSchema = z.object({ total: z.number().int(), sessions: z.array(liveSessionSchema) }).meta({ id: 'LiveGroup' });

export const whatsOnOutput = z.object({
  phase: z.enum(['before_event', 'during_event', 'after_event']),
  at: z.string().describe('The moment that was checked, as an ISO 8601 UTC timestamp.'),
  atLabel: z.string().describe('The same moment in Pacific Time, e.g. "Wed Nov 18, 2:00 PM".'),
  windowMinutes: z.number().int(),
  inProgress: liveGroupSchema,
  startingSoon: liveGroupSchema,
  next: liveGroupSchema,
  filters: z.array(z.string()),
  warnings: z.array(z.string()),
  message: z.string(),
});

const agendaItemSchema = sessionSummarySchema.extend({
  pinned: z.boolean().describe('True when the session was requested through mustInclude.'),
  matchedInterests: z.array(z.string()),
  why: z.string(),
  otherSlots: z.array(slotSchema).describe('Other times this session is offered; "slots" holds the one that was planned.'),
  alternatives: z
    .array(z.object({ code: z.string(), title: z.string(), slotId: z.string(), label: z.string(), matchedInterests: z.array(z.string()) }))
    .describe('Good matches that run at the same time.'),
});

export const agendaOutput = z.object({
  assumptions: z.array(z.string()),
  totalSessions: z.number().int(),
  days: z.array(z.object({ date: z.string(), day: z.string(), sessions: z.array(agendaItemSchema) })),
  onDemand: z.array(recommendationSchema).describe('Best on-demand matches: no fixed time, watch any time.'),
  skipped: z.array(z.object({ code: z.string(), title: z.string(), label: z.string(), reason: z.string() })).describe('Good matches that did not fit.'),
  coverage: z.array(z.object({ interest: z.string(), sessions: z.number().int() })),
  uncoveredInterests: z.array(z.string()),
  pinnedConflicts: z.array(conflictSchema),
  unresolved: z.array(unresolvedSchema),
  slotIds: z.array(z.string()).describe('Every planned slot, ready to pass to export_calendar.'),
  filters: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const conflictsOutput = z.object({
  ok: z.boolean().describe('True when every session can be attended and every reference was understood.'),
  assumptions: z.array(z.string()),
  schedule: z.array(
    sessionSummarySchema.extend({
      slotChosen: z.boolean().describe('True when the session has several time slots and one was picked for you.'),
      otherSlots: z.array(slotSchema),
    }),
  ),
  conflicts: z.array(conflictSchema),
  onDemand: z.array(sessionSummarySchema).describe('On-demand sessions: they have no time to clash with.'),
  unresolved: z.array(unresolvedSchema),
  suggestions: z.array(z.string()),
});

export const calendarOutput = z.object({
  filename: z.string(),
  eventCount: z.number().int(),
  events: z.array(z.object({ code: z.string(), title: z.string(), slotId: z.string(), label: z.string() })),
  downloadUrl: z.string().optional().describe('Open this link to download the .ics file. Absent when the server does not offer downloads.'),
  ics: z
    .string()
    .describe('The complete iCalendar (.ics) file: save it with the extension .ics and open it with any calendar app. Empty when there is nothing to export.'),
  conflicts: z.array(conflictSchema),
  onDemand: z.array(z.object({ code: z.string(), title: z.string(), url: z.string() })).describe('On-demand sessions have no time slot and were left out.'),
  unresolved: z.array(unresolvedSchema),
});

const facetSchema = z.object({ name: z.string(), count: z.number().int() });

export const overviewOutput = z.object({
  event: z.object({ name: z.string(), city: z.string(), timeZone: z.string(), firstDay: z.string(), lastDay: z.string(), sessionsUrl: z.string() }),
  sessions: z.object({
    total: z.number().int(),
    scheduled: z.number().int(),
    onDemand: z.number().int(),
    recorded: z.number().int(),
    liveStream: z.number().int(),
    speakers: z.number().int(),
  }),
  days: z.array(z.object({ date: z.string(), day: z.string(), sessions: z.number().int(), slots: z.number().int() })),
  venues: z.array(facetSchema),
  types: z.array(facetSchema),
  topics: z.array(facetSchema),
  levels: z.array(facetSchema),
  audiences: z.array(facetSchema),
  industries: z.array(facetSchema),
  delivery: z.array(facetSchema),
  topTags: z.array(facetSchema),
  data: z.object({
    source: z.enum(['live', 'snapshot']).describe('live: the current official feed. snapshot: the copy bundled with the server.'),
    asOf: z.string(),
    lastCheckedAt: z.string().optional(),
    refreshIntervalMinutes: z.number().int(),
  }),
});

export type Slot = z.infer<typeof slotSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SearchHitView = z.infer<typeof searchHitSchema>;
export type ConflictView = z.infer<typeof conflictSchema>;
export type LiveSession = z.infer<typeof liveSessionSchema>;
export type AgendaSession = z.infer<typeof agendaItemSchema>;
export type SearchOutput = z.infer<typeof searchOutput>;
export type SessionDetailOutput = z.infer<typeof sessionDetailOutput>;
export type RecommendOutput = z.infer<typeof recommendOutput>;
export type Recommendation = z.infer<typeof recommendationSchema>;
export type WhatsOnOutput = z.infer<typeof whatsOnOutput>;
export type AgendaOutput = z.infer<typeof agendaOutput>;
export type ConflictsOutput = z.infer<typeof conflictsOutput>;
export type CalendarOutput = z.infer<typeof calendarOutput>;
export type OverviewOutput = z.infer<typeof overviewOutput>;
