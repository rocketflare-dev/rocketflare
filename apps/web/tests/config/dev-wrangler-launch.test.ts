/**
 * `wrangler dev` takes the first entry of `routes` as the origin the Worker sees unless told not
 * to, so every local request in a provisioned copy would look like production's host. Host-based
 * dispatch then answers for the wrong host. Every place the kit launches it carries the flag.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8')
const FLAG = '--infer-origin-from-routes=false'

describe('wrangler dev launches', () => {
  it('every package script running wrangler dev keeps the real local origin', () => {
    const launches = ['package.json', 'apps/web/package.json'].flatMap(rel =>
      Object.values(JSON.parse(read(rel)).scripts as Record<string, string>).filter(script =>
        script.includes('wrangler dev')
      )
    )
    expect(launches.length).toBeGreaterThan(0)
    for (const script of launches) expect(script).toContain(FLAG)
  })

  it('the supervised dev stack does too', () => {
    const launch = /launch\('api', 'wrangler', \[([\s\S]*?)\]\)/.exec(
      read('apps/web/scripts/dev-server.mjs')
    )
    expect(launch?.[1]).toContain(`'${FLAG}'`)
  })
})
