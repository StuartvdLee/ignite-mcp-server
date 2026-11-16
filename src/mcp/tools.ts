import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import { buildAgenda } from '../catalog/agenda';
import type { Catalog } from '../catalog/catalog';
import { createCalendarFile } from '../catalog/calendar';
import type { SessionFilters } from '../catalog/filters';
import { diversify, scoreInterests } from '../catalog/interests';
import { resolveAt, whatsOn } from '../catalog/live';
import type { LiveGroup, WhatsOn } from '../catalog/live';
import { OFF_SITE_MINUTES, VENUE_CHANGE_MINUTES, clashes, findConflicts, resolveItems } from '../catalog/schedule';
import type { Conflict, GapRules, ScheduleEntry } from '../catalog/schedule';
import type { StoreStatus } from '../catalog/store';
import { dayLabel } from '../catalog/time';
import { errorFields } from '../log';
import type { Logger } from '../log';
import { instantLabel, minutesLabel, plural, TIME_NOTE } from './format';
import {
  agendaItemView,
  conflictView,
  hitView,
  liveView,
  overviewView,
  recommendationView,
  scheduleView,
  sessionDetailView,
  skippedView,
  slotView,
  summaryView,
} from './present';
import {
  agendaText,
  calendarText,
  conflictsText,
  overviewText,
  recommendText,
  searchText,
  sessionDetailText,
  whatsOnText,
} from './render';
import {
  agendaInput,
  agendaOutput,
  calendarInput,
  calendarOutput,
  conflictsInput,
  conflictsOutput,
  filtersFrom,
  getSessionInput,
  overviewInput,
  overviewOutput,
  recommendInput,
  recommendOutput,
  searchInput,
  searchOutput,
  sessionDetailOutput,
  whatsOnInput,
  whatsOnOutput,
} from './schemas';
import type { AgendaOutput, CalendarOutput, ConflictsOutput, RecommendOutput, SearchOutput, WhatsOnOutput } from './schemas';

export interface ToolDeps {
  /** The current catalog; the store may swap it for a fresher one at any time, so never keep it. */
  catalog: () => Catalog;
  status: () => StoreStatus | undefined;
  now: () => number;
  /** Public origin for calendar download links. Unset when the server does not offer downloads. */
  downloadBaseUrl?: string | undefined;
  logger: Logger;
}

type Args<T extends z.ZodType> = z.infer<T>;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** Spread over recommendations so that a broad interest cannot crowd out a narrow one. */
const RECOMMEND_DECAY = 0.75;
const ON_DEMAND_PICKS = 5;

export function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

/** A result the model should read as a failure, for example an unknown session code. */
export function fail(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Logs the tool name and duration (never the arguments) and turns unexpected exceptions into a generic failure. */
function instrument<A>(deps: ToolDeps, tool: string, run: (args: A) => CallToolResult): (args: A) => CallToolResult {
  return (args) => {
    const started = performance.now();
    let result: CallToolResult;
    try {
      result = run(args);
    } catch (error) {
      deps.logger.error('Tool failed', { tool, ...errorFields(error) });
      result = fail('Something went wrong while running this tool. Please try again.');
    }
    deps.logger.info('Tool call', { tool, ms: Math.round(performance.now() - started), isError: result.isError === true });
    return result;
  };
}

const canonicalCodes = (catalog: Catalog, refs: readonly string[] | undefined): Set<string> =>
  new Set((refs ?? []).map((ref) => catalog.find(ref)?.code ?? ref.trim().toUpperCase()));

function gapAssumptions(rules: GapRules): string[] {
  const lines = [rules.minBreakMinutes === 0 ? 'Back-to-back sessions are allowed.' : `At least ${minutesLabel(rules.minBreakMinutes)} between sessions.`];
  lines.push(
    rules.attendance === 'online'
      ? 'Attending online: no travel time between sessions.'
      : `Walking time between venues is included: ${minutesLabel(VENUE_CHANGE_MINUTES)} extra when the venue changes and ${minutesLabel(OFF_SITE_MINUTES)} more to or from Chase Center (rough estimates).`,
  );
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------
// search_sessions
// ---------------------------------------------------------------------------------------------------------------------

function searchSessions(deps: ToolDeps, args: Args<typeof searchInput>): CallToolResult {
  const outcome = deps.catalog().search({
    query: args.query,
    filters: filtersFrom(args),
    limit: args.limit,
    offset: args.offset,
    sort: args.sort,
    nowMs: deps.now(),
  });
  const sessions = outcome.hits.map(hitView);
  const next = args.offset + sessions.length;
  const out: SearchOutput = {
    total: outcome.total,
    returned: sessions.length,
    offset: args.offset,
    ...(next < outcome.total ? { nextOffset: next } : {}),
    query: outcome.query,
    alsoSearched: outcome.expansions,
    filters: outcome.filters,
    warnings: outcome.warnings,
    sessions,
  };
  return ok(searchText(out), out);
}

// ---------------------------------------------------------------------------------------------------------------------
// get_session
// ---------------------------------------------------------------------------------------------------------------------

function getSession(deps: ToolDeps, args: Args<typeof getSessionInput>): CallToolResult {
  const catalog = deps.catalog();
  const resolved = catalog.resolveRef(args.code);
  if (!resolved) {
    const closest = catalog.search({ query: args.code, limit: 3 }).hits.map((hit) => `${hit.session.code} (${hit.session.title})`);
    return fail(
      `No session found for "${args.code}".` +
        (closest.length > 0 ? ` Closest matches: ${closest.join('; ')}.` : '') +
        ' Use search_sessions to look a session up by title, topic or speaker.',
    );
  }
  const { session } = resolved;
  const out = sessionDetailView(catalog, session);
  return ok(sessionDetailText(out), out);
}

// ---------------------------------------------------------------------------------------------------------------------
// recommend_sessions
// ---------------------------------------------------------------------------------------------------------------------

function recommendSessions(deps: ToolDeps, args: Args<typeof recommendInput>): CallToolResult {
  const catalog = deps.catalog();
  const resolved = catalog.resolve(filtersFrom(args), deps.now());
  const scored = scoreInterests(catalog, args.interests, resolved, { exclude: canonicalCodes(catalog, args.excludeCodes) });
  const picked = diversify(scored.sessions, RECOMMEND_DECAY, { limit: args.limit });
  const out: RecommendOutput = {
    interests: scored.interests.map((summary) => ({ interest: summary.interest, matches: summary.matches, alsoSearched: summary.expansions })),
    unmatchedInterests: scored.interests.filter((summary) => summary.matches === 0).map((summary) => summary.interest),
    returned: picked.length,
    filters: resolved.summary,
    warnings: resolved.warnings,
    recommendations: picked.map(recommendationView),
  };
  return ok(recommendText(out), out);
}

// ---------------------------------------------------------------------------------------------------------------------
// whats_on
// ---------------------------------------------------------------------------------------------------------------------

function whatsOnMessage(result: WhatsOn): string {
  const at = instantLabel(result.atMs);
  const another = 'Pass "at" (for example "2026-11-18T14:00", Pacific Time) to check another moment.';
  if (result.phase === 'before_event') {
    return `Ignite 2026 has not started yet: the first session starts ${instantLabel(result.eventStartMs)}. The sessions that start first are listed below. ${another} ${TIME_NOTE}`;
  }
  if (result.phase === 'after_event') {
    return `Ignite 2026 is over: the last session ended ${instantLabel(result.eventEndMs)}. ${another} search_sessions can still look up any session.`;
  }
  const { inProgress, startingSoon, next } = result;
  const window = minutesLabel(result.windowMinutes);
  const head =
    inProgress.total === 0 && startingSoon.total === 0
      ? `Nothing matching is in progress at ${at} or starting within ${window}.${next.items.length > 0 ? ' The next sessions to start are listed below.' : ' No later session matches either.'}`
      : `At ${at}: ${plural(inProgress.total, 'session')} in progress and ${plural(startingSoon.total, 'session')} starting within ${window}.`;
  return `${head} ${TIME_NOTE}`;
}

function whatsOnTool(deps: ToolDeps, args: Args<typeof whatsOnInput>): CallToolResult {
  const catalog = deps.catalog();
  const nowMs = deps.now();
  const at = resolveAt(args.at, nowMs);
  if ('error' in at) return fail(at.error);

  const resolved = catalog.resolve(filtersFrom(args), nowMs);
  const result = whatsOn(catalog, { query: args.query, resolved, atMs: at.ms, windowMinutes: args.windowMinutes, limit: args.limit });
  const group = (live: LiveGroup, kind: 'in_progress' | 'upcoming') => ({ total: live.total, sessions: live.items.map((item) => liveView(item, kind)) });
  const out: WhatsOnOutput = {
    phase: result.phase,
    at: new Date(at.ms).toISOString(),
    atLabel: instantLabel(at.ms),
    windowMinutes: result.windowMinutes,
    inProgress: group(result.inProgress, 'in_progress'),
    startingSoon: group(result.startingSoon, 'upcoming'),
    next: group(result.next, 'upcoming'),
    filters: resolved.summary,
    warnings: resolved.warnings,
    message: whatsOnMessage(result),
  };
  return ok(whatsOnText(out), out);
}

// ---------------------------------------------------------------------------------------------------------------------
// build_agenda
// ---------------------------------------------------------------------------------------------------------------------

const ATTENDANCE_NOTES = {
  in_person: 'Only sessions you can attend in person are considered.',
  online: 'Only sessions you can attend online are considered.',
  either: 'Both in-person and online sessions are considered.',
} as const;

function buildAgendaTool(deps: ToolDeps, args: Args<typeof agendaInput>): CallToolResult {
  const catalog = deps.catalog();
  const nowMs = deps.now();
  const rules: GapRules = { minBreakMinutes: args.minBreakMinutes, attendance: args.attendance };

  const filters: SessionFilters = filtersFrom(args);
  const assumptions = ['Times are Pacific Time.', ...gapAssumptions(rules), `At most ${plural(args.maxPerDay, 'session')} per day.`];
  if (!filters.delivery && args.attendance !== 'either') filters.delivery = [args.attendance === 'online' ? 'Online' : 'In-person'];
  if (!args.delivery) assumptions.push(ATTENDANCE_NOTES[args.attendance]);

  const resolved = catalog.resolve(filters, nowMs);
  const pinned = resolveItems(catalog, args.mustInclude ?? [], rules);
  const avoid = canonicalCodes(catalog, args.avoid);
  if (pinned.entries.length + pinned.onDemand.length > 0) assumptions.push('The sessions you asked for are kept and the rest is planned around them.');

  const agenda = buildAgenda(catalog, { interests: args.interests, resolved, rules, maxPerDay: args.maxPerDay, mustInclude: pinned.entries, avoid });

  // On-demand content has no time, so neither the time filters nor the in-person requirement apply to it.
  const taken = new Set([...avoid, ...pinned.onDemand.map((session) => session.code)]);
  const onDemandPicks =
    args.scheduled === true
      ? []
      : diversify(
          scoreInterests(
            catalog,
            args.interests,
            catalog.resolve({ ...filters, delivery: undefined, days: undefined, startAfter: undefined, startBefore: undefined, location: undefined, scheduled: false }, nowMs),
            { exclude: taken },
          ).sessions,
          RECOMMEND_DECAY,
          { limit: ON_DEMAND_PICKS },
        );
  const requestedOnDemand = pinned.onDemand.map((session) => ({
    ...summaryView(session, []),
    relevance: 1,
    matchedInterests: [] as string[],
    why: 'Included because you asked for it.',
  }));

  const days = agenda.days.map((day) => ({ date: day.date, day: dayLabel(day.date), sessions: day.items.map(agendaItemView) }));
  const onDemand = [...requestedOnDemand, ...onDemandPicks.map(recommendationView)];
  const covered = new Set(onDemand.flatMap((session) => session.matchedInterests));
  const out: AgendaOutput = {
    assumptions,
    totalSessions: days.reduce((sum, day) => sum + day.sessions.length, 0),
    days,
    onDemand,
    skipped: agenda.skipped.map(skippedView),
    coverage: agenda.coverage,
    uncoveredInterests: agenda.coverage.filter((entry) => entry.sessions === 0 && !covered.has(entry.interest)).map((entry) => entry.interest),
    pinnedConflicts: agenda.pinnedConflicts.map(conflictView),
    unresolved: pinned.unresolved,
    slotIds: days.flatMap((day) => day.sessions.map((session) => session.slots[0]?.slotId).filter((slotId) => slotId !== undefined)),
    filters: resolved.summary,
    warnings: resolved.warnings,
  };
  return ok(agendaText(out), out);
}

// ---------------------------------------------------------------------------------------------------------------------
// check_schedule_conflicts
// ---------------------------------------------------------------------------------------------------------------------

/** For each clash, another time slot of one of the two sessions that fits the rest of the schedule. */
function suggestFixes(conflicts: readonly Conflict[], entries: readonly ScheduleEntry[], rules: GapRules): string[] {
  const suggestions: string[] = [];
  const handled = new Set<string>();
  const stuck: string[] = [];
  for (const conflict of conflicts) {
    const pair = [conflict.second, conflict.first];
    if (pair.some((entry) => handled.has(entry.session.code))) continue;
    let fixed = false;
    for (const moving of pair) {
      const others = entries.filter((entry) => entry !== moving);
      const slot = moving.otherSlots.find((candidate) => others.every((other) => !clashes(candidate, other.occurrence, rules)));
      if (!slot) continue;
      handled.add(moving.session.code);
      suggestions.push(`Move ${moving.session.code} to ${slotView(slot).label} (slot id ${slot.slotId}): it fits the rest of the schedule.`);
      fixed = true;
      break;
    }
    if (!fixed) stuck.push(`${conflict.first.session.code} and ${conflict.second.session.code}`);
  }
  for (const pair of stuck) {
    suggestions.push(`${pair} are not offered at any other time: keep one and swap the other, for example with recommend_sessions.`);
  }
  return suggestions;
}

function checkConflicts(deps: ToolDeps, args: Args<typeof conflictsInput>): CallToolResult {
  const rules: GapRules = { minBreakMinutes: args.minBreakMinutes, attendance: args.attendance };
  const { entries, onDemand, unresolved } = resolveItems(deps.catalog(), args.items, rules);
  const conflicts = findConflicts(entries, rules);
  const out: ConflictsOutput = {
    ok: conflicts.length === 0 && unresolved.length === 0,
    assumptions: gapAssumptions(rules),
    schedule: entries.map(scheduleView),
    conflicts: conflicts.map(conflictView),
    onDemand: onDemand.map((session) => summaryView(session, [])),
    unresolved,
    suggestions: suggestFixes(conflicts, entries, rules),
  };
  return ok(conflictsText(out), out);
}

// ---------------------------------------------------------------------------------------------------------------------
// export_calendar
// ---------------------------------------------------------------------------------------------------------------------

/** Link to `GET /calendar.ics` for exactly the slots in this file. */
export function calendarDownloadUrl(baseUrl: string, slotIds: readonly string[], options: { name?: string | undefined; reminderMinutes?: number | undefined }): string {
  const params = new URLSearchParams({ sessions: slotIds.join(',') });
  if (options.name) params.set('name', options.name);
  if (options.reminderMinutes !== undefined) params.set('reminder', String(options.reminderMinutes));
  return `${baseUrl.replace(/\/+$/, '')}/calendar.ics?${params.toString()}`;
}

function exportCalendar(deps: ToolDeps, args: Args<typeof calendarInput>): CallToolResult {
  const file = createCalendarFile(deps.catalog(), args.items, { name: args.calendarName, nowMs: deps.now(), reminderMinutes: args.reminderMinutes });
  const events = file.entries.map((entry) => ({
    code: entry.session.code,
    title: entry.session.title,
    slotId: entry.occurrence.slotId,
    label: slotView(entry.occurrence).label,
  }));
  const downloadUrl =
    deps.downloadBaseUrl && events.length > 0
      ? calendarDownloadUrl(
          deps.downloadBaseUrl,
          events.map((event) => event.slotId),
          { name: args.calendarName, reminderMinutes: args.reminderMinutes },
        )
      : undefined;
  const out: CalendarOutput = {
    filename: file.filename,
    eventCount: events.length,
    events,
    ...(downloadUrl ? { downloadUrl } : {}),
    ics: file.ics,
    conflicts: file.conflicts.map(conflictView),
    onDemand: file.onDemand.map((session) => ({ code: session.code, title: session.title, url: session.url })),
    unresolved: file.unresolved,
  };
  return ok(calendarText(out), out);
}

// ---------------------------------------------------------------------------------------------------------------------
// get_catalog_overview
// ---------------------------------------------------------------------------------------------------------------------

function catalogOverview(deps: ToolDeps): CallToolResult {
  const out = overviewView(deps.catalog(), deps.status());
  return ok(overviewText(out), out);
}

// ---------------------------------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------------------------------

export function registerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'search_sessions',
    {
      title: 'Search sessions',
      description:
        'Search the Microsoft Ignite 2026 session catalog by keywords, topic, technology, speaker, company or session code, and narrow it down by day, time, level, session type, venue and more. ' +
        'Returns ranked sessions with their time slots (Pacific Time), speakers and a link to the official catalog. ' +
        'Use it for questions such as "which sessions cover Kubernetes security", "what is Satya Nadella presenting" or "which labs are on Wednesday afternoon".',
      inputSchema: searchInput,
      outputSchema: searchOutput,
      annotations: READ_ONLY,
    },
    instrument(deps, 'search_sessions', (args) => searchSessions(deps, args)),
  );

  server.registerTool(
    'get_session',
    {
      title: 'Get session details',
      description:
        'Get everything about one Ignite 2026 session: full description, speakers, every time slot and room, resources, linked sessions and similar sessions. Takes a session code such as "BRK217".',
      inputSchema: getSessionInput,
      outputSchema: sessionDetailOutput,
      annotations: READ_ONLY,
    },
    instrument(deps, 'get_session', (args) => getSession(deps, args)),
  );

  server.registerTool(
    'recommend_sessions',
    {
      title: 'Recommend sessions',
      description:
        'Recommend Ignite 2026 sessions for a person\'s interests. Give several interests (topics, technologies, goals): each one is matched separately and the picks are balanced across them, with a short reason per session. ' +
        'Prefer this over search_sessions when the user describes what they care about rather than a specific keyword. Includes on-demand content.',
      inputSchema: recommendInput,
      outputSchema: recommendOutput,
      annotations: READ_ONLY,
    },
    instrument(deps, 'recommend_sessions', (args) => recommendSessions(deps, args)),
  );

  server.registerTool(
    'whats_on',
    {
      title: "What's on now",
      description:
        'Show which sessions are in progress and which start soon, right now or at a given moment. Before the event it shows the opening sessions. ' +
        'Use it for "what is on right now", "what can I join after lunch" or "anything about security starting in the next hour".',
      inputSchema: whatsOnInput,
      outputSchema: whatsOnOutput,
      annotations: READ_ONLY,
    },
    instrument(deps, 'whats_on', (args) => whatsOnTool(deps, args)),
  );

  server.registerTool(
    'build_agenda',
    {
      title: 'Build a personal agenda',
      description:
        'Plan a conflict-free personal agenda from interests: picks the best sessions for every day without overlaps, leaves time to walk between venues and balances the interests. ' +
        'Sessions can be required (mustInclude) or excluded (avoid), and days, levels, topics and more can be restricted. ' +
        'Returns the plan per day, good alternatives at the same time, on-demand picks and slot ids that export_calendar accepts.',
      inputSchema: agendaInput,
      outputSchema: agendaOutput,
      annotations: READ_ONLY,
    },
    instrument(deps, 'build_agenda', (args) => buildAgendaTool(deps, args)),
  );

  server.registerTool(
    'check_schedule_conflicts',
    {
      title: 'Check schedule conflicts',
      description:
        'Check a list of sessions for overlaps and for too little time to get from one to the next. A session that is offered several times is placed in the slot that clashes least. ' +
        'Suggests other time slots that fix a clash.',
      inputSchema: conflictsInput,
      outputSchema: conflictsOutput,
      annotations: READ_ONLY,
    },
    instrument(deps, 'check_schedule_conflicts', (args) => checkConflicts(deps, args)),
  );

  server.registerTool(
    'export_calendar',
    {
      title: 'Export to calendar',
      description:
        'Create an iCalendar (.ics) file for sessions, ready to import into Outlook, Google Calendar or Apple Calendar. Returns a download link when the server offers downloads, otherwise the file content. ' +
        'Pass session codes or slot ids, for example the slotIds from build_agenda.',
      inputSchema: calendarInput,
      outputSchema: calendarOutput,
      annotations: READ_ONLY,
    },
    instrument(deps, 'export_calendar', (args) => exportCalendar(deps, args)),
  );

  server.registerTool(
    'get_catalog_overview',
    {
      title: 'Catalog overview',
      description:
        'Overview of the Ignite 2026 catalog: dates and venues, sessions per day, the available session types, topics, levels, audiences and industries, the most common tags and how fresh the data is. ' +
        'Call it when unsure which filter values exist.',
      inputSchema: overviewInput,
      outputSchema: overviewOutput,
      annotations: READ_ONLY,
    },
    instrument(deps, 'get_catalog_overview', () => catalogOverview(deps)),
  );
}
