import { request } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/app';
import type { CatalogSource } from '../src/app';
import type { Catalog } from '../src/catalog/catalog';
import type { StoreStatus } from '../src/catalog/store';
import { loadConfig } from '../src/config';
import type { Config } from '../src/config';
import { createLogger } from '../src/log';
import type { LogLevel } from '../src/log';
import { fixtureCatalog, pacific } from './helpers';

export interface LogLine {
  level: string;
  msg: string;
  [key: string]: unknown;
}

/** What the real store reports besides the facts that it reads from the catalog itself. */
export const STATUS = {
  lastCheckedAt: undefined,
  lastError: undefined,
  refreshIntervalMinutes: 15,
} satisfies Partial<StoreStatus>;

/** A catalog source that tests can switch to "still loading" or "broken", or give another catalog like a refresh does. */
export class FakeStore implements CatalogSource {
  ready = true;
  /** When set, reading the catalog throws it. */
  failure: Error | undefined;
  statusOverride: Partial<StoreStatus> = {};

  constructor(public source: Catalog = fixtureCatalog()) {}

  get catalog(): Catalog {
    if (this.failure) throw this.failure;
    return this.source;
  }

  /** Like the real store, the source and the age of the data are those of the catalog. */
  status(): StoreStatus {
    const { source, dataAsOf } = this.source.meta;
    return { ...STATUS, source, dataAsOf, sessions: this.source.sessions.length, ...this.statusOverride };
  }
}

/** The settings of a local run (no rate limit, no proxy), with the given changes. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({ RATE_LIMIT_PER_MINUTE: '0', TRUST_PROXY_HOPS: '0', LOG_LEVEL: 'debug' }, import.meta.url), ...overrides };
}

export interface TestResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json<T = Record<string, any>>(): T;
}

export interface SendOptions {
  headers?: Record<string, string>;
  body?: string | Buffer;
}

export interface StartOptions {
  config?: Partial<Config>;
  store?: FakeStore;
  /** Lowest level that is logged; default `debug`, so that nothing is hidden from the assertions. */
  level?: LogLevel;
  /** The clock the app starts with; default Wednesday 8:00 at the event. */
  now?: number;
}

export interface RunningApp {
  /** `http://127.0.0.1:<port>` */
  url: string;
  config: Config;
  store: FakeStore;
  logs: LogLine[];
  /** Move the app's clock; the rate limiter, calendar files and "what's on" all follow it. */
  advance(ms: number): void;
  now(): number;
  /** A plain HTTP request with full control over the headers (`Host` and `Origin` included). */
  send(method: string, path: string, options?: SendOptions): Promise<TestResponse>;
  get(path: string, headers?: Record<string, string>): Promise<TestResponse>;
  /** A POST of a JSON-RPC message with the headers an MCP client sends. */
  rpc(message: unknown, headers?: Record<string, string>): Promise<TestResponse>;
  /** An MCP client that talks to the app over HTTP. It is closed by `stop()`. */
  connect(headers?: Record<string, string>): Promise<Client>;
  stop(): Promise<void>;
}

export const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};

export async function startApp(options: StartOptions = {}): Promise<RunningApp> {
  const store = options.store ?? new FakeStore();
  const config = testConfig(options.config);
  const logs: LogLine[] = [];
  const logger = createLogger(options.level ?? 'debug', (line) => logs.push(JSON.parse(line) as LogLine));
  let time = options.now ?? pacific('2026-11-18', '08:00');
  const now = () => time;

  const { app, close } = createApp({ config, store, logger, now });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  const clients: Client[] = [];

  const send: RunningApp['send'] = (method, path, { headers = {}, body } = {}) =>
    new Promise<TestResponse>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json: <T>() => JSON.parse(text) as T });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });

  return {
    url: `http://127.0.0.1:${port}`,
    config,
    store,
    logs,
    advance: (ms) => void (time += ms),
    now,
    send,
    get: (path, headers) => send('GET', path, headers ? { headers } : {}),
    rpc: (message, headers = {}) =>
      send('POST', '/mcp', {
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(message),
      }),
    async connect(headers) {
      const client = new Client({ name: 'ignite-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), headers ? { requestInit: { headers } } : {});
      clients.push(client);
      await client.connect(transport);
      return client;
    },
    async stop() {
      await Promise.allSettled(clients.map((client) => client.close()));
      await close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
