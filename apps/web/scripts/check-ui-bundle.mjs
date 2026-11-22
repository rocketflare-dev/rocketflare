#!/usr/bin/env node
/**
 * Chunk discipline (`.claude/rules/ui.md`), checked on the build `vite build` just wrote: `build:ui`
 * runs this straight after it, so the check always reads a fresh bundle, never a stale one. The
 * eager shell must not carry the chat, analytics or markdown dependencies, the run workspace is
 * its own lazy chunk, and protobuf never reaches the browser: `@ag-ui/encoder` and `@ag-ui/proto`
 * are server dependencies, and only `@ag-ui/core`'s zod schemas ship, in the lazy chat chunk. The
 * source-level half (`components/shared` imports no markdown renderer) is
 * `tests/config/ui-bundle.test.ts`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/ui/assets')

/** What must never appear in the eager entry chunk. */
const EAGER_FORBIDDEN = ['recharts', 'drizzle-cube', 'react-markdown']
/** What must never appear in ANY chunk: the protobuf transport is the server's business. */
const FORBIDDEN_ANYWHERE = ['@bufbuild/protobuf', '@ag-ui/proto', '@ag-ui/encoder']

if (!existsSync(ASSETS)) {
  console.error(`✖ ui bundle: ${ASSETS} does not exist — run vite build first`)
  process.exit(1)
}
const chunks = readdirSync(ASSETS).filter(f => f.endsWith('.js'))
const read = f => readFileSync(path.join(ASSETS, f), 'utf8')
const problems = []

const entry = chunks.filter(f => /^index-[^.]+\.js$/.test(f))
if (entry.length !== 1) problems.push(`expected one eager entry chunk, found ${entry.length}`)
else {
  const source = read(entry[0])
  for (const needle of EAGER_FORBIDDEN) {
    if (source.includes(needle)) problems.push(`the eager entry chunk carries ${needle}`)
  }
}
// The run workspace is reached from a notification by people who may never open any other AI
// surface, so the shell must not pay for it.
if (chunks.filter(f => f.startsWith('RunPage-')).length !== 1) {
  problems.push('the run workspace is not its own lazy chunk (RunPage-*.js)')
}
for (const file of chunks) {
  const source = read(file)
  for (const needle of FORBIDDEN_ANYWHERE) {
    if (source.includes(needle)) problems.push(`${file} ships ${needle}`)
  }
}

if (problems.length) {
  console.error(`✖ ui bundle (.claude/rules/ui.md, chunk discipline):\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`✔ ui bundle: ${chunks.length} chunks, chunk discipline holds`)
