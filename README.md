# Microsoft Ignite 2026 MCP server

An [MCP](https://modelcontextprotocol.io) server for the Microsoft Ignite 2026 session catalog (San Francisco, 16–20 November 2026). Connect it to an AI assistant to ask about sessions, find the ones that match your interests, plan a conflict-free agenda and put it in your calendar.

- **The full catalog.** It serves Microsoft's public session feed ([aka.ms/ignite2026-session-info](https://aka.ms/ignite2026-session-info)), 1,353 sessions at the time of writing. The feed is rechecked every 15 minutes and kept in memory; a bundled snapshot is the fallback when it can't be reached.
- **8 tools, 2 resources and 3 prompts.** All of them are read-only.

## What you can ask

- "Which sessions cover Kubernetes security?"
- "Which labs are on Wednesday afternoon?"
- "I care about AI agents, Microsoft Fabric and Zero Trust, and I'm there Tuesday to Thursday. Plan my agenda."
- "What's on right now? Anything about security starting in the next hour?"
- "Do LTG1279, THR901 and LAB722 clash?"
- "Put that agenda in my calendar, with a reminder 10 minutes before each session."

What `search_sessions` returns for the query "Azure Container Apps" on Wednesday, limited to 3 results (the first two are shown):

```text
31 sessions found for "Azure Container Apps"; showing 1–3. Filters: days: 2026-11-18. All times are Pacific Time (San Francisco).

1. **LTG1279** · [Deploy AI apps effortlessly with Azure Container Apps Express](https://ignite.microsoft.com/en-US/sessions/1787856679900001E1WS-1791588182996001CK1M?source=sessions)
   Lightning Talk · Level 200 (Intermediate) · In-person
   Wed Nov 18, 1:20–1:35 PM · Moscone South, The Hub, Lightning Talk 2
   Speakers: Chris Ross
   Matched: title; description
   Learn how Azure Container Apps Express helps practitioners quickly orchestrate AI capabilities without Kubernetes expertise. See how to deploy, operate, and scale from zero to hyperscale without…
2. **LAB722** · [Operate secure, multi-tenant agentic apps on Azure Container Apps](https://ignite.microsoft.com/en-US/sessions/1787856876398001h9Z7-1791588128453001CPL2?source=sessions)
   Lab · Level 300 (Advanced) · In-person
   Wed Nov 18, 2:15–3:30 PM · Moscone West, Level 3, Room 3020
   Speakers: Ahmed ElSayed, Jenny Lawrance
   Matched: title; description
   Build the skills to run multi-tenant isolated AI workloads in production. You will place a workload in the right isolation boundary for user separation, contain untrusted code, scale from zero, right…
…
```

Every tool returns readable text like this for the model, plus structured content for clients that use it. All times are Pacific Time.

## Tools, resources and prompts

| Tool | Use it to |
| --- | --- |
| `search_sessions` | Search by keywords, topic, technology, speaker, company or session code, narrowed down with filters. Ranked by relevance or by time, with paging. |
| `get_session` | Get everything about one session: description, speakers, every time slot and room, resources, linked and similar sessions. |
| `recommend_sessions` | Pick sessions for several interests at once. The picks are balanced across the interests, each with a reason. |
| `whats_on` | See what is in progress and what starts soon, right now or at a given moment. Before the event it shows the opening sessions. |
| `build_agenda` | Plan a conflict-free agenda per day from interests. Walking time between venues is kept free; sessions can be required or avoided; alternatives and on-demand picks are listed. |
| `check_schedule_conflicts` | Find overlaps and too-short gaps in a list of sessions, and get other time slots that fix them. |
| `export_calendar` | Create an iCalendar (`.ics`) file for Outlook, Google Calendar or Apple Calendar: a download link when the server offers one, otherwise the file content. |
| `get_catalog_overview` | See dates, venues, counts, the values the filters accept and how fresh the data is. |

`search_sessions`, `recommend_sessions` and `build_agenda` share these optional filters: `topics`, `types`, `levels`, `audiences`, `industries`, `delivery`, `tags`, `speaker`, `company`, `days`, `startAfter`, `startBefore`, `location`, `recorded`, `sponsored` and `scheduled`. `whats_on` takes `topics`, `types`, `levels`, `audiences`, `delivery` and `location`. Sessions that are offered several times can be referred to by code (`LAB650`) or by slot (`LAB650@2026-11-18T14:00`).

| Resource | Content |
| --- | --- |
| `ignite://overview` | The catalog overview. |
| `ignite://sessions/{code}` | One session; codes are auto-completed. |

| Prompt | Does |
| --- | --- |
| `plan_my_ignite` | Plans an agenda from your interests (and optionally the days you attend). |
| `session_briefing` | Prepares you for one session. |
| `topic_roundup` | Collects everything on a topic by type and day. |

## Connect a client

The endpoint is `/mcp` (Streamable HTTP): `http://localhost:3000/mcp` when you run it locally.

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "ignite": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

When the server requires an API key (see [Security](#security)):

```json
{
  "servers": {
    "ignite": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer ${input:ignite-key}" }
    }
  },
  "inputs": [{ "id": "ignite-key", "type": "promptString", "description": "Ignite MCP API key", "password": true }]
}
```

**Claude Code:**

```bash
claude mcp add --transport http ignite http://localhost:3000/mcp
# with an API key: add --header "Authorization: Bearer <key>"
```

**GitHub Copilot CLI** (`~/.copilot/mcp-config.json`):

```json
{
  "mcpServers": {
    "ignite": { "type": "http", "url": "http://localhost:3000/mcp", "tools": ["*"] }
  }
}
```

To try it without a client, call a tool with curl (the server is stateless, so there is no handshake):

```bash
curl -s http://localhost:3000/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_catalog_overview","arguments":{}}}'
```

## Run it locally

You need Node.js 22 or newer.

```bash
npm ci
npm run dev      # http://localhost:3000/mcp, restarts when you edit a file
```

Or the production build:

```bash
npm run build && npm start
```

`GET /healthz` reports whether the catalog is loaded and where it came from (`snapshot` or `live`).

## Configuration reference

Environment variables of the server itself.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on. `CONTAINER_APP_PORT` is the fallback. |
| `HOST` | `0.0.0.0` | Interface to listen on. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `IGNITE_DATA_URL` | the official feed | Where the catalog is downloaded from. |
| `REFRESH_INTERVAL_MINUTES` | `15` | Minutes between checks for a new feed. `0` turns refreshing off. |
| `SNAPSHOT_PATH` | bundled | A snapshot file to use instead of `data/sessions.snapshot.json`. |
| `PUBLIC_BASE_URL` | detected | The public origin, used for calendar download links. On Container Apps it is built from `CONTAINER_APP_NAME` and `CONTAINER_APP_ENV_DNS_SUFFIX`, which the platform sets. |
| `ALLOWED_HOSTS` | none | Host names accepted besides `localhost` and the app's own address. |
| `ALLOWED_ORIGINS` | none | Browser origins that get CORS access. |
| `RATE_LIMIT_PER_MINUTE` | `120` | Requests per minute for each client IP and replica, for `/mcp` and `/calendar.ics`. `0` turns the limit off. |
| `TRUST_PROXY_HOPS` | `1` | Reverse proxies in front of the app; the Container Apps ingress is one. |
| `MCP_API_KEY` | none | When set, `/mcp` and `/calendar.ics` require `Authorization: Bearer <key>`. |

## Security

The data is public and every tool is read-only; the only outbound call is the catalog download.

- **Host and Origin checks** protect against DNS rebinding. `/mcp` answers only for `localhost`, the app's own address and `ALLOWED_HOSTS`, and it refuses a browser `Origin` from any other host unless it is listed in `ALLOWED_ORIGINS`. Both answer `403`. `/healthz` answers for any host, so platform probes work.
- **CORS** is off unless `ALLOWED_ORIGINS` lists the exact origins of your browser apps. Clients that aren't browsers aren't affected.
- **Rate limit** of 120 requests a minute for each client IP and replica (`429` with `Retry-After`).
- **API key** (optional): set `MCP_API_KEY` to a long random value, for example `openssl rand -hex 32`. It is compared in constant time. The rate limit is the only protection against guessing, so don't use a short key. Without a key, anyone who knows the address can use the server, and the compute it runs on.
- **Calendar downloads:** `export_calendar` can give a link to `/calendar.ics`, but only when the public address is known and there is no API key (a link can't carry the key). With a key, the tool returns the file content instead.
- **Request bodies** are limited to 128 KiB.

## How it works and its limits

At startup the server reads the bundled snapshot, so it answers within a second of the process starting on a laptop, then downloads the live feed and switches to it. Later it checks the feed every 15 minutes with a conditional request, and it ignores a feed that is suddenly far smaller than the current catalog. Search is a full-text index (MiniSearch) over codes, titles, tags, speakers, topics, companies, session types, audiences and descriptions, with stemming and a list of synonyms for common terms. Recommendations search each interest separately and balance the picks. Agendas are planned in memory for each request; nothing is stored between requests.

- **Search is lexical.** It matches words and their synonyms, not meaning, so a description in entirely different words can be missed.
- **The walking time between venues is a heuristic**, an estimate by venue, not a route.
- **Session links point to a time slot.** The Ignite site has a page per session instance (`{sessionId}-{sessionTimeId}`), so a session that runs several times links to its first slot, and calendar entries link to their own slot.
- **Large answers.** A 25-result search is about 42 KB; the biggest answers are up to roughly 130 KB. Ask for fewer results if your client struggles.
- **No push.** The server is stateless and doesn't send notifications; the catalog changes show up on the next call after a refresh. Each replica keeps its own copy and its own rate-limit counters.

## Development

```bash
npm run check      # type-check and run the tests (Vitest; fixtures and a fixed clock, no network needed)
npm run build      # bundle the server into dist/server.mjs (esbuild)
npm run snapshot   # download the live feed and rewrite data/sessions.snapshot.json
```

`npm run snapshot -- --input feed.json` builds the snapshot from a feed file you already have. Commit the new snapshot and deploy again to update the fallback data.

```text
src/
  server.ts       process entry: loads the catalog, starts HTTP, drains on SIGTERM
  app.ts          Express app: /mcp, /healthz, /calendar.ics, guards, request log
  config.ts       environment variables
  catalog/        loading, normalising, searching, scheduling, agendas, calendar files
  mcp/            tools, resources, prompts and their schemas
  http/           host, origin and CORS guards, rate limiter, landing page
data/             the bundled fallback catalog (sessions.snapshot.json)
scripts/          build.mjs (bundler) and snapshot.ts
test/             Vitest suites
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `403` from `/mcp` | The Host or Origin isn't allowed. Use `localhost` locally; for a custom domain set `ALLOWED_HOSTS`, and `ALLOWED_ORIGINS` for browser apps. |
| `401` from `/mcp` | The server has an API key. Send `Authorization: Bearer <key>`. |
| `429` | The rate limit. Wait the `Retry-After` seconds, or raise `RATE_LIMIT_PER_MINUTE`. |
| `/healthz` answers `503` | The catalog is still loading, which takes a moment after a start. |
