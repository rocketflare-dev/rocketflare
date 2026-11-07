/** The example `ssoPolicy` as a pure function: one domain, development only. */
import { describe, expect, it } from 'vitest'
import type { PluginConfig } from '@/plugins/api'
import { EXAMPLE_SSO_METHOD_ID, exampleSsoPolicy } from '../../api/sso-policy'

const config = (APP_ENV: 'development' | 'staging' | 'production') =>
  ({ APP_ENV }) as unknown as PluginConfig

describe('exampleSsoPolicy', () => {
  it('claims @sso-required.example.test in development, routed to the example SSO', async () => {
    expect(await exampleSsoPolicy('Jane@SSO-Required.example.test', config('development'))).toEqual(
      { required: true, methodId: EXAMPLE_SSO_METHOD_ID, label: 'Example SSO' }
    )
  })

  it('claims no other domain, and nothing at all outside development', async () => {
    expect(await exampleSsoPolicy('jane@example.test', config('development'))).toBeNull()
    expect(
      await exampleSsoPolicy('jane@evil-sso-required.example.test', config('development'))
    ).toBeNull()
    for (const env of ['staging', 'production'] as const) {
      expect(await exampleSsoPolicy('jane@sso-required.example.test', config(env))).toBeNull()
    }
  })
})
