import { describe, expect, it } from 'vitest';
import { parseCalendarQuery } from '../src/app';
import { bearerToken, secretsMatch } from '../src/http/guards';
import { escapeHtml, landingPage } from '../src/http/landing';
import { RateLimiter } from '../src/http/ratelimit';
import { calendarDownloadUrl } from '../src/mcp/tools';
import { VERSION } from '../src/version';
import { EVENT } from '../src/event';

function clock(start = 1_000_000) {
  let time = start;
  return { now: () => time, advance: (ms: number) => void (time += ms) };
}

describe('RateLimiter', () => {
  it('lets a client make `limit` requests per window and then says when to come back', () => {
    const time = clock();
    const limiter = new RateLimiter(3, { now: time.now });
    for (let call = 0; call < 3; call++) expect(limiter.take('a')).toEqual({ allowed: true, retryAfterSeconds: 0, firstDenied: false });
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 60, firstDenied: true });
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 60, firstDenied: false });
  });

  it('flags only the first denial of a window, so that it can be logged once', () => {
    const time = clock();
    const limiter = new RateLimiter(1, { now: time.now });
    limiter.take('a');
    const denials = Array.from({ length: 5 }, () => limiter.take('a').firstDenied);
    expect(denials).toEqual([true, false, false, false, false]);

    time.advance(60_000);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').firstDenied).toBe(true);
  });

  it('counts down the wait and never rounds it to nothing', () => {
    const time = clock();
    const limiter = new RateLimiter(1, { now: time.now });
    limiter.take('a');
    const wait = (elapsed: number) => {
      time.advance(elapsed);
      return limiter.take('a').retryAfterSeconds;
    };
    expect(wait(0)).toBe(60);
    expect(wait(1)).toBe(60);
    expect(wait(999)).toBe(59);
    expect(wait(29_000)).toBe(30);
    expect(wait(29_500)).toBe(1);
    expect(wait(499)).toBe(1);
  });

  it('starts a new window once the old one is over', () => {
    const time = clock();
    const limiter = new RateLimiter(2, { windowMs: 10_000, now: time.now });
    limiter.take('a');
    limiter.take('a');
    expect(limiter.take('a').allowed).toBe(false);

    time.advance(9_999);
    expect(limiter.take('a').allowed).toBe(false);
    time.advance(1);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
  });

  it('gives every client its own quota', () => {
    const limiter = new RateLimiter(1, { now: clock().now });
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
    expect(limiter.take('b').allowed).toBe(true);
    expect(limiter.take('b').allowed).toBe(false);
    expect(limiter.size).toBe(2);
  });

  it('is switched off by a limit of 0 and tracks nobody', () => {
    for (const limit of [0, -1]) {
      const limiter = new RateLimiter(limit, { now: clock().now });
      for (let call = 0; call < 1000; call++) expect(limiter.take('a')).toEqual({ allowed: true, retryAfterSeconds: 0, firstDenied: false });
      expect(limiter.size).toBe(0);
    }
  });

  describe('memory', () => {
    it('forgets the oldest clients, who start over, when there are too many', () => {
      const limiter = new RateLimiter(1, { maxKeys: 3, now: clock().now });
      for (const key of ['a', 'b', 'c']) limiter.take(key);
      expect(limiter.size).toBe(3);

      limiter.take('d');
      expect(limiter.size).toBe(3);
      expect(limiter.take('b').allowed).toBe(false);
      expect(limiter.take('d').allowed).toBe(false);
      // `a` was the oldest and lost its record, so it gets a fresh quota; that in turn pushes `b` out.
      expect(limiter.take('a').allowed).toBe(true);
      expect(limiter.size).toBe(3);
    });

    it('drops windows that are over before it drops clients that are still being limited', () => {
      const time = clock();
      const limiter = new RateLimiter(1, { maxKeys: 3, now: time.now });
      limiter.take('old1');
      limiter.take('old2');
      time.advance(60_000);
      limiter.take('current');
      limiter.take('new');
      expect(limiter.size).toBe(2);
      expect(limiter.take('current').allowed).toBe(false);
      expect(limiter.take('new').allowed).toBe(false);
    });

    it('never tracks more than maxKeys clients', () => {
      const time = clock();
      const limiter = new RateLimiter(5, { maxKeys: 50, now: time.now });
      for (let client = 0; client < 5_000; client++) {
        limiter.take(`client-${client}`);
        if (client % 100 === 0) time.advance(1_000);
        expect(limiter.size).toBeLessThanOrEqual(50);
      }
    });

    it('moves a client to the back of the queue when its window restarts', () => {
      const time = clock();
      const limiter = new RateLimiter(1, { windowMs: 1_000, maxKeys: 2, now: time.now });
      limiter.take('a');
      time.advance(500);
      limiter.take('b');
      time.advance(500);
      // `a`'s window is over and restarts, so `b` is now the oldest entry and is the one forgotten for `c`.
      limiter.take('a');
      limiter.take('c');
      expect(limiter.take('a').allowed).toBe(false);
      expect(limiter.take('b').allowed).toBe(true);
    });
  });

  it('uses the real clock by default', () => {
    const limiter = new RateLimiter(1);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a')).toMatchObject({ allowed: false, retryAfterSeconds: 60 });
  });
});

describe('bearerToken', () => {
  it.each([
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
    ['BEARER abc', 'abc'],
    ['Bearer    abc   ', 'abc'],
    ['Bearer\tabc', 'abc'],
    ['Bearer a.b-c_d~e+f/g=', 'a.b-c_d~e+f/g='],
  ])('reads %j as %j', (header, token) => {
    expect(bearerToken(header)).toBe(token);
  });

  it.each([undefined, '', 'Bearer', 'Bearer ', 'Bearer   ', 'Basic abc', 'Token abc', 'Bearerabc', 'Bearer a b', ' Bearer abc', 'Bearer abc\n'])(
    'does not read %j',
    (header) => {
      expect(bearerToken(header)).toBeUndefined();
    },
  );
});

describe('secretsMatch', () => {
  it('accepts only the exact secret', () => {
    expect(secretsMatch('s3cret-value', 's3cret-value')).toBe(true);
    expect(secretsMatch('S3cret-value', 's3cret-value')).toBe(false);
    expect(secretsMatch('s3cret-value ', 's3cret-value')).toBe(false);
    expect(secretsMatch('s3cret', 's3cret-value')).toBe(false);
    expect(secretsMatch('s3cret-value-and-more', 's3cret-value')).toBe(false);
    expect(secretsMatch('', 's3cret-value')).toBe(false);
  });

  it('never accepts a missing secret', () => {
    expect(secretsMatch(undefined, 's3cret-value')).toBe(false);
    expect(secretsMatch(undefined, '')).toBe(false);
  });

  it('compares text, not bytes of some encoding it guessed', () => {
    expect(secretsMatch('pässwörd-🔑', 'pässwörd-🔑')).toBe(true);
    expect(secretsMatch('passwörd-🔑', 'pässwörd-🔑')).toBe(false);
  });
});

describe('escapeHtml', () => {
  it('escapes everything that could end a text node or an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>R&D</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;R&amp;D&lt;/a&gt;');
  });

  it('escapes the ampersand first, so nothing is escaped twice', () => {
    expect(escapeHtml('&amp; &lt;')).toBe('&amp;amp; &amp;lt;');
  });

  it('leaves everything else alone', () => {
    expect(escapeHtml('Plain text, 100% fine: café 🎉 / \\')).toBe('Plain text, 100% fine: café 🎉 / \\');
    expect(escapeHtml('')).toBe('');
  });
});

describe('the landing page', () => {
  const status = {
    source: 'live' as const,
    sessions: 1353,
    dataAsOf: '2026-11-16T12:00:00.000Z',
    lastCheckedAt: undefined,
    lastError: undefined,
    refreshIntervalMinutes: 15,
  };
  const page = (overrides: Partial<Parameters<typeof landingPage>[0]> = {}) => landingPage({ baseUrl: 'https://ignite.example.test', status, requiresKey: false, ...overrides });

  it('is a complete HTML document about this event', () => {
    const html = page();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain(`<title>${EVENT.name} MCP server</title>`);
    expect(html).toContain(`<h1>${EVENT.name} MCP server</h1>`);
    expect(html).toContain(`Version ${VERSION}`);
    expect(html).toContain(`href="${EVENT.sessionsUrl}"`);
    expect(html.endsWith('</html>\n')).toBe(true);
  });

  it('shows how to connect to the endpoint', () => {
    const html = page();
    expect(html).toContain('<code>https://ignite.example.test/mcp</code>');
    expect(html).toContain('&quot;type&quot;: &quot;http&quot;');
    expect(html).toContain('&quot;url&quot;: &quot;https://ignite.example.test/mcp&quot;');
    expect(html).toContain('claude mcp add --transport http ignite https://ignite.example.test/mcp');
  });

  it('asks for a key only when the server needs one', () => {
    const open = page({ requiresKey: false });
    expect(open).not.toContain('Authorization');
    expect(open).not.toContain('API key');

    const locked = page({ requiresKey: true });
    expect(locked).toContain('This server needs an API key.');
    expect(locked).toContain('&quot;Authorization&quot;: &quot;Bearer &lt;your key&gt;&quot;');
    expect(locked).toContain('--header &quot;Authorization: Bearer &lt;your key&gt;&quot;');
  });

  it('says where the data comes from', () => {
    expect(page()).toContain('1,353 sessions. Live from the official feed, data as of 2026-11-16T12:00:00.000Z.');
    expect(page({ status: { ...status, source: 'snapshot' } })).toContain('Bundled snapshot, data as of 2026-11-16T12:00:00.000Z.');
    expect(page({ status: undefined })).toContain('The session catalog is loading.');
  });

  it('suggests things to ask', () => {
    const html = page();
    expect(html).toContain('<h2>Try asking</h2>');
    expect(html.match(/<li>/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('escapes whatever it is given', () => {
    const hostile = 'https://x.test/"><script>alert(1)</script>';
    const html = page({ baseUrl: hostile, status: { ...status, dataAsOf: '<img src=x onerror=alert(1)>' } });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('needs nothing that its content security policy (no scripts, images, fonts or frames) would block', () => {
    const html = page({ requiresKey: true });
    expect(html).not.toMatch(/<(script|img|link|iframe|object|embed|video|audio|form|base)\b/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).not.toContain('@import');
  });
});

describe('parseCalendarQuery', () => {
  const ok = (query: string) => {
    const parsed = parseCalendarQuery(`/calendar.ics${query}`);
    if (!parsed.ok) throw new Error(`Expected ${query} to be accepted: ${parsed.error}`);
    return parsed;
  };
  const error = (query: string) => {
    const parsed = parseCalendarQuery(`/calendar.ics${query}`);
    if (parsed.ok) throw new Error(`Expected ${query} to be refused`);
    return parsed.error;
  };

  it('reads a single session', () => {
    expect(ok('?sessions=BRK217')).toEqual({ ok: true, refs: ['BRK217'], name: undefined, reminderMinutes: undefined });
  });

  it('reads sessions given as a comma separated list, as repeated parameters, or both', () => {
    expect(ok('?sessions=BRK217,LAB652@2026-11-18T14:00&sessions=KEY01').refs).toEqual(['BRK217', 'LAB652@2026-11-18T14:00', 'KEY01']);
    expect(ok('?sessions=BRK217%2CLAB652%402026-11-18T14%3A00').refs).toEqual(['BRK217', 'LAB652@2026-11-18T14:00']);
  });

  it('trims the references and drops blank ones', () => {
    expect(ok('?sessions=%20BRK217%20,,%20,KEY01,').refs).toEqual(['BRK217', 'KEY01']);
  });

  it('wants at least one reference', () => {
    const message = 'Pass the sessions to include as ?sessions=BRK217,LAB650@2026-11-18T14:00';
    for (const query of ['', '?', '?sessions=', '?sessions=%20,%20', '?name=Mine', '?session=BRK217']) expect(error(query)).toBe(message);
  });

  it('accepts at most 50 references of at most 80 characters', () => {
    const refs = (count: number) => Array.from({ length: count }, (_, index) => `S${index}`).join(',');
    expect(ok(`?sessions=${refs(50)}`).refs).toHaveLength(50);
    expect(error(`?sessions=${refs(51)}`)).toBe('At most 50 sessions fit in one calendar file.');
    expect(ok(`?sessions=${'A'.repeat(80)}`).refs).toEqual(['A'.repeat(80)]);
    expect(error(`?sessions=${'A'.repeat(81)}`)).toBe('Session references are at most 80 characters long.');
  });

  it('reads a calendar name of at most 80 characters', () => {
    expect(ok('?sessions=A&name=My%20Ignite').name).toBe('My Ignite');
    expect(ok('?sessions=A&name=%20%20Padded%20').name).toBe('Padded');
    expect(ok('?sessions=A&name=').name).toBeUndefined();
    expect(ok('?sessions=A&name=%20').name).toBeUndefined();
    expect(ok(`?sessions=A&name=${'n'.repeat(80)}`).name).toHaveLength(80);
    expect(error(`?sessions=A&name=${'n'.repeat(81)}`)).toBe('The calendar name is at most 80 characters long.');
  });

  it('reads a reminder of 0 to 1440 whole minutes', () => {
    expect(ok('?sessions=A').reminderMinutes).toBeUndefined();
    expect(ok('?sessions=A&reminder=').reminderMinutes).toBeUndefined();
    expect(ok('?sessions=A&reminder=%20').reminderMinutes).toBeUndefined();
    expect(ok('?sessions=A&reminder=0').reminderMinutes).toBe(0);
    expect(ok('?sessions=A&reminder=15').reminderMinutes).toBe(15);
    expect(ok('?sessions=A&reminder=1440').reminderMinutes).toBe(1440);
    for (const reminder of ['1441', '9999', '12345', '-5', '1.5', '1e2', '15m', 'abc', '0x10', '+5']) {
      expect(error(`?sessions=A&reminder=${encodeURIComponent(reminder)}`)).toBe('reminder must be a whole number of minutes between 0 and 1440.');
    }
  });

  it('understands the links export_calendar hands out, with every limit it has', () => {
    const slotIds = Array.from({ length: 50 }, (_, index) => `BRKSP${590 + index}@2026-11-1${(index % 4) + 6}T1${index % 10}:30`);
    const url = new URL(calendarDownloadUrl('https://ignite.example.test/', slotIds, { name: `${'Ñ'.repeat(40)} & friends, "quoted"`, reminderMinutes: 1440 }));
    expect(url.origin + url.pathname).toBe('https://ignite.example.test/calendar.ics');
    const parsed = ok(url.search);
    expect(parsed.refs).toEqual(slotIds);
    expect(parsed.name).toBe(`${'Ñ'.repeat(40)} & friends, "quoted"`);
    expect(parsed.reminderMinutes).toBe(1440);
  });
});
