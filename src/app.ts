import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import express from 'express';
import type { ErrorRequestHandler, Express, Request, RequestHandler, Response } from 'express';
import { createCalendarFile } from './catalog/calendar';
import type { Catalog } from './catalog/catalog';
import type { StoreStatus } from './catalog/store';
import type { Config } from './config';
import { errorFields } from './log';
import type { Logger } from './log';
import { createIgniteServer } from './mcp/factory';
import { VERSION } from './version';
import { bearerToken, cors, secretsMatch } from './http/guards';
import { landingPage } from './http/landing';
import { RateLimiter } from './http/ratelimit';

/** What the app needs from the catalog store; a structural subset so that tests can pass any catalog. */
export interface CatalogSource {
  readonly ready: boolean;
  readonly catalog: Catalog;
  status(): StoreStatus;
}

export interface AppOptions {
  config: Config;
  store: CatalogSource;
  logger: Logger;
  /** Clock in epoch milliseconds; injectable for tests. */
  now?: () => number;
}

export interface IgniteApp {
  app: Express;
  /** Ends open MCP streams; call once the HTTP server has stopped accepting requests. */
  close(): Promise<void>;
}

/** Every MCP request is a small JSON-RPC message; the default of 4 MiB would only help someone trying to exhaust memory. */
const MAX_BODY_BYTES = 128 * 1024;
/** Nothing is ever published to subscribers, so a small cap only limits what idle streams can hold on to. */
const MAX_SUBSCRIPTIONS = 100;

const MAX_CALENDAR_ITEMS = 50;
const MAX_REF_LENGTH = 80;
const MAX_NAME_LENGTH = 80;
const MAX_REMINDER_MINUTES = 24 * 60;

type ErrorStyle = 'jsonrpc' | 'plain';

function sendError(res: Response, status: number, message: string, style: ErrorStyle = 'plain', extra: Record<string, unknown> = {}): void {
  res.status(status).json(style === 'jsonrpc' ? { jsonrpc: '2.0', error: { code: -32000, message }, id: null } : { error: message, ...extra });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

type CalendarQuery = { ok: true; refs: string[]; name: string | undefined; reminderMinutes: number | undefined } | { ok: false; error: string };

/** Same limits as the `export_calendar` tool, so that every link the tool hands out is accepted here. */
export function parseCalendarQuery(url: string): CalendarQuery {
  const params = new URL(url, 'http://localhost').searchParams;
  const refs = params
    .getAll('sessions')
    .flatMap((value) => value.split(','))
    .map((ref) => ref.trim())
    .filter(Boolean);
  if (refs.length === 0) return { ok: false, error: 'Pass the sessions to include as ?sessions=BRK217,LAB650@2026-11-18T14:00' };
  if (refs.length > MAX_CALENDAR_ITEMS) return { ok: false, error: `At most ${MAX_CALENDAR_ITEMS} sessions fit in one calendar file.` };
  if (refs.some((ref) => ref.length > MAX_REF_LENGTH)) return { ok: false, error: `Session references are at most ${MAX_REF_LENGTH} characters long.` };

  const name = params.get('name')?.trim() || undefined;
  if (name && name.length > MAX_NAME_LENGTH) return { ok: false, error: `The calendar name is at most ${MAX_NAME_LENGTH} characters long.` };

  const reminder = params.get('reminder')?.trim();
  if (reminder !== undefined && reminder !== '' && !(/^\d{1,4}$/.test(reminder) && Number(reminder) <= MAX_REMINDER_MINUTES)) {
    return { ok: false, error: `reminder must be a whole number of minutes between 0 and ${MAX_REMINDER_MINUTES}.` };
  }
  return { ok: true, refs, name, reminderMinutes: reminder ? Number(reminder) : undefined };
}

/**
 * Runs `create` with `console.warn` redirected to the logger at debug level, so that everything the process prints stays
 * structured JSON. The SDK writes its startup notice with `console.warn` while the handler is being created.
 */
function warningsAsDebug<T>(logger: Logger, create: () => T): T {
  const original = console.warn;
  console.warn = (...args: unknown[]) => logger.debug('MCP SDK notice', { message: args.map(String).join(' ') });
  try {
    return create();
  } finally {
    console.warn = original;
  }
}

function methodNotAllowed(allow: string): RequestHandler {
  return (_req, res) => {
    res.setHeader('Allow', allow);
    sendError(res, 405, 'Method not allowed.');
  };
}

export function createApp({ config, store, logger, now = Date.now }: AppOptions): IgniteApp {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);

  const limiter = new RateLimiter(config.rateLimitPerMinute, { now });
  const apiKey = config.apiKey;

  const handler = warningsAsDebug(logger, () =>
    createMcpHandler(
      () =>
        createIgniteServer({
          catalog: () => store.catalog,
          status: () => (store.ready ? store.status() : undefined),
          now,
          // Download links cannot carry the key, so they are only offered when anyone may call the server.
          downloadBaseUrl: apiKey ? undefined : config.publicBaseUrl,
          logger,
        }),
      {
        legacy: 'stateless',
        // Nothing here emits notifications while a tool runs, so JSON responses lose nothing. The SDK warns about
        // that once, which is why the handler is created inside warningsAsDebug.
        responseMode: 'json',
        maxRequestBodySize: MAX_BODY_BYTES,
        maxSubscriptions: MAX_SUBSCRIPTIONS,
        onerror: (error) => logger.warn('MCP request failed', { errorName: error.name, error: truncate(error.message, 300) }),
      },
    ),
  );
  const mcp = toNodeHandler(handler, {
    maxRequestBodySize: MAX_BODY_BYTES,
    onerror: (error) => logger.error('MCP adapter failed', errorFields(error)),
  });

  // ---- Common headers and request log -------------------------------------------------------------------------------

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

    const started = performance.now();
    res.on('close', () => {
      // Probes arrive every few seconds; keep them out of the default log level.
      const level = req.path === '/healthz' ? 'debug' : 'info';
      logger[level]('Request', {
        method: req.method,
        path: truncate(req.path, 120),
        status: res.statusCode,
        ms: Math.round(performance.now() - started),
        ...(res.writableFinished ? {} : { aborted: true }),
      });
    });
    next();
  });

  // ---- Guards --------------------------------------------------------------------------------------------------------

  const originHostnames = new Set(config.allowedHosts);
  for (const origin of config.allowedOrigins) originHostnames.add(new URL(origin).hostname);

  const rateLimit =
    (style: ErrorStyle): RequestHandler =>
    (req, res, next) => {
      const result = limiter.take(req.ip ?? 'unknown');
      if (result.allowed) return next();
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      if (result.firstDenied) logger.warn('Rate limit exceeded', { path: req.path });
      sendError(res, 429, `Too many requests. Try again in ${result.retryAfterSeconds} seconds.`, style);
    };

  const requireKey =
    (style: ErrorStyle): RequestHandler =>
    (req, res, next) => {
      if (!apiKey || secretsMatch(bearerToken(req.headers.authorization), apiKey)) return next();
      res.setHeader('WWW-Authenticate', 'Bearer realm="ignite-mcp"');
      sendError(res, 401, 'Missing or invalid API key. Send it as "Authorization: Bearer <key>".', style);
    };

  // ---- Routes --------------------------------------------------------------------------------------------------------

  app.get('/healthz', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!store.ready) {
      res.status(503).json({ status: 'starting' });
      return;
    }
    const status = store.status();
    res.json({ status: 'ok', version: VERSION, source: status.source, sessions: status.sessions, dataAsOf: status.dataAsOf });
  });
  app.all('/healthz', methodNotAllowed('GET, HEAD'));

  app.get('/', (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(landingPage({ baseUrl: publicOrigin(req, config), status: store.ready ? store.status() : undefined, requiresKey: apiKey !== undefined }));
  });
  app.all('/', methodNotAllowed('GET, HEAD'));

  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  app.get('/calendar.ics', rateLimit('plain'), requireKey('plain'), (req, res) => {
    const query = parseCalendarQuery(req.originalUrl);
    if (!query.ok) {
      sendError(res, 400, query.error);
      return;
    }
    if (!store.ready) {
      sendError(res, 503, 'The session catalog is still loading.');
      return;
    }
    const file = createCalendarFile(store.catalog, query.refs, { name: query.name, nowMs: now(), reminderMinutes: query.reminderMinutes });
    if (file.entries.length === 0) {
      sendError(res, 404, 'None of these sessions has a fixed time that can be added to a calendar.', 'plain', {
        unresolved: file.unresolved,
        onDemand: file.onDemand.map((session) => session.code),
      });
      return;
    }
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(file.ics);
  });
  app.all('/calendar.ics', methodNotAllowed('GET, HEAD'));

  app.all(
    '/mcp',
    hostHeaderValidation(config.allowedHosts),
    originValidation([...originHostnames]),
    cors(config.allowedOrigins),
    rateLimit('jsonrpc'),
    requireKey('jsonrpc'),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      await mcp(req, res);
    },
  );

  app.use((_req, res) => {
    sendError(res, 404, 'Not found.');
  });

  const onError: ErrorRequestHandler = (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const status = clientErrorStatus(error);
    if (status === undefined) logger.error('Unhandled error', { path: truncate(req.path, 120), ...errorFields(error) });
    sendError(res, status ?? 500, status === undefined ? 'Internal server error.' : 'Bad request.');
  };
  app.use(onError);

  return { app, close: () => handler.close() };
}

/** Express and its parsers tag malformed requests with a 4xx status. */
function clientErrorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown; statusCode?: unknown } | null)?.status ?? (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

/** The configured public origin; otherwise the request's own origin, but only when its Host header is on the allow list. */
function publicOrigin(req: Request, config: Config): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const host = req.headers.host;
  if (host) {
    try {
      if (config.allowedHosts.includes(new URL(`http://${host}`).hostname)) return `${req.protocol}://${host}`;
    } catch {
      // A malformed Host header falls through to the default below.
    }
  }
  return `http://localhost:${config.port}`;
}
