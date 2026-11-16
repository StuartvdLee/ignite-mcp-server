import { completable } from '@modelcontextprotocol/server';
import type { GetPromptResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { completeFromList, completeLastItem, completeSessionCodes, interestCandidates } from './complete';
import type { ToolDeps } from './tools';

const userMessage = (text: string): GetPromptResult => ({ messages: [{ role: 'user', content: { type: 'text', text } }] });

/** `"AI agents, Fabric; security"` becomes a bullet list. */
const bulletList = (text: string): string =>
  text
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map((item) => `- ${item}`)
    .join('\n');

/** Ready-made requests that users can pick from the prompt menu of their client. */
export function registerPrompts(server: McpServer, deps: ToolDeps): void {
  // completable() marks the schema it is given, so every server needs its own schema objects.
  server.registerPrompt(
    'plan_my_ignite',
    {
      title: 'Plan my Ignite',
      description: 'Plan a personal, conflict-free Ignite 2026 agenda around your interests.',
      argsSchema: z.object({
        interests: completable(
          z.string().trim().min(1).max(500).describe('What you want to learn or do, separated by commas, e.g. "AI agents, Kubernetes security, Fabric".'),
          (value) => completeLastItem(interestCandidates(deps.catalog()), value),
        ),
        days: z.string().trim().max(100).optional().describe('The days you attend, e.g. "Tuesday to Thursday". Leave empty for every day.'),
      }),
    },
    ({ interests, days }) =>
      userMessage(
        `Plan my Microsoft Ignite 2026 agenda.\n\nMy interests:\n${bulletList(interests)}\n${days ? `\nI can attend: ${days}.\n` : ''}\n` +
          '1. Call build_agenda with these interests' +
          `${days ? ' and restrict it to the days I can attend' : ''}.\n` +
          '2. Show the plan day by day: the time, the session code and title, and one line on why it fits me. Mention where I have a choice between sessions at the same time.\n' +
          '3. Tell me which interests found little or nothing, and how to broaden them.\n' +
          '4. Offer to export the agenda to my calendar with export_calendar.',
      ),
  );

  server.registerPrompt(
    'session_briefing',
    {
      title: 'Session briefing',
      description: 'A short briefing for one session: what it covers, who it is for, when it runs and what to read first.',
      argsSchema: z.object({
        code: completable(z.string().trim().min(1).max(80).describe('The session code, e.g. "BRK217".'), (value) => completeSessionCodes(deps.catalog(), value)),
      }),
    },
    ({ code }) =>
      userMessage(
        `Prepare me for Microsoft Ignite 2026 session ${code}.\n\n` +
          'Call get_session and then give me: what the session covers in two or three sentences, who it is for and at which level, the speakers, when and where it runs (every slot if there are several), what I should know beforehand, and two or three related sessions that are worth adding.',
      ),
  );

  server.registerPrompt(
    'topic_roundup',
    {
      title: 'Topic roundup',
      description: 'Everything Ignite 2026 offers on a topic, organised by type and day.',
      argsSchema: z.object({
        topic: completable(z.string().trim().min(1).max(100).describe('A topic or technology, e.g. "Microsoft Fabric".'), (value) =>
          completeFromList(interestCandidates(deps.catalog()), value),
        ),
      }),
    },
    ({ topic }) =>
      userMessage(
        `Give me a roundup of what Microsoft Ignite 2026 offers on "${topic}".\n\n` +
          'Call search_sessions, and try related keywords when the first results are thin. Organise what you find: the sessions I should not miss first, then hands-on labs, then the rest by level. Give the day and time of each one and mention sessions that are on demand only. Offer to build an agenda from them.',
      ),
  );
}
