/**
 * Chunk discipline (`.claude/rules/ui.md`): the eager shell must not carry the chat, analytics or
 * markdown dependencies, and **protobuf must not reach the browser at all** — `@ag-ui/encoder` and
 * `@ag-ui/proto` are `apps/web` server dependencies; only `@ag-ui/core`'s zod schemas ship, and
 * only in the lazy chat chunk.
 *
 * The bundle half reads the built output, so it runs after the build instead:
 * `scripts/check-ui-bundle.mjs`, which `build:ui` calls straight after `vite build`. This file keeps
 * the source-level half, which needs no build.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The source-level half, which runs whether or not there is a build: `components/shared` is the
 * barrel `App.tsx` imports EAGERLY, so one markdown import anywhere under it puts `react-markdown`
 * in the main chunk. `DocumentCard` is the reason this is worth pinning — it is rendered
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
