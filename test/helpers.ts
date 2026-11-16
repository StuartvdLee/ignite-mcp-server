import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Catalog } from '../src/catalog/catalog';
import { readSnapshot } from '../src/catalog/loader';
import { normalizeCatalog } from '../src/catalog/normalize';
import { zonedToUtcMs } from '../src/catalog/time';
import type { CatalogMeta, Occurrence, Session } from '../src/catalog/types';
import { NO_TIME_ID, sessionUrl } from '../src/event';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SNAPSHOT_PATH = fileURLToPath(new URL('../data/sessions.snapshot.json', import.meta.url));
const FEED_PATH = fileURLToPath(new URL('./fixtures/feed.json', import.meta.url));

export const META: CatalogMeta = { source: 'live', sourceUrl: 'https://example.test/feed.json', dataAsOf: '2026-11-16T12:00:00.000Z' };

/** The raw records of the trimmed feed fixture: 34 sessions, the way the official feed delivers them. */
export function readFeed(): Record<string, unknown>[] {
  return JSON.parse(readFileSync(FEED_PATH, 'utf8')) as Record<string, unknown>[];
}

let fixture: Catalog | undefined;

/** A small catalog built from the feed fixture. Catalogs are read-only, so tests can share it. */
export function fixtureCatalog(): Catalog {
  fixture ??= new Catalog(normalizeCatalog(readFeed()).sessions, META);
  return fixture;
}

let bundled: Promise<Catalog> | undefined;

/** The whole bundled snapshot, for tests that need realistic search behaviour. */
export function snapshotCatalog(): Promise<Catalog> {
  bundled ??= readSnapshot([SNAPSHOT_PATH]).then(
    ({ snapshot }) => new Catalog(snapshot.sessions, { source: 'snapshot', sourceUrl: snapshot.sourceUrl, dataAsOf: snapshot.generatedAt }),
  );
  return bundled;
}

export function sessionOf(catalog: Catalog, code: string): Session {
  const found = catalog.get(code);
  if (!found) throw new Error(`Test catalog has no session ${code}`);
  return found;
}

/** Epoch milliseconds of a Pacific wall-clock time, e.g. `pacific('2026-11-18', '10:00')`. */
export const pacific = (date: string, time: string): number => zonedToUtcMs(date, time);

/** A hand-made time slot, e.g. `makeSlot('A1', '2026-11-17', '09:00', '10:00')`. Times are Pacific. */
export function makeSlot(code: string, date: string, start: string, end: string, venue = 'Moscone West'): Occurrence {
  const startMs = pacific(date, start);
  const endMs = pacific(date, end);
  return {
    slotId: `${code}@${date}T${start}`,
    instanceId: `${code}-${date}T${start}`,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    startMs,
    endMs,
    durationMinutes: Math.round((endMs - startMs) / 60_000),
    location: `${venue} | Room 1`,
    venue,
    room: 'Room 1',
    date,
    startTime: start,
    endTime: end,
  };
}

/** A hand-made session. It is on demand unless it has slots. */
export function makeSession(code: string, overrides: Partial<Session> = {}, slots: Occurrence[] = []): Session {
  return {
    code,
    id: `id${code}`,
    title: code,
    description: '',
    type: 'Breakout',
    topics: [],
    audiences: [],
    industries: [],
    tags: [],
    delivery: ['In-person'],
    speakers: [],
    companies: [],
    recorded: false,
    liveStream: false,
    sponsored: false,
    reservableSeating: false,
    featured: false,
    onDemand: slots.length === 0,
    occurrences: slots,
    relatedCodes: [],
    resources: [],
    url: sessionUrl(slots[0]?.instanceId ?? `id${code}-${NO_TIME_ID}`),
    ...overrides,
  };
}

/** A catalog of hand-made sessions, for tests that need to control every detail. */
export const syntheticCatalog = (sessions: Session[]): Catalog => new Catalog(sessions, META);

export interface FetchCall {
  url: string;
  headers: Headers;
  init: RequestInit;
}

/** A stand-in for `fetch` that records its calls. `reply` builds a fresh Response each time, as a body can be read only once. */
export function fakeFetch(reply: (call: FetchCall, number: number) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), headers: new Headers(init?.headers), init: init ?? {} };
    calls.push(call);
    return reply(call, calls.length);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export const jsonResponse = (body: unknown, headers: Record<string, string> = {}, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A raw feed of `count` one-slot sessions (SYN000, SYN001, …): enough to get past the store's sanity checks. */
export function syntheticFeed(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => {
    const n = String(index).padStart(3, '0');
    return {
      sessionCode: `SYN${n}`,
      title: `Synthetic session ${n}`,
      sessionId: `syn-id-${n}`,
      sessionInstanceId: `syn-id-${n}-slot`,
      startDateTime: '2026-11-18T18:00:00Z',
      endDateTime: '2026-11-18T18:45:00Z',
    };
  });
}

/** The content lines of an iCalendar file with folded lines joined again. */
export function icsLines(ics: string): string[] {
  const lines = ics.replace(/\r\n[ \t]/g, '').split('\r\n');
  if (lines.pop() !== '') throw new Error('An iCalendar file has to end with CRLF');
  return lines;
}

export interface IcsEvent {
  /** The properties of the event itself, by name. */
  props: Record<string, string>;
  /** The properties of its alarm, when it has one. */
  alarm?: Record<string, string>;
}

/** The events of an iCalendar file. A simple reader: every property name occurs once per block, as in our files. */
export function icsEvents(ics: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let current: IcsEvent | undefined;
  let target: Record<string, string> | undefined;
  for (const line of icsLines(ics)) {
    if (line === 'BEGIN:VEVENT') {
      current = { props: {} };
      events.push(current);
      target = current.props;
    } else if (line === 'BEGIN:VALARM' && current) {
      current.alarm = {};
      target = current.alarm;
    } else if (line === 'END:VALARM' && current) {
      target = current.props;
    } else if (line === 'END:VEVENT') {
      current = undefined;
      target = undefined;
    } else if (target) {
      const colon = line.indexOf(':');
      target[line.slice(0, colon)] = line.slice(colon + 1);
    }
  }
  return events;
}
