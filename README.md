# Microsoft Ignite 2026 MCP server

An [MCP](https://modelcontextprotocol.io) server for the Microsoft Ignite 2026 session catalog (San Francisco, 16–20 November 2026). Connect it to an AI assistant to ask about sessions, find the ones that match your interests, plan a conflict-free agenda and put it in your calendar.

- **The full catalog.** It serves Microsoft's public session feed ([aka.ms/ignite2026-session-info](https://aka.ms/ignite2026-session-info)), 1,353 sessions at the time of writing. The feed is rechecked every 15 minutes and kept in memory; a bundled snapshot is the fallback when it can't be reached.
- **Built for Azure Container Apps.** One small stateless container, no database. `infra/` deploys it to the Consumption plan at the smallest replica size.
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

1. **LTG1279** · [Deploy AI apps effortlessly with Azure Container Apps Express](https://ignite.microsoft.com/en-US/sessions/1787856679900001E1WS-AAAAAAAAAAAAAAAAAAAA?source=sessions)
   Lightning Talk · Level 200 (Intermediate) · In-person
   Wed Nov 18, 1:20–1:35 PM · Moscone South, The Hub, Lightning Talk 2
   Speakers: Chris Ross
   Matched: title; description
   Learn how Azure Container Apps Express helps practitioners quickly orchestrate AI capabilities without Kubernetes expertise. See how to deploy, operate, and scale from zero to hyperscale without…
2. **LAB722** · [Operate secure, multi-tenant agentic apps on Azure Container Apps](https://ignite.microsoft.com/en-US/sessions/1787856876398001h9Z7-AAAAAAAAAAAAAAAAAAAA?source=sessions)
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

The endpoint is `/mcp` (Streamable HTTP): `http://localhost:3000/mcp` when you run it locally, and the address that `infra/deploy.sh` prints once it is deployed.

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "ignite": {
      "type": "http",
      "url": "https://<your-app>.<region>.azurecontainerapps.io/mcp"
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
      "url": "https://<your-app>.<region>.azurecontainerapps.io/mcp",
      "headers": { "Authorization": "Bearer ${input:ignite-key}" }
    }
  },
  "inputs": [{ "id": "ignite-key", "type": "promptString", "description": "Ignite MCP API key", "password": true }]
}
```

**Claude Code:**

```bash
claude mcp add --transport http ignite https://<your-app>.<region>.azurecontainerapps.io/mcp
# with an API key: add --header "Authorization: Bearer <key>"
```

**GitHub Copilot CLI** (`~/.copilot/mcp-config.json`):

```json
{
  "mcpServers": {
    "ignite": { "type": "http", "url": "https://<your-app>.<region>.azurecontainerapps.io/mcp", "tools": ["*"] }
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

Or the production build, or Docker (the image uses Node 24 and listens on 8080):

```bash
npm run build && npm start

docker build -t ignite-mcp .
docker run --rm -p 8080:8080 ignite-mcp    # http://localhost:8080/mcp
```

`GET /healthz` reports whether the catalog is loaded and where it came from (`snapshot` or `live`).

## Deploy to Azure Container Apps

The template in `infra/` runs the server on the **Consumption plan**, the pay-per-use option without dedicated hardware: one replica of 0.25 vCPU and 0.5 GiB, the smallest size that Container Apps offers.

| Resource | Notes |
| --- | --- |
| Container Apps environment | Only the Consumption workload profile, so there are no fixed hourly charges. |
| Container app | One replica that is always running (it keeps the catalog warm), up to three under load, HTTPS only. |
| Azure Container Registry | Basic SKU. The app pulls its image with a managed identity (AcrPull), so there is no admin user or password. |
| Log Analytics workspace | 30 days of logs, capped at 0.1 GB a day, fed by a diagnostic setting on the environment. |

### Deploy

You need the [Azure CLI](https://aka.ms/installazurecli), signed in with `az login`, and **Owner** on the resource group (or Contributor plus User Access Administrator), because the template grants the AcrPull role.

```bash
infra/deploy.sh ignite-rg westeurope      # the location is only needed if the resource group doesn't exist yet
```

The script deploys in two steps, because the app can't start before its image exists and the image needs a registry:

1. It creates the resource group if necessary, then the registry, the environment and the workspace.
2. It builds the image in the registry with `az acr build` (when ACR Tasks isn't available for your subscription type, it falls back to a local Docker build and push), deploys the app with that image and waits until `/healthz` answers.

It ends with `MCP endpoint: https://ignite-mcp.<…>.azurecontainerapps.io/mcp`; use that address in your client.

### Settings

Settings are read from environment variables by `infra/main.bicepparam`, so secrets never appear on a command line. All of them are optional.

| Variable | Default | Effect |
| --- | --- | --- |
| `APP_NAME` | `ignite-mcp` | Name of the container app and prefix of the other resources: 2–24 lowercase letters, numbers and hyphens. |
| `MIN_REPLICAS` | `1` | `1` keeps the server warm. `0` lets it scale to zero when idle: no compute cost, but the first request after a pause waits several seconds for a replica to start. |
| `MAX_REPLICAS` | `3` | The most replicas it scales out to; a replica is added when it has more than 20 concurrent requests. |
| `REPLICA_CPU` | `0.25` | `0.25`, `0.5`, `1` or `2` vCPU. The memory follows: 0.5, 1, 2 or 4 GiB. |
| `MCP_API_KEY` | none | Clients must send `Authorization: Bearer <key>`. Stored as a Container Apps secret. |
| `ALLOWED_ORIGINS` | none | Comma separated origins of browser apps that may call the server (CORS). |
| `ALLOWED_HOSTS` | none | Extra host names the server answers to, such as a custom domain. |
| `PUBLIC_BASE_URL` | detected | The address clients use. Only needed behind a custom domain. |
| `IGNITE_DATA_URL` | official feed | Where the catalog is downloaded from. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

```bash
MIN_REPLICAS=0 infra/deploy.sh ignite-rg                           # scale to zero when idle
MCP_API_KEY="$(openssl rand -hex 32)" infra/deploy.sh ignite-rg    # require an API key
```

### Update, custom domain, tear down

- **Update:** run `infra/deploy.sh` again. Every run builds a new image and applies the whole configuration, so pass the same variables each time. A setting you leave out goes back to its default, and that includes `MCP_API_KEY`.
- **Custom domain:** [add the domain and a managed certificate](https://learn.microsoft.com/azure/container-apps/custom-domains-managed-certificates), then deploy with `ALLOWED_HOSTS=<domain>` and `PUBLIC_BASE_URL=https://<domain>`. The template doesn't manage domain bindings, so a later deploy can remove a binding that was made by hand; bind the domain again afterwards.
- **Tear down:** `az group delete --name ignite-rg` deletes everything, including the registry and the logs.

### Logs

The server writes one JSON object per line (`time`, `level`, `msg` and fields such as `method`, `path`, `status` and `ms` for each request).

```bash
az containerapp logs show --name ignite-mcp --resource-group ignite-rg --follow           # live console output
az containerapp logs show --name ignite-mcp --resource-group ignite-rg --type system      # platform events
```

The stored logs are in the workspace `ignite-mcp-logs`: open it in the portal and choose **Logs** (the container app's own Logs page is disabled with this setup). The template sends them with the `azure-monitor` destination and a diagnostic setting on the environment, which replaces the older, deprecated Log Analytics destination. Azure documents that a new diagnostic setting can take up to 90 minutes to start delivering, so the live stream above is the quickest way to see what a fresh deployment does.

```kusto
ContainerAppConsoleLogs
| where ContainerAppName == "ignite-mcp" and Log startswith "{"
| extend e = parse_json(Log)
| where tostring(e.msg) == "Request"
| project TimeGenerated, method = tostring(e.method), path = tostring(e.path), status = toint(e.status), ms = toint(e.ms)
| order by TimeGenerated desc
```

```kusto
ContainerAppConsoleLogs
| where ContainerAppName == "ignite-mcp" and Log startswith "{"
| extend e = parse_json(Log)
| where tostring(e.level) in ("warn", "error")
| project TimeGenerated, level = tostring(e.level), msg = tostring(e.msg), error = tostring(e.error)
| order by TimeGenerated desc
```

The cap of 0.1 GB a day keeps ingestion inside the free allowance; when it is reached, logs stop for the rest of that day. Raise `dailyQuotaGb` in `infra/main.bicep` if you expect heavy traffic.

### Deploy from GitHub Actions

`.github/workflows/ci.yml` runs on every push to `main` and every pull request: type-check and tests on Node 22 and 24, the bundle, a Docker build that is started and called (health, one tool call, graceful stop), and a compile of the Bicep template.

`.github/workflows/deploy.yml` is started by hand (Actions tab, **Deploy**, **Run workflow**) and runs `infra/deploy.sh`. It signs in with OpenID Connect, so no Azure password or secret is stored in GitHub. One-time setup:

```bash
SUB=$(az account show --query id -o tsv)
TENANT=$(az account show --query tenantId -o tsv)
RG=ignite-rg
LOCATION=westeurope

az group create --name $RG --location $LOCATION
APP_ID=$(az ad app create --display-name ignite-mcp-deploy --query appId -o tsv)
SP_ID=$(az ad sp create --id $APP_ID --query id -o tsv)

# Trust workflow runs on the main branch of this repository
az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "github-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:StuartvdLee/ignite-mcp-server:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'

# The template assigns the AcrPull role, which needs User Access Administrator next to Contributor
for ROLE in "Contributor" "User Access Administrator"; do
  az role assignment create --assignee-object-id $SP_ID --assignee-principal-type ServicePrincipal \
    --role "$ROLE" --scope /subscriptions/$SUB/resourceGroups/$RG
done

gh variable set AZURE_CLIENT_ID --body $APP_ID
gh variable set AZURE_TENANT_ID --body $TENANT
gh variable set AZURE_SUBSCRIPTION_ID --body $SUB
gh variable set AZURE_RESOURCE_GROUP --body $RG
gh variable set AZURE_LOCATION --body $LOCATION
gh secret set MCP_API_KEY            # optional: asks for the value
```

Then run `gh workflow run deploy.yml`. The settings from the table above can be set as repository variables of the same name (`APP_NAME`, `MIN_REPLICAS`, `MAX_REPLICAS`, `REPLICA_CPU`, `LOG_LEVEL`, `ALLOWED_ORIGINS`, `ALLOWED_HOSTS`, `PUBLIC_BASE_URL`, `IGNITE_DATA_URL`); the workflow passes them on to the script. The credential only trusts the `main` branch, so run the workflow from there. Whoever can push to `main` can then deploy to that resource group: protect the branch.

### Cost

List prices in US dollars for a month with one replica running all the time, and almost no traffic:

| Item | Per month |
| --- | --- |
| Container app: 0.25 vCPU and 0.5 GiB, mostly idle | about $4 in US regions, $5.60 in West Europe, after the free grant |
| Container Registry, Basic | about $5 |
| Log Analytics, capped at 0.1 GB a day | $0, inside the free monthly allowance |
| **Total** | **about $9–11** |

- Container Apps bills the vCPU-seconds and GiB-seconds that replicas use, plus requests. Every subscription gets a free grant each month (180,000 vCPU-seconds, 360,000 GiB-seconds and 2 million requests), shared by all its container apps. A replica that is waiting for requests pays a lower idle rate for CPU, and health probes aren't billed.
- A replica that is busy around the clock costs about $20 a month, but one small replica is nowhere near that for this workload.
- `MIN_REPLICAS=0` brings the compute cost to about nothing, at the price of cold starts. The registry stays.
- Prices differ per region and change over time; check the [Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/).

Measured on one full CPU core of a development machine: about 80 heavy search calls a second, which suggests roughly 20 for a 0.25 vCPU replica (an extrapolation, not a measurement). A 25-result search answers with about 42 KB, and memory peaked at 222 MiB of the 512 MiB limit under load, with no growth over thousands of requests.

## Configuration reference

Environment variables of the server itself. In Container Apps the template sets `PORT`, `LOG_LEVEL` and what the settings table above lists; the rest keep their defaults.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` (`8080` in the image) | Port to listen on. `CONTAINER_APP_PORT` is the fallback. |
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
- **API key** (optional): set `MCP_API_KEY` to a long random value, for example `openssl rand -hex 32`. It is compared in constant time and stored as a Container Apps secret. The rate limit is the only protection against guessing, so don't use a short key. Without a key, anyone who knows the address can use the server, and the compute it runs on.
- **Calendar downloads:** `export_calendar` can give a link to `/calendar.ics`, but only when the public address is known and there is no API key (a link can't carry the key). With a key, the tool returns the file content instead.
- **Containers and Azure:** request bodies are limited to 128 KiB, the container runs as the non-root `node` user, HTTP is redirected to HTTPS, and the registry has no admin user.

## How it works and its limits

At startup the server reads the bundled snapshot, so it answers within a second of the process starting on a laptop (a cold replica also has to pull the image), then downloads the live feed and switches to it. Later it checks the feed every 15 minutes with a conditional request, and it ignores a feed that is suddenly far smaller than the current catalog. Search is a full-text index (MiniSearch) over codes, titles, tags, speakers, topics, companies, session types, audiences and descriptions, with stemming and a list of synonyms for common terms. Recommendations search each interest separately and balance the picks. Agendas are planned in memory for each request; nothing is stored between requests.

- **Search is lexical.** It matches words and their synonyms, not meaning, so a description in entirely different words can be missed.
- **The walking time between venues is a heuristic**, an estimate by venue, not a route.
- **The link to a session is built from its id** in the format of the Ignite site. The site blocks automated requests, so the format could not be checked here; if a link doesn't open, search for the session code on the catalog site.
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
infra/            main.bicep, main.bicepparam and deploy.sh
test/             Vitest suites
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `403` from `/mcp` | The Host or Origin isn't allowed. The default Container Apps address works as is; for a custom domain set `ALLOWED_HOSTS`, and `ALLOWED_ORIGINS` for browser apps. |
| `401` from `/mcp` | The server has an API key. Send `Authorization: Bearer <key>`. |
| `429` | The rate limit. Wait the `Retry-After` seconds, or raise `RATE_LIMIT_PER_MINUTE`. |
| `/healthz` answers `503` | The catalog is still loading, which takes a moment after a start. |
| `MissingSubscriptionRegistration` while deploying | Register the providers once: `az provider register --namespace Microsoft.App`, and the same for `Microsoft.ContainerRegistry`, `Microsoft.OperationalInsights` and `Microsoft.Insights`. |
| `deploy.sh` reports that the app isn't healthy | Read its logs with the `az containerapp logs show` commands above. They work straight away, unlike the stored logs. |
| No rows in Log Analytics | Wait; after the first deployment the diagnostic setting can take up to 90 minutes. |
