/**
 * Chunk discipline (`.claude/rules/ui.md`): the eager shell must not carry the chat, analytics or
 * markdown dependencies, and **protobuf must not reach the browser at all** — `@ag-ui/encoder` and
 * `@ag-ui/proto` are `apps/web` server dependencies; only `@ag-ui/core`'s zod schemas ship, and
 * only in the lazy chat chunk.
 *
 * It reads the built output, so it is skipped when there is none (CI builds after it runs; a local
 * `pnpm web build:ui` makes it assert). The import-graph rule itself is not enforceable from a
 * bundle — this catches the consequence, which is the thing that actually costs users bytes.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ASSETS = path.resolve(__dirname, '../../dist/ui/assets')
const built = existsSync(ASSETS)

/** What must never appear in the eager entry chunk, and the rule each stands for. */
const EAGER_FORBIDDEN = ['recharts', 'drizzle-cube', 'react-markdown']

/** What must never appear in ANY chunk: the protobuf transport is the server's business. */
const FORBIDDEN_ANYWHERE = ['@bufbuild/protobuf', '@ag-ui/proto', '@ag-ui/encoder']

const chunks = () => (built ? readdirSync(ASSETS).filter(f => f.endsWith('.js')) : [])
const read = (file: string) => readFileSync(path.join(ASSETS, file), 'utf8')

/**
 * The source-level half, which runs whether or not there is a build: `components/shared` is the
 * barrel `App.tsx` imports EAGERLY, so one markdown import anywhere under it puts `react-markdown`
 * in the main chunk. `DocumentCard` (D18) is the reason this is worth pinning — it is rendered
 * from Search, from a citation and from inside `Markdown` itself, and the temptation to let it
 * render its own excerpt as markdown is exactly the mistake.
 */
describe('components/shared', () => {
  it('imports no markdown renderer, directly or through components/ai', () => {
    const dir = path.resolve(__dirname, '../../src/ui/components/shared')
    const offenders = readdirSync(dir)
      .filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
      .filter(file => {
        const imports = (
          readFileSync(path.join(dir, file), 'utf8').match(/^import .*$/gm) ?? []
        ).join('\n')
        return /react-markdown|remark-|components\/ai/.test(imports)
      })
    expect(offenders).toEqual([])
  })
})

describe.skipIf(!built)('the UI bundle', () => {
  it('keeps the heavy dependencies out of the eager entry chunk', () => {
    const entry = chunks().filter(f => /^index-[^.]+\.js$/.test(f))
    expect(entry).toHaveLength(1)
    const source = read(entry[0] as string)
    for (const needle of EAGER_FORBIDDEN) expect(source).not.toContain(needle)
  })

  it('ships no protobuf in any chunk', () => {
    const offenders = chunks().filter(file => {
      const source = read(file)
      return FORBIDDEN_ANYWHERE.some(needle => source.includes(needle))
    })
    expect(offenders).toEqual([])
  })
})
