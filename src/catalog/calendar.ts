import { EVENT } from '../event';
import type { Catalog } from './catalog';
import { buildCalendar, calendarFilename, toCalendarEvent } from './ics';
import { DEFAULT_MIN_BREAK_MINUTES, findConflicts, resolveItems } from './schedule';
import type { Conflict, GapRules, ScheduleEntry, Unresolved } from './schedule';
import type { Session } from './types';

/** What clashes are measured against when a calendar is exported: an attendee on site with a short break. */
export const DEFAULT_RULES: GapRules = { minBreakMinutes: DEFAULT_MIN_BREAK_MINUTES, attendance: 'in_person' };

export interface CalendarRequest {
  name?: string | undefined;
  nowMs: number;
  reminderMinutes?: number | undefined;
}

export interface CalendarFile {
  filename: string;
  /** Empty when no session has a fixed time. */
  ics: string;
  entries: ScheduleEntry[];
  /** Sessions without a fixed time: they cannot be put in a calendar. */
  onDemand: Session[];
  unresolved: Unresolved[];
  conflicts: Conflict[];
}

/** Used by the `export_calendar` tool and the `/calendar.ics` download. */
export function createCalendarFile(catalog: Catalog, refs: readonly string[], request: CalendarRequest): CalendarFile {
  const { entries, onDemand, unresolved } = resolveItems(catalog, refs, DEFAULT_RULES);
  const ics =
    entries.length === 0
      ? ''
      : buildCalendar(
          entries.map((entry) => toCalendarEvent(entry.session, entry.occurrence)),
          { name: request.name ?? EVENT.name, nowMs: request.nowMs, reminderMinutes: request.reminderMinutes },
        );
  return {
    filename: calendarFilename(entries.map((entry) => entry.session.code)),
    ics,
    entries,
    onDemand,
    unresolved,
    conflicts: findConflicts(entries, DEFAULT_RULES),
  };
}
