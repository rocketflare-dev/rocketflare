/**
 * The plugin skills slot (D34 follow-up): a plugin ships agent skills at `skills/<dir>/`, declares
 * them in `"skills"`, and `pnpm plugin` installs them at `.claude/skills/<dir>/`.
 *
 * Two halves. The RULES are pure functions over strings and are driven with fixtures. The
 * LIFECYCLE — add, check, upgrade, remove — runs the real `scripts/plugin.mjs` against a throwaway
 * host: a temp git repository holding a copy of `scripts/` and the handful of files the script
 * reads, so an install can really be applied and undone without touching this checkout. The
 * `config` project: no database.
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
  PLUGIN_MANIFEST_FILE,
  pluginManifestProblems,
  pluginSkillDirs,
  renderAddPlan,
  SKILLS_ROOT,
  skillDirProblem,
  skillFileProblems,
  skillFrontmatter,
  skillTarget,
  surfaceDirectories,
  undeclaredSkillDirs,
} from '../../../../scripts/lib/plugin-lib.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

const skillMd = (name: string, description = `Use the ${name} skill.`, body = '# Body\n') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`

// ---------------------------------------------------------------- the rules

describe('skill directories', () => {
  it('are namespaced by the plugin id, exactly like its tables and jobs', () => {
    expect(skillDirProblem('orders', 'orders')).toBeNull()
    expect(skillDirProblem('orders', 'orders-admin')).toBeNull()
    expect(skillDirProblem('orders', 'order')).toMatch(/not namespaced/)
    expect(skillDirProblem('orders', 'ordersx')).toMatch(/not namespaced/)
    expect(skillDirProblem('orders', 'rf-plugin')).toMatch(/not namespaced/)
    expect(skillDirProblem('orders', 'Orders')).toMatch(/must be a directory name/)
    expect(skillDirProblem('orders', 42)).toMatch(/must be a directory name/)
  })

  it('land under .claude/skills/', () => {
    expect(SKILLS_ROOT).toBe('.claude/skills/')
    expect(skillTarget('orders')).toBe('.claude/skills/orders/')
    expect(pluginSkillDirs({ skills: ['orders', 7, 'orders-x'] })).toEqual(['orders', 'orders-x'])
    expect(pluginSkillDirs({})).toEqual([])
    expect(pluginSkillDirs(null)).toEqual([])
  })
})

describe('what a plugin tree may carry under skills/', () => {
  it('copies a DECLARED skill into .claude/skills/, file by file', () => {
    expect(classifyPluginFile('skills/orders/SKILL.md', 'orders', { skills: ['orders'] })).toEqual({
      role: 'copy',
      target: '.claude/skills/orders/SKILL.md',
      root: '.claude/skills/orders/',
      skill: 'orders',
    })
    expect(
      classifyPluginFile('skills/orders/providers/m365.md', 'orders', { skills: ['orders'] }).target
    ).toBe('.claude/skills/orders/providers/m365.md')
  })

  it('refuses an undeclared one — declaring is what lets remove find it again', () => {
    expect(classifyPluginFile('skills/orders/SKILL.md', 'orders').role).toBe('refused')
    expect(
      classifyPluginFile('skills/orders-extra/SKILL.md', 'orders', { skills: ['orders'] }).role
    ).toBe('refused')
    expect(classifyPluginFile('skills/README.md', 'orders', { skills: ['orders'] }).role).toBe(
      'refused'
    )
  })

  it("still treats the plugin repository's own .claude/ as its tooling", () => {
    expect(
      classifyPluginFile('.claude/skills/orders/SKILL.md', 'orders', { skills: ['orders'] }).role
    ).toBe('repo-only')
  })
})

describe('SKILL.md frontmatter', () => {
  it('reads name and description, including a folded description', () => {
    expect(skillFrontmatter(skillMd('orders', 'Manage orders.'))).toEqual({
      name: 'orders',
      description: 'Manage orders.',
    })
    expect(
      skillFrontmatter('---\nname: "orders"\ndescription: >\n  Two\n  lines.\n---\nbody')
    ).toEqual({ name: 'orders', description: 'Two lines.' })
    expect(skillFrontmatter('# no frontmatter')).toBeNull()
  })

  it('must name its own directory and say when it is used', () => {
    expect(skillFileProblems('orders', skillMd('orders'))).toEqual([])
    expect(skillFileProblems('orders', skillMd('orders-admin'))[0]).toMatch(
      /"name" must equal the directory/
    )
    expect(skillFileProblems('orders', '---\nname: orders\n---\n')[0]).toMatch(/no description/)
    expect(skillFileProblems('orders', '---\nname: orders\ndescription:\n---\n')[0]).toMatch(
      /no description/
    )
    expect(skillFileProblems('orders', '# hi')[0]).toMatch(/no frontmatter/)
    expect(skillFileProblems('orders', null)[0]).toMatch(/no SKILL.md/)
  })
})

describe('undeclared skill directories', () => {
  it("are the ones in a plugin's namespace that it does not declare", () => {
    expect(
      undeclaredSkillDirs('orders', ['orders'], ['orders', 'orders-extra', 'rf-plugin', 'other'])
    ).toEqual(['orders-extra'])
  })

  it('belong to the LONGER id when two installed ids share a prefix', () => {
    const host = ['example', 'example-feature', 'example-feature-x', 'example-other']
    const installed = ['example', 'example-feature']
    expect(undeclaredSkillDirs('example', ['example'], host, installed)).toEqual(['example-other'])
    expect(undeclaredSkillDirs('example-feature', ['example-feature'], host, installed)).toEqual([
      'example-feature-x',
    ])
  })
})

describe('the manifest field', () => {
  const base = { id: 'orders', version: '1.0.0', repo: 'https://x/y.git', minKit: '0.1.0' }
  const skillProblems = (skills: unknown) =>
    pluginManifestProblems({ ...base, skills }).filter(p => p.field === 'skills')

  it('is an array of namespaced directory names, each once', () => {
    expect(skillProblems(['orders', 'orders-admin'])).toEqual([])
    expect(skillProblems(undefined)).toEqual([])
    expect(skillProblems('orders')[0].problem).toMatch(/array of strings/)
    expect(skillProblems(['rf-plugin'])[0].problem).toMatch(/not namespaced/)
    expect(skillProblems(['orders', 'orders'])[0].problem).toMatch(/twice/)
  })

  it('puts each skill directory on the surface, so remove deletes it', () => {
    const surface = buildPluginSurface(
      { ...base, skills: ['orders', 'orders-admin'] },
      { repo: base.repo, at: '2026-09-27' }
    )
    expect(surface.paths).toContain('.claude/skills/orders/**')
    expect(surface.paths).toContain('.claude/skills/orders-admin/**')
    expect(surfaceDirectories(surface)).toContain('.claude/skills/orders')
  })

  it('shows the skills in the install plan, as text and as data', () => {
    const plan = {
      manifest: { ...base, skills: ['orders'] },
      source: { repo: base.repo, subdir: '', ref: null, commit: null },
      host: { label: 'the kit itself', kitVersion: '0.13.0', recordsIn: 'x', translated: false },
      vendored: false,
      problems: [] as string[],
      files: [],
      byRoot: {},
      barrels: [],
      verify: null,
    }
    expect(renderAddPlan(plan).join('\n')).toMatch(/Skills .*\n {2}\.claude\/skills\/orders\//)
    expect(addPlanJson(plan).skills).toEqual([{ name: 'orders', target: '.claude/skills/orders/' }])
  })
})

// ---------------------------------------------------------------- the lifecycle, for real

const sandboxes: string[] = []
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Whatever the developer's global git config says about identity, signing or tags. */
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

/**
 * A host the script can write to: this checkout's `scripts/`, its ledger, its barrels, the kit's
 * own `rf-plugin` skill (so a collision with a kit skill is real), and a `.rocketflare.json` for an
 * app called Acme with no plugin surfaces — a vendored plugin's files are not copied, so recording
 * it would make every `check` fail on its missing anchor.
 */
function makeHost(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'rf-skills-host-'))
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
    write(root, rel, readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
  }
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, '.rocketflare.json'), 'utf8'))
  manifest.surfaces = manifest.surfaces.filter((s: { kind?: string }) => s.kind !== 'plugin')
  // An APP, which is where a plugin is installed — and `upgrade` translates what it patches into
  // the app's names, which the kit itself (no `app`) has none of.
  manifest.app = { slug: 'acme', display: 'Acme' }
  write(root, '.rocketflare.json', `${JSON.stringify(manifest, null, 2)}\n`)
  write(root, '.gitignore', '.rocketflare.local.json\n.upgrade/\nnode_modules/\n')
  // `pnpm exec biome` resolves this before anything on PATH. Formatting is not what is under test,
  // and a host with no `biome.json` would reformat the anchor with Biome's defaults — after which
  // an upgrade's patch no longer matches it.
  write(root, 'node_modules/.bin/biome', '#!/bin/sh\nexit 0\n')
  chmodSync(path.join(root, 'node_modules/.bin/biome'), 0o755)
  git(root, ['init', '-q'])
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'host'])
  return root
}

interface PluginFixture {
  id?: string
  version?: string
  skills?: string[]
  files?: Record<string, string>
}

/** A plugin repository with nothing but skills — the smallest thing the slot applies to. */
function makePlugin(fixture: PluginFixture = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'rf-skills-plugin-'))
  sandboxes.push(root)
  git(root, ['init', '-q'])
  writePluginVersion(root, fixture)
  return root
}

function writePluginVersion(root: string, fixture: PluginFixture) {
  const id = fixture.id ?? 'orders'
  const version = fixture.version ?? '1.0.0'
  const skills = fixture.skills ?? [id]
  const manifest = `${JSON.stringify(
    { id, label: id, version, repo: root, subdir: '', minKit: '0.1.0', uses: {}, skills },
    null,
    2
  )}\n`
  // Both copies, as a real plugin ships them: the release manifest, and the ANCHOR a host keeps —
  // which is the copy `upgrade` patches forward.
  write(root, PLUGIN_MANIFEST_FILE, manifest)
  write(root, `apps/web/src/plugins/${id}/plugin.json`, manifest)
  const files =
    fixture.files ?? Object.fromEntries(skills.map(s => [`skills/${s}/SKILL.md`, skillMd(s)]))
  for (const [rel, text] of Object.entries(files)) write(root, rel, text)
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', version])
  git(root, ['tag', '-a', '-m', version, version])
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

/** Every file in the host, minus git's and the script's own scratch space. */
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

const sidecar = (host: string) =>
  JSON.parse(readFileSync(path.join(host, '.rocketflare.local.json'), 'utf8')) as {
    surfaces: { id: string; paths: string[] }[]
  }

describe('pnpm plugin, with skills, end to end', () => {
  it('adds a skill where Claude Code finds it, checks it, and removes it without a trace', () => {
    const host = makeHost()
    const plugin = makePlugin({
      skills: ['orders', 'orders-admin'],
      files: {
        'skills/orders/SKILL.md': skillMd('orders'),
        'skills/orders/reference.md': '# Reference\n',
        'skills/orders-admin/SKILL.md': skillMd('orders-admin'),
      },
    })
    const before = tree(host)

    const plan = run(host, ['add', plugin, '--local'])
    expect(plan.status).toBe(0)
    expect(plan.out).toContain('.claude/skills/orders/')
    expect(existsSync(path.join(host, '.claude/skills/orders'))).toBe(false)

    const added = run(host, ['add', plugin, '--local', '--apply', '--allow-dirty'])
    expect(added.status, added.out).toBe(0)
    expect(readFileSync(path.join(host, '.claude/skills/orders/SKILL.md'), 'utf8')).toBe(
      skillMd('orders')
    )
    expect(existsSync(path.join(host, '.claude/skills/orders/reference.md'))).toBe(true)
    expect(existsSync(path.join(host, '.claude/skills/orders-admin/SKILL.md'))).toBe(true)
    expect(sidecar(host).surfaces[0].paths).toEqual(
      expect.arrayContaining(['.claude/skills/orders/**', '.claude/skills/orders-admin/**'])
    )
    const checked = run(host, ['check'])
    expect(checked.status, checked.out).toBe(0)

    const removed = run(host, ['remove', 'orders', '--apply', '--allow-dirty'])
    expect(removed.status, removed.out).toBe(0)
    expect(tree(host).filter(f => f !== '.rocketflare.local.json')).toEqual(before)
  })

  it('fails check for a declared skill that is gone, misnamed, or one it never declared', () => {
    const host = makeHost()
    const plugin = makePlugin({ skills: ['orders', 'orders-admin'] })
    expect(run(host, ['add', plugin, '--local', '--apply', '--allow-dirty']).status).toBe(0)

    rmSync(path.join(host, '.claude/skills/orders-admin'), { recursive: true })
    write(host, '.claude/skills/orders/SKILL.md', skillMd('wrong'))
    write(host, '.claude/skills/orders-extra/SKILL.md', skillMd('orders-extra'))
    const checked = run(host, ['check', '--json'])
    expect(checked.status).toBe(1)
    const ids = (JSON.parse(checked.out).failures as { id: string }[]).map(f => f.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'orders:skill:orders-admin',
        'orders:skill:orders',
        'orders:skill-undeclared:orders-extra',
      ])
    )
    // The kit's own skills are nobody's plugin's.
    expect(ids.some(i => i.includes('rf-plugin'))).toBe(false)
  })

  it('refuses a skill directory that already exists — the kit’s or anyone else’s', () => {
    const host = makeHost()
    // `rf` is a legal id and `rf-plugin` is in its namespace, so only the collision stops it.
    const kitClash = run(host, [
      'add',
      makePlugin({ id: 'rf', skills: ['rf-plugin'] }),
      '--local',
      '--apply',
      '--allow-dirty',
    ])
    expect(kitClash.status).toBe(7)
    expect(kitClash.out).toContain('.claude/skills/rf-plugin/')
    expect(readFileSync(path.join(host, '.claude/skills/rf-plugin/SKILL.md'), 'utf8')).toBe(
      readFileSync(path.join(REPO_ROOT, '.claude/skills/rf-plugin/SKILL.md'), 'utf8')
    )

    write(host, '.claude/skills/orders/SKILL.md', skillMd('orders'))
    const mine = run(host, ['add', makePlugin(), '--local', '--apply', '--allow-dirty'])
    expect(mine.status).toBe(7)
  })

  it('refuses a plugin whose skills are undeclared, misnamed or undescribed', () => {
    const host = makeHost()
    const undeclared = makePlugin({
      skills: [],
      files: { 'skills/orders/SKILL.md': skillMd('orders') },
    })
    const a = run(host, ['add', undeclared, '--local'])
    expect(a.status).toBe(1)
    expect(a.out).toMatch(/skills\/orders\/SKILL\.md/)

    const misnamed = makePlugin({ files: { 'skills/orders/SKILL.md': skillMd('other') } })
    const b = run(host, ['add', misnamed, '--local'])
    expect(b.status).toBe(1)
    expect(b.out).toMatch(/"name" must equal the directory/)

    const outside = makePlugin({ skills: ['billing'] })
    const c = run(host, ['add', outside, '--local'])
    expect(c.status).toBe(1)
    expect(c.out).toMatch(/not namespaced/)
    expect(existsSync(path.join(host, '.claude/skills/billing'))).toBe(false)
  })

  it('upgrade REPLACES a skill, deletes what the release deleted, and drops an undeclared one', () => {
    const host = makeHost()
    const plugin = makePlugin({
      skills: ['orders', 'orders-admin'],
      files: {
        'skills/orders/SKILL.md': skillMd('orders', 'v1', '# One\n'),
        'skills/orders/reference.md': '# Reference\n',
        'skills/orders-admin/SKILL.md': skillMd('orders-admin'),
      },
    })
    expect(run(host, ['add', plugin, '--local', '--apply', '--allow-dirty']).status).toBe(0)
    git(host, ['add', '-A'])
    git(host, ['commit', '-qm', 'installed'])

    rmSync(path.join(plugin, 'skills/orders/reference.md'))
    rmSync(path.join(plugin, 'skills/orders-admin'), { recursive: true })
    writePluginVersion(plugin, {
      version: '1.1.0',
      skills: ['orders'],
      files: { 'skills/orders/SKILL.md': skillMd('orders', 'v2', '# Two\n') },
    })

    const up = run(host, ['upgrade', 'orders', '--to', '1.1.0', '--apply', '--allow-dirty'])
    expect(up.status, up.out).toBe(0)
    expect(readFileSync(path.join(host, '.claude/skills/orders/SKILL.md'), 'utf8')).toBe(
      skillMd('orders', 'v2', '# Two\n')
    )
    expect(existsSync(path.join(host, '.claude/skills/orders/reference.md'))).toBe(false)
    expect(existsSync(path.join(host, '.claude/skills/orders-admin'))).toBe(false)
    const paths = sidecar(host).surfaces[0].paths
    expect(paths).toContain('.claude/skills/orders/**')
    expect(paths).not.toContain('.claude/skills/orders-admin/**')
    const checked = run(host, ['check'])
    expect(checked.status, checked.out).toBe(0)
  })

  it('exports a skill back to skills/<dir>/, never .claude/', () => {
    const host = makeHost()
    const plugin = makePlugin()
    expect(run(host, ['add', plugin, '--local', '--apply', '--allow-dirty']).status).toBe(0)
    const out = mkdtempSync(path.join(tmpdir(), 'rf-skills-export-'))
    sandboxes.push(out)
    const exported = run(host, ['export', 'orders', out])
    expect(exported.status, exported.out).toBe(0)
    expect(readFileSync(path.join(out, 'skills/orders/SKILL.md'), 'utf8')).toBe(skillMd('orders'))
    expect(existsSync(path.join(out, '.claude'))).toBe(false)
    const manifest = JSON.parse(readFileSync(path.join(out, PLUGIN_MANIFEST_FILE), 'utf8'))
    expect(manifest.skills).toEqual(['orders'])
    expect(manifest.paths.some((p: string) => p.startsWith('.claude/'))).toBe(false)
  })
})
