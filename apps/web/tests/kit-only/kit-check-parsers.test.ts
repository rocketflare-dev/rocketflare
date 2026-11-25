/**
 * The two dependency-free readers `scripts/kit-check.mjs` parses the tomls and the workflows with
 * (`scripts/lib/toml-lite.mjs`, `scripts/lib/yaml-lite.mjs`), shared with the meta-kit — its
 * `scripts/tests/parsers.test.mjs`, ported to vitest. Inline documents only: that this checkout's
 * own tomls and workflows parse is kit-only (`tests/kit-only/kit-files-parse.test.ts`). The
 * `config` project: no database.
 */
import { describe, expect, it } from 'vitest'
import { parseToml, TomlError } from '../../../../scripts/lib/toml-lite.mjs'
import { parseYaml } from '../../../../scripts/lib/yaml-lite.mjs'

describe('toml-lite', () => {
  it('reads tables, arrays of tables, strings, arrays and inline tables', () => {
    const doc = parseToml(`
name = "app" # comment
flags = ["a", 'b',
  "c", # trailing
]
n = 1_000
on = true
[vars]
URL = "https://x.test/#frag"
[[kv_namespaces]]
binding = "KV"
id = "<KV_ID>"
[[kv_namespaces]]
binding = "KV2"
id = "<KV2_ID>"
[assets]
run_worker_first = ["/api/*"]
inline = { a = 1, b = "two" }
[queues]
[[queues.producers]]
queue = "app-jobs"
`)
    expect(doc.name).toBe('app')
    expect(doc.flags).toEqual(['a', 'b', 'c'])
    expect(doc.n).toBe(1000)
    expect(doc.vars.URL).toBe('https://x.test/#frag')
    expect(doc.kv_namespaces.map((k: { id: string }) => k.id)).toEqual(['<KV_ID>', '<KV2_ID>'])
    expect(doc.assets.inline).toEqual({ a: 1, b: 'two' })
    expect(doc.queues.producers[0].queue).toBe('app-jobs')
  })

  it('refuses a duplicate key and a broken line', () => {
    expect(() => parseToml('a = 1\na = 2')).toThrow(TomlError)
    expect(() => parseToml('a = "open')).toThrow(TomlError)
  })
})

describe('yaml-lite', () => {
  it('reads mappings, sequences of mappings, block scalars and flow sequences', () => {
    const doc = parseYaml(`
name: CI # comment
on:
  push:
    tags:
      - "[0-9]+"
  workflow_dispatch:
    inputs:
      environment:
        options: [staging, production]
jobs:
  gate:
    name: Gate
    if: |
      a &&
      b
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: echo "a: b" # not a key
`)
    expect(doc.name).toBe('CI')
    expect(doc.on.push.tags).toEqual(['[0-9]+'])
    expect(doc.on.workflow_dispatch.inputs.environment.options).toEqual(['staging', 'production'])
    expect(doc.jobs.gate.if).toBe('a &&\nb\n')
    expect(doc.jobs.gate.steps[0].with['fetch-depth']).toBe('0')
    expect(doc.jobs.gate.steps[1].run).toBe('echo "a: b"')
  })
})
