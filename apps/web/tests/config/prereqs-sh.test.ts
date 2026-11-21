/**
 * `scripts/lib/prereqs.sh` — what `bootstrap.sh` knows about Windows through WSL2 before any Node
 * exists: detecting WSL, refusing a Windows binary that WSL's shared PATH exposed (the `corepack`
 * that dies with "/bin/sh^M: bad interpreter"), and the fix lines for a root-only distro, Docker
 * Desktop's integration switched off, and no Node version manager. Each case sources the file in a
 * child bash with a fake environment (a temp `/proc/version`, a temp Windows drive, a PATH of stubs).
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const LIB = resolve(__dirname, '../../../../scripts/lib/prereqs.sh')

function sh(script: string, env: Record<string, string> = {}) {
  const result = spawnSync('bash', ['-c', `set -u; . "${LIB}"; ${script}`], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: tmpdir(), ...env } as unknown as NodeJS.ProcessEnv,
  })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'rf-prereqs-'))
}

describe('is_wsl', () => {
  it('is true with WSL_DISTRO_NAME, or "microsoft" in the kernel version', () => {
    const dir = tempDir()
    const wslKernel = join(dir, 'version-wsl')
    const plainKernel = join(dir, 'version-plain')
    writeFileSync(wslKernel, 'Linux version 6.6.36.3-microsoft-standard-WSL2\n')
    writeFileSync(plainKernel, 'Linux version 6.8.0-45-generic\n')
    expect(sh('is_wsl', { WSL_DISTRO_NAME: 'Ubuntu' }).code).toBe(0)
    expect(sh('is_wsl', { ROCKETFLARE_PROC_VERSION: wslKernel }).code).toBe(0)
    expect(sh('is_wsl', { ROCKETFLARE_PROC_VERSION: plainKernel }).code).toBe(1)
  })
})

describe('linux_command', () => {
  it('ignores a command that resolves onto a Windows drive and keeps a Linux one', () => {
    const dir = tempDir()
    const linuxBin = join(dir, 'linux-bin')
    mkdirSync(linuxBin)
    writeFileSync(join(linuxBin, 'pnpm'), '#!/bin/sh\necho 10.0.0\n')
    chmodSync(join(linuxBin, 'pnpm'), 0o755)
    expect(sh('is_windows_path "/mnt/c/Program Files/nodejs/corepack"').code).toBe(0)
    expect(sh('is_windows_path "/home/neil/.nvm/versions/node/v26/bin/corepack"').code).toBe(1)
    const found = sh('linux_command pnpm', { PATH: `${linuxBin}:/usr/bin:/bin` })
    expect(found.code).toBe(0)
    expect(found.out.trim()).toBe(join(linuxBin, 'pnpm'))
    expect(sh('linux_command no-such-tool-here').code).toBe(1)
  })
})

describe('the fix lines', () => {
  it('a root-only distro gets adduser and the wsl -u command for its own name', () => {
    const { out } = sh('wsl_root_hint', { WSL_DISTRO_NAME: 'Ubuntu-24.04' })
    expect(out).toContain('adduser <name>')
    expect(out).toContain('wsl -d Ubuntu-24.04 -u <name>')
  })

  it('docker missing beside an installed Docker Desktop says: turn on integration, then restart it', () => {
    const windows = tempDir()
    mkdirSync(join(windows, 'Program Files/Docker/Docker'), { recursive: true })
    writeFileSync(join(windows, 'Program Files/Docker/Docker/Docker Desktop.exe'), '')
    const { out } = sh('wsl_docker_hint', {
      WSL_DISTRO_NAME: 'Ubuntu',
      ROCKETFLARE_WINDOWS_ROOT: windows,
    })
    expect(out).toContain('WSL integration → turn on Ubuntu')
    expect(out).toMatch(/QUIT Docker Desktop/)
  })

  it('docker missing with no Docker Desktop says to install it', () => {
    const { out } = sh('wsl_docker_hint', {
      WSL_DISTRO_NAME: 'Ubuntu',
      ROCKETFLARE_WINDOWS_ROOT: tempDir(),
    })
    expect(out).toContain('Install Docker Desktop for Windows')
  })

  it('no version manager prints the documented nvm install and the major to install', () => {
    const { out } = sh('node_install_hint 26')
    if (process.platform === 'darwin') expect(out).toContain('fnm install 26')
    else expect(out).toMatch(/nvm-sh\/nvm\/v[\d.]+\/install\.sh \| bash[\s\S]*nvm install 26/)
  })
})
