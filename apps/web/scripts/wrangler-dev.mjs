#!/usr/bin/env node
// `pnpm dev:api` (and `pnpm dev:tunnel`, through it): `wrangler dev` with every argument passed
// on, run from the generated offline config when `DEV_WORKERS_AI=off` (shell or .dev.vars) —
// `scripts/lib/dev-ai.mjs` says why. `pnpm dev` does the same inside `scripts/dev-server.mjs`.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { wranglerDevConfigArgs } from '../../../scripts/lib/dev-ai.mjs'

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const { args, note } = wranglerDevConfigArgs({ webDir: WEB_DIR })
if (note) console.log(`[dev:api] ${note}`)

const child = spawn(
  path.join(WEB_DIR, 'node_modules/.bin/wrangler'),
  ['dev', ...args, ...process.argv.slice(2)],
  { cwd: WEB_DIR, env: process.env, stdio: 'inherit' }
)
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
child.on('error', err => {
  console.error(`[dev:api] failed to start wrangler: ${err.message}`)
  process.exit(1)
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
