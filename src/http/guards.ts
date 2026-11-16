import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;

/** The token of an `Authorization: Bearer <token>` header, or undefined for anything else. */
export function bearerToken(header: string | undefined): string | undefined {
  return header ? BEARER.exec(header)?.[1] : undefined;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison: hashing first makes the work independent of the secret's length and of where the values differ. */
export function secretsMatch(provided: string | undefined, expected: string): boolean {
  const expectedDigest = digest(expected);
  return timingSafeEqual(digest(provided ?? ''), expectedDigest) && provided !== undefined;
}

const ALLOW_METHODS = 'GET, POST, DELETE, OPTIONS';
const DEFAULT_ALLOW_HEADERS = 'Content-Type, Accept, Authorization, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID';
const EXPOSE_HEADERS = 'Mcp-Session-Id, Mcp-Protocol-Version, Retry-After, WWW-Authenticate';
const SAFE_REQUESTED_HEADERS = /^[\w-]+(?:\s*,\s*[\w-]+)*$/;

/**
 * CORS for browser based MCP clients. Only origins on the allow list (full origins such as `https://app.example.com`)
 * get CORS headers; everything else is left to the browser's default, which is to block the response.
 */
export function cors(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    if (allowed.size === 0) return next();
    res.vary('Origin');
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) return next();

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', EXPOSE_HEADERS);
    if (req.method !== 'OPTIONS') return next();

    // The 2026 protocol adds Mcp-* request headers, so echo what the browser asks for instead of keeping a list in sync.
    const requested = req.headers['access-control-request-headers'];
    res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
    res.setHeader('Access-Control-Allow-Headers', requested && requested.length <= 500 && SAFE_REQUESTED_HEADERS.test(requested) ? requested : DEFAULT_ALLOW_HEADERS);
    res.setHeader('Access-Control-Max-Age', '600');
    res.status(204).end();
  };
}
