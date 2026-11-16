import type { StoreStatus } from '../catalog/store';
import { EVENT } from '../event';
import { VERSION } from '../version';

export interface LandingInfo {
  /** Public origin of this server, without a trailing slash. */
  baseUrl: string;
  /** Undefined while the catalog is still loading. */
  status: StoreStatus | undefined;
  /** True when `/mcp` needs an `Authorization: Bearer` header. */
  requiresKey: boolean;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const EXAMPLES = [
  'Which sessions cover responsible AI?',
  'Plan my Ignite: I care about AI agents and zero trust, and I am only there Tuesday to Thursday.',
  "What's on right now, and what starts in the next hour?",
  'Do BRK217 and LAB652 clash? Export my agenda to my calendar.',
];

export function landingPage(info: LandingInfo): string {
  const endpoint = `${info.baseUrl}/mcp`;
  const headers = info.requiresKey ? `,\n      "headers": { "Authorization": "Bearer <your key>" }` : '';
  const vscode = `{\n  "servers": {\n    "ignite": {\n      "type": "http",\n      "url": "${endpoint}"${headers}\n    }\n  }\n}`;
  const claude = `claude mcp add --transport http ignite ${endpoint}${info.requiresKey ? ' --header "Authorization: Bearer <your key>"' : ''}`;
  const data = info.status
    ? `${info.status.sessions.toLocaleString('en-US')} sessions. ${
        info.status.source === 'live' ? 'Live from the official feed' : 'Bundled snapshot'
      }, data as of ${info.status.dataAsOf}.`
    : 'The session catalog is loading.';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(EVENT.name)} MCP server</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; color: #1b1b1f; background: #fafafa; }
  main { max-width: 46rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
  pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
  pre { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 0.75rem 1rem; overflow-x: auto; }
  code { background: #eee; padding: 0.1em 0.3em; border-radius: 4px; }
  pre code { background: none; padding: 0; }
  small { color: #555; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e6e6; background: #17171a; }
    pre { background: #202024; border-color: #3a3a40; }
    code { background: #2a2a30; }
    small { color: #a0a0a8; }
    a { color: #7aa7ff; }
  }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(EVENT.name)} MCP server</h1>
<p>Connect an AI assistant to the ${escapeHtml(EVENT.name)} session catalog (${escapeHtml(EVENT.city)}). It can search sessions, recommend ones that fit your interests, plan an agenda around clashes and export it to your calendar.</p>
<h2>Connect</h2>
<p>MCP endpoint (Streamable HTTP): <code>${escapeHtml(endpoint)}</code>${info.requiresKey ? '<br><small>This server needs an API key.</small>' : ''}</p>
<h3>VS Code <small>(.vscode/mcp.json)</small></h3>
<pre><code>${escapeHtml(vscode)}</code></pre>
<h3>Claude Code</h3>
<pre><code>${escapeHtml(claude)}</code></pre>
<h2>Try asking</h2>
<ul>
${EXAMPLES.map((example) => `<li>${escapeHtml(example)}</li>`).join('\n')}
</ul>
<p><small>${escapeHtml(data)} Version ${escapeHtml(VERSION)}. Official catalog: <a href="${escapeHtml(EVENT.sessionsUrl)}">${escapeHtml(EVENT.sessionsUrl)}</a></small></p>
</main>
</body>
</html>
`;
}
