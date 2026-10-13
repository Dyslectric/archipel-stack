import { cpSync, existsSync, mkdirSync } from 'node:fs';
// Keep compiled workspace startup self-contained, with the same relative assets
// as the Docker runtime. These are generated build directories only.
const build = new URL('../build/', import.meta.url);
mkdirSync(build, { recursive: true });
cpSync(new URL('../migrations/', import.meta.url), new URL('migrations/', build), { recursive: true });
const client = new URL('../dist/client/', import.meta.url);
if (existsSync(new URL('index.html', client))) {
  mkdirSync(new URL('dist/', build), { recursive: true });
  cpSync(client, new URL('dist/client/', build), { recursive: true });
}
