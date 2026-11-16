import { readFile } from 'node:fs/promises';
import { normalizeCatalog } from './normalize';
import { SNAPSHOT_SCHEMA_VERSION } from './types';
import type { CatalogSnapshot, Session } from './types';

const MAX_FEED_BYTES = 64 * 1024 * 1024;

export interface FetchFeedOptions {
  etag?: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type FetchFeedResult = { status: 'modified'; feed: unknown; etag?: string } | { status: 'not-modified' };

/** Downloads the session feed, sending `If-None-Match` when an ETag from a previous download is known. */
export async function fetchFeed(url: string, options: FetchFeedOptions = {}): Promise<FetchFeedResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    headers: {
      accept: 'application/json',
      'user-agent': 'ignite-mcp-server',
      ...(options.etag ? { 'if-none-match': options.etag } : {}),
    },
  });
  if (response.status === 304) return { status: 'not-modified' };
  if (!response.ok) throw new Error(`Session feed returned HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) throw new Error('Session feed is unexpectedly large');
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_FEED_BYTES) throw new Error('Session feed is unexpectedly large');
  const etag = response.headers.get('etag') ?? undefined;
  return { status: 'modified', feed: JSON.parse(new TextDecoder().decode(body)) as unknown, ...(etag ? { etag } : {}) };
}

export interface LoadedFeed {
  sessions: Session[];
  skipped: number;
  etag?: string;
}

export function buildSnapshot(sessions: Session[], sourceUrl: string, generatedAt = new Date().toISOString()): CatalogSnapshot {
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, generatedAt, sourceUrl, sessions };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export function parseSnapshot(json: unknown): CatalogSnapshot {
  if (!isObject(json) || json.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`Unsupported snapshot format (expected schemaVersion ${SNAPSHOT_SCHEMA_VERSION})`);
  }
  const { sessions } = json;
  if (!Array.isArray(sessions) || sessions.length === 0) throw new Error('Snapshot contains no sessions');
  for (const session of sessions) {
    if (!isObject(session) || typeof session.code !== 'string' || typeof session.title !== 'string' || !Array.isArray(session.occurrences)) {
      throw new Error('Snapshot contains a malformed session');
    }
  }
  return json as unknown as CatalogSnapshot;
}

export async function readSnapshot(candidates: readonly string[]): Promise<{ snapshot: CatalogSnapshot; path: string }> {
  const errors: string[] = [];
  for (const path of candidates) {
    try {
      const text = await readFile(path, 'utf8');
      return { snapshot: parseSnapshot(JSON.parse(text)), path };
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No usable session snapshot found (${errors.join('; ')})`);
}

export async function loadLiveFeed(url: string, options: FetchFeedOptions = {}): Promise<LoadedFeed | 'not-modified'> {
  const result = await fetchFeed(url, options);
  if (result.status === 'not-modified') return 'not-modified';
  const { sessions, skipped } = normalizeCatalog(result.feed);
  return { sessions, skipped, ...(result.etag ? { etag: result.etag } : {}) };
}
