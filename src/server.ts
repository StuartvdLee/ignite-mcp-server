import { createServer } from 'node:http';
import { createApp } from './app';
import { CatalogStore } from './catalog/store';
import { ConfigError, loadConfig } from './config';
import { createLogger, errorFields } from './log';
import type { Logger } from './log';
import { VERSION } from './version';

/** Container Apps waits 30 seconds after SIGTERM before it kills the container. */
const DRAIN_MS = 8_000;

function fatal(logger: Logger | undefined, message: string, error: unknown): never {
  if (logger) logger.error(message, errorFields(error));
  else process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'error', msg: message, ...errorFields(error) })}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  let logger: Logger | undefined;
  try {
    const config = loadConfig();
    logger = createLogger(config.logLevel);
    const log = logger;

    process.on('uncaughtException', (error) => fatal(log, 'Uncaught exception', error));
    process.on('unhandledRejection', (reason) => fatal(log, 'Unhandled rejection', reason));

    const store = new CatalogStore({
      dataUrl: config.dataUrl,
      snapshotPaths: config.snapshotPaths,
      refreshIntervalMinutes: config.refreshIntervalMinutes,
      logger: log,
    });
    await store.init();

    const { app, close } = createApp({ config, store, logger: log });
    const server = createServer(app);
    // Longer than the ingress keeps idle connections, and the request timeout is only for receiving the request.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    server.requestTimeout = 30_000;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    store.startRefreshing();
    log.info('Server started', {
      version: VERSION,
      port: config.port,
      publicBaseUrl: config.publicBaseUrl,
      apiKey: config.apiKey !== undefined,
      rateLimitPerMinute: config.rateLimitPerMinute,
      allowedOrigins: config.allowedOrigins.length,
      node: process.version,
    });

    let stopping = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (stopping) return;
      stopping = true;
      log.info('Shutting down', { signal });
      store.stop();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const drained = new Promise<void>((resolve) => setTimeout(resolve, DRAIN_MS).unref());
      await Promise.race([closed, drained]);
      // Long-lived MCP streams would otherwise keep the server open until the platform kills it.
      await close();
      server.closeAllConnections();
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (error) {
    if (error instanceof ConfigError) fatal(logger, `Invalid configuration: ${error.message}`, error);
    fatal(logger, 'Failed to start', error);
  }
}

void main();
