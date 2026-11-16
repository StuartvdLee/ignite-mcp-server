export const EVENT = {
  name: 'Microsoft Ignite 2026',
  city: 'San Francisco, California',
  /** Pacific time: every date and time shown to users is in this zone. */
  timeZone: 'America/Los_Angeles',
  timeZoneLabel: 'Pacific Time',
  sessionsUrl: 'https://ignite.microsoft.com/en-US/sessions',
} as const;

export const DEFAULT_DATA_URL = 'https://aka.ms/ignite2026-session-info';

/**
 * Deep links are inferred from the links embedded in the session descriptions of the
 * official dataset: `/sessions/{sessionId}-AAAAAAAAAAAAAAAAAAAA?source=sessions`.
 */
export function sessionUrl(sessionId: string): string {
  return `${EVENT.sessionsUrl}/${encodeURIComponent(sessionId)}-AAAAAAAAAAAAAAAAAAAA?source=sessions`;
}
