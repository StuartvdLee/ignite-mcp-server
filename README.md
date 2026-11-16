# Microsoft Ignite 2026 catalog and planning library

The library loads and normalizes Microsoft Ignite 2026 sessions, indexes them for search, and supports filters, recommendations, agenda planning, live-session lookups and calendar export. It uses Microsoft's public [session feed](https://aka.ms/ignite2026-session-info), with a bundled snapshot as an offline fallback.

## Planning features

- `src/catalog/interests.ts` scores sessions against a list of interests and diversifies recommendations.
- `src/catalog/agenda.ts` builds a conflict-aware agenda, placing required sessions first and balancing recommendations across interests.
- `src/catalog/schedule.ts` resolves session codes, IDs and occurrence slot IDs, then detects overlaps and insufficient breaks or travel time.
- `src/catalog/live.ts` reports sessions in progress, starting soon, or next, at a requested time.
- `src/catalog/calendar.ts` creates an iCalendar (`.ics`) export with stable, occurrence-specific event IDs, optional reminders, and reported schedule conflicts.

The planning modules operate on the catalog and its normalized session occurrences; they do not require a server. Calendar event links point to the matching occurrence on the Ignite site.

## Development

Requires Node.js 22 or later. Install dependencies with `npm ci`, then run `npm run check` to type-check and test the library.

Run `npm run snapshot` to refresh the session snapshot from the live feed, or `npm run snapshot -- --input feed.json` to use a downloaded feed.
