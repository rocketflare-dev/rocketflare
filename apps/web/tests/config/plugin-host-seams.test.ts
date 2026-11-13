/**
 * Two plugin seams that write OUTSIDE a plugin's own roots, each under its own ownership rule:
 *
 *   - `claudeHooks`: Claude Code hooks merged into the host's `.claude/settings.json`. The PLUGIN's,
 *     identified by the skill directory their command runs — `add` merges them, `upgrade`
 *     replaces them, `remove` takes out exactly them and leaves the file byte-identical.
 *   - `hostFiles`: content seeded once into `docs/<id>/`, `apps/web/public/<id>/` or
 *     `apps/web/src/host/<id>/`. The DEVELOPER's from then on — `add` copies only what is absent,
 *     `upgrade` never touches it, `remove` leaves it and says so.
 *
 * The rules are pure functions driven with fixtures; the lifecycle runs the real
 * `scripts/plugin.mjs` against a throwaway host, as `plugin-skills.test.ts` does. The `config`
 * project: no database.
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addPlanJson,
  BARRELS,
  buildPluginSurface,
  classifyPluginFile,
  claudeHookOwner,
  claudeHookProblems,
  hostFileProblems,
  hostFileRoots,
  ownedClaudeHooks,
  PLUGIN_MANIFEST_FILE,
  parseClaudeHookCommand,
  pluginManifestProblems,
  renderAddPlan,
  setClaudeHooks,
} from '../../../../scripts/lib/plugin-lib.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
/**
 * A FIXTURE in the kit's settings shape, never the checkout's own file: a checkout may carry a
 * plugin's hooks already (that is what this suite installs), and a copy's file is its own.
 */
const KIT_SETTINGS = `${JSON.stringify(
  {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: 'node "$CLAUDE_PROJECT_DIR/scripts/nudge.mjs"',
              timeout: 10,
            },
          ],
        },
      ],
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node "$CLAUDE_PROJECT_DIR/scripts/check.mjs"',
              timeout: 10,
            },
          ],
        },
      ],
    },
  },
  null,
  2
)}\n`

const cmd = (dir: string, script = 'stale.mjs', flags = '') =>
  `node "$CLAUDE_PROJECT_DIR/.claude/skills/${dir}/${script}"${flags}`

const skillMd = (name: string) => `---\nname: ${name}\ndescription: Use ${name}.\n---\n\n# Body\n`

// ---------------------------------------------------------------- the hook command

describe('a plugin hook command', () => {
  it('runs one node script in a skill directory, with plain flags at most', () => {
    expect(parseClaudeHookCommand(cmd('gdemo'))).toEqual({ dir: 'gdemo', script: 'stale.mjs' })
    expect(parseClaudeHookCommand(cmd('gdemo-docs', 'bin/check.js', ' --hook --quiet'))).toEqual({
      dir: 'gdemo-docs',
      script: 'bin/check.js',
    })
    expect(parseClaudeHookCommand(cmd('gdemo', 'x.mjs', ' --mode=changed'))).not.toBeNull()
  })

  it('is refused for anything else a shell would run', () => {
    for (const bad of [
      'pnpm -s docs:stale --hook',
      `cd "$CLAUDE_PROJECT_DIR" && ${cmd('gdemo')}`,
      `${cmd('gdemo')} && rm -rf /`,
      `${cmd('gdemo')}; curl x`,
      `${cmd('gdemo')} | sh`,
      `${cmd('gdemo')} $(whoami)`,
      'node "$CLAUDE_PROJECT_DIR/scripts/kit-update-check.mjs"',
      cmd('gdemo', '../../../scripts/x.mjs'),
      cmd('gdemo', 'stale.sh'),
      'node .claude/skills/gdemo/stale.mjs',
      42,
    ]) {
      expect(parseClaudeHookCommand(bad), String(bad)).toBeNull()
    }
  })

  it('belongs to the plugin whose namespace holds its skill — the LONGER id wins', () => {
    const ids = ['example', 'example-feature']
    expect(claudeHookOwner(cmd('example'), ids)).toBe('example')
    expect(claudeHookOwner(cmd('example-other'), ids)).toBe('example')
    expect(claudeHookOwner(cmd('example-feature-x'), ids)).toBe('example-feature')
    expect(claudeHookOwner('node "$CLAUDE_PROJECT_DIR/scripts/x.mjs"', ids)).toBeNull()
    // Hand-edited into a shape the validator refuses, it is still recognised for removal.
    expect(claudeHookOwner(`cd x && ${cmd('example')}`, ids)).toBe('example')
  })
})

describe('the claudeHooks manifest field', () => {
  const base = { id: 'gdemo', skills: ['gdemo'] }
  const problems = (claudeHooks: unknown, extra = {}) =>
    claudeHookProblems({ ...base, ...extra, claudeHooks })

  it('accepts Claude Code events running a declared skill’s script', () => {
    expect(problems(undefined)).toEqual([])
    expect(
      problems({
        Stop: [{ command: cmd('gdemo'), timeout: 30 }],
        PreToolUse: [{ matcher: 'Bash', command: cmd('gdemo', 'pre.mjs') }],
      })
    ).toEqual([])
  })

  it('refuses an unknown event, a foreign or undeclared skill, a bad timeout or extra keys', () => {
    expect(problems({ OnSave: [{ command: cmd('gdemo') }] })[0]).toMatch(
      /not a Claude Code hook event/
    )
    expect(problems({ Stop: [] })[0]).toMatch(/non-empty array/)
    expect(problems({ Stop: [{ command: cmd('rf-plugin') }] })[0]).toMatch(
      /not in 'gdemo's namespace/
    )
    expect(problems({ Stop: [{ command: cmd('gdemo-x') }] })[0]).toMatch(
      /"skills" does not declare/
    )
    expect(problems({ Stop: [{ command: 'pnpm docs:stale' }] })[0]).toMatch(/may only be/)
    expect(problems({ Stop: [{ command: cmd('gdemo'), timeout: 0 }] })[0]).toMatch(/timeout/)
    expect(problems({ Stop: [{ command: cmd('gdemo'), timeout: 601 }] })[0]).toMatch(/timeout/)
    expect(problems({ Stop: [{ command: cmd('gdemo'), type: 'prompt' }] })[0]).toMatch(
      /only command/
    )
    expect(problems([{ command: cmd('gdemo') }])[0]).toMatch(/must be an object/)
  })

  it('is reported by the manifest validator under its own field', () => {
    const found = pluginManifestProblems({
      id: 'gdemo',
      version: '1.0.0',
      minKit: '0.1.0',
      skills: ['gdemo'],
      claudeHooks: { Stop: [{ command: 'pnpm x' }] },
    })
    expect(found.map(p => p.field)).toContain('claudeHooks')
  })
})

// ---------------------------------------------------------------- the settings merge

describe('merging hooks into .claude/settings.json', () => {
  const stop = [{ event: 'Stop', command: cmd('gdemo'), timeout: 30 }]

  it('creates the file when it is absent, and remove deletes it again', () => {
    const added = setClaudeHooks(null, 'gdemo', stop)
    expect(added.text).toBe(
      `${JSON.stringify(
        { hooks: { Stop: [{ hooks: [{ type: 'command', command: cmd('gdemo'), timeout: 30 }] }] } },
        null,
        2
      )}\n`
    )
    expect(added.added).toEqual(stop)
    expect(setClaudeHooks(added.text, 'gdemo', []).text).toBeNull()
  })

  it('appends to a present file, keeps every other hook in place, and round-trips its bytes', () => {
    const added = setClaudeHooks(KIT_SETTINGS, 'gdemo', [
      ...stop,
      { event: 'PreToolUse', matcher: 'Edit', command: cmd('gdemo', 'pre.mjs') },
    ])
    const parsed = JSON.parse(added.text as string)
    expect(parsed.$schema).toBe(JSON.parse(KIT_SETTINGS).$schema)
    // The kit's own PreToolUse group is first and untouched; the plugin's is its own group after.
    expect(parsed.hooks.PreToolUse[0]).toEqual(JSON.parse(KIT_SETTINGS).hooks.PreToolUse[0])
    expect(parsed.hooks.PreToolUse[1]).toEqual({
      matcher: 'Edit',
      hooks: [{ type: 'command', command: cmd('gdemo', 'pre.mjs') }],
    })
    expect(parsed.hooks.Stop).toHaveLength(1)
    expect(setClaudeHooks(added.text, 'gdemo', []).text).toBe(KIT_SETTINGS)
  })

  it('is idempotent — the same hooks again write nothing', () => {
    const once = setClaudeHooks(KIT_SETTINGS, 'gdemo', stop).text as string
    const twice = setClaudeHooks(once, 'gdemo', stop)
    expect(twice.text).toBe(once)
    expect(twice.added).toEqual([])
  })

  it('replaces only this plugin’s entries on upgrade', () => {
    const v1 = setClaudeHooks(KIT_SETTINGS, 'gdemo', stop).text as string
    const withOther = setClaudeHooks(v1, 'other', [{ event: 'Stop', command: cmd('other') }])
      .text as string
    const v2 = setClaudeHooks(withOther, 'gdemo', [
      { event: 'Stop', command: cmd('gdemo'), timeout: 45 },
    ])
    expect(v2.removed).toEqual(stop)
    expect(v2.added).toEqual([{ event: 'Stop', command: cmd('gdemo'), timeout: 45 }])
    const owned = ownedClaudeHooks(JSON.parse(v2.text as string), 'gdemo')
    expect(owned).toEqual([{ event: 'Stop', command: cmd('gdemo'), timeout: 45 }])
    expect(ownedClaudeHooks(JSON.parse(v2.text as string), 'other')).toHaveLength(1)
  })

  it('never takes a hook of a plugin with a LONGER id that shares the prefix', () => {
    const both = setClaudeHooks(
      setClaudeHooks(null, 'example', [{ event: 'Stop', command: cmd('example') }]).text,
      'example-feature',
      [{ event: 'Stop', command: cmd('example-feature') }],
      { installedIds: ['example'] }
    ).text
    const gone = setClaudeHooks(both, 'example', [], { installedIds: ['example-feature'] })
    expect(
      ownedClaudeHooks(JSON.parse(gone.text as string), 'example-feature', ['example'])
    ).toEqual([{ event: 'Stop', command: cmd('example-feature') }])
  })

  it('keeps a four-space file four-space', () => {
    const four = `${JSON.stringify({ hooks: {} }, null, 4)}\n`
    expect(setClaudeHooks(four, 'gdemo', stop).text).toMatch(/^ {4}"hooks"/m)
  })
})

// ---------------------------------------------------------------- host files

describe('the hostFiles manifest field', () => {
  const problems = (hostFiles: unknown) => hostFileProblems({ id: 'gdemo', hostFiles })

  it('names the three namespaced host roots', () => {
    expect(hostFileRoots('gdemo')).toEqual([
      'docs/gdemo/',
      'apps/web/public/gdemo/',
      'apps/web/src/host/gdemo/',
    ])
  })

  it('accepts files and directories under them', () => {
    expect(
      problems([
        { path: 'docs/gdemo', from: 'host/docs' },
        { path: 'apps/web/public/gdemo/', from: 'host/public/' },
        { path: 'apps/web/src/host/gdemo/content.generated.ts', from: 'host/content.generated.ts' },
      ])
    ).toEqual([])
  })

  it('refuses any other root, a climb, another id’s namespace or a doubled path', () => {
    expect(problems([{ path: 'docs/plugins/gdemo/x.md', from: 'a' }])[0]).toMatch(/outside/)
    expect(problems([{ path: 'apps/web/src/api/x.ts', from: 'a' }])[0]).toMatch(/outside/)
    expect(problems([{ path: 'docs/other/x.md', from: 'a' }])[0]).toMatch(/outside/)
    expect(problems([{ path: 'docs/gdemobook/x.md', from: 'a' }])[0]).toMatch(/outside/)
    expect(problems([{ path: 'docs/gdemo/../../x', from: 'a' }])[0]).toMatch(/hostFiles path/)
    expect(problems([{ path: '/etc/passwd', from: 'a' }])[0]).toMatch(/hostFiles path/)
    expect(problems([{ path: 'docs/gdemo/x', from: '../x' }])[0]).toMatch(/hostFiles from/)
    expect(problems([{ path: 'docs/gdemo/x', from: 'skills/gdemo' }])[0]).toMatch(/skills/)
    expect(problems([{ path: 'docs/gdemo/x', from: PLUGIN_MANIFEST_FILE }])[0]).toMatch(/seedable/)
    expect(
      problems([
        { path: 'docs/gdemo', from: 'a' },
        { path: 'docs/gdemo/', from: 'b' },
      ])[0]
    ).toMatch(/twice/)
    expect(problems('docs/gdemo')[0]).toMatch(/must be an array/)
  })

  it('classifies what it covers as a seed — a file one to one, a directory beneath it', () => {
    const hostFiles = [
      { path: 'docs/gdemo', from: 'host/docs' },
      { path: 'apps/web/src/host/gdemo/content.generated.ts', from: 'host/content.generated.ts' },
    ]
    expect(classifyPluginFile('host/docs/intro.md', 'gdemo', { hostFiles })).toEqual({
      role: 'seed',
      target: 'docs/gdemo/intro.md',
      hostFile: 'docs/gdemo',
    })
    expect(classifyPluginFile('host/content.generated.ts', 'gdemo', { hostFiles }).target).toBe(
      'apps/web/src/host/gdemo/content.generated.ts'
    )
    // Anything outside a declared `from` is refused as before.
    expect(classifyPluginFile('host/other.md', 'gdemo', { hostFiles }).role).toBe('refused')
  })

  it('is recorded on the surface beside its paths, never in them', () => {
    const surface = buildPluginSurface(
      { id: 'gdemo', version: '1.0.0', hostFiles: [{ path: 'docs/gdemo', from: 'host/docs' }] },
      { repo: 'x', at: '2026-11-10' }
    )
    expect(surface.paths.some(p => p.startsWith('docs/gdemo'))).toBe(false)
    expect((surface as { hostFiles?: string[] }).hostFiles).toEqual(['docs/gdemo', 'docs/gdemo/**'])
  })
})

describe('the install plan', () => {
  it('shows the settings change and each host file before anything is written', () => {
    const plan = {
      manifest: {
        id: 'gdemo',
        version: '1.0.0',
        skills: ['gdemo'],
        claudeHooks: { Stop: [{ command: cmd('gdemo'), timeout: 30 }] },
      },
      source: { repo: 'x', subdir: '', ref: null, commit: null },
      host: { label: 'Acme', kitVersion: '0.29.0', recordsIn: 'x', translated: false },
      vendored: false,
      problems: [] as string[],
      files: [],
      byRoot: {},
      barrels: [],
      hostSeeds: [
        { target: 'docs/gdemo/intro.md', state: 'seed' as const },
        { target: 'docs/gdemo/mine.md', state: 'keep' as const },
      ],
      settingsExists: false,
      verify: null,
    }
    const text = renderAddPlan(plan).join('\n')
    expect(text).toContain('Claude Code hooks (merged into .claude/settings.json, which is created')
    expect(text).toContain(`+ Stop  ${cmd('gdemo')}  (timeout 30s)`)
    expect(text).toMatch(/seeded {2}docs\/gdemo\/intro\.md/)
    expect(text).toMatch(/kept {4}docs\/gdemo\/mine\.md/)
    const json = addPlanJson(plan) as {
      claudeHooks: { creates: boolean; hooks: unknown[] }
      hostFiles: unknown[]
    }
    expect(json.claudeHooks.creates).toBe(true)
    expect(json.claudeHooks.hooks).toHaveLength(1)
    expect(json.hostFiles).toEqual([
      { target: 'docs/gdemo/intro.md', action: 'seeded' },
      { target: 'docs/gdemo/mine.md', action: 'kept' },
    ])
  })
})

// ---------------------------------------------------------------- the lifecycle, for real

const sandboxes: string[] = []
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const GIT_ISOLATION = [
  '-c',
  'user.name=t',
  '-c',
  'user.email=t@t',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'tag.gpgSign=false',
]
const git = (cwd: string, args: string[]) =>
  execFileSync('git', [...GIT_ISOLATION, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
const write = (root: string, rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}
const read = (root: string, rel: string) => readFileSync(path.join(root, rel), 'utf8')

/** A throwaway app host — the same shape as `plugin-skills.test.ts`'s, optionally with settings. */
function makeHost({ settings = false }: { settings?: boolean } = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'rf-seams-host-'))
  sandboxes.push(root)
  cpSync(path.join(REPO_ROOT, 'scripts'), path.join(root, 'scripts'), {
    recursive: true,
    filter: src => !src.includes(`${path.sep}.upgrade`),
  })
  for (const rel of [
    'package.json',
    'docs/plugin-api.md',
    '.claude/skills/rf-plugin/SKILL.md',
    ...Object.values(BARRELS).map(b => b.file),
    'apps/web/package.json',
    'apps/cli/package.json',
    'packages/shared/package.json',
  ]) {
    write(root, rel, read(REPO_ROOT, rel))
  }
  if (settings) write(root, '.claude/settings.json', KIT_SETTINGS)
  const manifest = JSON.parse(read(REPO_ROOT, '.rocketflare.json'))
  manifest.surfaces = manifest.surfaces.filter((s: { kind?: string }) => s.kind !== 'plugin')
  manifest.app = { slug: 'acme', display: 'Acme' }
  write(root, '.rocketflare.json', `${JSON.stringify(manifest, null, 2)}\n`)
  write(root, '.gitignore', '.rocketflare.local.json\n.upgrade/\nnode_modules/\n')
  write(root, 'node_modules/.bin/biome', '#!/bin/sh\nexit 0\n')
  chmodSync(path.join(root, 'node_modules/.bin/biome'), 0o755)
  git(root, ['init', '-q'])
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'host'])
  return root
}

interface GuideVersion {
  version?: string
  manifest?: Record<string, unknown>
  files?: Record<string, string>
}

const GUIDE_FILES = {
  'skills/gdemo/SKILL.md': skillMd('gdemo'),
  'skills/gdemo/stale.mjs': 'console.log("ok")\n',
  'host/docs/intro.md': '# Intro\n',
  'host/docs/images/a.txt': 'image\n',
  'host/content.generated.ts': 'export const GUIDE = []\n',
}
const GUIDE_MANIFEST = {
  skills: ['gdemo'],
  claudeHooks: { Stop: [{ command: cmd('gdemo', 'stale.mjs', ' --hook'), timeout: 30 }] },
  hostFiles: [
    { path: 'docs/gdemo', from: 'host/docs' },
    { path: 'apps/web/src/host/gdemo/content.generated.ts', from: 'host/content.generated.ts' },
  ],
}

function writeGuide(root: string, v: GuideVersion = {}) {
  const version = v.version ?? '1.0.0'
  const manifest = `${JSON.stringify(
    {
      id: 'gdemo',
      label: 'gdemo',
      version,
      repo: root,
      subdir: '',
      minKit: '0.1.0',
      uses: {},
      ...GUIDE_MANIFEST,
      ...v.manifest,
    },
    null,
    2
  )}\n`
  write(root, PLUGIN_MANIFEST_FILE, manifest)
  write(root, 'apps/web/src/plugins/gdemo/plugin.json', manifest)
  for (const [rel, text] of Object.entries(v.files ?? GUIDE_FILES)) write(root, rel, text)
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', version])
  git(root, ['tag', '-a', '-m', version, version])
}

function makeGuide(v: GuideVersion = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'rf-seams-plugin-'))
  sandboxes.push(root)
  git(root, ['init', '-q'])
  writeGuide(root, v)
  return root
}

const run = (host: string, args: string[]) => {
  try {
    return {
      status: 0,
      out: execFileSync('node', [path.join(host, 'scripts/plugin.mjs'), ...args], {
        cwd: host,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    }
  } catch (err) {
    const e = err as { status: number; stdout?: string; stderr?: string }
    return { status: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

function tree(root: string, prefix = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (['.git', '.upgrade', 'node_modules'].includes(e.name)) continue
    if (e.isDirectory()) out.push(...tree(root, rel))
    else out.push(rel)
  }
  return out.sort()
}

const SEEDED = [
  'apps/web/src/host/gdemo/content.generated.ts',
  'docs/gdemo/images/a.txt',
  'docs/gdemo/intro.md',
]

describe('pnpm plugin with claudeHooks and hostFiles, end to end', () => {
  it('merges into an ABSENT settings file, seeds, checks, and removes leaving only the host files', () => {
    const host = makeHost()
    const plugin = makeGuide()
    const before = tree(host)

    const plan = run(host, ['add', plugin, '--local'])
    expect(plan.status, plan.out).toBe(0)
    expect(plan.out).toContain('merged into .claude/settings.json, which is created')
    expect(plan.out).toContain(`+ Stop  ${cmd('gdemo', 'stale.mjs', ' --hook')}`)
    expect(plan.out).toMatch(/seeded {2}docs\/gdemo\/intro\.md/)
    expect(existsSync(path.join(host, '.claude/settings.json'))).toBe(false)
    expect(existsSync(path.join(host, 'docs/gdemo'))).toBe(false)

    const added = run(host, ['add', plugin, '--local', '--apply', '--allow-dirty'])
    expect(added.status, added.out).toBe(0)
    expect(added.out).toContain('host files: 3 seeded, 0 kept')
    const settings = JSON.parse(read(host, '.claude/settings.json'))
    expect(settings.hooks.Stop[0].hooks[0]).toEqual({
      type: 'command',
      command: cmd('gdemo', 'stale.mjs', ' --hook'),
      timeout: 30,
    })
    for (const f of SEEDED) expect(existsSync(path.join(host, f)), f).toBe(true)
    expect(read(host, 'docs/gdemo/intro.md')).toBe('# Intro\n')
    // Seeded content is not plugin code: nothing of it lands under the plugin's roots.
    expect(existsSync(path.join(host, 'apps/web/src/plugins/gdemo/host'))).toBe(false)
    const surface = JSON.parse(read(host, '.rocketflare.local.json')).surfaces[0]
    expect(surface.hostFiles).toContain('docs/gdemo/**')
    expect(surface.paths.some((p: string) => p.startsWith('docs/gdemo'))).toBe(false)

    const checked = run(host, ['check'])
    expect(checked.status, checked.out).toBe(0)

    const removePlan = run(host, ['remove', 'gdemo'])
    expect(removePlan.out).toContain('Claude Code hooks removed')
    expect(removePlan.out).toContain('Left in place')
    const removed = run(host, ['remove', 'gdemo', '--apply', '--allow-dirty'])
    expect(removed.status, removed.out).toBe(0)
    expect(removed.out).toContain('left in place (yours): docs/gdemo')
    expect(existsSync(path.join(host, '.claude/settings.json'))).toBe(false)
    expect(tree(host).filter(f => f !== '.rocketflare.local.json')).toEqual(
      [...before, ...SEEDED].sort()
    )
  })

  it('merges into a PRESENT settings file and remove restores it byte for byte', () => {
    const host = makeHost({ settings: true })
    const plugin = makeGuide()
    expect(run(host, ['add', plugin, '--local', '--apply', '--allow-dirty']).status).toBe(0)
    const merged = JSON.parse(read(host, '.claude/settings.json'))
    expect(merged.hooks.SessionStart).toEqual(JSON.parse(KIT_SETTINGS).hooks.SessionStart)
    expect(merged.hooks.Stop).toHaveLength(1)
    expect(run(host, ['remove', 'gdemo', '--apply', '--allow-dirty']).status).toBe(0)
    expect(read(host, '.claude/settings.json')).toBe(KIT_SETTINGS)
  })

  it('keeps a host file the developer already has, byte for byte', () => {
    const host = makeHost()
    write(host, 'docs/gdemo/intro.md', '# Mine\n')
    git(host, ['add', '-A'])
    git(host, ['commit', '-qm', 'mine'])
    const plan = run(host, ['add', makeGuide(), '--local'])
    expect(plan.out).toMatch(/kept {4}docs\/gdemo\/intro\.md/)
    const added = run(host, ['add', makeGuide(), '--local', '--apply', '--allow-dirty'])
    expect(added.status, added.out).toBe(0)
    expect(added.out).toContain('2 seeded, 1 kept')
    expect(read(host, 'docs/gdemo/intro.md')).toBe('# Mine\n')
  })

  it('upgrade replaces the hooks, leaves every host file alone, and seeds only a NEW entry', () => {
    const host = makeHost({ settings: true })
    const plugin = makeGuide()
    expect(run(host, ['add', plugin, '--local', '--apply', '--allow-dirty']).status).toBe(0)
    write(host, 'docs/gdemo/intro.md', '# Edited by the developer\n')
    rmSync(path.join(host, 'docs/gdemo/images'), { recursive: true })
    git(host, ['add', '-A'])
    git(host, ['commit', '-qm', 'installed and edited'])

    writeGuide(plugin, {
      version: '1.1.0',
      manifest: {
        claudeHooks: { Stop: [{ command: cmd('gdemo', 'stale.mjs', ' --hook'), timeout: 45 }] },
        hostFiles: [
          ...GUIDE_MANIFEST.hostFiles,
          { path: 'apps/web/public/gdemo', from: 'host/public' },
        ],
      },
      files: {
        ...GUIDE_FILES,
        'host/docs/intro.md': '# Intro, v2\n',
        'host/docs/new.md': '# New upstream\n',
        'host/public/logo.svg': '<svg/>\n',
      },
    })
    const plan = run(host, ['upgrade', 'gdemo', '--to', '1.1.0'])
    expect(plan.status, plan.out).toBe(0)
    expect(plan.out).toContain('Left alone (host files are yours')
    expect(plan.out).toContain('Claude Code hooks replaced')
    expect(plan.out).toContain('(timeout 45s)')

    const up = run(host, ['upgrade', 'gdemo', '--to', '1.1.0', '--apply', '--allow-dirty'])
    expect(up.status, up.out).toBe(0)
    expect(read(host, 'docs/gdemo/intro.md')).toBe('# Edited by the developer\n')
    expect(existsSync(path.join(host, 'docs/gdemo/new.md'))).toBe(false)
    expect(existsSync(path.join(host, 'docs/gdemo/images'))).toBe(false)
    expect(read(host, 'apps/web/public/gdemo/logo.svg')).toBe('<svg/>\n')
    const hooks = JSON.parse(read(host, '.claude/settings.json')).hooks.Stop
    expect(hooks).toHaveLength(1)
    expect(hooks[0].hooks[0].timeout).toBe(45)
    expect(run(host, ['check']).status).toBe(0)

    expect(run(host, ['remove', 'gdemo', '--apply', '--allow-dirty']).status).toBe(0)
    expect(read(host, '.claude/settings.json')).toBe(KIT_SETTINGS)
    expect(existsSync(path.join(host, 'apps/web/public/gdemo/logo.svg'))).toBe(true)
  })

  it('upgrade with a reject stamps nothing; --continue finishes it once the reject is resolved', () => {
    // The re-run the message used to advise could not work: the tree is dirty, and the patch no
    // longer applies to the files it already patched. `--continue` stamps what the apply held back.
    const thing = 'apps/web/src/plugins/gdemo/thing.ts'
    const recordedVersion = () =>
      JSON.parse(read(host, '.rocketflare.local.json')).surfaces.find(
        (x: { id: string }) => x.id === 'gdemo'
      ).source.version
    const host = makeHost()
    const plugin = makeGuide({ files: { ...GUIDE_FILES, [thing]: "export const x = 'one'\n" } })
    expect(run(host, ['add', plugin, '--local', '--apply', '--allow-dirty']).status).toBe(0)
    write(host, thing, "export const x = 'mine'\n")
    git(host, ['add', '-A'])
    git(host, ['commit', '-qm', 'installed and edited'])
    writeGuide(plugin, {
      version: '1.1.0',
      files: { ...GUIDE_FILES, [thing]: "export const x = 'two'\n" },
    })

    const up = run(host, ['upgrade', 'gdemo', '--to', '1.1.0', '--apply'])
    expect(up.status, up.out).toBe(4)
    expect(up.out).toContain('pnpm plugin upgrade gdemo --to 1.1.0 --continue')
    expect(existsSync(path.join(host, `${thing}.rej`))).toBe(true)
    expect(recordedVersion()).toBe('1.0.0')

    const early = run(host, ['upgrade', 'gdemo', '--to', '1.1.0', '--continue'])
    expect(early.status, early.out).toBe(4)
    expect(early.out).toContain(`${thing}.rej`)
    expect(recordedVersion()).toBe('1.0.0')

    write(host, thing, "export const x = 'mine, two'\n")
    rmSync(path.join(host, `${thing}.rej`))
    const done = run(host, ['upgrade', 'gdemo', '--to', '1.1.0', '--continue'])
    expect(done.status, done.out).toBe(0)
    expect(done.out).toContain("surface 'gdemo' stamped at 1.1.0")
    expect(read(host, thing)).toBe("export const x = 'mine, two'\n")
    expect(recordedVersion()).toBe('1.1.0')
  })

  it('refuses a hook that runs anything else, or a script the plugin does not ship — nothing written', () => {
    const host = makeHost()
    const shell = run(host, [
      'add',
      makeGuide({
        manifest: { claudeHooks: { Stop: [{ command: 'pnpm -s docs:stale --hook' }] } },
      }),
      '--local',
      '--apply',
      '--allow-dirty',
    ])
    expect(shell.status).toBe(1)
    expect(shell.out).toMatch(/may only be/)
    const missing = run(host, [
      'add',
      makeGuide({ manifest: { claudeHooks: { Stop: [{ command: cmd('gdemo', 'gone.mjs') }] } } }),
      '--local',
      '--apply',
      '--allow-dirty',
    ])
    expect(missing.status).toBe(1)
    expect(missing.out).toContain('skills/gdemo/gone.mjs, which the plugin does not ship')
    const outside = run(host, [
      'add',
      makeGuide({
        manifest: { hostFiles: [{ path: 'apps/web/src/api/x.ts', from: 'host/docs' }] },
      }),
      '--local',
    ])
    expect(outside.status).toBe(1)
    expect(outside.out).toMatch(/outside docs\/gdemo\//)
    expect(existsSync(path.join(host, '.claude/settings.json'))).toBe(false)
    expect(existsSync(path.join(host, 'apps/web/src/plugins/gdemo'))).toBe(false)
  })

  it('check fails a declared hook gone from settings, an undeclared one, and a missing script', () => {
    const host = makeHost()
    expect(run(host, ['add', makeGuide(), '--local', '--apply', '--allow-dirty']).status).toBe(0)
    const settings = JSON.parse(read(host, '.claude/settings.json'))
    settings.hooks.Stop[0].hooks[0].timeout = 99
    write(host, '.claude/settings.json', `${JSON.stringify(settings, null, 2)}\n`)
    rmSync(path.join(host, '.claude/skills/gdemo/stale.mjs'))
    const checked = run(host, ['check', '--json'])
    expect(checked.status).toBe(1)
    const ids = (JSON.parse(checked.out).failures as { id: string }[]).map(f => f.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'gdemo:claude-hook:Stop',
        'gdemo:claude-hook-undeclared:Stop',
        'gdemo:claude-hook-script:Stop',
      ])
    )
  })
})
