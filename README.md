# Microsoft Ignite 2026 catalog foundation

The catalog loads and normalizes Microsoft Ignite 2026 sessions, indexes them for search, and supports filters. It uses Microsoft's public [session feed](https://aka.ms/ignite2026-session-info), with a bundled snapshot as an offline fallback.

Requires Node.js 22 or later. Install dependencies with `npm ci`, then run `npm run check` to type-check and test the catalog.

Run `npm run snapshot` to refresh the snapshot from the live feed, or `npm run snapshot -- --input feed.json` to use a downloaded feed.
