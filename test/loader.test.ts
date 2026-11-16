import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildSnapshot, fetchFeed, loadLiveFeed, parseSnapshot, readSnapshot } from '../src/catalog/loader';
import { SNAPSHOT_SCHEMA_VERSION } from '../src/catalog/types';
import { fakeFetch, fixtureCatalog, jsonResponse, readFeed, SNAPSHOT_PATH, syntheticFeed } from './helpers';

const URL_UNDER_TEST = 'https://example.test/feed.json';

describe('downloading the feed', () => {
  it('returns the parsed feed together with its ETag', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse([{ a: 1 }], { etag: '"abc"' }));
    expect(await fetchFeed(URL_UNDER_TEST, { fetchImpl })).toEqual({ status: 'modified', feed: [{ a: 1 }], etag: '"abc"' });
  });

  it('leaves the ETag out when the server has none', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse([]));
    expect(await fetchFeed(URL_UNDER_TEST, { fetchImpl })).toEqual({ status: 'modified', feed: [] });
  });

  it('asks for JSON, follows redirects (aka.ms redirects) and identifies itself', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse([]));
    await fetchFeed(URL_UNDER_TEST, { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL_UNDER_TEST);
    expect(calls[0]?.init.redirect).toBe('follow');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.headers.get('accept')).toBe('application/json');
    expect(calls[0]?.headers.get('user-agent')).toBe('ignite-mcp-server');
    expect(calls[0]?.headers.has('if-none-match')).toBe(false);
  });

  it('sends the ETag it knows so that an unchanged feed costs almost nothing', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 304 }));
    expect(await fetchFeed(URL_UNDER_TEST, { fetchImpl, etag: '"abc"' })).toEqual({ status: 'not-modified' });
    expect(calls[0]?.headers.get('if-none-match')).toBe('"abc"');
  });

  it('fails on an HTTP error', async () => {
    for (const status of [403, 404, 500, 503]) {
      const { fetchImpl } = fakeFetch(() => new Response('nope', { status }));
      await expect(fetchFeed(URL_UNDER_TEST, { fetchImpl })).rejects.toThrow(`Session feed returned HTTP ${status}`);
    }
  });

  it('fails on a body that is not JSON', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('<html>Service unavailable</html>', { status: 200 }));
    await expect(fetchFeed(URL_UNDER_TEST, { fetchImpl })).rejects.toThrow(SyntaxError);
  });

  it('refuses a feed that is far too large, whether or not the server says so up front', async () => {
    const declared = fakeFetch(() => new Response('[]', { status: 200, headers: { 'content-length': String(65 * 1024 * 1024) } }));
    await expect(fetchFeed(URL_UNDER_TEST, { fetchImpl: declared.fetchImpl })).rejects.toThrow('Session feed is unexpectedly large');
    const undeclared = fakeFetch(() => new Response(new Uint8Array(64 * 1024 * 1024 + 1), { status: 200 }));
    await expect(fetchFeed(URL_UNDER_TEST, { fetchImpl: undeclared.fetchImpl })).rejects.toThrow('Session feed is unexpectedly large');
  });

  it('gives up when the server takes too long', async () => {
    const { fetchImpl } = fakeFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    await expect(fetchFeed(URL_UNDER_TEST, { fetchImpl, timeoutMs: 25 })).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  describe('with the global fetch', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('uses it when no fetch is given', async () => {
      const { fetchImpl, calls } = fakeFetch(() => jsonResponse([{ ok: true }]));
      vi.stubGlobal('fetch', fetchImpl);
      expect(await fetchFeed(URL_UNDER_TEST)).toEqual({ status: 'modified', feed: [{ ok: true }] });
      expect(calls).toHaveLength(1);
    });
  });
});

describe('loading the live feed', () => {
  it('turns the official records into sessions', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(readFeed(), { etag: '"v7"' }));
    const loaded = await loadLiveFeed(URL_UNDER_TEST, { fetchImpl });
    expect(loaded).not.toBe('not-modified');
    if (loaded === 'not-modified') return;
    expect(loaded.etag).toBe('"v7"');
    expect(loaded.skipped).toBe(0);
    expect(loaded.sessions.map((session) => session.code)).toEqual(fixtureCatalog().sessions.map((session) => session.code));
  });

  it('counts the records it cannot use, and has no ETag key when there is none', async () => {
    const junk = [null, 'text', 42, [], {}, { sessionCode: 'X1' }, { sessionCode: 'X2', title: 'No id' }];
    const { fetchImpl } = fakeFetch(() => jsonResponse([...syntheticFeed(3), ...junk]));
    const loaded = await loadLiveFeed(URL_UNDER_TEST, { fetchImpl });
    expect(loaded).toMatchObject({ skipped: junk.length });
    expect(loaded === 'not-modified' ? [] : loaded.sessions).toHaveLength(3);
    expect(loaded).not.toHaveProperty('etag');
  });

  it('passes on that nothing has changed', async () => {
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: 304 }));
    expect(await loadLiveFeed(URL_UNDER_TEST, { fetchImpl, etag: '"v7"' })).toBe('not-modified');
  });

  it('refuses a feed that is not a list of records', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ sessions: [] }));
    await expect(loadLiveFeed(URL_UNDER_TEST, { fetchImpl })).rejects.toThrow('Expected the session feed to be a JSON array');
  });
});

describe('snapshot files', () => {
  const sessions = fixtureCatalog().sessions;

  it('round-trips through JSON', () => {
    const snapshot = buildSnapshot(sessions, 'https://example.test/source', '2026-11-01T00:00:00.000Z');
    expect(snapshot).toMatchObject({ schemaVersion: SNAPSHOT_SCHEMA_VERSION, generatedAt: '2026-11-01T00:00:00.000Z', sourceUrl: 'https://example.test/source' });
    expect(parseSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it('is stamped with the time it was made by default', () => {
    const before = Date.now();
    const { generatedAt } = buildSnapshot(sessions, 'x');
    expect(Date.parse(generatedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(generatedAt)).toBeLessThanOrEqual(Date.now());
  });

  it('refuses a file in another format', () => {
    for (const value of [null, undefined, 'text', 42, [], {}, { sessions }, { schemaVersion: SNAPSHOT_SCHEMA_VERSION + 1, sessions }]) {
      expect(() => parseSnapshot(value)).toThrow(`Unsupported snapshot format (expected schemaVersion ${SNAPSHOT_SCHEMA_VERSION})`);
    }
  });

  it('refuses a file without sessions', () => {
    for (const list of [undefined, null, {}, 'x', []]) {
      expect(() => parseSnapshot({ schemaVersion: SNAPSHOT_SCHEMA_VERSION, sessions: list })).toThrow('Snapshot contains no sessions');
    }
  });

  it('refuses a file with a session that is not usable', () => {
    const good = sessions[0];
    for (const bad of [null, 'x', {}, { ...good, code: 7 }, { ...good, title: undefined }, { ...good, occurrences: 'later' }]) {
      expect(() => parseSnapshot({ schemaVersion: SNAPSHOT_SCHEMA_VERSION, sessions: [good, bad] })).toThrow('Snapshot contains a malformed session');
    }
  });
});

describe('reading a snapshot from disk', () => {
  let directory: string;
  let good: string;
  let broken: string;
  let wrongFormat: string;
  const missing = (name: string) => join(directory, name);

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'ignite-loader-'));
    good = missing('good.json');
    broken = missing('broken.json');
    wrongFormat = missing('wrong.json');
    writeFileSync(good, JSON.stringify(buildSnapshot(fixtureCatalog().sessions, 'x', '2026-11-01T00:00:00.000Z')));
    writeFileSync(broken, '{ "schemaVersion": 1, "sessions": [');
    writeFileSync(wrongFormat, JSON.stringify({ schemaVersion: 99, sessions: [] }));
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it('reads the first file that is usable and says which one that was', async () => {
    const result = await readSnapshot([missing('nope.json'), broken, wrongFormat, good, SNAPSHOT_PATH]);
    expect(result.path).toBe(good);
    expect(result.snapshot.sessions).toHaveLength(34);
  });

  it('reads the bundled snapshot of the whole event', async () => {
    const { snapshot, path } = await readSnapshot([SNAPSHOT_PATH]);
    expect(path).toBe(SNAPSHOT_PATH);
    expect(snapshot.sessions.length).toBeGreaterThan(1000);
  });

  it('explains what was wrong with every candidate when none works', async () => {
    const message = await readSnapshot([missing('nope.json'), broken, wrongFormat]).then(
      () => 'it did not fail',
      (caught: Error) => caught.message,
    );
    expect(message).toMatch(/^No usable session snapshot found \(/);
    expect(message).toContain(`${missing('nope.json')}: ENOENT`);
    expect(message).toContain(`${broken}: `);
    expect(message).toContain(`${wrongFormat}: Unsupported snapshot format`);
  });

  it('fails without candidates', async () => {
    await expect(readSnapshot([])).rejects.toThrow('No usable session snapshot found');
  });
});
