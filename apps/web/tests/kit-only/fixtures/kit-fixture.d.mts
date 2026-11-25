import type { KitManifest } from '../../../../../scripts/lib/kit-manifest.mjs'

export const FIXTURE_TOKENS: { slug: string; display: string; domain: string }
export const FIXTURE_APP_MANIFEST: string
export const FIXTURE_TOMLS: [string, string]
export const FIXTURE_DEPLOY_YML: string
export function fixtureManifest(): KitManifest
export function writeKitFixture(
  dir: string,
  options?: { app?: { slug: string; display: string; domain: string } | null }
): string
export function provisionLikeLaunch(
  dir: string,
  options?: { domain?: string; issuer?: string; clientId?: string }
): string[]
