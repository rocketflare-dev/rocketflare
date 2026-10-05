/**
 * The kit's own `.rocketflare.json` is what Biome formats, and `formatJson` reproduces it byte for
 * byte — so `pnpm kit:upgrade` and the rename, which rewrite it with `formatJson`, leave a file the
 * copy's `pnpm lint` passes. Kit-only: a copy's manifest is its own, and may carry hand edits.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatJson } from '../../../../scripts/lib/json-format.mjs'

describe("the kit's manifest", () => {
  it('round-trips through formatJson unchanged', () => {
    const text = readFileSync(path.resolve(__dirname, '../../../../.rocketflare.json'), 'utf8')
    expect(formatJson(JSON.parse(text))).toBe(text)
  })
})
