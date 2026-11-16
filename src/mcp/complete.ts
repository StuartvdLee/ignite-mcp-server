import type { Catalog } from '../catalog/catalog';

/** Clients show a short list; the protocol allows at most 100. */
export const MAX_COMPLETIONS = 20;

const MAX_TYPED = 100;

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** Session codes for an autocomplete box: codes starting with what was typed first, then keyword matches. */
export function completeSessionCodes(catalog: Catalog, typed: string): string[] {
  const value = typed.trim().slice(0, MAX_TYPED);
  if (value === '') {
    return catalog.sessions
      .filter((session) => session.featured)
      .slice(0, MAX_COMPLETIONS)
      .map((session) => session.code);
  }
  const prefix = value.replace(/\s+/g, '').toUpperCase();
  const byCode = catalog.sessions.filter((session) => session.code.startsWith(prefix)).map((session) => session.code);
  if (byCode.length >= MAX_COMPLETIONS) return byCode.slice(0, MAX_COMPLETIONS);
  const byKeyword = catalog.search({ query: value, limit: MAX_COMPLETIONS }).hits.map((hit) => hit.session.code);
  return unique([...byCode, ...byKeyword]).slice(0, MAX_COMPLETIONS);
}

/** Names starting with what was typed first, then names that contain it. */
export function completeFromList(candidates: readonly string[], typed: string): string[] {
  const value = typed.trim().slice(0, MAX_TYPED).toLowerCase();
  if (value === '') return candidates.slice(0, MAX_COMPLETIONS);
  const lower = candidates.map((candidate) => candidate.toLowerCase());
  const starts = candidates.filter((_, index) => lower[index]?.startsWith(value));
  const contains = candidates.filter((_, index) => lower[index]?.includes(value) && !lower[index]?.startsWith(value));
  return [...starts, ...contains].slice(0, MAX_COMPLETIONS);
}

/** For a comma-separated value, completes the last item and keeps the ones before it. */
export function completeLastItem(candidates: readonly string[], typed: string): string[] {
  const cut = typed.lastIndexOf(',');
  const head = cut === -1 ? '' : `${typed.slice(0, cut).trim()}, `;
  return completeFromList(candidates, cut === -1 ? typed : typed.slice(cut + 1)).map((candidate) => `${head}${candidate}`);
}

/** Topics first, then tags: the vocabulary people search with. */
export function interestCandidates(catalog: Catalog): string[] {
  return unique([...catalog.facets.topics, ...catalog.facets.tags].map((facet) => facet.name));
}
