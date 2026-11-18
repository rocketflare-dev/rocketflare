/**
 * The lexical leg queries with `to_tsquery(SEARCH_TEXT_CONFIG, …)` against `chunks.search_vector`,
 * a GENERATED column whose `to_tsvector('<config>', …)` the schema spells as a literal (a schema
 * cannot import a service). If the two disagree, stemming differs between the index and the
 * query and keyword search quietly stops matching inflected words. This pins the schema and the
 * newest migration that (re)defines the column to the constant.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SEARCH_TEXT_CONFIG } from '@/api/services/ai/retrieval'

const WEB = path.resolve(import.meta.dirname, '../..')
const configsIn = (source: string) =>
  [...source.matchAll(/to_tsvector\('([a-z_]+)'/g)].map(m => m[1])

describe('SEARCH_TEXT_CONFIG', () => {
  it('the schema generates search_vector with the same text-search configuration', () => {
    const schema = fs.readFileSync(path.join(WEB, 'src/db/schema/chunks.ts'), 'utf8')
    const configs = configsIn(schema)
    expect(configs.length).toBeGreaterThan(0)
    for (const config of configs) expect(config).toBe(SEARCH_TEXT_CONFIG)
  })

  it('the newest migration defining search_vector uses it too', () => {
    const dir = path.join(WEB, 'migrations')
    const defining = fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.sql'))
      .sort()
      .filter(f =>
        /"search_vector"[^;]*GENERATED ALWAYS AS/.test(fs.readFileSync(path.join(dir, f), 'utf8'))
      )
    const newest = defining[defining.length - 1]
    expect(newest, 'no migration defines chunks.search_vector').toBeDefined()
    const configs = configsIn(fs.readFileSync(path.join(dir, newest as string), 'utf8'))
    expect(configs.length).toBeGreaterThan(0)
    for (const config of configs) expect(config).toBe(SEARCH_TEXT_CONFIG)
  })
})
