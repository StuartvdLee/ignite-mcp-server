import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildSnapshot } from '../src/catalog/loader';
import { normalizeCatalog } from '../src/catalog/normalize';
import { CatalogStore } from '../src/catalog/store';
import type { StoreOptions } from '../src/catalog/store';
import { createLogger } from '../src/log';
import { fakeFetch, fixtureCatalog, jsonResponse, readFeed, syntheticFeed } from './helpers';
import type { FetchCall } from './helpers';

const DATA_URL = 'https://example.test/feed.json';
const SNAPSHOT_TIME = '2026-11-01T00:00:00.000Z';

let directory: string;
let small: string;
let large: string;
let broken: string;
let empty: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'ignite-store-'));
  small = join(directory, 'small.json');
  large = join(directory, 'large.json');
  broken = join(directory, 'broken.json');
  empty = join(directory, 'empty.json');
  writeFileSync(small, JSON.stringify(buildSnapshot(fixtureCatalog().sessions, 'https://example.test/source', SNAPSHOT_TIME)));
  writeFileSync(large, JSON.stringify(buildSnapshot(normalizeCatalog(syntheticFeed(300)).sessions, 'https://example.test/source', SNAPSHOT_TIME)));
  writeFileSync(broken, '{ "schemaVersion": 1, "sessions": [');
  writeFileSync(empty, JSON.stringify({ schemaVersion: 1, generatedAt: SNAPSHOT_TIME, sourceUrl: 'x', sessions: [] }));
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
afterEach(() => {
  vi.useRealTimers();
});

interface LogLine {
  level: string;
  msg: string;
  [key: string]: unknown;
}

function setup(snapshot: string, reply: (call: FetchCall, number: number) => Response | Promise<Response>, options: Partial<StoreOptions> = {}) {
  const { fetchImpl, calls } = fakeFetch(reply);
  const logs: LogLine[] = [];
  const store = new CatalogStore({
    dataUrl: DATA_URL,
    snapshotPaths: [snapshot],
    refreshIntervalMinutes: 15,
    logger: createLogger('debug', (line) => logs.push(JSON.parse(line) as LogLine)),
    fetchImpl,
    ...options,
  });
  return { store, calls, logs };
}

const feedResponse = (count: number, etag?: string) => jsonResponse(syntheticFeed(count), etag ? { etag } : {});
const notModified = () => new Response(null, { status: 304 });

describe('before anything is loaded', () => {
  it('is not ready and has no catalog', () => {
    const { store, calls } = setup(small, () => feedResponse(150));
    expect(store.ready).toBe(false);
    expect(() => store.catalog).toThrow('Catalog is not loaded yet');
    expect(() => store.status()).toThrow('Catalog is not loaded yet');
    expect(calls).toEqual([]);
  });

  it('reports a failed refresh rather than throwing or crashing', async () => {
    const { store, calls } = setup(small, () => feedResponse(150));
    expect(await store.refresh()).toBe('failed');
    expect(calls).toEqual([]);
    expect(store.ready).toBe(false);
  });
});

describe('starting from the bundled snapshot', () => {
  it('serves the snapshot straight away', async () => {
    const { store, logs } = setup(small, () => feedResponse(150));
    await store.init();
    expect(store.ready).toBe(true);
    expect(store.catalog.sessions).toHaveLength(34);
    expect(store.catalog.get('KEY01')).toBeDefined();
    expect(store.catalog.meta).toEqual({ source: 'snapshot', sourceUrl: 'https://example.test/source', dataAsOf: SNAPSHOT_TIME });
    expect(store.status()).toEqual({ source: 'snapshot', sessions: 34, dataAsOf: SNAPSHOT_TIME, lastCheckedAt: undefined, lastError: undefined, refreshIntervalMinutes: 15 });
    expect(logs).toEqual([expect.objectContaining({ level: 'info', msg: 'Loaded session snapshot', path: small, sessions: 34, generatedAt: SNAPSHOT_TIME })]);
  });

  it('does not touch the network by itself', async () => {
    const { store, calls } = setup(small, () => feedResponse(150));
    await store.init();
    expect(calls).toEqual([]);
  });

  it('skips candidates that cannot be used', async () => {
    const { store } = setup(small, () => feedResponse(150), { snapshotPaths: [join(directory, 'missing.json'), broken, small] });
    await store.init();
    expect(store.catalog.sessions).toHaveLength(34);
  });

  it('fails to start when there is no usable snapshot', async () => {
    const { store } = setup(small, () => feedResponse(150), { snapshotPaths: [join(directory, 'missing.json'), broken] });
    await expect(store.init()).rejects.toThrow('No usable session snapshot found');
    expect(store.ready).toBe(false);
    const { store: emptyStore } = setup(small, () => feedResponse(150), { snapshotPaths: [empty] });
    await expect(emptyStore.init()).rejects.toThrow('Snapshot contains no sessions');
  });

  it('reports the configured refresh interval', async () => {
    const { store } = setup(small, () => feedResponse(150), { refreshIntervalMinutes: 0 });
    await store.init();
    expect(store.status().refreshIntervalMinutes).toBe(0);
  });
});

describe('switching to the live feed', () => {
  it('replaces the snapshot with the live sessions', async () => {
    const { store, calls, logs } = setup(small, () => feedResponse(150, '"v1"'));
    await store.init();
    expect(await store.refresh()).toBe('updated');

    const status = store.status();
    expect(status).toMatchObject({ source: 'live', sessions: 150, lastError: undefined, refreshIntervalMinutes: 15 });
    expect(status.lastCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(status.dataAsOf).toBe(status.lastCheckedAt);
    expect(store.catalog.meta).toEqual({ source: 'live', sourceUrl: DATA_URL, dataAsOf: status.lastCheckedAt, etag: '"v1"' });
    expect(store.catalog.get('SYN007')).toBeDefined();
    expect(store.catalog.get('KEY01')).toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(DATA_URL);
    expect(calls[0]?.headers.has('if-none-match')).toBe(false);
    expect(logs.at(-1)).toMatchObject({ level: 'info', msg: 'Loaded live session feed', sessions: 150, skipped: 0 });
  });

  it('does not count records it had to skip', async () => {
    const { store, logs } = setup(small, () => jsonResponse([...syntheticFeed(120), ...Array.from({ length: 20 }, () => ({ nothing: 'useful' }))]));
    await store.init();
    expect(await store.refresh()).toBe('updated');
    expect(store.catalog.sessions).toHaveLength(120);
    expect(logs.at(-1)).toMatchObject({ msg: 'Loaded live session feed', sessions: 120, skipped: 20 });
  });

  it('asks only for changes once it has live data', async () => {
    const { store, calls, logs } = setup(small, (_call, number) => (number === 1 ? feedResponse(150, '"v1"') : notModified()));
    await store.init();
    await store.refresh();
    const first = store.status();
    const catalog = store.catalog;

    expect(await store.refresh()).toBe('unchanged');
    expect(calls[1]?.headers.get('if-none-match')).toBe('"v1"');
    expect(store.catalog).toBe(catalog);
    expect(store.status()).toMatchObject({ source: 'live', sessions: 150, dataAsOf: first.dataAsOf, lastError: undefined });
    expect(store.status().lastCheckedAt! >= first.lastCheckedAt!).toBe(true);
    expect(logs.at(-1)).toMatchObject({ level: 'debug', msg: 'Session feed unchanged' });
  });

  it('takes a newer feed and remembers its ETag', async () => {
    const { store, calls } = setup(small, (_call, number) => (number === 1 ? feedResponse(150, '"v1"') : number === 2 ? feedResponse(160, '"v2"') : notModified()));
    await store.init();
    expect(await store.refresh()).toBe('updated');
    expect(await store.refresh()).toBe('updated');
    expect(store.catalog.sessions).toHaveLength(160);
    expect(await store.refresh()).toBe('unchanged');
    expect(calls.map((call) => call.headers.get('if-none-match'))).toEqual([null, '"v1"', '"v2"']);
  });

  it('does not send a conditional request when the live feed came without an ETag', async () => {
    const { store, calls } = setup(small, () => feedResponse(150));
    await store.init();
    await store.refresh();
    await store.refresh();
    expect(calls.map((call) => call.headers.has('if-none-match'))).toEqual([false, false]);
  });

  it('still sends no conditional request after a failed first attempt', async () => {
    const { store, calls } = setup(small, (_call, number) => (number === 1 ? new Response('down', { status: 503 }) : feedResponse(150, '"v1"')));
    await store.init();
    expect(await store.refresh()).toBe('failed');
    expect(await store.refresh()).toBe('updated');
    expect(calls.map((call) => call.headers.has('if-none-match'))).toEqual([false, false]);
  });
});

describe('when the live feed cannot be used', () => {
  const unusable: [string, (call: FetchCall) => Response | Promise<Response>, string][] = [
    ['an HTTP error', () => new Response('down', { status: 500 }), 'Session feed returned HTTP 500'],
    ['an unreachable server', () => Promise.reject(new TypeError('fetch failed')), 'fetch failed'],
    ['a body that is not JSON', () => new Response('<html></html>', { status: 200 }), 'Unexpected token'],
    ['a feed that is not a list', () => jsonResponse({ sessions: [] }), 'Expected the session feed to be a JSON array'],
    ['a feed that has shrunk to almost nothing', () => feedResponse(34), 'Live feed has only 34 sessions (expected at least 100); keeping current data'],
    ['an empty feed', () => jsonResponse([]), 'Live feed has only 0 sessions (expected at least 100); keeping current data'],
  ];

  it.each(unusable)('keeps serving the snapshot after %s', async (_name, reply, message) => {
    const { store, logs } = setup(small, reply);
    await store.init();
    const catalog = store.catalog;

    expect(await store.refresh()).toBe('failed');
    expect(store.catalog).toBe(catalog);
    const status = store.status();
    expect(status.source).toBe('snapshot');
    expect(status.sessions).toBe(34);
    expect(status.dataAsOf).toBe(SNAPSHOT_TIME);
    expect(status.lastError).toContain(message);
    expect(status.lastCheckedAt).toBeDefined();
    expect(logs.at(-1)).toMatchObject({ level: 'warn', msg: 'Could not refresh the session feed' });
    expect(String(logs.at(-1)?.error)).toContain(message);
  });

  it('does not take a feed from a successful request that holds too few sessions, and says so', async () => {
    const { store } = setup(large, () => feedResponse(149, '"v1"'));
    await store.init();
    expect(await store.refresh()).toBe('failed');
    expect(store.status().lastError).toBe('Live feed has only 149 sessions (expected at least 150); keeping current data');
    expect(store.catalog.sessions).toHaveLength(300);
  });

  it('takes a feed that is exactly half the size of the current data', async () => {
    const { store } = setup(large, () => feedResponse(150, '"v1"'));
    await store.init();
    expect(await store.refresh()).toBe('updated');
    expect(store.catalog.sessions).toHaveLength(150);
  });

  it('keeps the live data it has when a later refresh fails, and recovers on its own', async () => {
    const replies = [() => feedResponse(150, '"v1"'), () => new Response('down', { status: 502 }), () => notModified(), () => feedResponse(155, '"v2"')];
    const { store, calls } = setup(small, (_call, number) => replies[number - 1]!());
    await store.init();

    expect(await store.refresh()).toBe('updated');
    expect(await store.refresh()).toBe('failed');
    expect(store.status()).toMatchObject({ source: 'live', sessions: 150, lastError: 'Session feed returned HTTP 502' });

    expect(await store.refresh()).toBe('unchanged');
    expect(store.status().lastError).toBeUndefined();
    expect(await store.refresh()).toBe('updated');
    expect(store.status()).toMatchObject({ source: 'live', sessions: 155, lastError: undefined });
    expect(calls.map((call) => call.headers.get('if-none-match'))).toEqual([null, '"v1"', '"v1"', '"v1"']);
  });

  it('clears the error as soon as a feed is loaded', async () => {
    const { store } = setup(small, (_call, number) => (number === 1 ? new Response('down', { status: 500 }) : feedResponse(150)));
    await store.init();
    await store.refresh();
    expect(store.status().lastError).toBeDefined();
    await store.refresh();
    expect(store.status().lastError).toBeUndefined();
  });

  it('shows a non-Error failure as text', async () => {
    const { store } = setup(small, () => Promise.reject('plain string'));
    await store.init();
    expect(await store.refresh()).toBe('failed');
    expect(store.status().lastError).toBe('plain string');
  });
});

describe('concurrent refreshes', () => {
  it('share a single download', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { store, calls } = setup(small, async () => {
      await gate;
      return feedResponse(150, '"v1"');
    });
    await store.init();

    const first = store.refresh();
    const second = store.refresh();
    release?.();
    expect(await Promise.all([first, second])).toEqual(['updated', 'updated']);
    expect(calls).toHaveLength(1);

    await store.refresh();
    expect(calls).toHaveLength(2);
  });

  it('start fresh after a failure', async () => {
    const { store, calls } = setup(small, (_call, number) => (number === 1 ? new Response('down', { status: 500 }) : feedResponse(150)));
    await store.init();
    expect(await store.refresh()).toBe('failed');
    expect(await store.refresh()).toBe('updated');
    expect(calls).toHaveLength(2);
  });
});

describe('refreshing in the background', () => {
  const MINUTE = 60_000;

  it('fetches once at once and then at the configured interval, until stopped', async () => {
    vi.useFakeTimers();
    const { store, calls } = setup(small, () => notModified(), { refreshIntervalMinutes: 15 });
    await store.init();

    store.startRefreshing();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(14 * MINUTE);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(calls).toHaveLength(4);

    store.stop();
    await vi.advanceTimersByTimeAsync(120 * MINUTE);
    expect(calls).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a second timer when started twice', async () => {
    vi.useFakeTimers();
    const { store, calls } = setup(small, () => notModified(), { refreshIntervalMinutes: 10 });
    await store.init();
    store.startRefreshing();
    store.startRefreshing();
    await vi.advanceTimersByTimeAsync(0);
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(calls.length - before).toBe(1);
    store.stop();
  });

  it('only fetches once at the start when the interval is 0', async () => {
    vi.useFakeTimers();
    const { store, calls } = setup(small, () => notModified(), { refreshIntervalMinutes: 0 });
    await store.init();
    store.startRefreshing();
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('survives failures and keeps trying', async () => {
    vi.useFakeTimers();
    const { store, calls } = setup(small, (_call, number) => (number < 3 ? new Response('down', { status: 500 }) : feedResponse(150, '"v1"')), { refreshIntervalMinutes: 5 });
    await store.init();
    store.startRefreshing();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(calls).toHaveLength(3);
    expect(store.status()).toMatchObject({ source: 'live', sessions: 150, lastError: undefined });
    store.stop();
  });

  it('can be stopped when it was never started', () => {
    const { store } = setup(small, () => notModified());
    expect(() => store.stop()).not.toThrow();
  });
});

describe('a realistic feed', () => {
  it('can be loaded from the official record format', async () => {
    const feed = readFeed();
    const many = Array.from({ length: 4 }, (_, copy) =>
      feed.map((record) => ({
        ...record,
        sessionCode: `${String(record.sessionCode)}X${copy}`,
        sessionId: `${String(record.sessionId)}X${copy}`,
        sessionInstanceId: `${String(record.sessionInstanceId)}X${copy}`,
      })),
    ).flat();
    const { store } = setup(small, () => jsonResponse(many));
    await store.init();
    expect(await store.refresh()).toBe('updated');
    expect(store.catalog.sessions).toHaveLength(34 * 4);
    expect(store.catalog.get('BRK217X2')).toBeDefined();
  });
});
