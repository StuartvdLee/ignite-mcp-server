import { describe, expect, it } from 'vitest';
import { cleanInline, htmlToText, normalizeForMatch, splitSentences, stripUrls, truncate } from '../src/catalog/text';

describe('cleanInline', () => {
  it('removes zero-width characters, non-breaking spaces and extra whitespace', () => {
    expect(cleanInline('Mi\u200Bcro\u00ADsoft\u2060 \uFEFFIgnite')).toBe('Microsoft Ignite');
    expect(cleanInline('  a\u00A0\u00A0b \n\t c  ')).toBe('a b c');
  });

  it('turns anything but a string into an empty string', () => {
    expect(cleanInline(undefined)).toBe('');
    expect(cleanInline(null)).toBe('');
    expect(cleanInline(42)).toBe('');
    expect(cleanInline({})).toBe('');
  });
});

describe('htmlToText', () => {
  it('keeps link targets that add information', () => {
    expect(htmlToText('<p>Read <a href="https://example.com/docs">the docs</a>.</p>')).toBe('Read the docs (https://example.com/docs).');
  });

  it('does not repeat a link whose text is its address, or add useless targets', () => {
    expect(htmlToText('<a href="https://example.com">https://example.com</a>')).toBe('https://example.com');
    expect(htmlToText('<a href="mailto:a@b.c">Mail us</a> <a href="#top">Top</a> <a href="javascript:void(0)">Click</a>')).toBe('Mail us Top Click');
    expect(htmlToText("<a href='https://x.test/?a=1&amp;b=2'>x</a>")).toBe('x (https://x.test/?a=1&b=2)');
  });

  it('turns structure into line breaks and bullets', () => {
    expect(htmlToText('<p>One</p><p>Two<br>three</p>')).toBe('One\nTwo\nthree');
    expect(htmlToText('<ul><li>a</li><li>b</li></ul>')).toBe('- a\n- b');
    expect(htmlToText('<p>a</p><p></p><p></p><p></p><p>b</p>')).toBe('a\n\nb');
  });

  it('decodes named and numeric entities and leaves unknown ones alone', () => {
    expect(htmlToText('Q&amp;A &#8217;s &#x2014; &nbsp;&lt;b&gt; &unknown; &#0; &#1114112;')).toBe('Q&A ’s — <b> &unknown; &#0; &#1114112;');
  });

  it('strips tags and handles non-strings', () => {
    expect(htmlToText('<b>bold</b> <i>text</i>')).toBe('bold text');
    expect(htmlToText(undefined)).toBe('');
    expect(htmlToText(12)).toBe('');
  });
});

describe('stripUrls and splitSentences', () => {
  it('removes web addresses', () => {
    expect(stripUrls('See https://a.test/x?y=1 and http://b.test now').replace(/\s+/g, ' ')).toBe('See and now');
  });

  it('splits sentences and list lines', () => {
    expect(splitSentences('One. Two! Three?\n- four\n- five')).toEqual(['One.', 'Two!', 'Three?', '- four', '- five']);
  });
});

describe('normalizeForMatch', () => {
  it('lowercases, drops accents and punctuation', () => {
    expect(normalizeForMatch('Café  Déjà-vu, C#!')).toBe('cafe deja vu c');
    expect(normalizeForMatch('')).toBe('');
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short  text', 50)).toBe('short text');
  });

  it('cuts at a word boundary and adds an ellipsis', () => {
    expect(truncate('Build agents that call tools, with governance', 30)).toBe('Build agents that call tools…');
  });

  it('cuts mid-word when there is no good boundary', () => {
    expect(truncate('a'.repeat(40), 10)).toBe(`${'a'.repeat(10)}…`);
  });
});
