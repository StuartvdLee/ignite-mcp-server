import { timeRangeLabel } from '../catalog/time';
import { joinList, linkText, minutesLabel, plural, TIME_NOTE } from './format';
import type {
  AgendaOutput,
  AgendaSession,
  CalendarOutput,
  ConflictsOutput,
  LiveSession,
  OverviewOutput,
  RecommendOutput,
  SearchOutput,
  SessionDetailOutput,
  SessionSummary,
  Slot,
  WhatsOnOutput,
} from './schemas';

/*
 * The text of a tool result is what many clients show and what the model reads first, so it carries every key
 * fact. The structured content holds the same information for programmatic use.
 */

const link = (title: string, url: string): string => `[${linkText(title)}](${url})`;

const quoted = (values: readonly string[]): string[] => values.map((value) => `"${value}"`);

const notes = (warnings: readonly string[]): string[] => warnings.map((warning) => `Note: ${warning}`);

const filterNote = (filters: readonly string[]): string => (filters.length > 0 ? ` Filters: ${filters.join('; ')}.` : '');

const facetList = (facets: readonly { name: string; count: number }[]): string => facets.map((facet) => `${facet.name} (${facet.count})`).join(', ');

function metaLine(s: SessionSummary): string {
  return [s.type, s.level, s.delivery.join(' + '), s.onDemand ? 'On demand' : s.recorded ? 'Recorded' : undefined]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

function whenText(slots: readonly Slot[], onDemand: boolean): string {
  if (slots.length === 0) return onDemand ? 'No fixed time: watch on demand' : 'Time not announced yet';
  return slots.map((slot) => slot.label).join(' | ');
}

function speakersText(s: SessionSummary): string {
  if (s.speakers.length === 0) return '';
  const more = s.speakerCount - s.speakers.length;
  return `${s.speakers.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
}

/** A list entry: title line, facts, time and place, speakers, optional extra lines and an excerpt. */
export function sessionEntry(s: SessionSummary, options: { index?: number; extra?: readonly string[] } = {}): string {
  const bullet = options.index === undefined ? '-' : `${options.index}.`;
  const indent = ' '.repeat(bullet.length + 1);
  const lines = [`${bullet} **${s.code}** · ${link(s.title, s.url)}`, `${indent}${metaLine(s)}`, `${indent}${whenText(s.slots, s.onDemand)}`];
  const speakers = speakersText(s);
  if (speakers) lines.push(`${indent}Speakers: ${speakers}`);
  for (const extra of options.extra ?? []) lines.push(`${indent}${extra}`);
  if (s.summary) lines.push(`${indent}${s.summary}`);
  return lines.join('\n');
}

export function searchText(out: SearchOutput): string {
  const subject = out.query ? ` for "${out.query}"` : '';
  if (out.total === 0) {
    return [
      `No sessions found${subject}.${filterNote(out.filters)}`,
      ...notes(out.warnings),
      'Try different keywords or fewer filters. get_catalog_overview lists the topics, session types and popular tags.',
    ].join('\n');
  }
  if (out.returned === 0) return `Offset ${out.offset} is past the end: only ${plural(out.total, 'session')} matched${subject}.`;

  const last = out.offset + out.returned;
  const lines = [`${plural(out.total, 'session')} found${subject}; showing ${out.offset + 1}–${last}.${filterNote(out.filters)} ${TIME_NOTE}`];
  if (out.alsoSearched.length > 0) lines.push(`Also searched related terms: ${out.alsoSearched.join(', ')}.`);
  lines.push(...notes(out.warnings), '');
  out.sessions.forEach((session, index) => {
    const extra = session.matchedOn.length > 0 ? [`Matched: ${session.matchedOn.join('; ')}`] : [];
    lines.push(sessionEntry(session, { index: out.offset + index + 1, extra }));
  });
  if (out.nextOffset !== undefined) lines.push('', `${plural(out.total - last, 'more session')}: call again with offset=${out.nextOffset}.`);
  return lines.join('\n');
}

export function sessionDetailText(d: SessionDetailOutput): string {
  const lines = [`# ${d.code}: ${d.title}`, [d.type, d.level, d.delivery.join(' + ')].filter(Boolean).join(' · '), `Catalog page: ${d.url}`];

  lines.push('', d.slots.length > 0 ? `When (${TIME_NOTE.replace('All times are ', '').replace(/\.$/, '')}):` : 'When:');
  if (d.slots.length === 0) lines.push(d.onDemand ? '- On demand: no fixed time' : '- Not scheduled yet');
  for (const slot of d.slots) lines.push(`- ${slot.label} [slot id: ${slot.slotId}]`);

  if (d.speakers.length > 0) {
    lines.push('', `Speakers: ${d.speakers.map((speaker) => (speaker.role ? `${speaker.name} (${speaker.role})` : speaker.name)).join(', ')}`);
  }
  if (d.companies.length > 0) lines.push(`Companies: ${d.companies.join(', ')}`);
  if (d.topics.length > 0) lines.push(`Topics: ${d.topics.join(', ')}`);
  if (d.audiences.length > 0) lines.push(`Audience: ${d.audiences.join(', ')}`);
  if (d.industries.length > 0) lines.push(`Industries: ${d.industries.join(', ')}`);
  if (d.tags.length > 0) lines.push(`Tags: ${d.tags.join(', ')}`);
  const flags = [
    d.recorded && 'Recorded',
    d.liveStream && 'Live stream',
    d.sponsored && 'Sponsored',
    d.featured && 'Featured',
    d.reservableSeating && 'Reservable seating',
  ].filter(Boolean);
  if (flags.length > 0) lines.push(`Flags: ${flags.join(', ')}`);

  lines.push('', d.description || 'No description available.');
  if (d.resources.length > 0) lines.push('', 'Resources:', ...d.resources.map((resource) => `- ${link(resource.label, resource.url)}`));
  const listRelated = (heading: string, items: SessionDetailOutput['related']): void => {
    if (items.length === 0) return;
    lines.push('', `${heading}:`, ...items.map((item) => `- **${item.code}** ${item.title} (${item.type}${item.when ? `; ${item.when}` : ''})`));
  };
  listRelated('Linked sessions', d.related);
  listRelated('Similar sessions', d.similar);
  return lines.join('\n');
}

export function recommendText(out: RecommendOutput): string {
  if (out.recommendations.length === 0) {
    return [`No sessions matched your interests.${filterNote(out.filters)}`, ...notes(out.warnings), 'Try other words, broader topics or fewer filters.'].join('\n');
  }
  const lines = [
    `${plural(out.returned, 'recommendation')} for ${joinList(quoted(out.interests.map((interest) => interest.interest)))}.${filterNote(out.filters)} ${TIME_NOTE}`,
    `Good matches per interest: ${out.interests.map((interest) => `"${interest.interest}" (${interest.matches})`).join(', ')}.`,
  ];
  if (out.unmatchedInterests.length > 0) lines.push(`No good match for ${joinList(quoted(out.unmatchedInterests))}: try other words or fewer filters.`);
  lines.push(...notes(out.warnings), '');
  out.recommendations.forEach((recommendation, index) => {
    lines.push(sessionEntry(recommendation, { index: index + 1, extra: [`Why: ${recommendation.why}`] }));
  });
  return lines.join('\n');
}

function liveLine(s: LiveSession): string {
  const slot = s.slots[0];
  const timing =
    s.minutesLeft !== undefined ? `${minutesLabel(s.minutesLeft)} left` : s.startsInMinutes !== undefined ? `starts in ${minutesLabel(s.startsInMinutes)}` : '';
  return `- **${s.code}** · ${link(s.title, s.url)} · ${s.type}${slot ? ` · ${slot.label}` : ''}${timing ? ` · ${timing}` : ''}`;
}

function liveSection(heading: string, group: { total: number; sessions: LiveSession[] }): string[] {
  if (group.sessions.length === 0) return [];
  const shown = group.sessions.length < group.total ? ` (${group.sessions.length} of ${group.total} shown)` : '';
  return ['', `${heading}${shown}:`, ...group.sessions.map(liveLine)];
}

export function whatsOnText(out: WhatsOnOutput): string {
  return [
    out.message,
    ...notes(out.warnings),
    ...liveSection('In progress', out.inProgress),
    ...liveSection(`Starting within ${minutesLabel(out.windowMinutes)}`, out.startingSoon),
    ...liveSection('Next to start', out.next),
  ].join('\n');
}

function agendaEntry(s: AgendaSession): string {
  const slot = s.slots[0];
  const time = slot ? timeRangeLabel(slot.startTime, slot.endTime) : 'Time to be announced';
  const place = slot ? [slot.venue, slot.room].filter(Boolean).join(', ') : '';
  const lines = [`- ${time} · **${s.code}** · ${link(s.title, s.url)}${s.pinned ? ' (requested)' : ''}`, `  ${metaLine(s)}${place ? ` · ${place}` : ''}`];
  if (s.why) lines.push(`  Why: ${s.why}`);
  if (s.alternatives.length > 0) lines.push(`  At the same time: ${s.alternatives.map((alternative) => `${alternative.code} ${alternative.title}`).join('; ')}`);
  if (s.otherSlots.length > 0) lines.push(`  Also offered: ${s.otherSlots.map((other) => other.label).join(' | ')}`);
  return lines.join('\n');
}

export function agendaText(out: AgendaOutput): string {
  const lines: string[] = [];
  if (out.totalSessions === 0) {
    lines.push('No scheduled sessions could be planned.', ...notes(out.warnings));
  } else {
    lines.push(`Agenda: ${plural(out.totalSessions, 'session')} on ${plural(out.days.length, 'day')}. ${TIME_NOTE}`, ...notes(out.warnings));
  }
  lines.push('', 'Assumptions:', ...out.assumptions.map((assumption) => `- ${assumption}`));

  for (const day of out.days) {
    lines.push('', `## ${day.day}`, ...day.sessions.map(agendaEntry));
  }
  if (out.onDemand.length > 0) {
    lines.push('', '## On demand (watch any time)');
    for (const recommendation of out.onDemand) lines.push(sessionEntry(recommendation, { extra: [`Why: ${recommendation.why}`] }));
  }
  if (out.skipped.length > 0) {
    lines.push('', 'Good matches that did not fit:', ...out.skipped.map((skipped) => `- **${skipped.code}** ${skipped.title} (${skipped.label}): ${skipped.reason}`));
  }
  if (out.coverage.length > 0) lines.push('', `Sessions per interest: ${out.coverage.map((entry) => `"${entry.interest}" (${entry.sessions})`).join(', ')}.`);
  if (out.uncoveredInterests.length > 0) lines.push(`Not covered: ${joinList(quoted(out.uncoveredInterests))}. Try other words or relax the filters.`);
  if (out.pinnedConflicts.length > 0) lines.push('', 'Clashes between the sessions you asked for:', ...out.pinnedConflicts.map((conflict) => `- ${conflict.message}`));
  if (out.unresolved.length > 0) lines.push('', 'Could not find:', ...out.unresolved.map((item) => `- "${item.ref}": ${item.reason}`));
  if (out.slotIds.length > 0) lines.push('', `To add this agenda to a calendar, call export_calendar with items: ${JSON.stringify(out.slotIds)}`);
  return lines.join('\n');
}

function noConflictsText(scheduled: number): string {
  if (scheduled === 0) return 'No conflicts: none of the sessions has a fixed time.';
  if (scheduled === 1) return 'No conflicts: only one session has a fixed time.';
  return `No conflicts: ${scheduled} sessions fit together.`;
}

export function conflictsText(out: ConflictsOutput): string {
  const verdict = out.ok
    ? noConflictsText(out.schedule.length)
    : out.conflicts.length > 0
      ? `${plural(out.conflicts.length, 'conflict')} found.`
      : 'Some references could not be resolved.';
  const lines = [`${verdict} ${TIME_NOTE}`, '', 'Assumptions:', ...out.assumptions.map((assumption) => `- ${assumption}`)];

  if (out.schedule.length > 0) {
    lines.push('', 'Schedule:');
    for (const s of out.schedule) {
      const label = s.slots[0]?.label ?? '';
      const chosen = s.slotChosen ? ` (time slot picked for you; also offered: ${s.otherSlots.map((other) => other.label).join(' | ')})` : '';
      lines.push(`- ${label} · **${s.code}** · ${link(s.title, s.url)}${chosen}`);
    }
  }
  if (out.conflicts.length > 0) lines.push('', 'Conflicts:', ...out.conflicts.map((conflict) => `- ${conflict.message}`));
  if (out.suggestions.length > 0) lines.push('', 'Suggestions:', ...out.suggestions.map((suggestion) => `- ${suggestion}`));
  if (out.onDemand.length > 0) lines.push('', 'On demand (no time to clash):', ...out.onDemand.map((s) => `- **${s.code}** · ${link(s.title, s.url)}`));
  if (out.unresolved.length > 0) lines.push('', 'Could not find:', ...out.unresolved.map((item) => `- "${item.ref}": ${item.reason}`));
  return lines.join('\n');
}

export function calendarText(out: CalendarOutput): string {
  const lines: string[] = [];
  if (out.eventCount === 0) {
    lines.push('No calendar file was created: none of the sessions has a fixed time slot.');
  } else {
    lines.push(`Calendar with ${plural(out.eventCount, 'session')} ready (${out.filename}). Times are stored in UTC, so your calendar shows them in your own time zone.`);
    if (out.downloadUrl) {
      lines.push(`Download: ${out.downloadUrl}`, 'Open the link, then import the .ics file into Outlook, Google Calendar or Apple Calendar.');
    } else {
      lines.push(`Save the text below as ${out.filename} and open it with your calendar app.`, '', '```ics', out.ics.trimEnd(), '```');
    }
    lines.push('', 'Sessions:', ...out.events.map((event) => `- **${event.code}** ${event.title} (${event.label})`));
  }
  if (out.conflicts.length > 0) lines.push('', 'Heads-up, these sessions clash:', ...out.conflicts.map((conflict) => `- ${conflict.message}`));
  if (out.onDemand.length > 0) {
    lines.push('', 'Left out because they have no fixed time (watch on demand):', ...out.onDemand.map((s) => `- **${s.code}** · ${link(s.title, s.url)}`));
  }
  if (out.unresolved.length > 0) lines.push('', 'Could not find:', ...out.unresolved.map((item) => `- "${item.ref}": ${item.reason}`));
  return lines.join('\n');
}

export function overviewText(o: OverviewOutput): string {
  const lines = [
    `${o.event.name}: ${o.event.city}, ${o.event.firstDay} to ${o.event.lastDay} (${o.event.timeZone}). Catalog: ${o.event.sessionsUrl}`,
    `${o.sessions.total} sessions: ${o.sessions.scheduled} scheduled and ${o.sessions.onDemand} on demand; ${o.sessions.recorded} recorded, ${o.sessions.liveStream} live streamed; ${o.sessions.speakers} speakers.`,
    '',
    `Days: ${o.days.map((day) => `${day.day} (${plural(day.sessions, 'session')})`).join(', ')}`,
    `Venues: ${facetList(o.venues)}`,
    `Session types: ${facetList(o.types)}`,
    `Topics: ${facetList(o.topics)}`,
    `Levels: ${facetList(o.levels)}`,
    `Audiences: ${facetList(o.audiences)}`,
    `Industries: ${facetList(o.industries)}`,
    `Delivery: ${facetList(o.delivery)}`,
    `Popular tags: ${facetList(o.topTags)}`,
    '',
    dataLine(o.data),
  ];
  return lines.join('\n');
}

function dataLine(data: OverviewOutput['data']): string {
  if (data.source !== 'live') {
    return `Data: bundled snapshot from ${data.asOf}; the official feed could not be reached yet, so very recent changes may be missing.`;
  }
  const checked = data.lastCheckedAt ? `, last checked ${data.lastCheckedAt}` : '';
  const refresh = data.refreshIntervalMinutes > 0 ? `; refreshed every ${plural(data.refreshIntervalMinutes, 'minute')}` : '';
  return `Data: live official feed as of ${data.asOf}${checked}${refresh}.`;
}
