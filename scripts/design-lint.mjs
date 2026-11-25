#!/usr/bin/env node
/**
 * `pnpm design:lint [path…] [--json]` — the UI lint (`lib/ui-lint.mjs`) over the UI tree:
 * `apps/web/src/ui/**` and every plugin's `apps/web/src/plugins/<id>/ui/**`, or only the paths
 * given. Bans are failures (exit 1); reflexes print as notes and never fail.
 *
 * The rules and their reasons are `.claude/rules/ui.md` "Visual quality". Silence one finding with
 * `// ui-allow <rule>: <reason>` on the line above it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatFinding, isUiPath, lintSource, splitFindings } from './lib/ui-lint.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DIRS = ['apps/web/src/ui', 'apps/web/src/plugins']

function walk(dir, out) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function main(argv) {
  const json = argv.includes('--json')
  const args = argv.filter(a => a !== '--json')
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('usage: pnpm design:lint [path…] [--json]\n')
    return 0
  }
  const roots = (args.length > 0 ? args : DEFAULT_DIRS).map(p => path.resolve(ROOT, p))
  const files = roots
    .flatMap(p => (existsSync(p) && statSync(p).isDirectory() ? walk(p, []) : [p]))
    .map(p => path.relative(ROOT, p).replaceAll('\\', '/'))
    .filter(rel => (args.length > 0 ? /\.(tsx|ts|jsx|css)$/.test(rel) : isUiPath(rel)))
    .sort()
  const findings = files.flatMap(rel =>
    existsSync(path.join(ROOT, rel))
      ? lintSource(readFileSync(path.join(ROOT, rel), 'utf8'), rel)
      : []
  )
  const { bans, reflexes } = splitFindings(findings)
  if (json) {
    process.stdout.write(`${JSON.stringify({ files: files.length, bans, reflexes }, null, 2)}\n`)
    return bans.length > 0 ? 1 : 0
  }
  for (const f of bans) process.stdout.write(`ban     ${formatFinding(f)}\n`)
  for (const f of reflexes) process.stdout.write(`reflex  ${formatFinding(f)}\n`)
  process.stdout.write(
    `design:lint: ${files.length} file(s), ${bans.length} ban(s), ${reflexes.length} reflex note(s)` +
      (reflexes.length > 0
        ? ' — reflexes are questions, not failures: does the brief earn it?'
        : '') +
      '\n'
  )
  return bans.length > 0 ? 1 : 0
}

process.exitCode = main(process.argv.slice(2))
