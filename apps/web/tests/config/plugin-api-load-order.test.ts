/**
 * `@/plugins/api` must finish loading before any plugin module evaluates against it.
 *
 * The plugin API and the server barrel are in a cycle by design: `peers.ts` reads the barrel, and
 * a handful of kit modules read it at module scope. Enter the app through one plugin's module
 * (which is what a plugin's own test file does) and the chain is: plugin A → `@/plugins/api` →
 * … → `plugins/server.ts` → plugin B → `@/plugins/api` again, which is still loading. B then
 * evaluates against whatever parts of the API had finished, so a `createRouter()` at its module
 * scope throws `createRouter is not a function`. The bug only shows with two plugins installed.
 *
 * Which parts have finished depends on the ORDER of `plugins/api/index.ts`'s re-exports: every
 * module listed before the first one that reaches the barrel is complete when B runs. So the
 * rule is that only the modules in `MAY_REACH_BARREL` reach the barrel statically, and each sits
 * after `http.ts` (`createRouter`) and `ai.ts` (`defineTool`), the two values a plugin uses at
 * module scope. A new edge is cut by moving the value to a leaf module (`services/ai/fusion.ts`)
 * or by importing at call time (`searchKnowledge` loads `retrieval.ts` lazily).
 *
 * The scan follows runtime imports and re-exports only; `import type` / `export type` are erased
 * before anything evaluates.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '../../src')
const API_INDEX = path.join(SRC, 'plugins/api/index.ts')
const BARREL = path.join(SRC, 'plugins/server.ts')

/** `plugins/api/*` modules allowed to reach the barrel at load, each after the values below. */
const MAY_REACH_BARREL = ['plugins/api/identity.ts']
/** Modules whose values a plugin uses at module scope; they must load before any barrel edge. */
const MUST_PRECEDE = ['plugins/api/ai.ts', 'plugins/api/http.ts']

const SPECIFIER = /^(?:import|export)\s+(?!type\b)(?:[^'"]*?\bfrom\s+)?['"]([^'"]+)['"]/gm

function resolveSpecifier(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec)
  else return null
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

const depsCache = new Map<string, string[]>()
function runtimeDeps(file: string): string[] {
  const cached = depsCache.get(file)
  if (cached) return cached
  const deps: string[] = []
  for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
    const resolved = resolveSpecifier(file, match[1] ?? '')
    if (resolved) deps.push(resolved)
  }
  depsCache.set(file, deps)
  return deps
}

/** The shortest runtime import chain from `start` to the barrel, or null. */
function chainToBarrel(start: string): string[] | null {
  const parent = new Map<string, string | null>([[start, null]])
  const queue = [start]
  while (queue.length) {
    const file = queue.shift() as string
    for (const dep of runtimeDeps(file)) {
      if (parent.has(dep)) continue
      parent.set(dep, file)
      if (dep === BARREL) {
        const chain: string[] = []
        for (let at: string | null = dep; at; at = parent.get(at) ?? null) {
          chain.unshift(path.relative(SRC, at))
        }
        return chain
      }
      queue.push(dep)
    }
  }
  return null
}

const rel = (file: string) => path.relative(SRC, file)
const apiModules = runtimeDeps(API_INDEX).filter(f => rel(f).startsWith('plugins/api/'))

describe('@/plugins/api load order', () => {
  it('reaches the server barrel only through the allowed modules', () => {
    const offenders = apiModules
      .filter(f => !MAY_REACH_BARREL.includes(rel(f)))
      .map(f => chainToBarrel(f))
      .filter((chain): chain is string[] => chain !== null)
      .map(chain => chain.join(' -> '))
    expect(
      offenders,
      'move the value to a leaf module or import it at call time (see this file)'
    ).toEqual([])
  })

  it('loads createRouter and defineTool before any module that reaches the barrel', () => {
    const order = apiModules.map(rel)
    const firstBarrel = order.findIndex(f => MAY_REACH_BARREL.includes(f))
    expect(firstBarrel).toBeGreaterThan(-1)
    for (const mod of MUST_PRECEDE) {
      expect(
        order.indexOf(mod),
        `${mod} must be re-exported before ${order[firstBarrel]}`
      ).toBeLessThan(firstBarrel)
    }
  })
})
