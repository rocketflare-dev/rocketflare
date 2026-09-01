/**
 * Environment helpers. The SPA bundle is byte-identical across deployments, so the
 * environment comes from the server (`/api/health` → `env`, mirroring `APP_ENV`, D4) — never
 * from the hostname or a `VITE_*` build flag.
 */
export const APP_ENVS = ['development', 'staging', 'production'] as const
export type AppEnv = (typeof APP_ENVS)[number]

export function isAppEnv(value: unknown): value is AppEnv {
  return typeof value === 'string' && (APP_ENVS as readonly string[]).includes(value)
}

/** The non-production marker shown in the header and tab title. */
export interface EnvironmentMarker {
  env: Exclude<AppEnv, 'production'>
  /** Badge label, e.g. "Staging" */
  label: string
  /** Tab-title prefix, e.g. "[staging] " */
  titlePrefix: string
  /** DaisyUI semantic badge class — tokens, never raw colours (safelisted in index.css) */
  badgeClassName: string
}

const MARKERS: Record<EnvironmentMarker['env'], EnvironmentMarker> = {
  development: {
    env: 'development',
    label: 'Dev',
    titlePrefix: '[dev] ',
    badgeClassName: 'badge-info',
  },
  staging: {
    env: 'staging',
    label: 'Staging',
    titlePrefix: '[staging] ',
    badgeClassName: 'badge-warning',
  },
}

/** Marker for `env`, or `null` in production (no marker shown). */
export function getEnvironmentMarker(env: AppEnv | undefined): EnvironmentMarker | null {
  if (!env || env === 'production') return null
  return MARKERS[env]
}
