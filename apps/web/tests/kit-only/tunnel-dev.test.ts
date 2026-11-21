/**
 * `pnpm dev:tunnel` must hand the Worker the tunnel's public URL as `APP_URL`, or every OAuth
 * redirect and discovery document it serves names localhost. pnpm 10 forwards a `--` literally and
 * wrangler drops whatever follows one, so the flag must come straight after the script name.
 */
import { describe, expect, it } from 'vitest'
import { tunnelChildren } from '../../scripts/lib/tunnel-dev.mjs'

describe('pnpm dev:tunnel', () => {
  it('passes APP_URL to wrangler as a flag it reads, not after a --', () => {
    const [api, ui] = tunnelChildren('https://dev.example.test')
    expect(api).toEqual(['pnpm', ['dev:api', '--var', 'APP_URL:https://dev.example.test']])
    expect(api?.[1]).not.toContain('--')
    expect(ui).toEqual(['pnpm', ['dev:ui']])
  })
})
