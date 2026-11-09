import { describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '@/config'
import { deploymentFeatures } from '@/permissions/features'

vi.mock('@/plugins/server', () => ({
  serverPlugins: [
    { deploymentFeatures: (cfg: AppConfig) => (cfg.APP_NAME === 'on' ? ['plugin-flag'] : []) },
    {},
  ],
}))

const config = (APP_NAME: string, FEATURES_ENABLED: string[] = []) =>
  ({ APP_NAME, FEATURES_ENABLED }) as unknown as AppConfig

describe('deploymentFeatures', () => {
  it('adds what a plugin switches on from its own config', async () => {
    expect(await deploymentFeatures(config('on', ['core-flag']))).toEqual([
      'core-flag',
      'plugin-flag',
    ])
  })

  it('leaves FEATURES_ENABLED alone when the plugin switches nothing on', async () => {
    expect(await deploymentFeatures(config('off', ['core-flag']))).toEqual(['core-flag'])
  })
})
