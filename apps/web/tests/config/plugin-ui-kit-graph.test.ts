/**
 * The plugin UI kit (`@/plugins/api/ui`, `@/plugins/api/ui-wiring`) must not reach the Home PAGE
 * through any import, type-only included. Anything that typechecks a plugin page compiles this
 * graph — `apps/evals` does, through an analytics page — and Home is the page an app grows first:
 * as soon as it imported a component reading `import.meta.env`, `apps/evals` (no Vite client
 * types) failed TS2339 (#178). The core quick links are data in `pages/home-links.ts` for this
 * reason, as the settings tabs are in `pages/settings/tabs.ts`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '../../src')
const ENTRIES = ['plugins/api/ui.ts', 'plugins/api/ui-wiring.ts']
const BANNED = ['ui/pages/Home.tsx']

const SPECIFIER_RE = /(?:^|\s)(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g

function resolve(fromFile: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith('@/')) base = path.join(SRC, specifier.slice(2))
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier)
  else return null
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** Every `src/` file reachable from `entry` by static import or re-export, with the path to it. */
function reachable(entry: string): Map<string, string[]> {
  const start = path.join(SRC, entry)
  const seen = new Map<string, string[]>([[start, [entry]]])
  const queue = [start]
  while (queue.length > 0) {
    const file = queue.shift() as string
    const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const match of source.matchAll(SPECIFIER_RE)) {
      const target = resolve(file, match[1])
      if (!target || seen.has(target)) continue
      seen.set(target, [...(seen.get(file) ?? []), path.relative(SRC, target)])
      queue.push(target)
    }
  }
  return seen
}

describe('the plugin UI kit import graph', () => {
  it.each(ENTRIES)('%s never reaches the Home page', entry => {
    const graph = reachable(entry)
    expect(graph.size).toBeGreaterThan(5)
    const hits = BANNED.map(b => graph.get(path.join(SRC, b))).filter(Boolean)
    expect(hits).toEqual([])
  })
})
