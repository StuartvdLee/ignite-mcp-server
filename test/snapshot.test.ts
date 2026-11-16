import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SNAPSHOT_SCHEMA_VERSION } from '../src/catalog/types';
import type { CatalogSnapshot, Session } from '../src/catalog/types';
import { EVENT } from '../src/event';
import { SNAPSHOT_PATH, pacific, snapshotCatalog } from './helpers';

const NOW = pacific('2026-11-16', '12:00');
const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as CatalogSnapshot;

const text = (session: Session) => [session.title, session.description, ...session.tags, ...session.topics].join(' ').toLowerCase();

describe('bundled session snapshot', () => {
  it('has the expected format and a plausible amount of data', () => {
    expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(Number.isFinite(Date.parse(snapshot.generatedAt))).toBe(true);
    expect(snapshot.sourceUrl).toMatch(/^https:\/\//);
    expect(snapshot.sessions.length).toBeGreaterThan(1000);
  });

  it('holds well-formed sessions with unique codes', () => {
    const codes = new Set<string>();
    for (const session of snapshot.sessions) {
      expect(codes.has(session.code), `duplicate ${session.code}`).toBe(false);
      codes.add(session.code);
      expect(session.code).toMatch(/^[A-Z]+\d+[A-Z]?$/);
      expect(session.title.trim()).not.toBe('');
      expect(session.url).toMatch(/^https:\/\/ignite\.microsoft\.com\/en-US\/sessions\//);
      expect(session.onDemand).toBe(session.occurrences.length === 0);
      for (const slot of session.occurrences) {
        expect(slot.slotId).toMatch(new RegExp(`^${session.code}@\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$`));
        expect(slot.endMs).toBeGreaterThan(slot.startMs);
        expect(slot.date).toBe(slot.slotId.slice(session.code.length + 1, session.code.length + 11));
      }
    }
    for (const session of snapshot.sessions) {
      for (const related of session.relatedCodes) expect(codes.has(related), `${session.code} -> ${related}`).toBe(true);
    }
  });

  it('is sorted by code and free of the raw embedding data', () => {
    const codes = snapshot.sessions.map((session) => session.code);
    expect(codes).toEqual([...codes].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })));
    expect(JSON.stringify(snapshot).includes('embeddingContent')).toBe(false);
  });

  it('only schedules sessions during the event', () => {
    const days = new Set(snapshot.sessions.flatMap((session) => session.occurrences.map((slot) => slot.date)));
    expect([...days].sort()).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']);
    expect(EVENT.timeZone).toBe('America/Los_Angeles');
  });
});

describe('search quality on the full catalog', () => {
  it('keeps "responsible AI" about responsible AI, not about "responses"', async () => {
    const catalog = await snapshotCatalog();
    const { hits } = catalog.search({ query: 'responsible AI', limit: 10, nowMs: NOW });
    expect(hits).toHaveLength(10);
    for (const hit of hits) expect(text(hit.session), hit.session.code).toMatch(/responsib/);
  });

  it('finds MCP sessions through the abbreviation and the spelled-out phrase', async () => {
    const catalog = await snapshotCatalog();
    const abbreviation = catalog.search({ query: 'MCP', limit: 25, nowMs: NOW });
    expect(abbreviation.total).toBeGreaterThan(20);
    for (const hit of abbreviation.hits) expect(text(hit.session), hit.session.code).toMatch(/\bmcp\b|model context protocol/);
    const phrase = catalog.search({ query: 'model context protocol', limit: 5, nowMs: NOW });
    expect(phrase.expansions).toEqual(['mcp = model context protocol']);
    for (const hit of phrase.hits) expect(text(hit.session), hit.session.code).toMatch(/\bmcp\b|model context protocol/);
  });

  it('treats Kubernetes and AKS as related but ranks literal mentions first', async () => {
    const catalog = await snapshotCatalog();
    const kubernetes = catalog.search({ query: 'kubernetes', limit: 10, nowMs: NOW });
    expect(kubernetes.hits.slice(0, 2).map((hit) => hit.session.title.toLowerCase()).join(' ')).toContain('kubernetes');
    for (const hit of kubernetes.hits) expect(text(hit.session), hit.session.code).toMatch(/kubernetes|\baks\b|k8s/);
    const aks = catalog.search({ query: 'AKS', limit: 6, nowMs: NOW });
    for (const hit of aks.hits) expect(hit.session.title, hit.session.code).toMatch(/\bAKS\b/);
  });

  it('ranks the product named in the query first', async () => {
    const catalog = await snapshotCatalog();
    const { hits } = catalog.search({ query: 'Azure Container Apps', limit: 4, nowMs: NOW });
    for (const hit of hits) expect(hit.session.title, hit.session.code).toMatch(/Container Apps/);
  });

  it('puts the exact code first, followed at most by its own variants', async () => {
    const catalog = await snapshotCatalog();
    for (const code of ['BRK217', 'LAB724', 'KEY01']) {
      const { hits } = catalog.search({ query: code, nowMs: NOW });
      expect(hits[0]?.session.code, code).toBe(code);
      for (const hit of hits) expect(hit.session.code.startsWith(code), `${code} -> ${hit.session.code}`).toBe(true);
    }
    expect(catalog.search({ query: 'BRK217', nowMs: NOW }).total).toBe(1);
  });

  it('combines a query with filters on the full catalog', async () => {
    const catalog = await snapshotCatalog();
    const { hits, total } = catalog.search({
      query: 'agents',
      filters: { days: ['Wednesday'], startAfter: '13:00', startBefore: '15:00', types: ['breakout'], delivery: ['in person'] },
      nowMs: NOW,
      limit: 25,
    });
    expect(total).toBeGreaterThan(0);
    for (const { session, occurrences } of hits) {
      expect(session.type).toBe('Breakout');
      expect(occurrences.length).toBeGreaterThan(0);
      for (const slot of occurrences) {
        expect(slot.date).toBe('2026-11-18');
        expect(slot.startTime >= '13:00' && slot.startTime < '15:00', slot.slotId).toBe(true);
      }
    }
  });
});
