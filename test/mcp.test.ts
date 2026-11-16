import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { MAX_COMPLETIONS } from '../src/mcp/complete';
import {
  agendaOutput,
  calendarOutput,
  conflictsOutput,
  overviewOutput,
  recommendOutput,
  searchOutput,
  sessionDetailOutput,
  whatsOnOutput,
} from '../src/mcp/schemas';
import { VERSION } from '../src/version';
import { FakeStore, startApp } from './harness';
import type { RunningApp, StartOptions } from './harness';
import { ROOT, fixtureCatalog, icsEvents, icsLines, makeSession, makeSlot, sessionOf, snapshotCatalog, syntheticCatalog } from './helpers';

// Facts about test/fixtures/feed.json that these tests rely on (times are Pacific Time):
// - 34 sessions: 29 have a time and 5 are on demand only (LAB711D, LAB724D, OD1930, OD1950, ODSP2100).
// - 9 sessions are about MCP: LAB724, LAB724D, LTG1192, LTG1285, LTG1356, THR859, THR978, TT1692, TT1767.
// - Tue Nov 17: KEY01 (Satya Nadella) opens at 10:00; BRK323 (AMC Metreon, 14:00-14:45) overlaps THRSP1050 (Moscone South, 14:35-15:00).
// - Wed Nov 18 16:00: LAB711, LAB723 and LABSP830 are the only labs that start after 3pm.
// - BRK217 has one slot, Thu Nov 19 16:00-16:45 (slot id BRK217@2026-11-19T16:00).
// - LAB711 has four slots and a linked on demand Digital Lab, LAB711D.
// - BRK248 (Wed 10:15-11:00) and BRK316 (Wed 11:30-12:15) fit together.
// The app's clock starts on Wednesday 2026-11-18 at 08:00 Pacific; the first session of the day, LAB652, starts at 08:30.

const TOOLS = [
  'search_sessions',
  'get_session',
  'recommend_sessions',
  'whats_on',
  'build_agenda',
  'check_schedule_conflicts',
  'export_calendar',
  'get_catalog_overview',
];
const MCP_SESSIONS = ['LAB724', 'LAB724D', 'LTG1192', 'LTG1285', 'LTG1356', 'THR859', 'THR978', 'TT1692', 'TT1767'];
const MINUTE = 60 * 1000;
const INVALID_PARAMS = -32602;

const running: RunningApp[] = [];

async function connected(options?: StartOptions): Promise<{ app: RunningApp; client: Client }> {
  const app = await startApp(options);
  running.push(app);
  return { app, client: await app.connect() };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.stop()));
});

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

const textOf = (result: ToolResult): string => result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');

const codesOf = (items: readonly { code: string }[]): string[] => items.map((item) => item.code);

function expectAllIn(text: string, codes: readonly string[]): void {
  for (const code of codes) expect(text, code).toContain(code);
}

/**
 * Calls a tool and checks what every tool promises: no error, one text block, and structured data
 * that has exactly the shape of the declared output schema.
 */
async function call<S extends z.ZodType>(client: Client, name: string, args: Record<string, unknown>, schema: S): Promise<{ text: string; data: z.output<S> }> {
  const result = await client.callTool({ name, arguments: args });
  const text = textOf(result);
  expect(result.isError, text).toBeFalsy();
  expect(result.content).toEqual([{ type: 'text', text: expect.any(String) }]);
  const data = schema.parse(result.structuredContent);
  // The schema drops the keys it does not declare: nothing may be left over.
  expect(data).toEqual(result.structuredContent);
  return { text, data };
}

/** Calls a tool that has to fail the way a model can recover from: an error result, not a protocol error. */
async function failure(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  expect(result.content).toHaveLength(1);
  return textOf(result);
}

async function promptText(client: Client, name: string, args: Record<string, string>): Promise<string> {
  const prompt = await client.getPrompt({ name, arguments: args });
  expect(prompt.messages).toHaveLength(1);
  const message = prompt.messages[0];
  expect(message?.role).toBe('user');
  if (message?.content.type !== 'text') throw new Error('A prompt has to be text');
  return message.content.text;
}

async function complete(client: Client, ref: { type: 'ref/prompt'; name: string } | { type: 'ref/resource'; uri: string }, name: string, value: string) {
  return (await client.complete({ ref, argument: { name, value } })).completion;
}

describe('the server', () => {
  it('introduces itself and offers tools, resources, prompts and completions', async () => {
    const { client } = await connected();
    expect(client.getServerVersion()).toMatchObject({ name: 'ignite-mcp-server', title: 'Microsoft Ignite 2026', version: VERSION });
    expect(Object.keys(client.getServerCapabilities() ?? {}).sort()).toEqual(['completions', 'prompts', 'resources', 'tools']);
  });

  it('tells the model which tool to use for what', async () => {
    const { client } = await connected();
    const instructions = client.getInstructions() ?? '';
    for (const tool of TOOLS) expect(instructions, tool).toContain(tool);
    expect(instructions).toContain('Pacific');
  });

  it('has the version of package.json', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(VERSION).toBe(manifest.version);
  });
});

describe('the tool list', () => {
  it('has the eight tools, each with a title, a guiding description, an output schema and read-only annotations', async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOLS].sort());
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(100);
      expect(tool.outputSchema?.type, tool.name).toBe('object');
      expect(tool.annotations, tool.name).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
  });

  it('describes every input, so that a model knows what to send', async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    for (const tool of tools.filter((candidate) => candidate.name !== 'get_catalog_overview')) {
      const properties = Object.entries(tool.inputSchema.properties ?? {});
      expect(properties.length, tool.name).toBeGreaterThan(0);
      for (const [name, schema] of properties) {
        expect((schema as { description?: string }).description?.trim(), `${tool.name}.${name}`).toBeTruthy();
      }
    }
  });

  it('requires only the inputs that a tool cannot guess', async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema.required ?? []]))).toEqual({
      search_sessions: [],
      get_session: ['code'],
      recommend_sessions: ['interests'],
      whats_on: [],
      build_agenda: ['interests'],
      check_schedule_conflicts: ['items'],
      export_calendar: ['items'],
      get_catalog_overview: [],
    });
  });

  it('stays small, because every model call carries it', async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    expect(JSON.stringify(tools).length).toBeLessThan(60_000);
  });

  it('only sends the model to tools that exist', async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    const texts = [
      client.getInstructions() ?? '',
      ...tools.map((tool) => tool.description ?? ''),
      await promptText(client, 'plan_my_ignite', { interests: 'AI', days: 'Tuesday' }),
      await promptText(client, 'session_briefing', { code: 'BRK217' }),
      await promptText(client, 'topic_roundup', { topic: 'Fabric' }),
    ];
    const mentioned = new Set(texts.flatMap((text) => text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []));
    expect([...mentioned].filter((name) => !TOOLS.includes(name))).toEqual([]);
    expect(mentioned.size).toBeGreaterThan(5);
  });
});

describe('search_sessions', () => {
  it('pages through every match once, until there is no next page', async () => {
    const { client } = await connected();
    const pages: string[][] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const { data, text }: { data: z.output<typeof searchOutput>; text: string } = await call(client, 'search_sessions', { query: 'MCP', limit: 4, offset }, searchOutput);
      expect(data).toMatchObject({ total: 9, offset, query: 'MCP' });
      expect(data.returned).toBe(data.sessions.length);
      expectAllIn(text, codesOf(data.sessions));
      if (data.nextOffset !== undefined) {
        expect(data.nextOffset).toBe(offset + data.returned);
        expect(text).toContain(`offset=${data.nextOffset}`);
      } else {
        expect(text).not.toContain('offset=');
      }
      pages.push(codesOf(data.sessions));
      offset = data.nextOffset;
    }
    expect(pages.map((page) => page.length)).toEqual([4, 4, 1]);
    expect(pages.flat().sort()).toEqual(MCP_SESSIONS);
  });

  it('narrows a search with filters and says which ones it applied', async () => {
    const { client } = await connected();
    const { data, text } = await call(client, 'search_sessions', { types: ['Lab'], days: ['Wednesday'], startAfter: '3pm' }, searchOutput);
    expect(codesOf(data.sessions).sort()).toEqual(['LAB711', 'LAB723', 'LABSP830']);
    for (const session of data.sessions) {
      expect(session.type).toBe('Lab');
      expect(session.slots.map((slot) => slot.slotId)).toContain(`${session.code}@2026-11-18T16:00`);
    }
    expect(data.filters).toEqual(['types: Lab', 'days: 2026-11-18', 'start at or after 3pm']);
    expect(text.split('\n')[0]).toBe('3 sessions found; showing 1–3. Filters: types: Lab; days: 2026-11-18; start at or after 3pm. All times are Pacific Time (San Francisco).');
  });

  it('lists the schedule in time order when there is no query', async () => {
    const { client } = await connected();
    const { data } = await call(client, 'search_sessions', { limit: 4 }, searchOutput);
    expect(data).toMatchObject({ total: fixtureCatalog().sessions.length, returned: 4, offset: 0, nextOffset: 4, query: '' });
    expect(codesOf(data.sessions)).toEqual(['BRK101', 'KEY01', 'LIVE50', 'BRK323']);
    const starts = data.sessions.map((session) => session.slots[0]?.startUtc);
    expect(starts).toEqual([...starts].sort());
  });

  it('finds a speaker', async () => {
    const { client } = await connected();
    const { data } = await call(client, 'search_sessions', { query: 'Satya Nadella' }, searchOutput);
    expect(data.total).toBe(1);
    const [hit] = data.sessions;
    expect(hit?.code).toBe('KEY01');
    expect(hit?.speakers).toContain('Satya Nadella');
    expect(hit?.matchedOn).toContain('speakers');
  });

  it('finds a session by its code', async () => {
    const { client } = await connected();
    const { data } = await call(client, 'search_sessions', { query: 'BRK217' }, searchOutput);
    expect(data.total).toBe(1);
    expect(data.sessions[0]).toMatchObject({ code: 'BRK217', matchedOn: ['session code'] });
  });

  it('warns about filter values it does not know, instead of failing or ignoring them silently', async () => {
    const { client } = await connected();
    const { data, text } = await call(client, 'search_sessions', { query: 'copilot', days: ['Tuesday', 'Funday'], types: ['Nonsense'] }, searchOutput);
    expect(data.total).toBe(0);
    expect(data.filters).toEqual(['types: (none matched)', 'days: 2026-11-17']);
    expect(data.warnings).toHaveLength(2);
    expect(data.warnings[0]).toContain('Nonsense');
    expect(data.warnings[0]).toContain('Breakout');
    expect(data.warnings[1]).toContain('Could not understand day "Funday"');
    for (const warning of data.warnings) expect(text).toContain(warning);
  });

  it('rejects a limit above the maximum with a message that names the limit', async () => {
    const { client } = await connected();
    const message = await failure(client, 'search_sessions', { query: 'MCP', limit: 100 });
    expect(message).toMatch(/search_sessions/);
    expect(message).toMatch(/limit/);
    expect(message).toMatch(/25/);
  });
});

describe('get_session', () => {
  it.each(['BRK217', 'brk217', ' BRK 217 ', 'BRK217@2026-11-19T16:00'])('finds the session for %j', async (code) => {
    const { client } = await connected();
    const { data, text } = await call(client, 'get_session', { code }, sessionDetailOutput);
    expect(data).toMatchObject({ code: 'BRK217', title: 'Real-World AI Transformation with Copilot in SharePoint', type: 'Breakout', onDemand: false });
    expect(data.slots.map((slot) => slot.slotId)).toEqual(['BRK217@2026-11-19T16:00']);
    expect(data.url).toBe(sessionOf(fixtureCatalog(), 'BRK217').url);
    expect(data.speakers.map((speaker) => speaker.name)).toContain('Rk Menon');
    expect(text).toContain('BRK217');
    expect(text).toContain(data.url);
  });

  it('gives every slot of a session, its linked session and similar ones', async () => {
    const { client } = await connected();
    const { data, text } = await call(client, 'get_session', { code: 'LAB711' }, sessionDetailOutput);
    expect(data.slots.map((slot) => slot.slotId)).toEqual([
      'LAB711@2026-11-17T14:00',
      'LAB711@2026-11-18T16:00',
      'LAB711@2026-11-19T09:00',
      'LAB711@2026-11-19T14:45',
    ]);
    expect(data.related).toEqual([{ code: 'LAB711D', title: 'Digital Lab: Build an AI-Ready Secure Foundation with Zero Trust', type: 'Digital Lab' }]);
    expect(data.similar).toHaveLength(5);
    expect(codesOf(data.similar)).not.toContain('LAB711');
    expect(text).toContain('Linked sessions:');
    expect(text).toContain('Similar sessions:');
  });

  it('shows an on demand session without a time', async () => {
    const { client } = await connected();
    const { data } = await call(client, 'get_session', { code: 'LAB711D' }, sessionDetailOutput);
    expect(data).toMatchObject({ code: 'LAB711D', onDemand: true, slots: [], related: [] });
  });

  it('suggests the closest sessions when the code is wrong, as an error that the model can act on', async () => {
    const { client } = await connected();
    for (const code of ['sharepoint', 'BRK21']) {
      const message = await failure(client, 'get_session', { code });
      expect(message).toContain(`No session found for "${code}".`);
      expect(message).toContain('BRK217');
      expect(message).toContain('search_sessions');
    }
  });

  it('says what is missing when the code is left out', async () => {
    const { client } = await connected();
    const message = await failure(client, 'get_session', {});
    expect(message).toContain('get_session');
    expect(message).toContain('code');
  });
});

describe('recommend_sessions', () => {
  it('ranks the sessions that fit several interests first and says how well each interest matched', async () => {
    const { client } = await connected();
    const { data, text } = await call(client, 'recommend_sessions', { interests: ['MCP', 'zero trust'], limit: 3 }, recommendOutput);
    expect(data.returned).toBe(3);
    expect(codesOf(data.recommendations)).toEqual(['LAB711', 'LTG1285', 'LAB711D']);
    expect(data.interests.map((entry) => [entry.interest, entry.matches])).toEqual([
      ['MCP', 9],
      ['zero trust', 4],
    ]);
    expect(data.unmatchedInterests).toEqual([]);
    for (const recommendation of data.recommendations) {
      expect(recommendation.matchedInterests.length, recommendation.code).toBeGreaterThan(0);
      expect(recommendation.why, recommendation.code).not.toBe('');
    }
    expectAllIn(text, codesOf(data.recommendations));
    expect(text).toContain('Good matches per interest');
  });

  it('leaves out the sessions that the attendee has already seen', async () => {
    const { client } = await connected();
    const { data } = await call(client, 'recommend_sessions', { interests: ['MCP', 'zero trust'], limit: 3, excludeCodes: ['LAB711', 'LAB711D'] }, recommendOutput);
    expect(data.returned).toBe(3);
    expect(codesOf(data.recommendations)).not.toContain('LAB711');
    expect(codesOf(data.recommendations)).not.toContain('LAB711D');
  });

  it('names the interests that matched nothing', async () => {
    const { client } = await connected();
    const { data, text } = await call(client, 'recommend_sessions', { interests: ['MCP', 'zzzzqqq'], limit: 3 }, recommendOutput);
    expect(data.unmatchedInterests).toEqual(['zzzzqqq']);
    expect(data.returned).toBe(3);
    expect(text).toContain('zzzzqqq');
  });
});

describe('whats_on', () => {
  it('shows what starts soon, by the clock of the server', async () => {
    const { app, client } = await connected();
    const early = await call(client, 'whats_on', {}, whatsOnOutput);
    expect(early.data).toMatchObject({ phase: 'during_event', at: '2026-11-18T16:00:00.000Z', atLabel: 'Wed Nov 18, 8:00 AM', windowMinutes: 60 });
    expect(early.data.inProgress.total).toBe(0);
    expect(early.data.startingSoon.sessions.map((session) => [session.code, session.startsInMinutes])).toEqual([
      ['LAB652', 30],
      ['LABSP830', 30],
      ['KEY02', 60],
    ]);

    app.advance(60 * MINUTE);
    const later = await call(client, 'whats_on', {}, whatsOnOutput);
    expect(later.data.atLabel).toBe('Wed Nov 18, 9:00 AM');
    expect(later.data.inProgress.sessions.map((session) => [session.code, session.minutesLeft])).toEqual([
      ['LAB652', 45],
      ['LABSP830', 45],
      ['KEY02', 90],
    ]);
    expect(later.data.startingSoon.total).toBe(0);
  });

  it('shows what is on at a given time, in sessions in progress and sessions about to start', async () => {
    const { client } = await connected();
    const { data, text } = await call(client, 'whats_on', { at: '2026-11-17T14:10' }, whatsOnOutput);
    expect(data.phase).toBe('during_event');
    expect(codesOf(data.inProgress.sessions).sort()).toEqual(['BRK323', 'LAB711', 'LAB723', 'LABSP830']);
    expect(codesOf(data.startingSoon.sessions)).toEqual(['THRSP1050', 'TT1692']);
    expect(data.next.total).toBe(0);
    expect(data.message).toBe('At Tue Nov 17, 2:10 PM: 4 sessions in progress and 2 sessions starting within 1 hour. All times are Pacific Time (San Francisco).');
    expect(text.split('\n')[0]).toBe(data.message);
  });

  it('understands a clock time as today', async () => {
    const { client } = await connected();
    const { data } = await call(client, 'whats_on', { at: '2pm' }, whatsOnOutput);
    expect(data).toMatchObject({ at: '2026-11-18T22:00:00.000Z', atLabel: 'Wed Nov 18, 2:00 PM' });
  });

  it('looks further ahead with a longer window, and only for what was asked for', async () => {
    const { client } = await connected();
    const { data } = await call(client, 'whats_on', { at: '2026-11-17T14:10', query: 'MCP', windowMinutes: 120 }, whatsOnOutput);
    expect(data.inProgress.total).toBe(0);
    expect(data.startingSoon.sessions.map((session) => [session.code, session.startsInMinutes])).toEqual([
      ['TT1692', 55],
      ['THR978', 80],
      ['LAB724', 95],
    ]);
  });

  it('points to the next keynote when nothing that was asked for is on', async () => {
    const { client } = await connected();
    const { data } = await call(client, 'whats_on', { at: '2026-11-17T14:10', types: ['Keynote'] }, whatsOnOutput);
    expect(data.inProgress.total).toBe(0);
    expect(data.startingSoon.total).toBe(0);
    expect(codesOf(data.next.sessions)).toEqual(['KEY02']);
    expect(data.filters).toEqual(['types: Keynote']);
  });

  it('says when the event has not started and what comes first', async () => {
    const { client } = await connected();
    const { data } = await call(client, 'whats_on', { at: '2026-11-10T10:00' }, whatsOnOutput);
    expect(data.phase).toBe('before_event');
    expect(codesOf(data.next.sessions)).toEqual(['BRK101']);
    expect(data.message).toMatch(/^Ignite 2026 has not started yet: the first session starts Mon Nov 16, 1:30 PM\./);
  });

  it('says when the event is over', async () => {
    const { client } = await connected();
    const { data } = await call(client, 'whats_on', { at: '2026-11-21T10:00' }, whatsOnOutput);
    expect(data.phase).toBe('after_event');
    expect(data.inProgress.total + data.startingSoon.total + data.next.total).toBe(0);
    expect(data.message).toMatch(/^Ignite 2026 is over: the last session ended Fri Nov 20, 10:15 AM\./);
  });

  it('explains how to write the time when it does not understand it', async () => {
    const { client } = await connected();
    expect(await failure(client, 'whats_on', { at: 'banana' })).toBe(
      'Could not understand at="banana". Use an ISO date-time such as 2026-11-18T14:00 (Pacific Time), or a clock time such as "2pm" (today).',
    );
  });
});

describe('build_agenda', () => {
  const INTERESTS = { interests: ['Security', 'Copilot'], maxPerDay: 2, mustInclude: ['LAB711'] };

  it('plans a conflict-free agenda around the interests, with the pinned session in it', async () => {
    const { client } = await connected();
    const { data, text } = await call(client, 'build_agenda', INTERESTS, agendaOutput);
    const planned = data.days.flatMap((day) => day.sessions);
    expect(data.totalSessions).toBe(planned.length);
    expect(data.totalSessions).toBe(6);
    expect(data.days.map((day) => day.date)).toEqual(['2026-11-17', '2026-11-18', '2026-11-19']);
    for (const day of data.days) expect(day.sessions.length, day.date).toBeLessThanOrEqual(2);
    expect(planned.filter((session) => session.pinned).map((session) => session.code)).toEqual(['LAB711']);
    expect(data.days[0]?.sessions[0]?.code).toBe('LAB711');
    expect(data.slotIds).toEqual(planned.map((session) => session.slots[0]?.slotId));
    expect(data.uncoveredInterests).toEqual([]);
    expect(data.coverage.map((entry) => entry.interest)).toEqual(['Security', 'Copilot']);
    expect(data.pinnedConflicts).toEqual([]);
    expectAllIn(text, codesOf(planned));
  });

  it('lists the on demand sessions and the ones it had to skip, with the reason', async () => {
    const { client } = await connected();
    const { data, text } = await call(client, 'build_agenda', INTERESTS, agendaOutput);
    expect(codesOf(data.onDemand).sort()).toEqual(['LAB711D', 'OD1930', 'OD1950', 'ODSP2100']);
    expect(data.skipped.length).toBeGreaterThan(0);
    for (const skipped of data.skipped) expect(skipped.reason, skipped.code).not.toBe('');
    expect(codesOf(data.skipped)).not.toEqual(expect.arrayContaining(data.slotIds.map((id) => id.split('@')[0] ?? '')));
    expectAllIn(text, codesOf(data.onDemand));
  });

  it('gives slot ids that the conflict checker accepts and the calendar export turns into events', async () => {
    const { client } = await connected();
    const { data: agenda } = await call(client, 'build_agenda', INTERESTS, agendaOutput);

    const { data: checked } = await call(client, 'check_schedule_conflicts', { items: agenda.slotIds }, conflictsOutput);
    expect(checked).toMatchObject({ ok: true, conflicts: [], unresolved: [], onDemand: [] });
    expect(checked.schedule.map((session) => session.slotChosen)).toEqual(agenda.slotIds.map(() => false));
    expect(checked.schedule.map((session) => session.slots[0]?.slotId)).toEqual(agenda.slotIds);

    const { data: calendar } = await call(client, 'export_calendar', { items: agenda.slotIds }, calendarOutput);
    expect(calendar).toMatchObject({ eventCount: agenda.slotIds.length, filename: 'ignite-2026-agenda.ics', unresolved: [], onDemand: [] });
    expect(calendar.events.map((event) => event.slotId)).toEqual(agenda.slotIds);
  });

  it('plans for an online attendee without travel time, and with sessions that can be followed online', async () => {
    const { client } = await connected();
    const { data } = await call(client, 'build_agenda', { interests: ['Security'], attendance: 'online' }, agendaOutput);
    expect(data.assumptions).toEqual([
      'Times are Pacific Time.',
      'At least 10 minutes between sessions.',
      'Attending online: no travel time between sessions.',
      'At most 5 sessions per day.',
      'Only sessions you can attend online are considered.',
    ]);
    expect(data.totalSessions).toBeGreaterThan(0);
  });

  it('says so when nothing fits the interests', async () => {
    const { client } = await connected();
    const { data, text } = await call(client, 'build_agenda', { interests: ['zzzzqqq'] }, agendaOutput);
    expect(data).toMatchObject({ totalSessions: 0, days: [], uncoveredInterests: ['zzzzqqq'], onDemand: [], slotIds: [] });
    expect(text.startsWith('No scheduled sessions could be planned.')).toBe(true);
  });
});

describe('check_schedule_conflicts', () => {
  it('confirms that sessions fit together', async () => {
    const { client } = await connected();
    const { data, text } = await call(client, 'check_schedule_conflicts', { items: ['BRK248', 'BRK316'] }, conflictsOutput);
    expect(data).toMatchObject({ ok: true, conflicts: [], unresolved: [], onDemand: [] });
    expect(codesOf(data.schedule)).toEqual(['BRK248', 'BRK316']);
    expect(text.split('\n')[0]).toBe('No conflicts: 2 sessions fit together. All times are Pacific Time (San Francisco).');
  });

  it('finds an overlap and suggests how to resolve it, and reports a reference it could not resolve', async () => {
    const { client } = await connected();
    const { data, text } = await call(client, 'check_schedule_conflicts', { items: ['BRK323', 'THRSP1050', 'KEY01', 'NOPE-1'] }, conflictsOutput);
    expect(data.ok).toBe(false);
    expect(data.conflicts).toHaveLength(1);
    expect(data.conflicts[0]).toMatchObject({ kind: 'overlap', minutes: 10, requiredGapMinutes: 20 });
    expect(data.conflicts[0]?.first.code).toBe('BRK323');
    expect(data.conflicts[0]?.second.code).toBe('THRSP1050');
    expect(data.unresolved).toEqual([{ ref: 'NOPE-1', reason: 'No session has that code or id' }]);
    expect(data.suggestions.length).toBeGreaterThan(0);
    expect(text).toContain(data.conflicts[0]?.message);
    expect(text.split('\n')[0]).toMatch(/^1 conflict found\./);
    for (const suggestion of data.suggestions) expect(text).toContain(suggestion);
  });

  it('does not count the travel time between venues when attending online', async () => {
    const { client } = await connected();
    const { data } = await call(client, 'check_schedule_conflicts', { items: ['BRK323', 'THRSP1050'], minBreakMinutes: 0, attendance: 'online' }, conflictsOutput);
    expect(data.conflicts.map((conflict) => [conflict.kind, conflict.minutes, conflict.requiredGapMinutes])).toEqual([['overlap', 10, 0]]);
  });

  it('has nothing to compare for sessions that are only on demand', async () => {
    const { client } = await connected();
    const { data, text } = await call(client, 'check_schedule_conflicts', { items: ['LAB711D', 'OD1930'] }, conflictsOutput);
    expect(data).toMatchObject({ ok: true, conflicts: [], schedule: [] });
    expect(codesOf(data.onDemand)).toEqual(['LAB711D', 'OD1930']);
    expect(text.split('\n')[0]).toBe('No conflicts: none of the sessions has a fixed time. All times are Pacific Time (San Francisco).');
  });
});

describe('export_calendar', () => {
  it('puts the sessions that have a time in a calendar file, and leaves the others out with a reason', async () => {
    const { client } = await connected();
    const slot = sessionOf(fixtureCatalog(), 'BRK217').occurrences[0];
    const { data, text } = await call(client, 'export_calendar', { items: ['BRK217', 'LAB711D', 'nope'], reminderMinutes: 10, calendarName: 'My Ignite' }, calendarOutput);
    expect(data).toMatchObject({ filename: 'ignite-2026-BRK217.ics', eventCount: 1 });
    expect(data.events).toEqual([{ code: 'BRK217', title: 'Real-World AI Transformation with Copilot in SharePoint', slotId: 'BRK217@2026-11-19T16:00', label: expect.any(String) }]);
    expect(codesOf(data.onDemand)).toEqual(['LAB711D']);
    expect(data.unresolved).toEqual([{ ref: 'nope', reason: 'No session has that code or id' }]);
    // The test app has no public address, so the file itself is in the answer instead of a link.
    expect(data.downloadUrl).toBeUndefined();
    expect(text).toContain(data.ics.trimEnd());

    expect(icsLines(data.ics).slice(0, 6)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//ignite-mcp-server//Microsoft Ignite 2026 sessions//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:My Ignite',
    ]);
    const events = icsEvents(data.ics);
    expect(events).toHaveLength(1);
    expect(events[0]?.props.UID).toBe(`${slot?.instanceId}@ignite-mcp`);
    expect(events[0]?.alarm?.TRIGGER).toBe('-PT10M');
  });

  it('creates no file when none of the sessions has a time', async () => {
    const { client } = await connected();
    const { data, text } = await call(client, 'export_calendar', { items: ['LAB711D', 'OD1930'] }, calendarOutput);
    expect(data).toMatchObject({ eventCount: 0, ics: '', events: [] });
    expect(data.downloadUrl).toBeUndefined();
    expect(codesOf(data.onDemand)).toEqual(['LAB711D', 'OD1930']);
    expect(text.split('\n')[0]).toBe('No calendar file was created: none of the sessions has a fixed time slot.');
  });
});

describe('get_catalog_overview', () => {
  it('summarises the catalog: sessions, days, venues and the values to filter on', async () => {
    const { client } = await connected();
    const { data, text } = await call(client, 'get_catalog_overview', {}, overviewOutput);
    expect(data.event).toMatchObject({ name: 'Microsoft Ignite 2026', firstDay: '2026-11-16', lastDay: '2026-11-20' });
    expect(data.sessions).toEqual({ total: 34, scheduled: 29, onDemand: 5, recorded: 18, liveStream: 15, speakers: 58 });
    expect(data.days.map((day) => [day.date, day.sessions])).toEqual([
      ['2026-11-16', 1],
      ['2026-11-17', 13],
      ['2026-11-18', 12],
      ['2026-11-19', 14],
      ['2026-11-20', 1],
    ]);
    expect(data.types.find((type) => type.name === 'Breakout')?.count).toBe(12);
    expect(data.venues[0]).toEqual({ name: 'Moscone West', count: 28 });
    expect(text).toContain('Microsoft Ignite 2026');
    expect(text).toContain('Breakout');
  });

  describe('says how fresh the data is', () => {
    it('for the live feed, with the time of the last check', async () => {
      const store = new FakeStore();
      store.statusOverride = { lastCheckedAt: '2026-11-18T15:45:00.000Z' };
      const { client } = await connected({ store });
      const { data, text } = await call(client, 'get_catalog_overview', {}, overviewOutput);
      expect(data.data).toEqual({ source: 'live', asOf: '2026-11-16T12:00:00.000Z', lastCheckedAt: '2026-11-18T15:45:00.000Z', refreshIntervalMinutes: 15 });
      expect(text).toContain('Data: live official feed as of 2026-11-16T12:00:00.000Z, last checked 2026-11-18T15:45:00.000Z; refreshed every 15 minutes.');
    });

    it('for the bundled snapshot, which may be behind', async () => {
      const snapshot = await snapshotCatalog();
      const { client } = await connected({ store: new FakeStore(snapshot) });
      const { data, text } = await call(client, 'get_catalog_overview', {}, overviewOutput);
      expect(data.data).toEqual({ source: 'snapshot', asOf: snapshot.meta.dataAsOf, refreshIntervalMinutes: 15 });
      expect(text).toContain(`Data: bundled snapshot from ${snapshot.meta.dataAsOf}; the official feed could not be reached yet, so very recent changes may be missing.`);
      expect(data.sessions.total).toBe(snapshot.sessions.length);
    });

    it('with the details in the data and not in the text, when the snapshot is all there is', async () => {
      const snapshot = await snapshotCatalog();
      const store = new FakeStore(snapshot);
      store.statusOverride = { lastCheckedAt: '2026-11-18T15:45:00.000Z', refreshIntervalMinutes: 5 };
      const { client } = await connected({ store });
      const { data, text } = await call(client, 'get_catalog_overview', {}, overviewOutput);
      expect(data.data).toEqual({ source: 'snapshot', asOf: snapshot.meta.dataAsOf, lastCheckedAt: '2026-11-18T15:45:00.000Z', refreshIntervalMinutes: 5 });
      expect(text).toContain(`Data: bundled snapshot from ${snapshot.meta.dataAsOf}; the official feed could not be reached yet`);
      expect(text).not.toContain('last checked');
    });
  });
});

describe('real data', () => {
  it('works on the whole catalog, not only on the small fixture', async () => {
    const snapshot = await snapshotCatalog();
    const { client } = await connected({ store: new FakeStore(snapshot) });

    const search = await call(client, 'search_sessions', { query: 'Azure', limit: 25 }, searchOutput);
    expect(search.data.total).toBeGreaterThan(25);
    expect(search.data.returned).toBe(25);
    expect(search.data.nextOffset).toBe(25);

    const recommended = await call(client, 'recommend_sessions', { interests: ['AI agents', 'security', 'Fabric'], limit: 10 }, recommendOutput);
    expect(recommended.data.returned).toBe(10);
    expect(recommended.data.unmatchedInterests).toEqual([]);

    const agenda = await call(client, 'build_agenda', { interests: ['AI agents', 'security', 'Fabric'] }, agendaOutput);
    expect(agenda.data.totalSessions).toBeGreaterThan(5);
    const checked = await call(client, 'check_schedule_conflicts', { items: agenda.data.slotIds }, conflictsOutput);
    expect(checked.data.ok).toBe(true);
    const calendar = await call(client, 'export_calendar', { items: agenda.data.slotIds }, calendarOutput);
    expect(calendar.data.eventCount).toBe(agenda.data.slotIds.length);

    const overview = await call(client, 'get_catalog_overview', {}, overviewOutput);
    expect(overview.data.sessions.total).toBe(snapshot.sessions.length);
  });
});

describe('a catalog refresh', () => {
  it('shows in the next call of every tool and resource, without reconnecting', async () => {
    const { app, client } = await connected();
    expect((await call(client, 'get_catalog_overview', {}, overviewOutput)).data.sessions.total).toBe(34);
    expect(await failure(client, 'get_session', { code: 'NEW1' })).toContain('No session found for "NEW1"');

    app.store.source = syntheticCatalog([makeSession('NEW1', { title: 'Fresh from the feed' }, [makeSlot('NEW1', '2026-11-17', '10:00', '11:00')]), makeSession('NEW2')]);

    expect((await call(client, 'get_catalog_overview', {}, overviewOutput)).data.sessions).toMatchObject({ total: 2, scheduled: 1, onDemand: 1 });
    expect((await call(client, 'get_session', { code: 'NEW1' }, sessionDetailOutput)).data.title).toBe('Fresh from the feed');
    expect((await call(client, 'search_sessions', { query: 'fresh' }, searchOutput)).data.total).toBe(1);
    expect(await failure(client, 'get_session', { code: 'BRK217' })).toContain('No session found for "BRK217"');

    const read = await client.readResource({ uri: 'ignite://sessions/NEW1' });
    expect(read.contents[0]).toMatchObject({ text: expect.stringContaining('Fresh from the feed') });
    await expect(client.readResource({ uri: 'ignite://sessions/BRK217' })).rejects.toMatchObject({ code: INVALID_PARAMS });
    expect((await complete(client, { type: 'ref/prompt', name: 'session_briefing' }, 'code', 'NEW')).values).toEqual(['NEW1', 'NEW2']);
  });
});

describe('resources', () => {
  it('has the overview and a template for single sessions, which clients may keep for an hour', async () => {
    const { client } = await connected();
    const resources = await client.listResources();
    expect(resources.resources).toEqual([
      expect.objectContaining({ name: 'catalog-overview', title: 'Ignite 2026 catalog overview', uri: 'ignite://overview', mimeType: 'text/markdown' }),
    ]);
    expect(resources).toMatchObject({ ttlMs: 60 * 60 * 1000, cacheScope: 'public' });

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates).toEqual([
      expect.objectContaining({ name: 'session', title: 'Ignite 2026 session', uriTemplate: 'ignite://sessions/{code}', mimeType: 'text/markdown' }),
    ]);
    expect(templates).toMatchObject({ ttlMs: 60 * 60 * 1000, cacheScope: 'public' });
  });

  it('reads the overview as the text of the overview tool', async () => {
    const { client } = await connected();
    const tool = await call(client, 'get_catalog_overview', {}, overviewOutput);
    const read = await client.readResource({ uri: 'ignite://overview' });
    expect(read.contents).toEqual([{ uri: 'ignite://overview', mimeType: 'text/markdown', text: tool.text }]);
    expect(read).toMatchObject({ ttlMs: 5 * MINUTE, cacheScope: 'public' });
  });

  it.each(['BRK217', 'brk217', 'BRK%20217', 'brk-217'])('reads a session as the text of the session tool: %s', async (code) => {
    const { client } = await connected();
    const tool = await call(client, 'get_session', { code: 'BRK217' }, sessionDetailOutput);
    const uri = `ignite://sessions/${code}`;
    const read = await client.readResource({ uri });
    expect(read.contents).toEqual([{ uri, mimeType: 'text/markdown', text: tool.text }]);
    expect(read).toMatchObject({ ttlMs: 5 * MINUTE, cacheScope: 'public' });
  });

  it('refuses a session that does not exist, and a resource that does not exist', async () => {
    const { client } = await connected();
    await expect(client.readResource({ uri: 'ignite://sessions/NOPE' })).rejects.toMatchObject({ code: INVALID_PARAMS, message: expect.stringContaining('No session found for "NOPE".') });
    await expect(client.readResource({ uri: 'ignite://nothing' })).rejects.toMatchObject({ code: INVALID_PARAMS, message: expect.stringContaining('Resource not found: ignite://nothing') });
  });

  it('does not fall over on a code that is not valid percent-encoding', async () => {
    const { client } = await connected();
    await expect(client.readResource({ uri: 'ignite://sessions/%E0%A4%A' })).rejects.toMatchObject({
      code: INVALID_PARAMS,
      message: expect.stringContaining('No session found for "%E0%A4%A".'),
    });
  });
});

describe('prompts', () => {
  it('has three ready-made requests, which clients may keep for an hour', async () => {
    const { client } = await connected();
    const list = await client.listPrompts();
    expect(Object.fromEntries(list.prompts.map((prompt) => [prompt.name, (prompt.arguments ?? []).map((argument) => [argument.name, argument.required ?? false])]))).toEqual({
      plan_my_ignite: [
        ['interests', true],
        ['days', false],
      ],
      session_briefing: [['code', true]],
      topic_roundup: [['topic', true]],
    });
    for (const prompt of list.prompts) {
      expect(prompt.title, prompt.name).toBeTruthy();
      expect(prompt.description, prompt.name).toBeTruthy();
      for (const argument of prompt.arguments ?? []) expect(argument.description, `${prompt.name}.${argument.name}`).toBeTruthy();
    }
    expect(list).toMatchObject({ ttlMs: 60 * 60 * 1000, cacheScope: 'public' });
  });

  it('turns a typed list of interests into a plan request, whatever separates them', async () => {
    const { client } = await connected();
    const text = await promptText(client, 'plan_my_ignite', { interests: ' AI agents ;; Fabric,\n security , ' });
    expect(text.startsWith('Plan my Microsoft Ignite 2026 agenda.\n\nMy interests:\n- AI agents\n- Fabric\n- security\n\n1. Call build_agenda with these interests.\n')).toBe(true);
    expect(text).not.toContain('I can attend');
    expect(text).not.toContain('restrict it');
  });

  it('adds the days that the attendee can come to', async () => {
    const { client } = await connected();
    const text = await promptText(client, 'plan_my_ignite', { interests: 'AI agents', days: 'Tuesday to Thursday' });
    expect(text).toContain('I can attend: Tuesday to Thursday.');
    expect(text).toContain('1. Call build_agenda with these interests and restrict it to the days I can attend.');
  });

  it('asks for a briefing on one session', async () => {
    const { client } = await connected();
    const text = await promptText(client, 'session_briefing', { code: 'BRK217' });
    expect(text.startsWith('Prepare me for Microsoft Ignite 2026 session BRK217.\n\nCall get_session and then give me:')).toBe(true);
  });

  it('asks for a roundup of a topic', async () => {
    const { client } = await connected();
    const text = await promptText(client, 'topic_roundup', { topic: 'Fabric' });
    expect(text.startsWith('Give me a roundup of what Microsoft Ignite 2026 offers on "Fabric".\n\nCall search_sessions')).toBe(true);
  });

  it('refuses a missing argument and an unknown prompt', async () => {
    const { client } = await connected();
    await expect(client.getPrompt({ name: 'session_briefing', arguments: {} })).rejects.toMatchObject({
      code: INVALID_PARAMS,
      message: expect.stringContaining('session_briefing'),
    });
    await expect(client.getPrompt({ name: 'nope' })).rejects.toMatchObject({ code: INVALID_PARAMS, message: expect.stringContaining('nope') });
  });
});

describe('completions', () => {
  it('completes a session code for the resource template and for the briefing prompt', async () => {
    const { client } = await connected();
    expect(await complete(client, { type: 'ref/resource', uri: 'ignite://sessions/{code}' }, 'code', 'BRK21')).toEqual({ values: ['BRK217'], total: 1, hasMore: false });
    const labs = await complete(client, { type: 'ref/prompt', name: 'session_briefing' }, 'code', 'lab7');
    expect(labs.values).toEqual(expect.arrayContaining(['LAB711', 'LAB711D', 'LAB723', 'LAB724', 'LAB724D']));
    expect(labs.values.every((value) => value.startsWith('LAB'))).toBe(true);
    expect((await complete(client, { type: 'ref/prompt', name: 'session_briefing' }, 'code', 'zzz')).values).toEqual([]);
  });

  it('suggests the featured sessions before anything is typed', async () => {
    const { client } = await connected();
    const featured = fixtureCatalog()
      .sessions.filter((session) => session.featured)
      .map((session) => session.code);
    expect(featured.length).toBeGreaterThan(0);
    expect((await complete(client, { type: 'ref/prompt', name: 'session_briefing' }, 'code', '')).values).toEqual(featured.slice(0, MAX_COMPLETIONS));
  });

  it('completes a topic from the topics and tags of the catalog, the best fit first', async () => {
    const { client } = await connected();
    const { values } = await complete(client, { type: 'ref/prompt', name: 'topic_roundup' }, 'topic', 'sec');
    expect(values.slice(0, 2)).toEqual(['Security', 'Secure AI']);
    expect(values.length).toBeLessThanOrEqual(MAX_COMPLETIONS);
    for (const value of values) expect(value.toLowerCase(), value).toContain('sec');
  });

  it('completes the last of several interests and keeps the ones before it', async () => {
    const { client } = await connected();
    const { values } = await complete(client, { type: 'ref/prompt', name: 'plan_my_ignite' }, 'interests', 'AI agents, sec');
    expect(values.slice(0, 2)).toEqual(['AI agents, Security', 'AI agents, Secure AI']);
    for (const value of values) expect(value.startsWith('AI agents, '), value).toBe(true);
  });
});

describe('protocol errors', () => {
  it('refuses an unknown tool as a protocol error, not as a tool result', async () => {
    const { client } = await connected();
    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toMatchObject({ code: INVALID_PARAMS, message: expect.stringContaining('nope') });
  });
});
