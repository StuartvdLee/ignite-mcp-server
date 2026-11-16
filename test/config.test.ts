import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, defaultSnapshotPaths, loadConfig } from '../src/config';
import { DEFAULT_DATA_URL } from '../src/event';
import { isLogLevel } from '../src/log';
import { ROOT } from './helpers';

const MODULE = 'file:///app/server.mjs';
const load = (env: Record<string, string | undefined> = {}) => loadConfig(env, MODULE);
const failure = (env: Record<string, string | undefined>): string => {
  try {
    load(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('Expected loadConfig to throw');
};

const APP_NAME = 'ignite-mcp';
const DNS_SUFFIX = 'happyhill-1234abcd.westeurope.azurecontainerapps.io';
const PLATFORM_HOST = `${APP_NAME}.${DNS_SUFFIX}`;

describe('the defaults', () => {
  it('works without any environment variables', () => {
    expect(load()).toEqual({
      port: 3000,
      host: '0.0.0.0',
      logLevel: 'info',
      dataUrl: DEFAULT_DATA_URL,
      refreshIntervalMinutes: 15,
      snapshotPaths: [resolve('/app/data/sessions.snapshot.json'), resolve('/data/sessions.snapshot.json')],
      publicBaseUrl: undefined,
      allowedHosts: ['localhost', '127.0.0.1', '[::1]'],
      allowedOrigins: [],
      rateLimitPerMinute: 120,
      trustProxyHops: 1,
      apiKey: undefined,
    });
  });

  it('treats blank values as not set', () => {
    const blank = Object.fromEntries(
      ['PORT', 'CONTAINER_APP_PORT', 'HOST', 'LOG_LEVEL', 'IGNITE_DATA_URL', 'REFRESH_INTERVAL_MINUTES', 'SNAPSHOT_PATH', 'PUBLIC_BASE_URL', 'ALLOWED_HOSTS', 'ALLOWED_ORIGINS', 'RATE_LIMIT_PER_MINUTE', 'TRUST_PROXY_HOPS', 'MCP_API_KEY'].map((name) => [name, '  ']),
    );
    expect(load(blank)).toEqual(load());
    expect(load({ LOG_LEVEL: '' }).logLevel).toBe('info');
  });

  it('reads the real process environment by default', () => {
    expect(loadConfig().port).toBeGreaterThan(0);
  });
});

describe('numbers', () => {
  it('reads the port, the Container Apps port and lets PORT win', () => {
    expect(load({ PORT: '8080' }).port).toBe(8080);
    expect(load({ CONTAINER_APP_PORT: '8081' }).port).toBe(8081);
    expect(load({ PORT: '8080', CONTAINER_APP_PORT: '8081' }).port).toBe(8080);
    expect(load({ PORT: ' 443 ' }).port).toBe(443);
    expect(load({ PORT: '1' }).port).toBe(1);
    expect(load({ PORT: '65535' }).port).toBe(65535);
  });

  it('rejects ports that are not a whole number from 1 to 65535', () => {
    for (const port of ['0', '65536', '-1', '80.5', 'abc', '80abc', '0x50', '1e3', '+80', '8 0', '99999999999999999999999']) {
      expect(failure({ PORT: port })).toBe(`PORT must be an integer between 1 and 65535, got "${port}"`);
    }
    expect(failure({ CONTAINER_APP_PORT: 'http' })).toBe('CONTAINER_APP_PORT must be an integer between 1 and 65535, got "http"');
  });

  it('reads the refresh interval, where 0 turns refreshing off', () => {
    expect(load({ REFRESH_INTERVAL_MINUTES: '0' }).refreshIntervalMinutes).toBe(0);
    expect(load({ REFRESH_INTERVAL_MINUTES: '5' }).refreshIntervalMinutes).toBe(5);
    expect(load({ REFRESH_INTERVAL_MINUTES: '1440' }).refreshIntervalMinutes).toBe(1440);
    expect(failure({ REFRESH_INTERVAL_MINUTES: '1441' })).toBe('REFRESH_INTERVAL_MINUTES must be an integer between 0 and 1440, got "1441"');
    expect(failure({ REFRESH_INTERVAL_MINUTES: '-1' })).toContain('REFRESH_INTERVAL_MINUTES');
  });

  it('reads the rate limit, where 0 turns it off', () => {
    expect(load({ RATE_LIMIT_PER_MINUTE: '0' }).rateLimitPerMinute).toBe(0);
    expect(load({ RATE_LIMIT_PER_MINUTE: '600' }).rateLimitPerMinute).toBe(600);
    expect(failure({ RATE_LIMIT_PER_MINUTE: '100001' })).toContain('between 0 and 100000');
    expect(failure({ RATE_LIMIT_PER_MINUTE: 'lots' })).toContain('RATE_LIMIT_PER_MINUTE');
  });

  it('reads the number of proxies in front of the app', () => {
    expect(load({ TRUST_PROXY_HOPS: '0' }).trustProxyHops).toBe(0);
    expect(load({ TRUST_PROXY_HOPS: '2' }).trustProxyHops).toBe(2);
    expect(failure({ TRUST_PROXY_HOPS: '11' })).toBe('TRUST_PROXY_HOPS must be an integer between 0 and 10, got "11"');
    expect(failure({ TRUST_PROXY_HOPS: 'true' })).toContain('TRUST_PROXY_HOPS');
  });
});

describe('text settings', () => {
  it('reads the host', () => {
    expect(load({ HOST: '127.0.0.1' }).host).toBe('127.0.0.1');
    expect(load({ HOST: ' :: ' }).host).toBe('::');
  });

  it('reads the log level without regard to case', () => {
    expect(load({ LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
    expect(load({ LOG_LEVEL: ' WARN ' }).logLevel).toBe('warn');
    expect(load({ LOG_LEVEL: 'Error' }).logLevel).toBe('error');
  });

  it('rejects an unknown log level, including names that merely exist on every object', () => {
    expect(failure({ LOG_LEVEL: 'verbose' })).toBe('LOG_LEVEL must be one of debug, info, warn, error, got "verbose"');
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(isLogLevel(name)).toBe(false);
      expect(failure({ LOG_LEVEL: name })).toContain('LOG_LEVEL must be one of');
    }
  });

  it('reads the API key, trimmed, and treats a blank key as none', () => {
    expect(load({ MCP_API_KEY: 'k3y-with-dashes' }).apiKey).toBe('k3y-with-dashes');
    expect(load({ MCP_API_KEY: '  padded  ' }).apiKey).toBe('padded');
    expect(load({ MCP_API_KEY: '' }).apiKey).toBeUndefined();
    expect(load({ MCP_API_KEY: '   ' }).apiKey).toBeUndefined();
  });

  it('reads the feed address and insists that it is an http(s) URL', () => {
    expect(load({ IGNITE_DATA_URL: 'https://example.test/feed.json' }).dataUrl).toBe('https://example.test/feed.json');
    expect(load({ IGNITE_DATA_URL: ' http://localhost:9000/feed ' }).dataUrl).toBe('http://localhost:9000/feed');
    expect(failure({ IGNITE_DATA_URL: 'example.test/feed.json' })).toBe('IGNITE_DATA_URL must be an absolute URL, got "example.test/feed.json"');
    expect(failure({ IGNITE_DATA_URL: 'file:///etc/passwd' })).toBe('IGNITE_DATA_URL must be an http(s) URL, got "file:///etc/passwd"');
  });
});

describe('where the server says it is', () => {
  it('uses PUBLIC_BASE_URL, reduced to its origin', () => {
    expect(load({ PUBLIC_BASE_URL: 'https://ignite.example.com' }).publicBaseUrl).toBe('https://ignite.example.com');
    expect(load({ PUBLIC_BASE_URL: 'https://ignite.example.com/' }).publicBaseUrl).toBe('https://ignite.example.com');
    expect(load({ PUBLIC_BASE_URL: ' https://Ignite.Example.com:8443/mcp?x=1#top ' }).publicBaseUrl).toBe('https://ignite.example.com:8443');
    expect(load({ PUBLIC_BASE_URL: 'http://localhost:3000' }).publicBaseUrl).toBe('http://localhost:3000');
  });

  it('rejects a PUBLIC_BASE_URL that is not an http(s) URL', () => {
    expect(failure({ PUBLIC_BASE_URL: 'ignite.example.com' })).toBe('PUBLIC_BASE_URL must be an absolute URL, got "ignite.example.com"');
    expect(failure({ PUBLIC_BASE_URL: 'ftp://ignite.example.com' })).toBe('PUBLIC_BASE_URL must be an http(s) URL, got "ftp://ignite.example.com"');
    expect(failure({ PUBLIC_BASE_URL: 'javascript:alert(1)' })).toContain('http(s)');
  });

  it('works out the address from what Azure Container Apps provides', () => {
    const config = load({ CONTAINER_APP_NAME: APP_NAME, CONTAINER_APP_ENV_DNS_SUFFIX: DNS_SUFFIX });
    expect(config.publicBaseUrl).toBe(`https://${PLATFORM_HOST}`);
    expect(config.allowedHosts).toEqual(['localhost', '127.0.0.1', '[::1]', PLATFORM_HOST]);
  });

  it('needs both Container Apps values', () => {
    expect(load({ CONTAINER_APP_NAME: APP_NAME }).publicBaseUrl).toBeUndefined();
    expect(load({ CONTAINER_APP_ENV_DNS_SUFFIX: DNS_SUFFIX }).publicBaseUrl).toBeUndefined();
    expect(load({ CONTAINER_APP_NAME: APP_NAME, CONTAINER_APP_ENV_DNS_SUFFIX: ' ' }).allowedHosts).toEqual(['localhost', '127.0.0.1', '[::1]']);
  });

  it('prefers PUBLIC_BASE_URL but still accepts the Container Apps address', () => {
    const config = load({ PUBLIC_BASE_URL: 'https://ignite.example.com', CONTAINER_APP_NAME: APP_NAME, CONTAINER_APP_ENV_DNS_SUFFIX: DNS_SUFFIX });
    expect(config.publicBaseUrl).toBe('https://ignite.example.com');
    expect(config.allowedHosts).toEqual(['localhost', '127.0.0.1', '[::1]', PLATFORM_HOST, 'ignite.example.com']);
  });

  it('adds the extra hosts, lowercased and without duplicates', () => {
    const config = load({ ALLOWED_HOSTS: ' Ignite.Example.com, other.test ,, LOCALHOST ,ignite.example.com', PUBLIC_BASE_URL: 'https://ignite.example.com' });
    expect(config.allowedHosts).toEqual(['localhost', '127.0.0.1', '[::1]', 'ignite.example.com', 'other.test']);
  });

  it('gives a clear error for a broken Container Apps name', () => {
    expect(failure({ CONTAINER_APP_NAME: 'bad name', CONTAINER_APP_ENV_DNS_SUFFIX: DNS_SUFFIX })).toContain('CONTAINER_APP_NAME and CONTAINER_APP_ENV_DNS_SUFFIX must be an absolute URL');
  });
});

describe('browser origins', () => {
  it('lists the origins that may call the server from a browser, reduced to the origin', () => {
    expect(load({ ALLOWED_ORIGINS: 'https://a.example.com, http://localhost:5173/ ,,https://b.example.com/app' }).allowedOrigins).toEqual([
      'https://a.example.com',
      'http://localhost:5173',
      'https://b.example.com',
    ]);
  });

  it('refuses anything that is not an origin, including a wildcard', () => {
    expect(failure({ ALLOWED_ORIGINS: '*' })).toBe('ALLOWED_ORIGINS must be an absolute URL, got "*"');
    expect(failure({ ALLOWED_ORIGINS: 'https://ok.example.com,null' })).toBe('ALLOWED_ORIGINS must be an absolute URL, got "null"');
    expect(failure({ ALLOWED_ORIGINS: 'chrome-extension://abc' })).toContain('http(s)');
  });
});

describe('finding the bundled snapshot', () => {
  it('looks next to the entry file first, then one level up', () => {
    expect(defaultSnapshotPaths('file:///app/server.mjs')).toEqual([resolve('/app/data/sessions.snapshot.json'), resolve('/data/sessions.snapshot.json')]);
    expect(defaultSnapshotPaths('file:///repo/src/config.ts')).toEqual([resolve('/repo/src/data/sessions.snapshot.json'), resolve('/repo/data/sessions.snapshot.json')]);
  });

  it('tries an explicit path before the others', () => {
    expect(defaultSnapshotPaths(MODULE, '/mnt/data/custom.json')).toEqual([resolve('/mnt/data/custom.json'), ...defaultSnapshotPaths(MODULE)]);
    expect(defaultSnapshotPaths(MODULE, 'relative/custom.json')[0]).toBe(resolve('relative/custom.json'));
    expect(load({ SNAPSHOT_PATH: ' /mnt/data/custom.json ' }).snapshotPaths[0]).toBe(resolve('/mnt/data/custom.json'));
  });

  it('finds the bundled file when running from the sources and from a local build', () => {
    for (const entry of ['src/config.ts', 'dist/server.mjs']) {
      const found = defaultSnapshotPaths(pathToFileURL(resolve(ROOT, entry)).href).filter((path) => existsSync(path));
      expect(found).toEqual([resolve(ROOT, 'data/sessions.snapshot.json')]);
    }
  });
});
