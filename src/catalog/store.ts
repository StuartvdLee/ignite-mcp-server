import { errorFields } from '../log';
import type { Logger } from '../log';
import { Catalog } from './catalog';
import { loadLiveFeed, readSnapshot } from './loader';

export interface StoreOptions {
  dataUrl: string;
  snapshotPaths: readonly string[];
  /** 0 disables background refreshes. */
  refreshIntervalMinutes: number;
  logger: Logger;
  fetchImpl?: typeof fetch | undefined;
  fetchTimeoutMs?: number | undefined;
}

export interface StoreStatus {
  source: 'snapshot' | 'live';
  sessions: number;
  dataAsOf: string;
  lastCheckedAt?: string | undefined;
  lastError?: string | undefined;
  refreshIntervalMinutes: number;
}

export type RefreshResult = 'updated' | 'unchanged' | 'failed';

/** A live feed that shrinks below this is treated as broken and ignored. */
const MIN_SESSIONS = 100;
const MIN_FRACTION_OF_CURRENT = 0.5;

/**
 * Holds the current catalog. It starts from the bundled snapshot so the server is useful immediately,
 * then swaps in the live feed (refreshed with conditional requests) once that has been downloaded.
 */
export class CatalogStore {
  private current: Catalog | undefined;
  private inflight: Promise<RefreshResult> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastCheckedAt: string | undefined;
  private lastError: string | undefined;

  constructor(private readonly options: StoreOptions) {}

  /** Loads the bundled snapshot. Throws when none can be read. */
  async init(): Promise<void> {
    const { snapshot, path } = await readSnapshot(this.options.snapshotPaths);
    this.current = new Catalog(snapshot.sessions, {
      source: 'snapshot',
      sourceUrl: snapshot.sourceUrl,
      dataAsOf: snapshot.generatedAt,
    });
    this.options.logger.info('Loaded session snapshot', { path, sessions: snapshot.sessions.length, generatedAt: snapshot.generatedAt });
  }

  get catalog(): Catalog {
    if (!this.current) throw new Error('Catalog is not loaded yet');
    return this.current;
  }

  get ready(): boolean {
    return this.current !== undefined;
  }

  status(): StoreStatus {
    const catalog = this.catalog;
    return {
      source: catalog.meta.source,
      sessions: catalog.sessions.length,
      dataAsOf: catalog.meta.dataAsOf,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
      refreshIntervalMinutes: this.options.refreshIntervalMinutes,
    };
  }

  /** Fetches the live feed in the background and keeps it fresh. Never throws and never blocks startup. */
  startRefreshing(): void {
    void this.refresh();
    const minutes = this.options.refreshIntervalMinutes;
    if (minutes > 0 && !this.timer) {
      this.timer = setInterval(() => void this.refresh(), minutes * 60_000);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  refresh(): Promise<RefreshResult> {
    this.inflight ??= this.refreshOnce().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async refreshOnce(): Promise<RefreshResult> {
    const { logger } = this.options;
    try {
      const previous = this.catalog;
      const loaded = await loadLiveFeed(this.options.dataUrl, {
        etag: previous.meta.source === 'live' ? previous.meta.etag : undefined,
        fetchImpl: this.options.fetchImpl,
        timeoutMs: this.options.fetchTimeoutMs,
      });
      this.lastCheckedAt = new Date().toISOString();
      if (loaded === 'not-modified') {
        this.lastError = undefined;
        logger.debug('Session feed unchanged');
        return 'unchanged';
      }
      const floor = Math.max(MIN_SESSIONS, Math.floor(previous.sessions.length * MIN_FRACTION_OF_CURRENT));
      if (loaded.sessions.length < floor) {
        throw new Error(`Live feed has only ${loaded.sessions.length} sessions (expected at least ${floor}); keeping current data`);
      }
      this.current = new Catalog(loaded.sessions, {
        source: 'live',
        sourceUrl: this.options.dataUrl,
        dataAsOf: this.lastCheckedAt,
        etag: loaded.etag,
      });
      this.lastError = undefined;
      logger.info('Loaded live session feed', { sessions: loaded.sessions.length, skipped: loaded.skipped });
      return 'updated';
    } catch (error) {
      this.lastCheckedAt = new Date().toISOString();
      this.lastError = error instanceof Error ? error.message : String(error);
      logger.warn('Could not refresh the session feed', errorFields(error));
      return 'failed';
    }
  }
}
