#!/usr/bin/env node
// `pnpm dev:tunnel` and `pnpm web cfld <command>` run cfld through here: install cloudflared the
// first time none is found (scripts/lib/cloudflared.mjs), then hand every argument to cfld.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureCloudflared } from './lib/cloudflared.mjs'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

try {
  await ensureCloudflared({ fromDir: appDir })
} catch (err) {
  console.error(`[cfld] ${err.message}`)
  process.exit(1)
}

const cfldPkg = createRequire(path.join(appDir, 'package.json')).resolve(
  '@cliftonc/cfld/package.json'
)
const { bin } = JSON.parse(readFileSync(cfldPkg, 'utf8'))
const cli = path.join(path.dirname(cfldPkg), typeof bin === 'string' ? bin : bin.cfld)

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' })
// cfld owns the terminal and its process tree: Ctrl-C reaches it directly (same process group),
// a SIGTERM sent to this wrapper alone is passed on, and the wrapper mirrors how cfld exits.
const onSigint = () => {}
const onSigterm = () => child.kill('SIGTERM')
process.on('SIGINT', onSigint)
process.on('SIGTERM', onSigterm)
child.on('exit', (code, signal) => {
  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
