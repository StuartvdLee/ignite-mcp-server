// Bundles the server into dist/server.mjs: one file that runs with plain `node`, so the container image needs
// neither node_modules nor a TypeScript runtime. The bundled snapshot (data/sessions.snapshot.json) stays a separate
// file next to it; the server finds it at ./data/sessions.snapshot.json or ../data/sessions.snapshot.json.
import { rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));

await rm(path('../dist'), { recursive: true, force: true });

await build({
  entryPoints: [path('../src/server.ts')],
  outfile: path('../dist/server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  logLevel: 'warning',
  // Some bundled dependencies are CommonJS and call require() for Node built-ins.
  banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
});

const { size } = await stat(path('../dist/server.mjs'));
console.log(`dist/server.mjs ${(size / 1024 / 1024).toFixed(2)} MB`);
