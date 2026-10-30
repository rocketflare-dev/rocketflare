/**
 * An example surface (`kind: "example"` in `.rocketflare.json`) is removable: an app deletes its
 * `paths` and its registry lines, and the gate stays green with no other test edit. That holds
 * only while no test OUTSIDE the surface leans on the example — names its agent key, or imports
 * one of its files. Core tests use the fixture agents instead (`tests/helpers/fixture-agents.ts`).
 *
 * Two checks per example surface, over every test file in the checkout (tracked or new):
 *
 * - **key**: a surface anchored on an example agent (`…/agents/examples/<key>.ts`) owns `<key>`; a
 *   test naming it as a token must be in the surface's `paths`. A surface that `requires` another
 *   (`triage-research` runs `research-topic`'s body) goes with it, so its paths count too.
 * - **import**: a test importing one of the surface's own files must be in its `paths` — this is
 *   the check for the surfaces with no key (`example-cli-commands`, `demo-seed`).
 *
 * Kit-only because it judges THIS checkout's manifest; `tests/kit-only/**` itself is not scanned.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import rawManifest from '../../../../.rocketflare.json'

interface Surface {
  id: string
  kind: string
  anchor: string
  paths: string[]
  requires?: { surfaces?: string[] }
}

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const surfaces = (rawManifest as unknown as { surfaces: Surface[] }).surfaces
const examples = surfaces.filter(s => s.kind === 'example')

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(f => existsSync(path.join(REPO_ROOT, f)))

/** Where a test lives: every package's `tests/`, a plugin's `tests/`, and the whole eval app. */
const IN_SCOPE = [
  /^apps\/[^/]+\/tests\//,
  /^apps\/web\/src\/plugins\/[^/]+\/tests\//,
  /^apps\/evals\//,
]
const scanned = files.filter(
  f =>
    IN_SCOPE.some(re => re.test(f)) &&
    !f.startsWith('apps/web/tests/kit-only/') &&
    /\.(ts|tsx|mts|mjs|js|json|jsonl|md)$/.test(f)
)

const EXAMPLE_AGENT_ANCHOR = /^apps\/web\/src\/api\/services\/agents\/examples\/([a-z0-9-]+)\.ts$/

/** The agent key a surface owns, or null for an example that is not an agent. */
function exampleKey(surface: Pick<Surface, 'anchor'>): string | null {
  return EXAMPLE_AGENT_ANCHOR.exec(surface.anchor)?.[1] ?? null
}

/** `key` as a whole token — `'summarize-text'`, `examples/summarize-text.ts` — not inside a longer id. */
function namesKey(text: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(text)
}

const EXT = /\.(ts|tsx|mts|mjs|js)$/

/** Repo paths (extension dropped) a file's static and dynamic imports resolve to. */
function importedPaths(file: string, text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|^import\s+)['"]([^'"]+)['"]/gm)) {
    const spec = m[1] ?? ''
    let target: string | null = null
    if (spec.startsWith('@/')) target = path.posix.join('apps/web/src', spec.slice(2))
    else if (spec.startsWith('.')) target = path.posix.join(path.posix.dirname(file), spec)
    if (target) out.push(target.replace(EXT, '').replace(/\/index$/, ''))
  }
  return out
}

/** A surface's own source files, as import targets (globs and non-code paths left out). */
function importTargets(surface: Surface): Set<string> {
  return new Set(
    surface.paths
      .filter(p => !p.includes('*') && EXT.test(p))
      .map(p => p.replace(EXT, '').replace(/\/index$/, ''))
  )
}

/**
 * Known couplings, named so they stay visible. `demo-seed`'s one path is the deterministic embedder,
 * which the test `RecordingAi` stub (`tests/mocks/bindings.ts`) also embeds with — deleting that
 * surface's paths breaks the harness. Shrink this list; never grow it to make a red check green.
 */
const KNOWN_COUPLINGS: Record<string, readonly string[]> = {
  'demo-seed': ['apps/web/tests/mocks/bindings.ts'],
}

/** Paths that leave with `surface`: its own, and those of every surface requiring it. */
function leavesWith(surface: Surface): Set<string> {
  const dependents = surfaces.filter(s => s.requires?.surfaces?.includes(surface.id))
  return new Set([
    ...[surface, ...dependents].flatMap(s => s.paths),
    ...(KNOWN_COUPLINGS[surface.id] ?? []),
  ])
}

describe('the helpers', () => {
  it('derive a key from an example agent anchor only', () => {
    expect(exampleKey({ anchor: 'apps/web/src/api/services/agents/examples/my-agent.ts' })).toBe(
      'my-agent'
    )
    expect(exampleKey({ anchor: 'apps/cli/src/commands/members.ts' })).toBeNull()
  })

  it('match a key as a token, never inside a longer id', () => {
    expect(namesKey("agentKey: 'my-agent'", 'my-agent')).toBe(true)
    expect(namesKey('invoke_agent my-agent', 'my-agent')).toBe(true)
    expect(namesKey("import x from './examples/my-agent'", 'my-agent')).toBe(true)
    expect(namesKey("'example-agent-my-agent'", 'my-agent')).toBe(false)
    expect(namesKey("'my-agent-b'", 'my-agent')).toBe(false)
  })

  it('resolve relative and @/ imports to repo paths', () => {
    const text = [
      "import { a } from '../src/commands/members'",
      "import b from '@/ui/pages/agents/forms/index'",
      "const c = await import('./sibling.ts')",
      "import 'zod'",
    ].join('\n')
    expect(importedPaths('apps/cli/tests/x.test.ts', text)).toEqual([
      'apps/cli/src/commands/members',
      'apps/web/src/ui/pages/agents/forms',
      'apps/cli/tests/sibling',
    ])
  })
})

describe.each(examples.map(s => [s.id, s] as const))('example surface %s', (_id, surface) => {
  const key = exampleKey(surface)
  const owned = leavesWith(surface)

  it.skipIf(key === null)("lists every test that names the example's key", () => {
    const offenders = scanned.filter(
      f => !owned.has(f) && namesKey(readFileSync(path.join(REPO_ROOT, f), 'utf8'), key as string)
    )
    expect(
      offenders,
      `these name '${key}' but are not in ${surface.id}'s paths — use the fixture agents ` +
        '(tests/helpers/fixture-agents.ts), or add the file to the surface'
    ).toEqual([])
  })

  it("lists every test that imports one of the example's files", () => {
    const targets = importTargets(surface)
    const offenders = scanned.filter(
      f =>
        !owned.has(f) &&
        EXT.test(f) &&
        importedPaths(f, readFileSync(path.join(REPO_ROOT, f), 'utf8')).some(p => targets.has(p))
    )
    expect(offenders, `these import ${surface.id}'s files but are not in its paths`).toEqual([])
  })
})
