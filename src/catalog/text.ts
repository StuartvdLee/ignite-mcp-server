const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
const SPACE_LIKE = /[\u00A0\u2007\u202F]/g;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Single-line text: zero-width characters removed, whitespace collapsed. */
export function cleanInline(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(ZERO_WIDTH, '').replace(SPACE_LIKE, ' ').replace(/\s+/g, ' ').trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/** Converts the HTML used in session descriptions to readable plain text. */
export function htmlToText(html: unknown): string {
  if (typeof html !== 'string') return '';
  let text = html.replace(
    /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, double: string | undefined, single: string | undefined, inner: string) => {
      const href = decodeEntities(double ?? single ?? '').trim();
      const label = decodeEntities(stripTags(inner)).replace(/\s+/g, ' ').trim();
      if (!href || href === label || /^(#|mailto:|javascript:)/i.test(href)) return label || href;
      return label ? `${label} (${href})` : href;
    },
  );
  text = text
    // Consecutive list items stay one tight list instead of getting a blank line between them.
    .replace(/<\/li\s*>\s*(?=<li\b)/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(?:p|div|li|ul|ol|h[1-6]|tr|table|blockquote)\s*>/gi, '\n');
  text = decodeEntities(stripTags(text)).replace(ZERO_WIDTH, '').replace(SPACE_LIKE, ' ');
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\r]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, ' ');
}

/** Sentences (or list lines) of a plain-text description. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** Lowercase, accent-free, punctuation-free form used for loose matching. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}
