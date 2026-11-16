import { clock12, dayLabel, localParts } from '../catalog/time';

export const TIME_NOTE = 'All times are Pacific Time (San Francisco).';

export function plural(count: number, singular: string, pluralForm: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** `a, b and c` */
export function joinList(items: readonly string[], conjunction = 'and'): string {
  const [last, ...rest] = [...items].reverse();
  if (last === undefined) return '';
  return rest.length === 0 ? last : `${rest.reverse().join(', ')} ${conjunction} ${last}`;
}

/** `Wed Nov 18, 2:00 PM` for an instant, in event time. */
export function instantLabel(ms: number): string {
  const { date, time } = localParts(ms);
  return `${dayLabel(date)}, ${clock12(time)}`;
}

/** `25 minutes`, `1 hour 30 minutes` */
export function minutesLabel(minutes: number): string {
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? plural(hours, 'hour') : `${plural(hours, 'hour')} ${plural(rest, 'minute')}`;
}

/** Escapes the characters that would end a Markdown link label early. */
export function linkText(text: string): string {
  return text.replace(/[[\]]/g, '\\$&');
}
