import { describe, expect, it } from 'vitest';
import { instantLabel, joinList, linkText, minutesLabel, plural, TIME_NOTE } from '../src/mcp/format';
import { pacific } from './helpers';

describe('plural', () => {
  it('uses the singular for exactly one', () => {
    expect(plural(1, 'session')).toBe('1 session');
    expect(plural(0, 'session')).toBe('0 sessions');
    expect(plural(2, 'session')).toBe('2 sessions');
  });

  it('takes an irregular plural', () => {
    expect(plural(1, 'match', 'matches')).toBe('1 match');
    expect(plural(3, 'match', 'matches')).toBe('3 matches');
  });
});

describe('joinList', () => {
  it.each([
    [[], ''],
    [['a'], 'a'],
    [['a', 'b'], 'a and b'],
    [['a', 'b', 'c'], 'a, b and c'],
    [['"MCP"', '"zero trust"', '"AKS"', '"Fabric"'], '"MCP", "zero trust", "AKS" and "Fabric"'],
  ])('joins %j as "%s"', (items, expected) => {
    expect(joinList(items)).toBe(expected);
  });

  it('takes another conjunction and leaves its argument alone', () => {
    const items = ['a', 'b', 'c'];
    expect(joinList(items, 'or')).toBe('a, b or c');
    expect(items).toEqual(['a', 'b', 'c']);
  });
});

describe('instantLabel', () => {
  it.each([
    ['2026-11-18', '14:00', 'Wed Nov 18, 2:00 PM'],
    ['2026-11-17', '00:05', 'Tue Nov 17, 12:05 AM'],
    ['2026-11-17', '12:00', 'Tue Nov 17, 12:00 PM'],
    ['2026-11-19', '23:59', 'Thu Nov 19, 11:59 PM'],
  ])('shows %s %s Pacific as "%s"', (date, time, expected) => {
    expect(instantLabel(pacific(date, time))).toBe(expected);
  });

  it('uses the day in San Francisco, not the UTC day', () => {
    expect(instantLabel(Date.UTC(2026, 10, 20, 0, 30))).toBe('Thu Nov 19, 4:30 PM');
  });
});

describe('minutesLabel', () => {
  it.each([
    [0, '0 minutes'],
    [1, '1 minute'],
    [25, '25 minutes'],
    [59, '59 minutes'],
    [60, '1 hour'],
    [61, '1 hour 1 minute'],
    [65, '1 hour 5 minutes'],
    [90, '1 hour 30 minutes'],
    [120, '2 hours'],
    [135, '2 hours 15 minutes'],
  ])('says %i minutes as "%s"', (minutes, expected) => {
    expect(minutesLabel(minutes)).toBe(expected);
  });
});

describe('linkText', () => {
  it('escapes the brackets that would end a Markdown link label early', () => {
    expect(linkText('A [beta] talk')).toBe('A \\[beta\\] talk');
    expect(`[${linkText('Ends with ]')}](https://example.test)`).toBe('[Ends with \\]](https://example.test)');
  });

  it('leaves other text alone', () => {
    expect(linkText('Plain (text) & more')).toBe('Plain (text) & more');
  });
});

describe('TIME_NOTE', () => {
  it('names the time zone of every time that the tools show', () => {
    expect(TIME_NOTE).toBe('All times are Pacific Time (San Francisco).');
  });
});
