import { sessionUrl } from '../event';
import { cleanInline, htmlToText } from './text';
import { localParts } from './time';
import type { Occurrence, Resource, Session, Speaker } from './types';

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads `{displayValue, logicalValue}` facet objects (single or array) as unique strings. */
function facetValues(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const out: string[] = [];
  for (const item of list) {
    const text = cleanInline(isRecord(item) ? (item.displayValue ?? item.logicalValue) : item);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

const CREDENTIAL =
  /^(?:phd|mba|md|jd|dba|esq|jr|sr|ii|iii|iv|cissp|cism|ccsp|cpa|pmp|ms|msc|mph|dds|dvm|rn|pe|cfa)$/i;

function speakerRole(type: string): string | undefined {
  const text = type.toLowerCase();
  if (text.includes('executive')) return 'Executive';
  if (text.includes('customer')) return 'Customer';
  if (text.includes('mvp')) return 'MVP';
  if (text.includes('sponsor')) return 'Sponsor';
  return undefined;
}

function parseSpeakers(raw: Raw): Speaker[] {
  const names: string[] = [];
  for (const segment of cleanInline(raw.speakerNames).split(',')) {
    const part = segment.trim();
    if (!part) continue;
    // "Amy Curley, PhD" is one person: attach credentials to the previous name.
    if (names.length > 0 && CREDENTIAL.test(part.replace(/\./g, ''))) {
      names[names.length - 1] += `, ${part}`;
    } else {
      names.push(part);
    }
  }
  const ids = Array.isArray(raw.speakerIds) ? raw.speakerIds.map((id) => cleanInline(String(id))) : [];
  const roles = new Map<string, string>();
  if (Array.isArray(raw.SpeakerTypes)) {
    for (const entry of raw.SpeakerTypes) {
      if (!isRecord(entry)) continue;
      const role = speakerRole(cleanInline(entry.SpeakerType));
      const id = cleanInline(entry.SpeakerId);
      if (role && id) roles.set(id, role);
    }
  }
  const aligned = ids.length === names.length;
  return names.map((name, index) => {
    const id = aligned ? ids[index] : undefined;
    const role = id ? roles.get(id) : undefined;
    return { name, ...(id ? { id } : {}), ...(role ? { role } : {}) };
  });
}

function cleanLink(value: unknown, depth = 0): string | undefined {
  let link = cleanInline(value).replace(/\s+/g, '');
  if (!link) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(link)) link = `https://${link}`;
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (depth === 0 && url.hostname.endsWith('safelinks.protection.outlook.com')) {
      const inner = url.searchParams.get('url');
      if (inner) return cleanLink(inner, 1);
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function parseResources(raw: Raw): Resource[] {
  const out: Resource[] = [];
  if (!Array.isArray(raw.relatedResources)) return out;
  for (const entry of raw.relatedResources) {
    if (!isRecord(entry)) continue;
    const url = cleanLink(entry.link);
    if (!url || out.some((existing) => existing.url === url)) continue;
    out.push({ label: cleanInline(entry.label) || new URL(url).hostname, url });
  }
  return out;
}

function parseOccurrence(code: string, raw: Raw): Occurrence | undefined {
  const startMs = Date.parse(cleanInline(raw.startDateTime));
  if (!Number.isFinite(startMs)) return undefined;
  const duration = Number(raw.durationInMinutes);
  let endMs = Date.parse(cleanInline(raw.endDateTime));
  if (!Number.isFinite(endMs) || endMs <= startMs) {
    endMs = startMs + (Number.isFinite(duration) && duration > 0 ? duration : 30) * 60_000;
  }
  const start = localParts(startMs);
  const end = localParts(endMs);
  const location = isRecord(raw.location) ? cleanInline(raw.location.displayValue) : '';
  const [venuePart, ...roomParts] = location.split('|').map((part) => part.trim());
  const venue = venuePart || undefined;
  const room = roomParts.join(' | ') || undefined;
  return {
    slotId: `${code}@${start.date}T${start.time}`,
    instanceId: cleanInline(raw.sessionInstanceId) || `${cleanInline(raw.sessionId)}-${cleanInline(raw.sessionTimeId)}`,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    startMs,
    endMs,
    durationMinutes: Math.round((endMs - startMs) / 60_000),
    ...(location ? { location } : {}),
    ...(venue ? { venue } : {}),
    ...(room ? { room } : {}),
    date: start.date,
    startTime: start.time,
    endTime: end.time,
  };
}

function parseLevel(raw: Raw): { level?: string; levelNumber?: number } {
  const value = facetValues(raw.sessionLevel)[0];
  if (!value) return {};
  const match = /^\(?(\d{3})\)?\s*[-–:]?\s*(.*)$/.exec(value);
  if (!match) return { level: value };
  const level = match[2]?.trim();
  return { ...(level ? { level } : {}), levelNumber: Number(match[1]) };
}

const isSponsorCode = (code: string): boolean => /^[A-Z]*SP\d/.test(code);

export interface NormalizeResult {
  sessions: Session[];
  skipped: number;
}

/**
 * Turns the official session feed (one record per session *instance*) into one
 * `Session` per session code, each with its list of scheduled occurrences.
 */
export function normalizeCatalog(feed: unknown): NormalizeResult {
  if (!Array.isArray(feed)) throw new Error('Expected the session feed to be a JSON array');

  const groups = new Map<string, Raw[]>();
  let skipped = 0;
  for (const record of feed) {
    if (!isRecord(record)) {
      skipped++;
      continue;
    }
    const code = cleanInline(record.sessionCode).toUpperCase();
    if (!code || !cleanInline(record.title) || !cleanInline(record.sessionId)) {
      skipped++;
      continue;
    }
    const group = groups.get(code);
    if (group) group.push(record);
    else groups.set(code, [record]);
  }

  const sessions: Session[] = [];
  const codeBySessionId = new Map<string, string>();
  const relatedRaw = new Map<string, string[]>();

  for (const [code, records] of groups) {
    const base = records.reduce((best, candidate) =>
      cleanInline(candidate.lastUpdate) > cleanInline(best.lastUpdate) ? candidate : best,
    );
    const id = cleanInline(base.sessionId);
    codeBySessionId.set(id, code);

    const occurrences = new Map<string, Occurrence>();
    for (const record of records) {
      const occurrence = parseOccurrence(code, record);
      if (occurrence && !occurrences.has(occurrence.slotId)) occurrences.set(occurrence.slotId, occurrence);
    }

    const related = new Set<string>();
    for (const record of records) {
      if (!Array.isArray(record.relatedSessionInstanceIds)) continue;
      for (const instance of record.relatedSessionInstanceIds) related.add(cleanInline(String(instance)).split('-')[0] ?? '');
    }
    relatedRaw.set(code, [...related].filter(Boolean));

    const { level, levelNumber } = parseLevel(base);
    const sorted = [...occurrences.values()].sort((a, b) => a.startMs - b.startMs);
    const session: Session = {
      code,
      id,
      title: cleanInline(base.title),
      description: htmlToText(base.description),
      type: facetValues(base.sessionType)[0] ?? 'Session',
      topics: facetValues(base.topic),
      ...(level ? { level } : {}),
      ...(levelNumber !== undefined ? { levelNumber } : {}),
      audiences: facetValues(base.audienceTypes),
      industries: facetValues(base.industry),
      tags: facetValues(base.tags),
      delivery: facetValues(base.deliveryTypes),
      speakers: parseSpeakers(base),
      companies: Array.isArray(base.associatedCompanies)
        ? [...new Set(base.associatedCompanies.map((company) => cleanInline(company)).filter(Boolean))]
        : [],
      recorded: facetValues(base.viewingOptions).some((option) => /will be recorded/i.test(option)),
      liveStream: records.some((record) => record.hasLiveStream === true),
      sponsored: isSponsorCode(code),
      reservableSeating: /^reservable/i.test(cleanInline(base.seatingExperience)),
      featured: base.heroSession === true,
      onDemand: sorted.length === 0,
      occurrences: sorted,
      relatedCodes: [],
      resources: parseResources(base),
      url: sessionUrl(id),
    };
    sessions.push(session);
  }

  for (const session of sessions) {
    const codes = (relatedRaw.get(session.code) ?? [])
      .map((sessionId) => codeBySessionId.get(sessionId))
      .filter((related): related is string => !!related && related !== session.code);
    session.relatedCodes = [...new Set(codes)];
  }

  sessions.sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
  return { sessions, skipped };
}
