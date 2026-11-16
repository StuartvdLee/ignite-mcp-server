export const EVENT = {
  name: 'Microsoft Ignite 2026',
  city: 'San Francisco, California',
  /** Pacific time: every date and time shown to users is in this zone. */
  timeZone: 'America/Los_Angeles',
  timeZoneLabel: 'Pacific Time',
  sessionsUrl: 'https://ignite.microsoft.com/en-US/sessions',
} as const;

export const DEFAULT_DATA_URL = 'https://aka.ms/ignite2026-session-info';

/** The time ID that the feed gives sessions without a time slot (on-demand content). */
export const NO_TIME_ID = 'AAAAAAAAAAAAAAAAAAAA';

/**
 * Catalog pages are addressed by session instance (`{sessionId}-{sessionTimeId}`), so a session that runs
 * several times has a page per time slot. On-demand sessions use the `NO_TIME_ID` time ID.
 */
export function sessionUrl(instanceId: string): string {
  return `${EVENT.sessionsUrl}/${encodeURIComponent(instanceId)}?source=sessions`;
}
