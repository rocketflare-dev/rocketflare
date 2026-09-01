#!/usr/bin/env node
// Boots the dev stack behind a Cloudflare tunnel (see `pnpm dev:tunnel`).
//
// cfld brings up a named tunnel to port 3000 (Vite) and runs THIS script as its managed child
// with the public HTTPS URL in our environment as PUBLIC_URL. Two things need that URL:
//
//   1. Vite (vite.config.ts) reads PUBLIC_URL itself: allowedHosts + HMR over the tunnel's wss.
//      Inheriting the environment is enough.
//   2. The Worker does NOT read the process environment as Worker vars — `wrangler dev` takes
//      `[vars]` from the toml and secrets from .dev.vars. So APP_URL (which derives OAuth
//      redirect URIs, magic-link URLs and the CSRF/CORS allowlist) has to be passed explicitly:
//      `wrangler dev --var APP_URL:<url>`. That is the one reason this script exists instead of
//      `PUBLIC_URL=… pnpm dev`.
//
// Neither .dev.vars nor the tomls are touched; a plain `pnpm dev` still uses http://localhost:3000.
import { spawn } from 'node:child_process'

const publicUrl = process.env.PUBLIC_URL
if (!publicUrl) {
  console.error(
    '[tunnel-dev] PUBLIC_URL is not set — run this via `pnpm dev:tunnel` (cfld injects it), not directly.'
  )
  process.exit(1)
}

console.log(`[tunnel-dev] APP_URL → ${publicUrl}`)

const children = [
  spawn('pnpm', ['dev:api', '--', '--var', `APP_URL:${publicUrl}`], {
    stdio: 'inherit',
    env: process.env,
  }),
  spawn('pnpm', ['dev:ui'], { stdio: 'inherit', env: process.env }),
]

let exiting = false
function shutdown(code, signal) {
  if (exiting) return
  exiting = true
  for (const c of children) if (c.exitCode === null) c.kill(signal ?? 'SIGTERM')
  // cfld owns the process tree and stops it on Ctrl-C; mirror the first child's exit.
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
}

for (const child of children) {
  child.on('exit', (code, signal) => shutdown(code, signal))
  child.on('error', err => {
    console.error(`[tunnel-dev] failed to start: ${err.message}`)
    shutdown(1)
  })
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0, sig))
