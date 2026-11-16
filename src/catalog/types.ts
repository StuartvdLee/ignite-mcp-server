export interface Speaker {
  name: string;
  id?: string;
  /** Only set for notable roles: Customer, MVP, Sponsor, Executive. */
  role?: string;
}

/** One scheduled time slot of a session (labs and some sessions repeat). */
export interface Occurrence {
  /** Stable id: `CODE@YYYY-MM-DDTHH:mm`, with the local (Pacific) start time. */
  slotId: string;
  instanceId: string;
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  durationMinutes: number;
  /** Raw display location, e.g. `Moscone West | Level 3, Room 3014`. */
  location?: string;
  venue?: string;
  room?: string;
  /** Local (Pacific) calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Local 24h times, `HH:mm`. */
  startTime: string;
  endTime: string;
}

export interface Resource {
  label: string;
  url: string;
}

export interface Session {
  code: string;
  id: string;
  title: string;
  /** Plain text with HTML removed. */
  description: string;
  type: string;
  topics: string[];
  level?: string;
  levelNumber?: number;
  audiences: string[];
  industries: string[];
  tags: string[];
  delivery: string[];
  speakers: Speaker[];
  companies: string[];
  recorded: boolean;
  liveStream: boolean;
  sponsored: boolean;
  reservableSeating: boolean;
  featured: boolean;
  /** True when the session has no scheduled time slot (pre-recorded and digital content). */
  onDemand: boolean;
  occurrences: Occurrence[];
  relatedCodes: string[];
  resources: Resource[];
  url: string;
}

export interface CatalogSnapshot {
  schemaVersion: number;
  generatedAt: string;
  sourceUrl: string;
  sessions: Session[];
}

export const SNAPSHOT_SCHEMA_VERSION = 1;

export interface FacetCount {
  name: string;
  count: number;
}

export interface DayInfo {
  date: string;
  weekday: string;
  label: string;
  sessions: number;
  occurrences: number;
}

export interface CatalogMeta {
  source: 'snapshot' | 'live';
  sourceUrl: string;
  /** When the underlying data was produced (snapshot) or fetched (live). */
  dataAsOf: string;
  etag?: string | undefined;
}
