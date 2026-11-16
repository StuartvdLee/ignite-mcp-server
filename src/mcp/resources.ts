import { ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';
import { completeSessionCodes } from './complete';
import { overviewView, sessionDetailView } from './present';
import { overviewText, sessionDetailText } from './render';
import type { ToolDeps } from './tools';

const MARKDOWN = 'text/markdown';

/** Clients percent-encode what a user typed ("BRK 217" arrives as "BRK%20217"); the template match leaves it encoded. */
function decodeVariable(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Context a user can attach to a chat: the catalog overview and any single session. */
export function registerResources(server: McpServer, deps: ToolDeps): void {
  server.registerResource(
    'catalog-overview',
    'ignite://overview',
    {
      title: 'Ignite 2026 catalog overview',
      description: 'Dates, venues, sessions per day, the available filter values (types, topics, levels, audiences) and how fresh the data is.',
      mimeType: MARKDOWN,
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: MARKDOWN, text: overviewText(overviewView(deps.catalog(), deps.status())) }],
    }),
  );

  server.registerResource(
    'session',
    new ResourceTemplate('ignite://sessions/{code}', {
      list: undefined,
      complete: { code: (value) => completeSessionCodes(deps.catalog(), value) },
    }),
    {
      title: 'Ignite 2026 session',
      description: 'Everything about one session: description, speakers, time slots, rooms and related sessions. For example ignite://sessions/BRK217.',
      mimeType: MARKDOWN,
    },
    (uri, variables) => {
      const catalog = deps.catalog();
      const value = variables.code;
      const code = decodeVariable(Array.isArray(value) ? (value[0] ?? '') : (value ?? ''));
      const resolved = code ? catalog.resolveRef(code) : undefined;
      if (!resolved) throw new ResourceNotFoundError(uri.href, `No session found for "${code}".`);
      return {
        contents: [{ uri: uri.href, mimeType: MARKDOWN, text: sessionDetailText(sessionDetailView(catalog, resolved.session)) }],
      };
    },
  );
}
