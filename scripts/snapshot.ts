/**
 * Regenerates data/sessions.snapshot.json, the offline fallback bundled with the server.
 *
 *   npm run snapshot                    download the live feed
 *   npm run snapshot -- --input f.json  use a raw feed file you already downloaded
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildSnapshot, fetchFeed } from '../src/catalog/loader';
import { normalizeCatalog } from '../src/catalog/normalize';
import { DEFAULT_DATA_URL } from '../src/event';

const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    url: { type: 'string', default: DEFAULT_DATA_URL },
    output: { type: 'string', default: 'data/sessions.snapshot.json' },
  },
});

const url = values.url ?? DEFAULT_DATA_URL;
const output = resolve(values.output ?? 'data/sessions.snapshot.json');

let feed: unknown;
if (values.input) {
  feed = JSON.parse(await readFile(resolve(values.input), 'utf8')) as unknown;
  console.log(`Read raw feed from ${values.input}`);
} else {
  console.log(`Downloading ${url}`);
  const result = await fetchFeed(url);
  if (result.status !== 'modified') throw new Error('Unexpected 304 response');
  feed = result.feed;
}

const { sessions, skipped } = normalizeCatalog(feed);
if (sessions.length < 100) throw new Error(`Only ${sessions.length} sessions were found; refusing to write a snapshot`);

const snapshot = buildSnapshot(sessions, url);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(snapshot)}\n`);

const scheduled = sessions.filter((session) => session.occurrences.length > 0).length;
console.log(`Wrote ${sessions.length} sessions (${scheduled} scheduled, ${sessions.length - scheduled} on-demand, ${skipped} records skipped) to ${output}`);
