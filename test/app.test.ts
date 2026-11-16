import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Catalog } from '../src/catalog/catalog';
import { VERSION } from '../src/version';
import { FakeStore, INITIALIZE, startApp } from './harness';
import type { RunningApp, StartOptions, TestResponse } from './harness';
import { META, fixtureCatalog, icsLines } from './helpers';

// Facts about test/fixtures/feed.json that these tests rely on (times are Pacific Time):
// - BRK217 has one slot, Thu Nov 19 16:00-16:45 at Moscone West (slot id BRK217@2026-11-19T16:00).
// - BRK323 and THRSP1050 overlap on Tue Nov 17; KEY01 is the opening keynote at Chase Center.
// - LAB711D is an on demand Digital Lab: it has no time that fits in a calendar.
// The app's clock starts on Wednesday 2026-11-18 at 08:00 Pacific, which is 16:00 UTC.

const KEY = 'correct-horse-battery-staple';
const ORIGIN = 'https://app.example.com';
const CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const running: RunningApp[] = [];

async function start(options?: StartOptions): Promise<RunningApp> {
  const app = await startApp(options);
  running.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.stop()));
});

/** The headers of a browser or client that talks to `/mcp`. */
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

function expectRpcError(response: TestResponse, status: number, message: string | RegExp, code = -32000): void {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/json/);
  expect(response.json()).toEqual({ jsonrpc: '2.0', error: { code, message: typeof message === 'string' ? message : expect.stringMatching(message) }, id: null });
}

/** The JSON-RPC message of a server-sent-events body. */
function sseMessage(response: TestResponse): { result?: Record<string, any>; error?: Record<string, any> } {
  const line = response.body.split('\n').find((candidate) => candidate.startsWith('data: '));
  if (!line) throw new Error(`No data line in ${response.body.slice(0, 200)}`);
  return JSON.parse(line.slice('data: '.length));
}

const requests = (app: RunningApp) => app.logs.filter((line) => line.msg === 'Request');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('health check', () => {
  it('reports the version, the data source and how fresh the data is', async () => {
    const app = await start();
    const response = await app.get('/healthz');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ status: 'ok', version: VERSION, source: 'live', sessions: 34, dataAsOf: META.dataAsOf });
  });

  it('says when it is still serving the bundled snapshot', async () => {
    const snapshot = new Catalog(fixtureCatalog().sessions, { source: 'snapshot', sourceUrl: META.sourceUrl, dataAsOf: '2026-11-16T04:59:16.356Z' });
    const app = await start({ store: new FakeStore(snapshot) });
    expect((await app.get('/healthz')).json()).toMatchObject({ status: 'ok', source: 'snapshot', dataAsOf: '2026-11-16T04:59:16.356Z' });
  });

  it('says that it is starting, with a 503, while the catalog is not loaded', async () => {
    const app = await start();
    app.store.ready = false;
    const response = await app.get('/healthz');
    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ status: 'starting' });
  });

  it('answers probes whatever Host they send, however often they come and without a key', async () => {
    const app = await start({ config: { rateLimitPerMinute: 1, apiKey: KEY } });
    for (let probe = 0; probe < 5; probe++) {
      expect((await app.get('/healthz', { host: 'internal-probe.invalid' })).status).toBe(200);
    }
  });

  it('answers HEAD without a body and refuses other methods', async () => {
    const app = await start();
    const head = await app.send('HEAD', '/healthz');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');

    const post = await app.send('POST', '/healthz');
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
    expect(post.json()).toEqual({ error: 'Method not allowed.' });
  });
});

describe('landing page', () => {
  it('is a locked down HTML page that says how to connect', async () => {
    const app = await start();
    const response = await app.get('/');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['content-security-policy']).toBe(CSP);
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.body).toContain(`${app.url}/mcp`);
    expect(response.body).toContain('34 sessions');
    expect(response.body).not.toContain('needs an API key');
  });

  it('prefers the configured public address', async () => {
    const app = await start({ config: { publicBaseUrl: 'https://ignite.example.test' } });
    const response = await app.get('/', { host: 'evil.example' });
    expect(response.status).toBe(200);
    expect(response.body).toContain('https://ignite.example.test/mcp');
    expect(response.body).not.toContain('evil.example');
  });

  it('never repeats a Host header that is not on the allow list', async () => {
    const app = await start();
    const response = await app.get('/', { host: 'evil.example' });
    expect(response.status).toBe(200);
    expect(response.body).toContain(`http://localhost:${app.config.port}/mcp`);
    expect(response.body).not.toContain('evil.example');
  });

  it('uses https when the proxy in front says so', async () => {
    const app = await start({ config: { trustProxyHops: 1 } });
    const response = await app.get('/', { 'x-forwarded-proto': 'https', host: 'localhost' });
    expect(response.body).toContain('https://localhost/mcp');
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
  });

  it('does not trust forwarded headers when no proxy is configured', async () => {
    const app = await start({ config: { trustProxyHops: 0 } });
    const response = await app.get('/', { 'x-forwarded-proto': 'https', host: 'localhost' });
    expect(response.body).toContain('http://localhost/mcp');
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });

  it('says that a key is needed when there is one, without revealing it', async () => {
    const app = await start({ config: { apiKey: KEY } });
    const response = await app.get('/');
    expect(response.status).toBe(200);
    expect(response.body).toContain('needs an API key');
    expect(response.body).toContain('Bearer &lt;your key&gt;');
    expect(response.body).not.toContain(KEY);
  });

  it('says that the catalog is loading before it is', async () => {
    const app = await start();
    app.store.ready = false;
    expect((await app.get('/')).body).toContain('The session catalog is loading.');
  });

  it('answers HEAD, refuses other methods and has an empty favicon', async () => {
    const app = await start();
    expect((await app.send('HEAD', '/')).body).toBe('');
    const post = await app.send('POST', '/');
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');

    const favicon = await app.get('/favicon.ico');
    expect(favicon.status).toBe(204);
    expect(favicon.body).toBe('');
  });
});

describe('calendar download', () => {
  it('serves an .ics file for the sessions in the link', async () => {
    const app = await start();
    const response = await app.get('/calendar.ics?sessions=BRK217');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(response.headers['content-disposition']).toBe('attachment; filename="ignite-2026-BRK217.ics"');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.endsWith('\r\n')).toBe(true);

    const lines = icsLines(response.body);
    expect(lines).toContain('BEGIN:VCALENDAR');
    expect(lines).toContain('SUMMARY:BRK217: Real-World AI Transformation with Copilot in SharePoint');
    // Thu 16:00 Pacific is Fri 00:00 UTC; the stamp is the app's clock (Wed 08:00 Pacific).
    expect(lines).toContain('DTSTART:20261120T000000Z');
    expect(lines).toContain('DTEND:20261120T004500Z');
    expect(lines).toContain('DTSTAMP:20261118T160000Z');
    expect(lines).not.toContain('BEGIN:VALARM');
  });

  it('takes slot ids, several parameters and comma separated lists', async () => {
    const app = await start();
    const response = await app.get('/calendar.ics?sessions=BRK217@2026-11-19T16:00&sessions=BRK323,%20KEY01,&sessions=BRK217');
    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toBe('attachment; filename="ignite-2026-agenda.ics"');
    const summaries = icsLines(response.body).filter((line) => line.startsWith('SUMMARY:'));
    expect(summaries.map((line) => line.slice('SUMMARY:'.length).split(':')[0])).toEqual(['KEY01', 'BRK323', 'BRK217']);
  });

  it('applies the name and the reminder', async () => {
    const app = await start();
    const response = await app.get('/calendar.ics?sessions=BRK217&name=My%20Ignite&reminder=10');
    const lines = icsLines(response.body);
    expect(lines).toContain('X-WR-CALNAME:My Ignite');
    expect(lines).toContain('TRIGGER:-PT10M');
  });

  it('answers HEAD with the headers only', async () => {
    const app = await start();
    const head = await app.send('HEAD', '/calendar.ics?sessions=BRK217');
    expect(head.status).toBe(200);
    expect(head.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(head.body).toBe('');
  });

  it('cannot be used to inject headers or calendar lines', async () => {
    const app = await start();
    const named = await app.get('/calendar.ics?sessions=BRK217&name=Evil%0D%0AX-Injected%3A%201');
    expect(named.status).toBe(200);
    expect(named.headers['x-injected']).toBeUndefined();
    expect(named.headers['content-disposition']).toBe('attachment; filename="ignite-2026-BRK217.ics"');
    expect(icsLines(named.body).some((line) => line.startsWith('X-Injected'))).toBe(false);

    const referenced = await app.get('/calendar.ics?sessions=BRK217%0D%0ASet-Cookie%3A%20a%3Db');
    expect(referenced.status).toBe(404);
    expect(referenced.headers['set-cookie']).toBeUndefined();
  });

  it.each([
    ['no sessions', '/calendar.ics', 'Pass the sessions to include as ?sessions=BRK217,LAB650@2026-11-18T14:00'],
    ['empty sessions', '/calendar.ics?sessions=,%20,', 'Pass the sessions to include as ?sessions=BRK217,LAB650@2026-11-18T14:00'],
    ['too many sessions', `/calendar.ics?sessions=${Array.from({ length: 51 }, (_, index) => `BRK${index}`).join(',')}`, 'At most 50 sessions fit in one calendar file.'],
    ['a reference that is too long', `/calendar.ics?sessions=${'A'.repeat(81)}`, 'Session references are at most 80 characters long.'],
    ['a name that is too long', `/calendar.ics?sessions=BRK217&name=${'n'.repeat(81)}`, 'The calendar name is at most 80 characters long.'],
    ['a reminder that is not a number', '/calendar.ics?sessions=BRK217&reminder=soon', 'reminder must be a whole number of minutes between 0 and 1440.'],
    ['a reminder that is too long', '/calendar.ics?sessions=BRK217&reminder=1441', 'reminder must be a whole number of minutes between 0 and 1440.'],
    ['a negative reminder', '/calendar.ics?sessions=BRK217&reminder=-5', 'reminder must be a whole number of minutes between 0 and 1440.'],
  ])('refuses %s with a 400', async (_label, path, message) => {
    const app = await start();
    const response = await app.get(path);
    expect(response.status).toBe(400);
    expect(response.json()).toEqual({ error: message });
  });

  it('accepts the limits themselves', async () => {
    const app = await start();
    const fifty = Array.from({ length: 50 }, (_, index) => `NOPE${index}`).join(',');
    // None of them exists, so this is a 404, but the request itself is valid.
    expect((await app.get(`/calendar.ics?sessions=${fifty}`)).status).toBe(404);
    expect((await app.get(`/calendar.ics?sessions=BRK217&name=${'n'.repeat(80)}&reminder=1440`)).status).toBe(200);
    expect((await app.get('/calendar.ics?sessions=BRK217&reminder=0')).status).toBe(200);
  });

  it('answers 404 with the reasons when nothing can go into the calendar', async () => {
    const app = await start();
    const response = await app.get('/calendar.ics?sessions=NOPE999,LAB711D');
    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json()).toEqual({
      error: 'None of these sessions has a fixed time that can be added to a calendar.',
      unresolved: [{ ref: 'NOPE999', reason: expect.stringContaining('No session has that code or id') }],
      onDemand: ['LAB711D'],
    });
  });

  it('keeps the sessions that exist when others do not', async () => {
    const app = await start();
    const response = await app.get('/calendar.ics?sessions=BRK217,NOPE999,LAB711D');
    expect(response.status).toBe(200);
    expect(icsLines(response.body).filter((line) => line.startsWith('SUMMARY:'))).toHaveLength(1);
  });

  it('tolerates malformed percent-encoding', async () => {
    const app = await start();
    const response = await app.get('/calendar.ics?sessions=%E0%A4%A');
    expect(response.status).toBe(404);
    expect(response.json<{ unresolved: unknown[] }>().unresolved).toHaveLength(1);
  });

  it('waits for the catalog, but still validates the request first', async () => {
    const app = await start();
    app.store.ready = false;
    const loading = await app.get('/calendar.ics?sessions=BRK217');
    expect(loading.status).toBe(503);
    expect(loading.json()).toEqual({ error: 'The session catalog is still loading.' });
    expect((await app.get('/calendar.ics')).status).toBe(400);
  });

  it('refuses other methods', async () => {
    const app = await start();
    const response = await app.send('POST', '/calendar.ics?sessions=BRK217');
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('GET, HEAD');
  });
});

describe('rate limiting', () => {
  it('turns requests away once the quota of the minute is used', async () => {
    const app = await start({ config: { rateLimitPerMinute: 2 } });
    expect((await app.rpc(INITIALIZE)).status).toBe(200);
    expect((await app.rpc(INITIALIZE)).status).toBe(200);

    const denied = await app.rpc(INITIALIZE);
    expectRpcError(denied, 429, 'Too many requests. Try again in 60 seconds.');
    expect(denied.headers['retry-after']).toBe('60');
    expect(denied.headers['cache-control']).toBeUndefined();
  });

  it('counts down and lets requests in again when the minute is over', async () => {
    const app = await start({ config: { rateLimitPerMinute: 1 } });
    expect((await app.rpc(INITIALIZE)).status).toBe(200);

    app.advance(20_000);
    const denied = await app.rpc(INITIALIZE);
    expectRpcError(denied, 429, 'Too many requests. Try again in 40 seconds.');
    expect(denied.headers['retry-after']).toBe('40');

    app.advance(40_000);
    expect((await app.rpc(INITIALIZE)).status).toBe(200);
  });

  it('answers calendar downloads in plain JSON and shares the quota with /mcp', async () => {
    const app = await start({ config: { rateLimitPerMinute: 2 } });
    expect((await app.rpc(INITIALIZE)).status).toBe(200);
    expect((await app.get('/calendar.ics?sessions=BRK217')).status).toBe(200);

    const denied = await app.get('/calendar.ics?sessions=BRK217');
    expect(denied.status).toBe(429);
    expect(denied.headers['retry-after']).toBe('60');
    expect(denied.json()).toEqual({ error: 'Too many requests. Try again in 60 seconds.' });
    expect((await app.rpc(INITIALIZE)).status).toBe(429);
  });

  it('leaves the health check, the landing page and the favicon alone', async () => {
    const app = await start({ config: { rateLimitPerMinute: 1 } });
    expect((await app.rpc(INITIALIZE)).status).toBe(200);
    expect((await app.rpc(INITIALIZE)).status).toBe(429);
    for (const path of ['/healthz', '/', '/favicon.ico']) {
      expect((await app.get(path)).status, path).not.toBe(429);
    }
  });

  it('is switched off by a limit of 0', async () => {
    const app = await start({ config: { rateLimitPerMinute: 0 } });
    for (let call = 0; call < 25; call++) expect((await app.get('/calendar.ics?sessions=BRK217')).status).toBe(200);
  });

  it('keeps a quota for every client address that the proxy reports', async () => {
    const app = await start({ config: { rateLimitPerMinute: 1, trustProxyHops: 1 } });
    const from = (address: string) => app.rpc(INITIALIZE, { 'x-forwarded-for': address });
    expect((await from('203.0.113.1')).status).toBe(200);
    expect((await from('203.0.113.1')).status).toBe(429);
    expect((await from('203.0.113.2')).status).toBe(200);
  });

  it('only believes the address that the trusted proxy added', async () => {
    const app = await start({ config: { rateLimitPerMinute: 1, trustProxyHops: 1 } });
    expect((await app.rpc(INITIALIZE, { 'x-forwarded-for': '10.0.0.1, 203.0.113.9' })).status).toBe(200);
    // A client cannot get a fresh quota by inventing the left side of the header.
    expect((await app.rpc(INITIALIZE, { 'x-forwarded-for': '10.0.0.2, 203.0.113.9' })).status).toBe(429);
  });

  it('ignores forwarded addresses when there is no proxy', async () => {
    const app = await start({ config: { rateLimitPerMinute: 1, trustProxyHops: 0 } });
    expect((await app.rpc(INITIALIZE, { 'x-forwarded-for': '203.0.113.1' })).status).toBe(200);
    expect((await app.rpc(INITIALIZE, { 'x-forwarded-for': '203.0.113.2' })).status).toBe(429);
  });

  it('warns once per window, not for every request that is turned away', async () => {
    const app = await start({ config: { rateLimitPerMinute: 1 } });
    for (let call = 0; call < 6; call++) await app.rpc(INITIALIZE);
    const warnings = app.logs.filter((line) => line.msg === 'Rate limit exceeded');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: 'warn', path: '/mcp' });
    expect(requests(app).filter((line) => line.status === 429)).toHaveLength(5);

    app.advance(60_000);
    await app.rpc(INITIALIZE);
    await app.rpc(INITIALIZE);
    expect(app.logs.filter((line) => line.msg === 'Rate limit exceeded')).toHaveLength(2);
  });
});

describe('API key', () => {
  const noKey = {};
  const wrongKey = { authorization: 'Bearer not-the-key' };
  const wrongScheme = { authorization: `Basic ${KEY}` };
  const keyWithoutScheme = { authorization: KEY };
  const rightKey = { authorization: `Bearer ${KEY}` };

  it.each([
    ['without a key', noKey],
    ['with another key', wrongKey],
    ['with another scheme', wrongScheme],
    ['with a key and no scheme', keyWithoutScheme],
  ])('turns away /mcp %s', async (_label, headers) => {
    const app = await start({ config: { apiKey: KEY } });
    const response = await app.rpc(INITIALIZE, headers);
    expectRpcError(response, 401, 'Missing or invalid API key. Send it as "Authorization: Bearer <key>".');
    expect(response.headers['www-authenticate']).toBe('Bearer realm="ignite-mcp"');
  });

  it('lets a client with the key in', async () => {
    const app = await start({ config: { apiKey: KEY } });
    expect((await app.rpc(INITIALIZE, rightKey)).status).toBe(200);
    expect((await app.rpc(INITIALIZE, { authorization: `bearer   ${KEY}  ` })).status).toBe(200);
  });

  it('works with a real MCP client that sends the key, and not without it', async () => {
    const app = await start({ config: { apiKey: KEY } });
    await expect(app.connect()).rejects.toThrow();
    const client = await app.connect(rightKey);
    expect((await client.listTools()).tools).toHaveLength(8);
  });

  it('protects the calendar download in the same way', async () => {
    const app = await start({ config: { apiKey: KEY } });
    const refused = await app.get('/calendar.ics?sessions=BRK217');
    expect(refused.status).toBe(401);
    expect(refused.headers['www-authenticate']).toBe('Bearer realm="ignite-mcp"');
    expect(refused.json()).toEqual({ error: 'Missing or invalid API key. Send it as "Authorization: Bearer <key>".' });

    expect((await app.get('/calendar.ics?sessions=BRK217', rightKey)).status).toBe(200);
  });

  it('keeps the health check and the landing page open', async () => {
    const app = await start({ config: { apiKey: KEY } });
    expect((await app.get('/healthz')).status).toBe(200);
    expect((await app.get('/')).status).toBe(200);
  });

  it('counts failed attempts against the quota, which is what slows down guessing', async () => {
    const app = await start({ config: { apiKey: KEY, rateLimitPerMinute: 2 } });
    expect((await app.rpc(INITIALIZE, wrongKey)).status).toBe(401);
    expect((await app.rpc(INITIALIZE, wrongKey)).status).toBe(401);
    expect((await app.rpc(INITIALIZE, rightKey)).status).toBe(429);
  });

  it('never writes the key, or what clients sent as the key, to the log', async () => {
    const app = await start({ config: { apiKey: KEY } });
    await app.rpc(INITIALIZE, { authorization: 'Bearer guess-number-one' });
    await app.rpc(INITIALIZE, rightKey);
    await app.get('/calendar.ics?sessions=BRK217', rightKey);

    const log = JSON.stringify(app.logs);
    expect(log).not.toContain(KEY);
    expect(log).not.toContain('guess-number-one');
    expect(requests(app).map((line) => line.status)).toEqual([401, 200, 200]);
  });

  it('does not hand out calendar links that could not be opened without the key', async () => {
    const withKey = await start({ config: { apiKey: KEY, publicBaseUrl: 'https://ignite.example.test' } });
    const keyed = await withKey.connect(rightKey);
    const inline = await keyed.callTool({ name: 'export_calendar', arguments: { items: ['BRK217'] } });
    expect(inline.structuredContent).not.toHaveProperty('downloadUrl');
    expect(inline.structuredContent).toHaveProperty('ics');

    const open = await start({ config: { publicBaseUrl: 'https://ignite.example.test' } });
    const client = await open.connect();
    const linked = await client.callTool({ name: 'export_calendar', arguments: { items: ['BRK217'] } });
    expect(linked.structuredContent).toHaveProperty('downloadUrl', 'https://ignite.example.test/calendar.ics?sessions=BRK217%402026-11-19T16%3A00');
  });
});

describe('host and origin checks', () => {
  it('refuses a Host that is not on the allow list', async () => {
    const app = await start();
    const response = await app.rpc(INITIALIZE, { host: 'evil.example' });
    expectRpcError(response, 403, 'Invalid Host: evil.example');
  });

  it('refuses it before the key or the quota are looked at', async () => {
    const app = await start({ config: { apiKey: KEY, rateLimitPerMinute: 1 } });
    expect((await app.rpc(INITIALIZE, { host: 'evil.example' })).status).toBe(403);
    expect((await app.rpc(INITIALIZE, { host: 'evil.example' })).status).toBe(403);
    // Neither request used the only request of the quota.
    expect((await app.rpc(INITIALIZE, { authorization: `Bearer ${KEY}` })).status).toBe(200);
  });

  it('accepts the hosts that were configured, with or without a port', async () => {
    const app = await start({ config: { allowedHosts: ['localhost', '127.0.0.1', 'ignite.example.test'] } });
    for (const host of ['localhost:3000', 'localhost', '127.0.0.1:8080', 'ignite.example.test']) {
      expect((await app.rpc(INITIALIZE, { host })).status, host).toBe(200);
    }
    expectRpcError(await app.rpc(INITIALIZE, { host: 'other.example.test' }), 403, 'Invalid Host: other.example.test');
  });

  it('refuses a browser that comes from another site', async () => {
    const app = await start();
    const response = await app.rpc(INITIALIZE, { origin: 'https://evil.example' });
    expectRpcError(response, 403, 'Invalid Origin: evil.example');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses the preflight of such a browser too', async () => {
    const app = await start({ config: { allowedOrigins: [ORIGIN] } });
    const response = await app.send('OPTIONS', '/mcp', {
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expectRpcError(response, 403, 'Invalid Origin: evil.example');
  });

  it('lets clients without an Origin header in, which is every client that is not a browser', async () => {
    const app = await start();
    expect((await app.rpc(INITIALIZE)).status).toBe(200);
  });

  it('lets a page on a local host in, but does not give it CORS headers', async () => {
    const app = await start({ config: { allowedOrigins: [ORIGIN] } });
    const response = await app.rpc(INITIALIZE, { origin: 'http://localhost:5173' });
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CORS', () => {
  it('lets the browsers of an allowed origin read the response', async () => {
    const app = await start({ config: { allowedOrigins: [ORIGIN] } });
    const response = await app.rpc(INITIALIZE, { origin: ORIGIN });
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(response.headers['access-control-expose-headers']).toBe('Mcp-Session-Id, Mcp-Protocol-Version, Retry-After, WWW-Authenticate');
    expect(response.headers.vary).toMatch(/\bOrigin\b/);
  });

  it('answers the preflight and repeats the headers that the browser asks for', async () => {
    const app = await start({ config: { allowedOrigins: [ORIGIN] } });
    const response = await app.send('OPTIONS', '/mcp', {
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, mcp-protocol-version, mcp-method',
      },
    });
    expect(response.status).toBe(204);
    expect(response.body).toBe('');
    expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(response.headers['access-control-allow-methods']).toBe('GET, POST, DELETE, OPTIONS');
    expect(response.headers['access-control-allow-headers']).toBe('content-type, mcp-protocol-version, mcp-method');
    expect(response.headers['access-control-max-age']).toBe('600');
  });

  it.each([
    ['contain characters that are not allowed in a header name', 'content-type, x bad!'],
    ['are very long', `x-${'a'.repeat(600)}`],
  ])('falls back to the usual list when the requested headers %s', async (_label, requested) => {
    const app = await start({ config: { allowedOrigins: [ORIGIN] } });
    const response = await app.send('OPTIONS', '/mcp', {
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': requested },
    });
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-headers']).toBe(
      'Content-Type, Accept, Authorization, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID',
    );
  });

  it('adds nothing for a request without an Origin, except that the answer depends on it', async () => {
    const app = await start({ config: { allowedOrigins: [ORIGIN] } });
    const response = await app.rpc(INITIALIZE);
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers.vary).toMatch(/\bOrigin\b/);
  });

  it('is off without allowed origins', async () => {
    const app = await start();
    const response = await app.rpc(INITIALIZE, { origin: 'http://localhost:5173' });
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers.vary).toBeUndefined();
  });

  it('puts the CORS headers on a refusal too, so that the browser can show why', async () => {
    const app = await start({ config: { allowedOrigins: [ORIGIN], apiKey: KEY } });
    const refused = await app.rpc(INITIALIZE, { origin: ORIGIN });
    expect(refused.status).toBe(401);
    expect(refused.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(refused.headers['access-control-expose-headers']).toContain('WWW-Authenticate');
  });
});

describe('routing and malformed requests', () => {
  it('answers an unknown path with a JSON 404', async () => {
    const app = await start();
    for (const path of ['/nope', '/mcp/extra', '/healthz/extra', '/%E0%A4%A']) {
      const response = await app.get(path);
      expect(response.status, path).toBe(404);
      expect(response.json(), path).toEqual({ error: 'Not found.' });
    }
  });

  it('ignores a trailing slash, so that a client configured with /mcp/ still works', async () => {
    const app = await start();
    expect((await app.get('/healthz/')).status).toBe(200);
    expect((await app.rpc(INITIALIZE)).status).toBe(200);
    const slash = await app.send('POST', '/mcp/', { headers: MCP_HEADERS, body: JSON.stringify(INITIALIZE) });
    expect(slash.status).toBe(200);
  });

  it.each(['GET', 'DELETE', 'OPTIONS'])('only accepts POST on /mcp, not %s', async (method) => {
    const app = await start();
    const response = await app.send(method, '/mcp');
    expectRpcError(response, 405, 'Method not allowed.');
    expect(response.headers.allow).toBe('POST');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('refuses a body that is not JSON', async () => {
    const app = await start();
    const response = await app.send('POST', '/mcp', { headers: MCP_HEADERS, body: '{"jsonrpc": ' });
    expectRpcError(response, 400, 'Parse error: Invalid JSON', -32700);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('refuses a body that is larger than 128 KiB', async () => {
    const app = await start();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { padding: 'x'.repeat(128 * 1024) } });
    const response = await app.send('POST', '/mcp', { headers: { ...MCP_HEADERS, 'content-length': String(Buffer.byteLength(body)) }, body });
    expectRpcError(response, 413, /^Payload Too Large: .*131072 bytes$/);
  });

  it('answers a call without a session, so that any replica can serve it', async () => {
    const app = await start();
    const initialized = await app.rpc(INITIALIZE);
    expect(initialized.status).toBe(200);
    expect(initialized.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(initialized.headers['mcp-session-id']).toBeUndefined();
    expect(sseMessage(initialized).result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'ignite-mcp-server', title: 'Microsoft Ignite 2026', version: VERSION },
      capabilities: { tools: {}, resources: {}, prompts: {}, completions: {} },
    });

    // No initialize, no session id: a replica that has never seen this client still answers.
    const listed = await app.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' });
    expect(listed.status).toBe(200);
    expect(listed.headers['mcp-session-id']).toBeUndefined();
    expect(sseMessage(listed).result?.tools).toHaveLength(8);
  });

  it('sets the safe headers on every response', async () => {
    const app = await start();
    for (const response of [await app.get('/healthz'), await app.get('/nope'), await app.rpc(INITIALIZE), await app.get('/calendar.ics?sessions=BRK217')]) {
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['x-powered-by']).toBeUndefined();
    }
  });
});

describe('logging', () => {
  it('writes one line per request, without queries, bodies or addresses', async () => {
    const app = await start();
    await app.get('/calendar.ics?sessions=BRK217&name=secret-calendar-name');
    await app.get('/nope');
    await app.rpc(INITIALIZE);

    const lines = requests(app);
    expect(lines.map(({ level, method, path, status }) => ({ level, method, path, status }))).toEqual([
      { level: 'info', method: 'GET', path: '/calendar.ics', status: 200 },
      { level: 'info', method: 'GET', path: '/nope', status: 404 },
      { level: 'info', method: 'POST', path: '/mcp', status: 200 },
    ]);
    for (const line of lines) {
      expect(typeof line.ms).toBe('number');
      expect(Object.keys(line).sort()).toEqual(['level', 'method', 'ms', 'msg', 'path', 'status', 'time']);
    }
    const log = JSON.stringify(app.logs);
    expect(log).not.toContain('secret-calendar-name');
    expect(log).not.toContain('127.0.0.1');
  });

  it('keeps probes out of the log unless debugging', async () => {
    const quiet = await start({ level: 'info' });
    await quiet.get('/healthz');
    await quiet.get('/nope');
    expect(requests(quiet).map((line) => line.path)).toEqual(['/nope']);

    const verbose = await start({ level: 'debug' });
    await verbose.get('/healthz');
    expect(requests(verbose)).toMatchObject([{ level: 'debug', path: '/healthz', status: 200 }]);
  });

  it('shortens very long paths', async () => {
    const app = await start();
    await app.get(`/${'a'.repeat(300)}`);
    const [line] = requests(app);
    expect(line?.path).toBe(`/${'a'.repeat(119)}…`);
  });

  it('marks requests that the client abandoned', async () => {
    const app = await start();
    const port = Number(new URL(app.url).port);
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    // Announce a body and send only a part of it, then hang up.
    socket.write(
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 1000\r\n\r\n{"jsonrpc"`,
    );
    await sleep(50);
    socket.destroy();

    await vi.waitFor(() => expect(requests(app).some((line) => line.aborted === true)).toBe(true));
    expect(requests(app).filter((line) => line.aborted !== true)).toEqual([]);
  });

  it('never writes what people asked for to the log', async () => {
    const app = await start();
    const client = await app.connect();
    await client.callTool({ name: 'search_sessions', arguments: { query: 'my-private-research-topic' } });
    await client.callTool({ name: 'get_session', arguments: { code: 'PRIVATE-CODE-123' } });
    await client.callTool({ name: 'recommend_sessions', arguments: { interests: ['my-secret-interest'] } });

    expect(app.logs.filter((line) => line.msg === 'Tool call').map((line) => line.tool)).toEqual(['search_sessions', 'get_session', 'recommend_sessions']);
    const log = JSON.stringify(app.logs);
    for (const secret of ['my-private-research-topic', 'PRIVATE-CODE-123', 'my-secret-interest']) expect(log).not.toContain(secret);
  });
});

describe('errors', () => {
  it('answers an unexpected failure with a generic 500 and logs the cause', async () => {
    const app = await start();
    app.store.failure = new Error('database password is hunter2');
    const response = await app.get('/calendar.ics?sessions=BRK217');
    expect(response.status).toBe(500);
    expect(response.json()).toEqual({ error: 'Internal server error.' });
    expect(response.body).not.toContain('hunter2');

    expect(app.logs.filter((line) => line.level === 'error')).toMatchObject([
      { msg: 'Unhandled error', path: '/calendar.ics', error: 'database password is hunter2', errorName: 'Error' },
    ]);
    expect(requests(app)).toMatchObject([{ status: 500 }]);
  });

  it('answers a client error that a parser tagged with 400, without detail', async () => {
    const app = await start();
    app.store.failure = Object.assign(new Error('request entity too large: 12 GB'), { status: 413 });
    const response = await app.get('/calendar.ics?sessions=BRK217');
    expect(response.status).toBe(413);
    expect(response.json()).toEqual({ error: 'Bad request.' });
    expect(app.logs.filter((line) => line.level === 'error')).toEqual([]);
  });

  it('keeps a failing tool call from leaking the cause and tells the model to try again', async () => {
    const app = await start();
    const client = await app.connect();
    app.store.failure = new Error('connection string with a password');
    const result = await client.callTool({ name: 'search_sessions', arguments: { query: 'agents' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('password');
    expect(result.content).toEqual([{ type: 'text', text: 'Something went wrong while running this tool. Please try again.' }]);
    expect(app.logs.filter((line) => line.msg === 'Tool call')).toMatchObject([{ tool: 'search_sessions', isError: true }]);
  });
});

describe('MCP over HTTP', () => {
  it('serves every tool to a real client', async () => {
    const app = await start();
    const client = await app.connect();
    expect(client.getServerVersion()).toMatchObject({ name: 'ignite-mcp-server', version: VERSION });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'search_sessions',
      'get_session',
      'recommend_sessions',
      'whats_on',
      'build_agenda',
      'check_schedule_conflicts',
      'export_calendar',
      'get_catalog_overview',
    ]);

    const found = await client.callTool({ name: 'get_session', arguments: { code: 'brk217' } });
    expect(found.isError).toBeFalsy();
    expect(found.structuredContent).toMatchObject({ code: 'BRK217', title: 'Real-World AI Transformation with Copilot in SharePoint' });
  });

  it('serves several clients at the same time', async () => {
    const app = await start();
    const clients = await Promise.all([app.connect(), app.connect(), app.connect()]);
    const results = await Promise.all(clients.map((client, index) => client.callTool({ name: 'search_sessions', arguments: { query: 'MCP', limit: index + 1 } })));
    expect(results.map((result) => (result.structuredContent as { returned: number }).returned)).toEqual([1, 2, 3]);
  });

  it('keeps the SDK notice about JSON responses out of the console and in the structured log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const app = await start();
      expect(warn).not.toHaveBeenCalled();
      expect(app.logs.find((line) => line.msg === 'MCP SDK notice')).toMatchObject({ level: 'debug', message: expect.stringContaining("responseMode: 'json'") });
      expect(console.warn).toBe(warn);
    } finally {
      warn.mockRestore();
    }
  });

  it('hands out download links that give the file of the export_calendar tool', async () => {
    const app = await start({ config: { publicBaseUrl: 'https://ignite.example.test' } });
    const client = await app.connect();
    const exported = await client.callTool({ name: 'export_calendar', arguments: { items: ['BRK217', 'KEY01'], reminderMinutes: 15, calendarName: 'My Ignite' } });
    const { downloadUrl, ics } = exported.structuredContent as { downloadUrl: string; ics: string };

    const link = new URL(downloadUrl);
    expect(link.origin).toBe('https://ignite.example.test');
    const downloaded = await app.get(`${link.pathname}${link.search}`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.body).toBe(ics);
  });
});
