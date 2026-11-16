import { McpServer } from '@modelcontextprotocol/server';
import { EVENT } from '../event';
import { VERSION } from '../version';
import { registerPrompts } from './prompts';
import { registerResources } from './resources';
import { registerTools } from './tools';
import type { ToolDeps } from './tools';

const INSTRUCTIONS = [
  `Answers questions about the ${EVENT.name} session catalog (${EVENT.city}, 17-20 November 2026). All times are ${EVENT.timeZoneLabel}.`,
  'Only report sessions, speakers, times and rooms that the tools return, and link to the session url. Never invent them.',
  'Search is keyword based (with synonyms), not semantic: use short queries such as "kubernetes security" and narrow them with filters (days, startAfter, types, levels, topics, location) instead of writing long sentences. Call get_catalog_overview when unsure which filter values exist.',
  'Pick the tool by intent: search_sessions for keywords, speakers or session codes; recommend_sessions when the user describes interests; get_session for the details of one session; whats_on for a moment in time; build_agenda for a personal schedule; check_schedule_conflicts for a list of sessions; export_calendar for an .ics file.',
].join('\n\n');

const HOUR_MS = 60 * 60 * 1000;
const STATIC = { ttlMs: HOUR_MS, cacheScope: 'public' } as const;
const CATALOG = { ttlMs: 5 * 60 * 1000, cacheScope: 'public' } as const;

/** Tool, prompt and resource listings never change while the server runs; session content follows the catalog refresh. */
const CACHE_HINTS = {
  'tools/list': STATIC,
  'prompts/list': STATIC,
  'resources/list': STATIC,
  'resources/templates/list': STATIC,
  'server/discover': STATIC,
  'resources/read': CATALOG,
} as const;

/** A fresh server for one request: the HTTP handler is stateless, so the catalog lives in `deps`, not here. */
export function createIgniteServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: 'ignite-mcp-server', title: EVENT.name, version: VERSION, description: `Session catalog, recommendations and agenda planning for ${EVENT.name}.` },
    { instructions: INSTRUCTIONS, cacheHints: CACHE_HINTS, maxToolInputElements: 1000 },
  );
  registerTools(server, deps);
  registerResources(server, deps);
  registerPrompts(server, deps);
  return server;
}
