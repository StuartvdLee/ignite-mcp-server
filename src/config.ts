import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DATA_URL } from './event';
import { isLogLevel } from './log';
import type { LogLevel } from './log';

export interface Config {
  port: number;
  host: string;
  logLevel: LogLevel;
  /** Where the live session feed is downloaded from. */
  dataUrl: string;
  /** Minutes between checks for a new feed; 0 disables background refreshes. */
  refreshIntervalMinutes: number;
  /** Places to look for the bundled fallback snapshot, in order. */
  snapshotPaths: string[];
  /** Public origin of this server, without a trailing slash; used for calendar download links. */
  publicBaseUrl: string | undefined;
  /** Host names accepted in the Host header of `/mcp` requests (DNS rebinding protection). */
  allowedHosts: string[];
  /** Browser origins allowed to call `/mcp`; empty means browsers get no CORS access. */
  allowedOrigins: string[];
  /** Requests per minute and client for `/mcp` and `/calendar.ics`; 0 disables the limit. */
  rateLimitPerMinute: number;
  /** Number of reverse proxies in front of the app (the Container Apps ingress is one). */
  trustProxyHops: number;
  /** When set, `/mcp` requires `Authorization: Bearer <key>`. */
  apiKey: string | undefined;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  // Digits only: Number() would also accept "0x50", "1e3" and "+8".
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function list(env: Env, name: string): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function httpUrl(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be an absolute URL, got "${value}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError(`${name} must be an http(s) URL, got "${value}"`);
  return url;
}

const origin = (name: string, value: string): string => httpUrl(name, value).origin;

/** Candidates cover running from `src/` (dev), from `dist/` (local build) and from the container image's app directory. */
export function defaultSnapshotPaths(moduleUrl: string, override?: string): string[] {
  const directory = dirname(fileURLToPath(moduleUrl));
  const paths = [resolve(directory, 'data/sessions.snapshot.json'), resolve(directory, '../data/sessions.snapshot.json')];
  return override ? [resolve(override), ...paths] : paths;
}

export function loadConfig(env: Env = process.env, moduleUrl: string = import.meta.url): Config {
  const level = (env.LOG_LEVEL?.trim() || 'info').toLowerCase();
  if (!isLogLevel(level)) throw new ConfigError(`LOG_LEVEL must be one of debug, info, warn, error, got "${level}"`);

  // Container Apps injects the app name and the environment's DNS suffix; together they form the public FQDN.
  const appName = env.CONTAINER_APP_NAME?.trim();
  const dnsSuffix = env.CONTAINER_APP_ENV_DNS_SUFFIX?.trim();
  const platformHost = appName && dnsSuffix ? `${appName}.${dnsSuffix}` : undefined;
  const configuredBase = env.PUBLIC_BASE_URL?.trim();
  const publicBaseUrl = configuredBase
    ? origin('PUBLIC_BASE_URL', configuredBase)
    : platformHost
      ? origin('CONTAINER_APP_NAME and CONTAINER_APP_ENV_DNS_SUFFIX', `https://${platformHost}`)
      : undefined;

  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...list(env, 'ALLOWED_HOSTS').map((host) => host.toLowerCase())]);
  if (platformHost) allowedHosts.add(platformHost.toLowerCase());
  if (publicBaseUrl) allowedHosts.add(new URL(publicBaseUrl).hostname.toLowerCase());

  const configuredDataUrl = env.IGNITE_DATA_URL?.trim();

  return {
    port: integer(env, 'PORT', integer(env, 'CONTAINER_APP_PORT', 3000, 1, 65535), 1, 65535),
    host: env.HOST?.trim() || '0.0.0.0',
    logLevel: level,
    dataUrl: configuredDataUrl ? httpUrl('IGNITE_DATA_URL', configuredDataUrl).href : DEFAULT_DATA_URL,
    refreshIntervalMinutes: integer(env, 'REFRESH_INTERVAL_MINUTES', 15, 0, 24 * 60),
    snapshotPaths: defaultSnapshotPaths(moduleUrl, env.SNAPSHOT_PATH?.trim() || undefined),
    publicBaseUrl,
    allowedHosts: [...allowedHosts],
    allowedOrigins: list(env, 'ALLOWED_ORIGINS').map((value) => origin('ALLOWED_ORIGINS', value)),
    rateLimitPerMinute: integer(env, 'RATE_LIMIT_PER_MINUTE', 120, 0, 100_000),
    trustProxyHops: integer(env, 'TRUST_PROXY_HOPS', 1, 0, 10),
    apiKey: env.MCP_API_KEY?.trim() || undefined,
  };
}
