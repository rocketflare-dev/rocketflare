/** `scripts/detach.sh` run against throwaway clones built with `git fast-import`. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = resolve(__dirname, '../../../../scripts/detach.sh')
const KIT_ORIGIN = 'https://github.com/rocketflare-dev/rocketflare.git'
const MANIFEST = `${JSON.stringify(
  { kit: { version: '0.0.0', commit: null }, surfaces: [{ source: { commit: null } }] },
  null,
  2
)}\n`
// Far more than a pipe buffer of subjects, so `git log` is still writing when a reader stops early.
const LONG_HISTORY = 3000

interface RunOptions {
  input?: string
  globalConfig?: string
}

function run(cwd: string, command: string, args: string[], options: RunOptions = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input: options.input,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: cwd,
      GIT_CONFIG_GLOBAL: options.globalConfig ?? '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    } as unknown as NodeJS.ProcessEnv,
  })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function git(cwd: string, ...args: string[]) {
  const result = run(cwd, 'git', args)
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.err}`)
  return result.out.trim()
}

function data(text: string) {
  return `data ${Buffer.byteLength(text)}\n${text}\n`
}

interface CloneOptions {
  commits: number
  firstSubject?: string
  origin?: string
  files?: Record<string, string>
}

function clone(options: CloneOptions) {
  const dir = mkdtempSync(join(tmpdir(), 'rf-detach-'))
  git(dir, 'init', '-q', '-b', 'main')
  const files = { '.rocketflare.json': MANIFEST, ...options.files }
  const tree = Object.entries(files)
    .map(([path, text]) => `M 100644 inline ${path}\n${data(text)}`)
    .join('')
  let stream = ''
  for (let n = 1; n <= options.commits; n++) {
    const subject =
      n === 1 && options.firstSubject ? options.firstSubject : `${n} ${'x'.repeat(120)}`
    stream += `commit refs/heads/main\ncommitter Kit <kit@example.test> ${1700000000 + n} +0000\n`
    stream += data(subject)
    stream += n === 1 ? tree : '\n'
  }
  const imported = run(dir, 'git', ['fast-import', '--quiet'], { input: stream })
  if (imported.code !== 0) throw new Error(`git fast-import failed: ${imported.err}`)
  git(dir, 'reset', '-q', '--hard', 'main')
  git(dir, 'remote', 'add', 'origin', options.origin ?? KIT_ORIGIN)
  return dir
}

function detach(dir: string, ...args: string[]) {
  return run(dir, 'bash', [SCRIPT, ...args])
}

function globalConfigIgnoring(pattern: string) {
  const dir = mkdtempSync(join(tmpdir(), 'rf-detach-home-'))
  const ignore = join(dir, 'gitignore')
  const config = join(dir, 'gitconfig')
  writeFileSync(ignore, `${pattern}\n`)
  writeFileSync(config, `[core]\n\texcludesFile = ${ignore}\n`)
  return config
}

describe('scripts/detach.sh', () => {
  it('replaces a long history with one commit and records the kit commit once', () => {
    const dir = clone({ commits: LONG_HISTORY })
    const kitCommit = git(dir, 'rev-parse', 'HEAD')

    const result = detach(dir)

    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    expect(result.out).toContain(`✔ detached from the kit's history (kit commit`)
    expect(git(dir, 'log', '--format=%s|%b')).toBe(
      `Start from Rocketflare|Kit commit: ${kitCommit}`
    )
    const manifest = JSON.parse(readFileSync(join(dir, '.rocketflare.json'), 'utf8'))
    expect(manifest.kit.commit).toBe(kitCommit)
    expect(manifest.surfaces[0].source.commit).toBeNull()
    expect(git(dir, 'status', '--porcelain')).toBe('')
  })

  it('keeps a tracked file the person’s global gitignore matches, and adds no ignored one', () => {
    const dir = clone({
      commits: 2,
      files: {
        '.claude/settings.json': '{}\n',
        '.gitignore': 'node_modules\n',
        'docs/[id] notes.md': 'a path git would read as a pattern\n',
      },
    })
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'node_modules/installed.js'), 'never tracked\n')
    const globalConfig = globalConfigIgnoring('.claude')

    const result = run(dir, 'bash', [SCRIPT], { globalConfig })

    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    expect(git(dir, 'ls-files').split('\n')).toEqual([
      '.claude/settings.json',
      '.gitignore',
      '.rocketflare.json',
      'docs/[id] notes.md',
    ])
    expect(git(dir, 'log', '--format=%s')).toBe('Start from Rocketflare')
  })

  it('does nothing to a copy that is already detached', () => {
    const dir = clone({ commits: 2, firstSubject: 'Start from Rocketflare' })
    const head = git(dir, 'rev-parse', 'HEAD')

    const result = detach(dir)

    expect(result.code).toBe(0)
    expect(result.out).toContain('already detached')
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('refuses an origin that is not the kit, and takes it with --force', () => {
    const dir = clone({ commits: 2, origin: 'https://github.com/someone/mirror.git' })
    const head = git(dir, 'rev-parse', 'HEAD')

    const refused = detach(dir)

    expect(refused.code).toBe(3)
    expect(refused.err).toContain("origin is 'https://github.com/someone/mirror.git'")
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
    expect(detach(dir, '--force').code).toBe(0)
    expect(git(dir, 'log', '--format=%s')).toBe('Start from Rocketflare')
  })

  it('refuses a tree with changes', () => {
    const dir = clone({ commits: 2 })
    const head = git(dir, 'rev-parse', 'HEAD')
    writeFileSync(join(dir, 'notes.txt'), 'edited before detaching\n')

    const result = detach(dir)

    expect(result.code).toBe(3)
    expect(result.err).toContain('the tree has changes')
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('exits 2 outside a kit clone', () => {
    const result = detach(mkdtempSync(join(tmpdir(), 'rf-detach-empty-')))

    expect(result.code).toBe(2)
    expect(result.err).toContain('run this from the root of a kit clone')
  })
})
