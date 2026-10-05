/**
 * `scripts/lib/json-format.mjs` — JSON in Biome's layout, so a file a script rewrites
 * (`.rocketflare.json` after `pnpm kit:upgrade` or the rename) passes the copy's own lint.
 * The `config` project: no database. The round trip over the kit's REAL manifest is kit-only
 * (`tests/kit-only/json-format-manifest.test.ts`): a copy's manifest is its own.
 */
import { describe, expect, it } from 'vitest'
import { formatJson, JSON_LINE_WIDTH } from '../../../../scripts/lib/json-format.mjs'

describe('formatJson', () => {
  it('puts an array of primitives on one line when it fits, and expands objects', () => {
    expect(formatJson({ registries: ['a.ts', 'b.ts'], n: 1, ok: true, none: null })).toBe(
      '{\n  "registries": ["a.ts", "b.ts"],\n  "n": 1,\n  "ok": true,\n  "none": null\n}\n'
    )
  })

  it('expands an array whose line would pass the width, counting indent, key and comma', () => {
    const long = Array.from({ length: 8 }, (_, i) => `apps/web/src/some/long/path-${i}.ts`)
    const out = formatJson({ outer: { paths: long, after: 1 } })
    expect(out).toContain('    "paths": [\n      "apps/web/src/some/long/path-0.ts",\n')
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(JSON_LINE_WIDTH)
  })

  it('fits exactly at the width and breaks one character past it', () => {
    // `  "k": [` + items + `]` — 2 + 5 + 2 = 9 characters around the items.
    const fits = 'x'.repeat(JSON_LINE_WIDTH - 9 - 2)
    expect(formatJson({ k: [fits] })).toBe(`{\n  "k": ["${fits}"]\n}\n`)
    expect(formatJson({ k: [`${fits}x`] })).toBe(`{\n  "k": [\n    "${fits}x"\n  ]\n}\n`)
  })

  it('expands an array of objects, keeps empties empty, and drops undefined members', () => {
    expect(formatJson({ list: [{ a: 1 }], e: [], o: {}, gone: undefined })).toBe(
      '{\n  "list": [\n    {\n      "a": 1\n    }\n  ],\n  "e": [],\n  "o": {}\n}\n'
    )
  })

  it('parses back to the same value', () => {
    const value = { kit: { version: '0.16.3' }, history: [{ from: 'a', to: 'b' }], tags: ['x'] }
    expect(JSON.parse(formatJson(value))).toEqual(value)
  })
})
