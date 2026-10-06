// Finds the cloudflared binary `pnpm dev:tunnel` will use, and installs it the first time there
// is none. Entry point: `apps/web/scripts/cfld.mjs`.
//
// The `cloudflared` npm package (an optional dependency of @cliftonc/cfld) used to download the
// LATEST release, ~38 MB, in its postinstall on every `pnpm install`. It is no longer in
// `onlyBuiltDependencies`, so that postinstall never runs; the download happens here instead, on
// the first tunnel run that needs it, through the package's own CLI (`bin install <version>`).
//
// The order mirrors cfld's own resolution, so this never installs a binary cfld would not use:
//   1. CFLD_CLOUDFLARED / CLOUDFLARED_BIN set  → cfld uses that path as-is
//   2. `cloudflared --version` works on PATH    → cfld uses it
//   3. the package's managed binary exists      → cfld uses `<cloudflared pkg>/bin/cloudflared`
//   4. none of these                            → install the managed binary, then 3 applies
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/**
 * The cloudflared release the first tunnel run installs. Pinned so two machines get the same
 * binary; `CLOUDFLARED_VERSION=<tag>` (the package's own variable, `latest` allowed) overrides it.
 * Cloudflare supports a release for a year — bump it with the kit.
 */
export const CLOUDFLARED_PINNED_VERSION = '2026.9.3'

/** The path cfld is told to use instead of resolving one, when set and non-empty. */
export function cloudflaredOverride(env) {
  return env.CFLD_CLOUDFLARED || env.CLOUDFLARED_BIN || null
}

/** Where the cloudflared package keeps its managed binary (its `DEFAULT_CLOUDFLARED_BIN`). */
export function managedBinaryPath(packageDir, platform = process.platform) {
  return path.join(packageDir, 'bin', platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
}

/** The version to install: `CLOUDFLARED_VERSION` when set, else the pin. */
export function cloudflaredVersion(env) {
  return env.CLOUDFLARED_VERSION || CLOUDFLARED_PINNED_VERSION
}

/**
 * Decides what to do, with no side effects. `onPath()` and `managedExists()` are only called when
 * the earlier rules did not already decide — the PATH probe spawns a process.
 *
 * @returns {{ action: 'none', source: 'override' | 'path' | 'managed' } | { action: 'install' }}
 */
export function planCloudflared({ env, onPath, managedExists }) {
  if (cloudflaredOverride(env)) return { action: 'none', source: 'override' }
  if (onPath()) return { action: 'none', source: 'path' }
  if (managedExists()) return { action: 'none', source: 'managed' }
  return { action: 'install' }
}

/** True when `cloudflared --version` runs from PATH. */
export function cloudflaredOnPath() {
  const res = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' })
  return !res.error && res.status === 0
}

/**
 * The cloudflared package directory, resolved FROM cfld — it is cfld's optional dependency, not
 * apps/web's, so pnpm only links it there. Null when it is not installed (optional deps can be
 * skipped, e.g. on an unsupported platform).
 */
export function resolveCloudflaredPackageDir(fromDir) {
  try {
    const appRequire = createRequire(path.join(fromDir, 'package.json'))
    const cfldPkg = appRequire.resolve('@cliftonc/cfld/package.json')
    const cfldRequire = createRequire(cfldPkg)
    return path.dirname(cfldRequire.resolve('cloudflared/package.json'))
  } catch {
    return null
  }
}

/** Runs the package's own installer: `node <pkg>/lib/cloudflared.js bin install <version>`. */
export function runCloudflaredInstall(packageDir, version, env) {
  const cli = path.join(packageDir, 'lib', 'cloudflared.js')
  const res = spawnSync(process.execPath, [cli, 'bin', 'install', version], {
    stdio: 'inherit',
    env,
  })
  return !res.error && res.status === 0
}

/**
 * Makes sure cfld will find a cloudflared binary, installing the managed one if nothing else is
 * there. Every side effect is injectable so the decision is testable without network.
 *
 * @returns {Promise<{ installed: boolean, source: string, bin?: string }>}
 * @throws {Error} when the package is missing or the install fails
 */
export async function ensureCloudflared({
  env = process.env,
  fromDir = process.cwd(),
  onPath = cloudflaredOnPath,
  resolvePackageDir = resolveCloudflaredPackageDir,
  exists = existsSync,
  install = runCloudflaredInstall,
  log = msg => console.log(msg),
} = {}) {
  let packageDir
  const plan = planCloudflared({
    env,
    onPath,
    managedExists: () => {
      packageDir = resolvePackageDir(fromDir)
      return packageDir !== null && exists(managedBinaryPath(packageDir))
    },
  })
  if (plan.action === 'none') return { installed: false, source: plan.source }

  if (packageDir === null) {
    throw new Error(
      'cloudflared is not on PATH and the cloudflared package is not installed. Install it ' +
        '(`brew install cloudflared`, or see https://developers.cloudflare.com/cloudflare-one/' +
        'connections/connect-networks/downloads/) or set CFLD_CLOUDFLARED to its path.'
    )
  }
  const version = cloudflaredVersion(env)
  const bin = managedBinaryPath(packageDir)
  log(`[cfld] cloudflared not found — installing ${version} to ${bin} (once)`)
  const ok = await install(packageDir, version, env)
  if (!ok || !exists(bin)) {
    throw new Error(
      `installing cloudflared ${version} failed. Retry, install it yourself ` +
        '(`brew install cloudflared`), or set CFLD_CLOUDFLARED to its path.'
    )
  }
  return { installed: true, source: 'managed', bin }
}
