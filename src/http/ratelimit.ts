export interface RateLimitResult {
  allowed: boolean;
  /** Whole seconds until the client may try again; 0 when allowed. */
  retryAfterSeconds: number;
  /** True only for the first denied request of a window, so that callers can log once instead of per request. */
  firstDenied: boolean;
}

export interface RateLimiterOptions {
  windowMs?: number;
  /** Upper bound on tracked clients, so that many different addresses cannot grow memory without limit. */
  maxKeys?: number;
  now?: () => number;
}

/**
 * Fixed-window limiter per client key, kept in memory. Each replica counts on its own, which is enough to stop a
 * single client from hogging a small instance.
 */
export class RateLimiter {
  /** Ordered by window start (a key is re-inserted when its window restarts), so the oldest windows come first. */
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  /** @param limit Requests per window and key; 0 disables the limiter. */
  constructor(
    private readonly limit: number,
    options: RateLimiterOptions = {},
  ) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.windows.size;
  }

  take(key: string): RateLimitResult {
    if (this.limit <= 0) return { allowed: true, retryAfterSeconds: 0, firstDenied: false };
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      this.windows.delete(key);
      this.makeRoom(now);
      window = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    if (window.count <= this.limit) return { allowed: true, retryAfterSeconds: 0, firstDenied: false };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
      firstDenied: window.count === this.limit + 1,
    };
  }

  private makeRoom(now: number): void {
    if (this.windows.size < this.maxKeys) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt > now) break;
      this.windows.delete(key);
    }
    // Still full: forget the oldest clients; they start over with a fresh quota.
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.maxKeys) break;
      this.windows.delete(key);
    }
  }
}
