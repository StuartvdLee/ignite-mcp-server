import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { overviewOutput } from '../src/mcp/schemas';
import { VERSION } from '../src/version';
import { ROOT, snapshotCatalog, syntheticFeed } from './helpers';

/**
 * Runs the real entry point (src/server.ts) as a child process, the way the container runs it: configured through
 * the environment, started from the bundled snapshot, refreshed from a feed, stopped by SIGTERM.
 * The feed is always a local server, so these tests never reach the internet.
 */

interface Line {
  level?: string;
  msg?: string;
  [field: string]: unknown;
}

interface ExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ServerProcess {
  child: ChildProcess;
  /** Every line the server wrote to stdout or stderr, parsed when it is JSON. */
  lines: Line[];
  exit: Promise<ExitStatus>;
}

const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot'];
/** The store ignores a feed that is much smaller than the snapshot, so the fake feed has to be bigger than any snapshot. */
const FEED_SESSIONS = 2000;

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function parseLine(text: string): Line {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Line;
  } catch {
    // Not a log line.
  }
  return { level: 'raw', msg: text };
}

/** Starts a server on a loopback port and closes it after the test. */
async function listen(handler?: Parameters<typeof createServer>[1]): Promise<number> {
  const server = handler ? createServer(handler) : createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return (server.address() as AddressInfo).port;
}

/** A port nothing listens on. */
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Serves the same feed to every request, like the real one (with an ETag). */
async function serveFeed(feed: unknown): Promise<string> {
  const body = JSON.stringify(feed);
  const port = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', etag: '"test-feed"' });
    res.end(body);
  });
  return `http://127.0.0.1:${port}/feed.json`;
}

async function launch(env: Record<string, string>): Promise<ServerProcess> {
  const inherited = Object.fromEntries(INHERITED_ENV.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: ROOT,
    env: {
      ...inherited,
      HOST: '127.0.0.1',
      RATE_LIMIT_PER_MINUTE: '0',
      TRUST_PROXY_HOPS: '0',
      IGNITE_DATA_URL: `http://127.0.0.1:${await unusedPort()}/feed.json`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanups.push(() => void (child.exitCode === null && child.signalCode === null && child.kill('SIGKILL')));

  const lines: Line[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      const parts = (pending + chunk).split('\n');
      pending = parts.pop() ?? '';
      for (const part of parts) if (part.trim() !== '') lines.push(parseLine(part));
    });
  }
  const exit = new Promise<ExitStatus>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, lines, exit };
}

/** Waits for a log line, and fails with everything the server wrote if it exits or never logs it. */
async function logged(proc: ServerProcess, msg: string): Promise<Line> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const line = proc.lines.find((candidate) => candidate.msg === msg);
    if (line) return line;
    const output = JSON.stringify(proc.lines, null, 1);
    if (proc.child.exitCode !== null) throw new Error(`The server exited with code ${proc.child.exitCode} before it logged "${msg}": ${output}`);
    if (Date.now() > deadline) throw new Error(`The server did not log "${msg}" in time: ${output}`);
    await sleep(25);
  }
}

async function health(port: number): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  return { status: response.status, body: await response.json() };
}

/** The overview tool, called through a real MCP client. */
async function overview(port: number) {
  const client = new Client({ name: 'ignite-server-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  cleanups.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const result = await client.callTool({ name: 'get_catalog_overview', arguments: {} });
  expect(result.isError).toBeFalsy();
  const data = overviewOutput.parse(result.structuredContent);
  await client.close();
  return data;
}

/** Sends SIGTERM, expects a clean exit, and returns how long that took. */
async function terminate(proc: ServerProcess): Promise<number> {
  const sent = Date.now();
  proc.child.kill('SIGTERM');
  expect(await proc.exit).toEqual({ code: 0, signal: null });
  return Date.now() - sent;
}

describe('the server process', () => {
  it('answers from the bundled snapshot at once, switches to the live feed and stops cleanly on SIGTERM', async () => {
    const dataUrl = await serveFeed(syntheticFeed(FEED_SESSIONS));
    const port = await unusedPort();
    const proc = await launch({ PORT: String(port), IGNITE_DATA_URL: dataUrl });

    const snapshot = await snapshotCatalog();
    expect(await logged(proc, 'Loaded session snapshot')).toMatchObject({ level: 'info', sessions: snapshot.sessions.length });
    expect(await logged(proc, 'Server started')).toMatchObject({ level: 'info', version: VERSION, port, apiKey: false, allowedOrigins: 0, node: process.version });
    expect(await logged(proc, 'Loaded live session feed')).toMatchObject({ level: 'info', sessions: FEED_SESSIONS });

    expect(await health(port)).toMatchObject({ status: 200, body: { status: 'ok', version: VERSION, source: 'live', sessions: FEED_SESSIONS } });
    const data = await overview(port);
    expect(data.data.source).toBe('live');
    expect(data.sessions.total).toBe(FEED_SESSIONS);

    // The drain period is 8 seconds: a clean stop with nothing in flight must not wait for it.
    expect(await terminate(proc)).toBeLessThan(5_000);
    expect(proc.lines).toContainEqual(expect.objectContaining({ level: 'info', msg: 'Shutting down', signal: 'SIGTERM' }));
  });

  it('keeps serving the bundled snapshot when the feed cannot be reached', async () => {
    const port = await unusedPort();
    const proc = await launch({ PORT: String(port) });

    const loaded = await logged(proc, 'Loaded session snapshot');
    expect(String(loaded.path)).toMatch(/[\\/]data[\\/]sessions\.snapshot\.json$/);
    await logged(proc, 'Server started');
    expect(await logged(proc, 'Could not refresh the session feed')).toMatchObject({ level: 'warn' });

    const snapshot = await snapshotCatalog();
    expect(await health(port)).toMatchObject({
      status: 200,
      body: { status: 'ok', source: 'snapshot', sessions: snapshot.sessions.length, dataAsOf: snapshot.meta.dataAsOf },
    });
    const data = await overview(port);
    expect(data.data.source).toBe('snapshot');
    expect(data.sessions.total).toBe(snapshot.sessions.length);

    await terminate(proc);
  });

  it('refuses to start when the configuration is invalid', async () => {
    const proc = await launch({ PORT: 'abc' });

    expect(await proc.exit).toEqual({ code: 1, signal: null });
    expect(proc.lines).toContainEqual(
      expect.objectContaining({ level: 'error', msg: 'Invalid configuration: PORT must be an integer between 1 and 65535, got "abc"' }),
    );
  });

  it('exits with an error when its port is already taken', async () => {
    const taken = await listen();
    const proc = await launch({ PORT: String(taken) });

    expect(await proc.exit).toEqual({ code: 1, signal: null });
    expect(proc.lines).toContainEqual(expect.objectContaining({ level: 'error', msg: 'Failed to start', error: expect.stringContaining('EADDRINUSE') }));
  });
});
