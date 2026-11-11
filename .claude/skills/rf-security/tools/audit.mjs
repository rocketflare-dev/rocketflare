#!/usr/bin/env node
/**
 * The audit runner behind `/rf-security`. The parent agent makes the judgement calls (what to hunt,
 * which candidates share a root cause, what a record should say); this script does every
 * mechanical step the same way each run: run directories, budgets, briefs, ledger updates,
 * consolidation, findings, citations, reports and the filesystem guard.
 *
 *   node audit.mjs <command> [--run <dir>] …   (`help` lists the commands)
 *
 * Every step writes beside the file it changes (`*.next.json`), runs upstream's validators, and
 * installs only when they pass. Nothing it writes is ever deleted; prior state is kept as
 * `*.before-<step>.json`. It prints identifiers and counts, never proof or payload text.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  block as mdBlock,
  byString,
  COMPANION_SECTIONS,
  COMPANIONS,
  countBy,
  coverageId,
  exists,
  extractResult,
  fence,
  installIfValid,
  keepBefore,
  markerPath,
  promoteArtifacts,
  REPO,
  readJson,
  readUpstream,
  runsRoot,
  section as mdSection,
  sevRank,
  TOOLS,
  validate,
  writeFile,
  writeJson,
  writeJsonNew,
  writeNew,
} from './lib.mjs'

// ---------------------------------------------------------------------------------------------
// Profiles and budgets

/**
 * Defaults per profile. `budget` is the total agent calls. The validation share covers verifiers
 * and Phase 5 reviewers: a deep run spends a little over half its calls there, about two candidates a
 * hunter.
 */
export const PROFILES = {
  quick: { budget: 16, recon: 2, reviewers: 'none', validationShare: 0.45 },
  standard: { budget: 50, recon: 4, reviewers: 'grouped', validationShare: 0.5 },
  deep: { budget: 90, recon: 4, reviewers: 'each', validationShare: 0.6 },
}

/**
 * How a budget splits: reconnaissance and critics first, a validation reserve next, hunters get
 * the rest (upstream SKILL.md "Cost budget"). Quick runs one critic; standard and deep reserve a
 * post-wave critic plus a final-clean critic for wave 1.
 */
export function budgetPlan(profile, budget, recon) {
  const p = PROFILES[profile]
  if (!p) throw new Error(`unknown profile ${profile}`)
  const total = budget ?? p.budget
  const reconCalls = recon ?? p.recon
  const critics = profile === 'quick' ? 1 : 2
  const afterCritics = total - reconCalls - critics
  // A run that spends its whole budget ends with a deferred unit: keep one hunter and one verifier
  // for whatever the final critic adds (standard and deep; quick defers by design).
  const followUp = profile === 'quick' ? 0 : 2
  const validation = Math.max(1, Math.ceil((afterCritics - followUp) * p.validationShare))
  const hunters = afterCritics - followUp - validation
  return { profile, total, recon: reconCalls, critics, final_follow_up: followUp, validation, hunters, ok: hunters >= 1 }
}

// ---------------------------------------------------------------------------------------------
// Arguments and run directories

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      args._.push(a)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) args[key] = true
    else {
      args[key] = args[key] === undefined ? next : [].concat(args[key], next)
      i++
    }
  }
  return args
}

const list = v => (v === undefined ? [] : [].concat(v))

/** The run a command acts on: `--run`, else the active audit's run. */
function runDir(args) {
  if (args.run) return path.resolve(args.run)
  if (exists(markerPath())) return readJson(markerPath()).run
  throw new Error('no --run and no active audit')
}

const P = run => ({
  meta: path.join(run, 'run-metadata.json'),
  ledger: path.join(run, 'coverage-ledger.json'),
  findings: path.join(run, 'findings.json'),
  agents: path.join(run, 'agents'),
  host: path.join(run, 'host'),
  decisions: path.join(run, 'decisions.json'),
  blocked: path.join(run, 'verification-blocked.json'),
  consolidated: path.join(run, 'candidates.consolidated.json'),
  rediscoveries: path.join(run, 'rediscoveries.json'),
})

const agentDir = (run, id) => path.join(run, 'agents', id)
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Agent ids: the directories under agents/, sorted. A stray file there is not an agent. */
function agentIds(run) {
  const dir = P(run).agents
  if (!exists(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()
}

// ---------------------------------------------------------------------------------------------
// Staged writes: `<name>.next.json` beside the file, installed only when upstream's validators pass

const nextOf = file => file.replace(/\.json$/, '.next.json')
const pendingPath = run => path.join(run, 'pending-next.json')
const pendingOf = run => (exists(pendingPath(run)) ? readJson(pendingPath(run)) : {})

/** The `.next.json` files a failed step left in the run directory, with the step that wrote each. */
function leftovers(run) {
  const pending = pendingOf(run)
  return fs
    .readdirSync(run)
    .filter(n => n.endsWith('.next.json'))
    .sort()
    .map(n => ({ file: n, by: pending[n] ?? null }))
}

/**
 * A step never reads a shared file while a failed step's `.next.json` waits beside it: that file
 * holds work the installed one lacks. Only the step that wrote it may run again (and replace it).
 */
function refuseLeftovers(run, step, files) {
  const pending = pendingOf(run)
  for (const file of files) {
    const next = path.basename(nextOf(file))
    if (!exists(path.join(run, next))) continue
    const by = pending[next]
    if (by === step) continue
    const who = by ? `a failed \`${by}\`` : 'an earlier step that did not install'
    const fix = by ? `rerun \`${by}\`` : 'rerun the step that wrote it'
    throw new Error(
      `${next} is left over from ${who}: fix what it reported and ${fix}, or set it aside with ` +
        `\`discard-next\`, before \`${step}\` (\`status\` lists leftovers)`
    )
  }
}

/** Writes `<file>.next.json` for `step` and records which step it belongs to. */
function stage(run, step, file, value) {
  const next = nextOf(file)
  writeJson(next, value)
  const pending = pendingOf(run)
  pending[path.basename(next)] = step
  writeJson(pendingPath(run), pending)
  return next
}

/** Installs staged files when every validator passes; otherwise the command exits 1. */
function install(run, step, pairs) {
  const ok = installIfValid(pairs)
  if (ok) {
    const pending = pendingOf(run)
    for (const [, next] of pairs) delete pending[path.basename(next)]
    writeJson(pendingPath(run), pending)
  } else {
    console.log(`${step}: nothing installed; fix the errors above and rerun \`${step}\``)
    process.exitCode = 1
  }
  return ok
}

/** Upstream's fingerprint pattern (validate-coverage-ledger.cjs). */
export const FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/

/** Replaces every occurrence of each `from` string with its `to`, in every string of `value`. */
function replaceStrings(value, map) {
  if (typeof value === 'string') return [...map].reduce((s, [a, b]) => s.replaceAll(a, b), value)
  if (Array.isArray(value)) return value.map(v => replaceStrings(v, map))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceStrings(v, map)]))
  }
  return value
}

/**
 * A hunter's fingerprints with `#` (which upstream's pattern refuses) as `:`, in its candidates,
 * its units and every string that quotes one. The stored result is evidence and stays as written.
 */
export function normaliseFingerprints(result) {
  const map = new Map()
  const fps = [
    ...result.candidates.map(c => c.fingerprint),
    ...result.units.flatMap(u => u.candidate_fingerprints ?? []),
  ]
  for (const f of fps) if (typeof f === 'string' && f.includes('#')) map.set(f, f.replaceAll('#', ':'))
  return { result: map.size ? replaceStrings(result, map) : result, renamed: [...map] }
}

function makeAgentDir(run, id) {
  if (!ID.test(id)) throw new Error(`bad agent id ${id}`)
  const dir = agentDir(run, id)
  for (const d of ['scratch', 'artifacts', 'poc']) fs.mkdirSync(path.join(dir, d), { recursive: true })
  return dir
}

const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr.trim()}`)
  return r.stdout.trim()
}

function nextRunId(repoDir) {
  if (!exists(repoDir)) return 'run-1'
  const used = fs
    .readdirSync(repoDir)
    .map(n => /^run-(\d+)$/.exec(n)?.[1])
    .filter(Boolean)
    .map(Number)
  return `run-${used.length ? Math.max(...used) + 1 : 1}`
}

// ---------------------------------------------------------------------------------------------
// init · host · budget · finish

function cmdInit(args) {
  const profile = args._[0] ?? 'standard'
  if (!PROFILES[profile]) throw new Error(`profile is quick, standard or deep, not ${profile}`)
  const repoDir = path.resolve(args.repo ?? REPO)
  if (!exists(path.join(repoDir, 'docs/THREAT-MODEL.md'))) {
    throw new Error(
      'the audit needs docs/THREAT-MODEL.md: restore the kit\'s copy or write your own first (docs/SECURITY-AUDIT.md)'
    )
  }
  const repoName = args.name ?? path.basename(git(repoDir, 'rev-parse', '--show-toplevel'))
  const root = path.join(runsRoot(), repoName)
  const runId = nextRunId(root)
  const run = path.join(root, runId)
  if (exists(markerPath()) && !args.takeover) {
    throw new Error(`an audit is active (${readJson(markerPath()).run}); finish it or pass --takeover`)
  }
  const ref = args.ref ?? 'HEAD'
  const commit = git(repoDir, 'rev-parse', `${ref}^{commit}`)
  const dirty = git(repoDir, 'status', '--porcelain').length > 0
  const scope = { paths: list(args.scope), diff: null }
  if (args.diff) {
    const [base, head = commit] = String(args.diff).split('..')
    const files = git(repoDir, 'diff', '--name-only', base, head).split('\n').filter(Boolean)
    scope.diff = { base: git(repoDir, 'rev-parse', `${base}^{commit}`), head, files }
  }
  const plan = budgetPlan(profile, args.budget ? Number(args.budget) : undefined, args.recon && Number(args.recon))
  if (!plan.ok) throw new Error(`budget ${plan.total} cannot fund reconnaissance, critics and validation`)
  const priors = exists(root)
    ? fs
        .readdirSync(root)
        .filter(n => /^run-\d+$/.test(n) && exists(path.join(root, n, 'findings.json')))
        .map(n => path.join(root, n))
    : []
  fs.mkdirSync(path.join(run, 'agents'), { recursive: true })
  const meta = {
    run_id: runId,
    repo: repoName,
    target: path.join(run, 'host'),
    source_ref: { kit: commit, ref, dirty_worktree: dirty },
    profile,
    scope_paths: scope.diff ? scope.diff.files : scope.paths,
    scope: scope.diff ? { diff: `${scope.diff.base}..${scope.diff.head}` } : null,
    budget: plan.total,
    budget_plan: plan,
    execution_policy: 'sandboxed-source-and-local-only',
    selected_companions: [...new Set(Object.values(COMPANIONS))].filter(f => f !== COMPANIONS.O),
    prior_runs: priors,
    shared_file_owners: {},
    models: { hunters: args['hunter-model'] ?? 'opus', verifiers: args['verifier-model'] ?? 'fable' },
    run_status: 'in_progress',
    started: new Date().toISOString(),
  }
  writeJsonNew(P(run).meta, meta)
  if (scope.diff) writeJsonNew(path.join(run, 'scope-diff.json'), scope.diff)
  writeJson(markerPath(), { run, repo: repoDir, started: new Date().toISOString() })
  console.log(run)
  console.log(JSON.stringify(plan))
}

/**
 * The checkout every agent reads and the sandbox image is built from: a clone of the audited ref
 * plus the sandbox tooling, then (optionally) every plugin installed by a disposable online
 * container with no host credentials. Agents never read the working repository.
 */
function cmdHost(args) {
  const run = runDir(args)
  const meta = readJson(P(run).meta)
  const host = P(run).host
  const repo = path.resolve(args.repo ?? REPO)
  if (!exists(host)) {
    git(run, 'clone', '--quiet', '--no-local', repo, host)
    git(host, 'checkout', '--quiet', '-B', 'audit-host', meta.source_ref.kit)
    git(host, 'config', 'user.name', 'audit')
    git(host, 'config', 'user.email', 'audit@localhost')
    const tooling = [
      'scripts/security-sandbox.mjs',
      'apps/web/docker-compose.security.yml',
      'apps/web/docker/Dockerfile.security-sandbox',
      'docs/THREAT-MODEL.md',
    ]
    const added = []
    for (const f of tooling) {
      if (exists(path.join(host, f))) continue
      fs.mkdirSync(path.dirname(path.join(host, f)), { recursive: true })
      fs.copyFileSync(path.join(repo, f), path.join(host, f), fs.constants.COPYFILE_EXCL)
      added.push(f)
    }
    if (added.length) {
      git(host, 'add', ...added)
      git(host, 'commit', '--quiet', '-m', 'audit tooling')
    }
  }
  const sandbox = path.join(host, 'scripts/security-sandbox.mjs')
  const plugins = list(args.plugin) // <repo-dir>:<subdir>, e.g. ../my-plugins:plugins/inbox
  if (plugins.length && git(host, 'branch', '--show-current') !== 'audit-plugins') {
    if (spawnSync('node', [sandbox, 'build', '--ref', 'audit-host'], { stdio: 'inherit' }).status !== 0) {
      throw new Error('sandbox build failed')
    }
    const repos = [...new Set(plugins.map(p => path.resolve(p.split(':')[0])))]
    const mounts = repos.flatMap((r, i) => ['-v', `${r}:/mnt/p${i}:ro`])
    const adds = plugins
      .map(p => {
        const [r, sub] = p.split(':')
        return `pnpm --silent plugin add /mnt/p${repos.indexOf(path.resolve(r))}/${sub} --apply --allow-dirty`
      })
      .join(' && ')
    const script = [
      'set -euo pipefail',
      "git config --global --add safe.directory '*'",
      'git config --global user.name audit && git config --global user.email audit@localhost',
      'git clone --quiet -b audit-host /mnt/clone /work/tree && cd /work/tree',
      'pnpm install --frozen-lockfile --silent',
      adds,
      'pnpm install --no-frozen-lockfile --silent',
      'pnpm --silent db:generate',
      'git add -A && git commit --quiet -m "plugins installed"',
      'git push --quiet /mnt/clone HEAD:refs/heads/audit-plugins',
    ].join('\n')
    const r = spawnSync(
      'docker',
      ['run', '--rm', '--user', 'node', '--tmpfs', '/work:uid=1000,gid=1000,exec,size=8g',
        '-e', 'HOME=/work', '-v', `${host}:/mnt/clone`, ...mounts,
        'rocketflare-security-sandbox', 'bash', '-c', script],
      { stdio: 'inherit', env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST ?? '' } }
    )
    if (r.status !== 0) throw new Error('plugin install failed')
    git(host, 'checkout', '--quiet', 'audit-plugins')
    meta.source_ref.plugins = repos.map(r => ({ repo: path.basename(r), commit: git(r, 'rev-parse', 'HEAD') }))
  }
  if (spawnSync('node', [sandbox, 'build', '--ref', 'HEAD'], { stdio: 'inherit' }).status !== 0) {
    throw new Error('sandbox build failed')
  }
  const verified = spawnSync('node', [sandbox, 'verify'], { encoding: 'utf8' })
  meta.source_ref.installed_tree = git(host, 'rev-parse', 'HEAD')
  meta.sandbox = `${verified.status === 0 ? 'verify passed' : 'verify FAILED'} on ${new Date().toISOString().slice(0, 10)} against ${meta.source_ref.installed_tree.slice(0, 7)}`
  writeJson(P(run).meta, meta)
  console.log(meta.sandbox)
  if (verified.status !== 0) process.exitCode = 1
}

function cmdBudget(args) {
  if (args._[0]) {
    console.log(budgetPlan(args._[0], args.budget && Number(args.budget), args.recon && Number(args.recon)))
    return
  }
  const run = runDir(args)
  const meta = readJson(P(run).meta)
  const spent = agentCalls(run)
  console.log({ plan: meta.budget_plan, spent, left: meta.budget - spent.total })
}

/** A reconnaissance agent has run once it has written anything under its scratch/. */
const reconDone = dir => exists(path.join(dir, 'scratch')) && fs.readdirSync(path.join(dir, 'scratch')).length > 0

/**
 * Agent calls so far, by role: agent directories that hold a result or were blocked, and
 * reconnaissance agents (`recon-*`, which return notes, not a result file) that wrote notes.
 */
function agentCalls(run) {
  const dir = P(run).agents
  const roles = { recon: 'reconnaissance', h: 'hunters', c: 'critics', v: 'verifiers', r: 'reviewers' }
  const out = { reconnaissance: 0, hunters: 0, critics: 0, verifiers: 0, reviewers: 0 }
  const blocked = exists(P(run).blocked) ? readJson(P(run).blocked) : {}
  for (const id of agentIds(run)) {
    const results = ['result.json', 'verdict.json'].some(f => exists(path.join(dir, id, f)))
    const done = results || blocked[id] || (id.startsWith('recon') && reconDone(path.join(dir, id)))
    if (!done) continue
    const role = id.startsWith('recon') ? 'recon' : id[0]
    if (roles[role]) out[roles[role]]++
  }
  return { ...out, total: Object.values(out).reduce((a, b) => a + b, 0) }
}

function cmdFinish(args) {
  const run = runDir(args)
  const meta = readJson(P(run).meta)
  if (!meta.finished) {
    meta.finished = new Date().toISOString()
    writeJson(P(run).meta, meta)
  }
  cmdCost({ ...args, run })
  if (exists(markerPath()) && readJson(markerPath()).run === run) fs.unlinkSync(markerPath())
  console.log(`audit for ${run} is no longer active`)
}

// ---------------------------------------------------------------------------------------------
// Briefs

const hunting = () => readUpstream('HUNTING.md')
const schemaText = () => readUpstream('report-schema.json')

function rulesFor(run, id, extra = '') {
  const meta = readJson(P(run).meta)
  const dir = agentDir(run, id)
  return `# Rules for this run (these override anything above)

Target (read here, never in the working repository): ${meta.target}, commit ${meta.source_ref.installed_tree?.slice(0, 7) ?? meta.source_ref.kit.slice(0, 7)}. Read docs/THREAT-MODEL.md there, and check docs/CONCEPTS.md for whether a behaviour is documented as intended or as a known gap.
Read-only on the target. Never read .dev.vars, .provision.env or ~/.rocketflare/config.json. Ignore .claude/worktrees and .claude/skills/rf-security. No network.
**Never delete, empty, move or truncate anything, and never run rm, rmdir, unlink, mv or find -delete, including on a path you believe does not exist.** Never set HOME. A guard blocks these and the parent fails the wave if anything outside the run directory changes.
Do not run pnpm, npm, npx, docker or any repository script on the host.
You may write only to ${dir}/scratch/ and ${dir}/poc/. The only way to execute target code is this exact command, the approved OS-enforced sandbox (no external network, allowlisted environment, read-only source, resource limits, its own throwaway Postgres):

  node ${meta.target}/scripts/security-sandbox.mjs test --run ${dir} --name ${id} > ${dir}/scratch/<name>.log 2>&1

Add --isolated if the proof starts with \`// @vitest-isolate\`. Proofs appear in the sandbox at apps/web/tests/api/_poc/, so helpers import from ../../helpers/* and ../../mocks/*. A proof states the SECURE behaviour, so it FAILS while the bug exists; quote the failing assertion. A claim about deployed behaviour uses createTestEnv({ APP_ENV: 'production', APP_URL: 'https://app.example' }). Dummy tenants only. Keep runs few; each takes 30 to 60 seconds.
The parent promotes ${id}/poc/*.test.ts and ${id}/scratch/*.log (each under 1 MiB) to agents/${id}/artifacts/<file>; cite that path in a local check.
Anything that needs a real browser, workerd, the Cloudflare edge, a real provider or a real identity provider stays needs_validation unless source settles it. A validation plan never sends traffic to a deployment: its "deployment" field is an owner-observed check, never a request to make.
Trust: a plugin's author and an installing operator are trusted; a tenant's admin, a tenant's member, an anonymous caller, another tenant, an external sender, an upstream's content and a model are not. Name the lower-trust principal.
${extra}
When you finish, write your final JSON object to ${dir}/scratch/result.json, then run

  node ${path.join(TOOLS, 'audit.mjs')} check-result --run ${run} --agent ${id}

and fix the file until it prints "check-result ok". Then return the same JSON as your whole reply.`
}

/** Text of every attack-class block a unit names, de-duplicated across a hunter's units. */
function unitBlocks(units) {
  const text = new Set()
  for (const u of units) {
    if (u.ordinary_attack_class_block) {
      const [file, name] = u.ordinary_attack_class_block.split('#')
      const got = blockOrSection(file, name)
      text.add(got)
    }
    for (const ref of u.selected_companion_blocks) {
      const [file, name] = ref.split('#')
      const got = blockOrSection(file, name)
      text.add(COMPANION_SECTIONS.includes(name) ? `### ${file}\n\n${got}` : got)
    }
  }
  return [...text]
}

function blockOrSection(file, name) {
  const text = readUpstream(file)
  const got = mdBlock(text, name) ?? mdSection(text, name)
  if (!got) throw new Error(`upstream block missing: ${file}#${name}`)
  return got
}

/** Ledger units for one hunter in a plan: new classes, prior-run units, or existing planned ones. */
function unitsFor(h, plan, ledger, wave, meta) {
  const blank = { attempts: [], wave, status: 'in_progress', reviewed_paths: [], local_checks: [], result_fingerprints: [], unresolved: [] }
  if (h.units) {
    return h.units.map(prefix => {
      const u = ledger.find(x => x.coverage_id === prefix || x.coverage_id.startsWith(prefix))
      if (!u) throw new Error(`${h.id}: no ledger unit ${prefix.slice(0, 60)}`)
      if (!['planned', 'deferred'].includes(u.status)) throw new Error(`${h.id}: unit is ${u.status}, not planned`)
      // `attempts` holds only earlier finished attempts (archived by `critic` when it reassigns a
      // unit); the new owner must be fresh and the wave later than every archived one.
      const earlier = u.attempts ?? []
      if (earlier.some(a => a.agent_id === h.id)) throw new Error(`${h.id}: already attempted ${prefix.slice(0, 60)}; use a fresh hunter id`)
      if (earlier.some(a => a.wave >= wave)) throw new Error(`${h.id}: wave ${wave} is not after an earlier attempt of ${prefix.slice(0, 60)}`)
      return Object.assign(u, { status: 'in_progress', wave, agent_id: h.id, attempts: earlier, unresolved: [] })
    })
  }
  if (h.prior) {
    const priorLedger = readJson(path.join(plan.prior_run ?? meta.prior_runs.at(-1), 'coverage-ledger.json'))
    return h.prior.map(prefix => {
      const u = priorLedger.find(x => x.coverage_id === prefix || x.surface.startsWith(prefix))
      if (!u) throw new Error(`${h.id}: no prior unit ${prefix}`)
      return { ...u, ...blank, prior_status: `prior_${u.status}`, agent_id: h.id }
    })
  }
  return h.classes.map(c => {
    const [code, ...rest] = c.split(':')
    const name = rest.join(':')
    const file = COMPANIONS[code]
    if (!file) throw new Error(`${h.id}: class code ${code} is not one of ${Object.keys(COMPANIONS)}`)
    const ordinary = code === 'O'
    const ref = `${file}#${name}`
    blockOrSection(file, name)
    const refs = { surface: `${h.boundary.split('#')[0]}#${h.surface}`, boundary: h.boundary, subsystem: h.subsystem, attack_class: ref }
    return {
      coverage_id: coverageId(refs),
      canonical_refs: refs,
      surface: h.surface,
      boundary: h.boundary,
      subsystem: h.subsystem,
      attack_class: name,
      starting_paths: h.paths,
      ordinary_attack_class_block: ordinary ? ref : null,
      selected_companion_blocks: ordinary ? [] : [ref, ...COMPANION_SECTIONS.map(s => `${file}#${s}`)],
      excluded_blocks: plan.excluded ?? [],
      prior_status: 'new',
      ...blank,
      agent_id: h.id,
    }
  })
}

/**
 * `hunters <plan.json>`: one brief per hunter and the ledger units they own. A plan is
 * { wave, excluded, notes, maps, hunters: [{ id, subsystem, surface, boundary, paths, classes }
 * | { id, prior: [surface prefix…] } | { id, units: [coverage id…] }] }.
 */
function cmdHunters(args) {
  const run = runDir(args)
  if (!args._[0]) {
    throw new Error(`usage: hunters <plan.json> [--over-budget]; the plan is usually ${path.join(run, 'plan.json')} (\`plan-next\` writes it for a later wave)`)
  }
  refuseLeftovers(run, 'hunters', [P(run).ledger])
  const meta = readJson(P(run).meta)
  const plan = readJson(path.resolve(args._[0]))
  const wave = plan.wave ?? 1
  const ledger = exists(P(run).ledger) ? readJson(P(run).ledger) : []
  if (wave === 1 && ledger.length) throw new Error('wave 1 already has a ledger; use wave 2+')
  const spent = agentCalls(run)
  const plannedHunters = spent.hunters + plan.hunters.length
  if (plannedHunters > meta.budget_plan.hunters && !args['over-budget']) {
    throw new Error(`${plannedHunters} hunters exceeds the allowance of ${meta.budget_plan.hunters}; narrow the plan or pass --over-budget with the owner's agreement`)
  }
  const diff = exists(path.join(run, 'scope-diff.json')) ? readJson(path.join(run, 'scope-diff.json')).files : null
  const h1 = hunting()
  const method = fence(h1, '#### Core hunting method')
  const promotion = fence(h1, '#### Promotion procedure')
  const gate = fence(h1, '#### Core validation rules')
  const contract = h1.slice(h1.indexOf('## Structured hunter result'), h1.indexOf('## Parent consolidation'))
  const architecture = fs.readFileSync(path.join(run, plan.architecture ?? 'architecture.md'), 'utf8')
  const host = meta.target
  const ids = new Set(ledger.map(u => u.coverage_id))
  const out = []
  for (const h of plan.hunters) {
    const own = unitsFor(h, plan, ledger, wave, meta)
    for (const u of own) {
      if (h.units) continue
      if (ids.has(u.coverage_id)) throw new Error(`${h.id}: duplicate unit ${u.coverage_id.slice(0, 80)}`)
      ids.add(u.coverage_id)
      ledger.push(u)
    }
    const paths = [...new Set(own.flatMap(u => u.starting_paths))]
    for (const p of paths) if (!exists(path.join(host, p))) console.log('MISSING PATH', h.id, p)
    if (diff && !h.prior && !h.units && !paths.some(p => diff.some(f => f === p || f.startsWith(`${p.replace(/\/$/, '')}/`)))) {
      console.log('OUTSIDE DIFF', h.id, '(no starting path touches a changed file)')
    }
    const dir = makeAgentDir(run, h.id)
    const peers = plan.hunters.filter(o => o.id !== h.id).map(o => `- ${o.id}: ${o.surface ?? (o.prior ?? o.units).join('; ').slice(0, 160)}`).join('\n')
    const first = own[0]
    writeFile(
      path.join(dir, 'prompt.md'),
      `Your goal is to find source-grounded security invariant failures in your assigned units of the user's own repository, as part of a defensive audit the owner requested. You must return exactly one JSON object matching the structured-result contract at the end of this prompt.

# Architecture

${architecture}

# Your assignment

Agent ID: ${h.id}
Subsystem: ${first.subsystem}
Surface: ${[...new Set(own.map(u => u.surface))].join('; ')}
Boundary: ${first.boundary}
Starting paths are repository-relative under ${host}; follow the code wherever your units lead.
${(plan.maps ?? []).length ? `Attack-surface maps (facts only, and they may be wrong): ${plan.maps.map(m => path.join(run, m)).join(', ')}.\n` : ''}${plan.notes ? `${plan.notes}\n` : ''}
Assigned coverage IDs (return each exactly once):
${own.map(u => `- ${u.coverage_id}\n  attack class: ${u.attack_class}${u.critic_reason ? `\n  why a critic asked for it: ${u.critic_reason}` : ''}`).join('\n')}

Starting paths:
${paths.map(p => `- ${p}`).join('\n')}

# Selected attack-class blocks (verbatim)

${unitBlocks(own).join('\n\n')}

# Excluded blocks

${(plan.excluded ?? []).map(e => `- ${e.block}: ${e.reason}`).join('\n') || '- none'}

# Method

${method}

${promotion}

${gate}

# Peers (do not duplicate; report anything of theirs you stumble on under \`uncovered\`)

${peers || '- none'}

${rulesFor(run, h.id, `Do not read any path under ${path.dirname(run)} other than this run's architecture and maps and your own directory.`)}

${contract}

Report-schema branches (verbatim):

${schemaText()}

Return only the JSON object.
`
    )
    out.push(`${h.id}:${own.length}u`)
  }
  ledger.sort(byString('coverage_id'))
  if (exists(P(run).ledger)) keepBefore(P(run).ledger, `wave${wave}-assign`)
  const next = stage(run, 'hunters', P(run).ledger, ledger)
  install(run, 'hunters', [['validate-coverage-ledger.cjs', next]])
  console.log(`wave ${wave}: ${plan.hunters.length} hunters, ${ledger.length} units`)
  console.log(out.join(' '))
}

// ---------------------------------------------------------------------------------------------
// Collection

const SHAPES = {
  hunter: { key: 'units', file: 'result.json', ok: v => v && Array.isArray(v.units) && Array.isArray(v.candidates) },
  verifier: { key: 'decision', file: 'verdict.json', ok: v => v && typeof v.decision === 'string' && v.record && typeof v.record.fingerprint === 'string' },
  critic: { key: 'missing_units', file: 'result.json', ok: v => v && Array.isArray(v.missing_units) && Array.isArray(v.reassign_ids) },
  reviewer: { key: 'results', file: 'result.json', ok: v => v && Array.isArray(v.results) },
}
const kindOf = id => (id.startsWith('recon') ? null : { h: 'hunter', v: 'verifier', c: 'critic', r: 'reviewer' }[id[0]])

/**
 * `collect [--map <id→transcript.json>]`: each agent's final JSON into its result file (never
 * overwritten), then proofs and logs promoted. Sources, first found: an existing result, the
 * transcript named in the map, the agent's own scratch/result.json.
 */
function cmdCollect(args) {
  const run = runDir(args)
  const map = args.map ? readJson(path.resolve(args.map)) : {}
  const blocked = exists(P(run).blocked) ? readJson(P(run).blocked) : {}
  const rows = []
  for (const id of agentIds(run)) {
    const kind = kindOf(id)
    if (!kind || !exists(path.join(agentDir(run, id), 'prompt.md'))) continue
    const shape = SHAPES[kind]
    const target = path.join(agentDir(run, id), shape.file)
    let state = 'waiting'
    if (blocked[id]) state = 'BLOCKED'
    else if (exists(target)) state = 'collected-earlier'
    else {
      for (const source of [map[id], path.join(agentDir(run, id), 'scratch', 'result.json')]) {
        if (!source || !exists(source)) continue
        const found = extractResult(source, shape.key, shape.ok)
        if (found) {
          writeJsonNew(target, found)
          state = 'collected'
          break
        }
        state = 'no-json'
      }
    }
    rows.push({ id, kind, state, promoted: promoteArtifacts(agentDir(run, id)) })
  }
  console.table(rows)
  console.log(countBy(rows, 'state'))
}

/** `block <agent-id> <reason…>`: an agent a model safeguard stopped. Never retried or reworded. */
function cmdBlock(args) {
  const run = runDir(args)
  const [id, ...why] = args._
  const blocked = exists(P(run).blocked) ? readJson(P(run).blocked) : {}
  const fingerprint = exists(P(run).consolidated)
    ? readJson(P(run).consolidated).find(c => c.verifier === id)?.fingerprint ?? null
    : null
  blocked[id] = { fingerprint, state: 'verification_blocked', reason: why.join(' ') || 'Stopped by a model safeguard. Not retried, reworded or reassigned.' }
  writeJson(P(run).blocked, blocked)
  console.log('blocked', id, fingerprint ?? '')
}

// ---------------------------------------------------------------------------------------------
// ingest

/**
 * `ingest`: every hunter result for the in-progress units into the ledger (upstream HUNTING.md).
 * A fingerprint with `#` is renamed with `:` everywhere it appears. Exits 1 unless the ledger
 * was installed.
 */
function cmdIngest(args) {
  const run = runDir(args)
  refuseLeftovers(run, 'ingest', [P(run).ledger])
  const ledger = readJson(P(run).ledger)
  const byId = new Map(ledger.map(u => [u.coverage_id, u]))
  const problems = []
  const raw = { candidates: [], hardening: [], uncovered: [] }
  for (const id of agentIds(run)) {
    if (kindOf(id) !== 'hunter') continue
    const file = path.join(agentDir(run, id), 'result.json')
    if (!exists(file)) continue
    const { result, renamed } = normaliseFingerprints(readJson(file))
    for (const [from, to] of renamed) console.log('RENAMED', id, from, '→', to)
    for (const c of result.candidates) {
      if (!FINGERPRINT.test(c.fingerprint)) problems.push(`${id}: fingerprint ${c.fingerprint} does not match ${FINGERPRINT}`)
    }
    for (const c of result.candidates) raw.candidates.push({ agent: id, ...c })
    for (const h of result.hardening ?? []) raw.hardening.push({ agent: id, note: h })
    for (const u of result.uncovered ?? []) raw.uncovered.push({ agent: id, ...u })
    result.units.forEach((r, index) => {
      const unit = byId.get(r.coverage_id)
      if (!unit) return problems.push(`${id}: unknown unit ${r.coverage_id.slice(0, 60)}`)
      if (unit.agent_id !== id) return problems.push(`${id}: not the owner of ${r.coverage_id.slice(0, 60)}`)
      if (unit.status !== 'in_progress') return
      for (const check of r.checks) {
        if (check.method === 'local' && (!check.artifact || !exists(path.join(run, check.artifact)))) {
          problems.push(`${id}: local check cites missing artifact ${check.artifact}`)
        }
      }
      unit.status = r.disposition
      // A path no check names is kept aside, not counted as reviewed.
      const owned = new Set(r.checks.flatMap(c => c.reviewed_paths))
      unit.reviewed_paths = r.reviewed_paths.filter(p => owned.has(p))
      const unattributed = r.reviewed_paths.filter(p => !owned.has(p))
      if (unattributed.length) unit.unattributed_reviewed_paths = unattributed
      unit.local_checks = r.checks
      unit.result_fingerprints = r.candidate_fingerprints
      unit.unresolved = r.unresolved
      if (index === 0 && result.hardening?.length) unit.hardening_notes = result.hardening
    })
  }
  for (const u of ledger) if (u.status === 'in_progress') problems.push(`no result yet for ${u.agent_id} ${u.coverage_id.slice(0, 60)}`)
  keepBefore(P(run).ledger, 'ingest')
  const next = stage(run, 'ingest', P(run).ledger, ledger)
  for (const [k, v] of Object.entries(raw)) writeJson(path.join(run, `${k}.raw.json`), v)
  for (const p of problems) console.log('PROBLEM', p)
  if (problems.length) {
    console.log(`ledger NOT installed (${problems.length} problems above); ${path.basename(next)} is left for inspection, and no later step runs until \`ingest\` installs`)
    process.exitCode = 1
  } else install(run, 'ingest', [['validate-coverage-ledger.cjs', next]])
  console.log('status', countBy(ledger, 'status'), 'candidates', raw.candidates.length)
  for (const c of raw.candidates) console.log(`${c.agent.padEnd(22)} ${c.proposed_verdict === 'confirmed' ? 'C ' : 'NV'} ${c.fingerprint}`)
}

// ---------------------------------------------------------------------------------------------
// consolidate → verifier briefs and the post-wave critic brief

/**
 * `consolidate`: merges candidates by root cause using the parent's decisions.json —
 * { carried: { raw: priorFp }, aliases: { raw: currentFp }, merges: { canonical: [raw…] },
 *   leads: [candidate…] } — then writes one verifier brief per unique candidate (vNN, in
 * fingerprint order) and the post-wave critic brief. Carried and aliased reports are recorded as
 * independent rediscoveries and get no verifier.
 */
function cmdConsolidate(args) {
  const run = runDir(args)
  refuseLeftovers(run, 'consolidate', [P(run).ledger])
  const meta = readJson(P(run).meta)
  const decisions = exists(P(run).decisions) ? readJson(P(run).decisions) : {}
  const carried = decisions.carried ?? {}
  const aliases = decisions.aliases ?? {}
  const merges = decisions.merges ?? {}
  const raw = readJson(path.join(run, 'candidates.raw.json'))
  const ledger = readJson(P(run).ledger)
  const done = exists(P(run).consolidated) ? readJson(P(run).consolidated) : []
  const doneFps = new Set(done.flatMap(c => c.raw_fingerprints))
  const aliasOf = new Map()
  for (const [canonical, fps] of Object.entries(merges)) for (const f of fps) aliasOf.set(f, canonical)
  const rediscoveries = {}
  const groups = new Map()
  for (const c of [...raw, ...(decisions.leads ?? []).map(l => ({ agent: 'parent-scan', ...l }))]) {
    const to = carried[c.fingerprint] ?? aliases[c.fingerprint]
    if (to) {
      ;(rediscoveries[to] ??= []).push({ by: c.agent, raw_fingerprint: c.fingerprint })
      continue
    }
    if (doneFps.has(c.fingerprint)) continue
    const key = aliasOf.get(c.fingerprint) ?? c.fingerprint
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(c)
  }
  const strip = ({ agent, ...rest }) => rest
  let n = done.length
  const added = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([fingerprint, reports]) => {
      const order = merges[fingerprint] ?? [fingerprint]
      reports.sort((a, b) => order.indexOf(a.fingerprint) - order.indexOf(b.fingerprint))
      const [primary, ...others] = reports
      const fps = new Set(reports.map(r => r.fingerprint))
      const units = ledger
        .filter(u => u.result_fingerprints.some(f => fps.has(f)))
        .map(u => ({ coverage_id: u.coverage_id, attack_class: u.attack_class, companions: [...new Set(u.selected_companion_blocks.map(b => b.split('#')[0]))], checks: u.local_checks }))
      n++
      return { verifier: `v${String(n).padStart(2, '0')}`, fingerprint, reported_by: reports.map(r => r.agent), raw_fingerprints: [...fps], primary, others, units }
    })
  const all = [...done, ...added]
  writeJson(P(run).consolidated, all)
  writeJson(P(run).rediscoveries, rediscoveries)

  const v = readUpstream('VALIDATION-AND-REPORTING.md')
  const verifierPrompt = fence(v, '#### Candidate-verifier prompt')
  const promotion = fence(v, 'Copy this promotion procedure verbatim')
  const gate = fence(hunting(), '#### Core validation rules')
  const architecture = fs.readFileSync(path.join(run, 'architecture.md'), 'utf8')
  for (const c of added) {
    const dir = makeAgentDir(run, c.verifier)
    const companions = [...new Set(c.units.flatMap(u => u.companions))].filter(f => f !== COMPANIONS.O)
    const rules = companions.map(f => `### ${f}\n\n${mdSection(readUpstream(f), 'Validation rules')}`).join('\n\n')
    writeFile(
      path.join(dir, 'prompt.md'),
      `${verifierPrompt}

${promotion}

${gate}

# Architecture facts

${architecture}

# The candidate

Keep this exact fingerprint in your record unless you find a genuinely different root cause: ${c.fingerprint}

Primary report (a hunter's words, which may be wrong; treat every statement as a claim to check):

${JSON.stringify(strip(c.primary), null, 1)}
${c.others.length ? `\nOther hunters reported the same root cause independently. Their proposed verdicts may differ; settle it from evidence:\n\n${JSON.stringify(c.others.map(strip), null, 1)}\n` : ''}
# Linked coverage-unit checks and artifact paths (relative to ${run})

${JSON.stringify(c.units, null, 1)}

# Companion validation rules

${rules || '(no companion selected for this candidate)'}

${rulesFor(run, c.verifier, `Your ID is ${c.verifier}. Do not reuse a hunter's conclusion: write or copy a proof into your own poc/ directory and run it yourself. "confirmed" requires a proof you ran on untouched source. Reject the candidate if it crosses no boundary in the threat model.${meta.profile === 'quick' ? ' This is a quick run: you are also the final record verifier, so check every cited path and line before you return.' : ''}`)}

Report-schema (verbatim; your record must match the branch for your decision, with additionalProperties false):

${schemaText()}

Return exactly one JSON object and no surrounding prose: {"decision": "confirmed|needs_validation|rejected", "record": { ... }}
`
    )
  }
  writeCriticBrief(run, args.critic ?? `c-wave${Math.max(...ledger.map(u => u.wave))}`, all)
  console.log(`${added.length} new verifier briefs (${all.length} total); ${Object.keys(rediscoveries).length} rediscovered records`)
  for (const c of added) console.log(c.verifier, c.fingerprint, c.reported_by.join(','))
}

function writeCriticBrief(run, id, consolidated) {
  const meta = readJson(P(run).meta)
  const ledger = readJson(P(run).ledger)
  makeAgentDir(run, id)
  const scope = meta.scope?.diff ? `This run is scoped to the diff ${meta.scope.diff} (${meta.scope_paths.length} files, listed in ${path.join(run, 'scope-diff.json')}); propose units only for changed code or what it now reaches.` : meta.scope_paths.length ? `This run is scoped to: ${meta.scope_paths.join(', ')}.` : 'This run covers the whole target.'
  writeFile(
    path.join(agentDir(run, id), 'prompt.md'),
    `You are a coverage critic for a defensive security audit of the owner's repository checkout at ${meta.target}. Read source to check coverage. You do not write files except your result, run nothing and propose no findings.

Read: ${run}/architecture.md, ${P(run).ledger} (${ledger.length} units, each with its assignment blocks, reviewed paths and checks), ${run}/uncovered.raw.json (items hunters flagged outside their own units; many belong to a unit that did cover them), and docs/THREAT-MODEL.md in the target. Ignore .claude/worktrees and .claude/skills/rf-security. Never read .dev.vars, .provision.env or ~/.rocketflare/config.json. Never delete, move or truncate anything.

Current candidate fingerprints (unverified):
${consolidated.map(c => `- ${c.fingerprint}: ${c.primary.proposed_verdict}`).join('\n') || '- none'}

${scope}${meta.prior_runs.length ? ` Prior ledgers: ${meta.prior_runs.map(r => path.join(r, 'coverage-ledger.json')).join(', ')}; do not ask for re-coverage of a unit a prior run closed unless the source it reaches changed.` : ''}

Check for: unmapped entry points, unchecked parallel paths, missing lifecycle modes, selected companion classes without a unit, unjustified exclusions, and units closed without enough paths or checks. Compare the ledger with the real route mounts in apps/web/src/api/index.ts and the handlers in apps/web/src/worker.ts. Propose coverage, not findings.

Write your result to ${agentDir(run, id)}/scratch/result.json and return exactly this JSON and nothing else:
{"missing_units":[{"surface":"...","boundary":"...","subsystem":"...","attack_class":"FILE.md#Block name","starting_paths":["repo/relative/path"],"selected_companion_blocks":["FILE.md#section"],"excluded_blocks":[{"block":"FILE.md#section","reason":"..."}],"reason":"source-backed coverage gap"}],"reassign_ids":["existing-id-that-did-not-close"],"resolved_prior_leads":[],"stop":false}
"stop" is true only when you accept no missing_units and no reassign_ids.
`
  )
  console.log('critic brief', id)
}

// ---------------------------------------------------------------------------------------------
// critic

/**
 * Moves a unit's finished attempt into `attempts` (upstream: an archived attempt keeps its owner,
 * evidence and the reason it was reassigned) and clears the unit for a fresh owner.
 */
function archiveAttempt(u, reason) {
  if (!['covered', 'candidate', 'blocked'].includes(u.status)) return false
  const unattributed = u.unattributed_reviewed_paths
  const attempt = {
    wave: u.wave,
    status: u.status,
    agent_id: u.agent_id,
    reviewed_paths: u.reviewed_paths,
    local_checks: u.local_checks,
    result_fingerprints: u.result_fingerprints,
    unresolved: u.unresolved,
    reassignment_reason: reason,
    ...(unattributed ? { unattributed_reviewed_paths: unattributed } : {}),
  }
  delete u.unattributed_reviewed_paths
  Object.assign(u, {
    attempts: [...(u.attempts ?? []), attempt],
    agent_id: null,
    reviewed_paths: [],
    local_checks: [],
    result_fingerprints: [],
    unresolved: [],
  })
  return true
}

/**
 * `critic <id> [--defer]`: a critic's accepted units into the ledger. Quick runs and `--defer`
 * (the final critic, or no budget left) record them `deferred`, with the reason in `unresolved`;
 * otherwise they are `planned` for the next wave (upstream: a planned unit has no `unresolved`, so
 * the critic's reason is kept in `critic_reason`). A reassigned unit's attempt is archived in
 * `attempts` and the unit goes back to `planned` (or `deferred`) for a fresh owner.
 */
function cmdCritic(args) {
  const run = runDir(args)
  const id = args._[0]
  if (!id) throw new Error('usage: critic <critic-id> [--defer] [--reason r]')
  refuseLeftovers(run, 'critic', [P(run).ledger])
  const meta = readJson(P(run).meta)
  const result = readJson(path.join(agentDir(run, id), 'result.json'))
  const ledger = readJson(P(run).ledger)
  const defer = args.defer || meta.profile === 'quick'
  const reason = args.reason ?? 'budget_cannot_reserve_critics_and_validation'
  const ids = new Set(ledger.map(u => u.coverage_id))
  const wave = Math.max(...ledger.map(u => u.wave)) + 1
  let added = 0
  for (const m of result.missing_units) {
    const refs = { surface: `${m.starting_paths[0]}#${m.surface}`, boundary: m.boundary, subsystem: m.subsystem, attack_class: m.attack_class }
    const cid = coverageId(refs)
    if (ids.has(cid)) continue
    ids.add(cid)
    added++
    ledger.push({
      coverage_id: cid,
      canonical_refs: refs,
      surface: m.surface,
      boundary: m.boundary,
      subsystem: m.subsystem,
      attack_class: m.attack_class.split('#')[1],
      starting_paths: m.starting_paths,
      ordinary_attack_class_block: m.attack_class.startsWith(`${COMPANIONS.O}#`) ? m.attack_class : null,
      selected_companion_blocks: m.selected_companion_blocks,
      excluded_blocks: m.excluded_blocks,
      prior_status: 'none',
      attempts: [],
      wave: defer ? Math.max(1, wave - 1) : wave,
      status: defer ? 'deferred' : 'planned',
      agent_id: null,
      reviewed_paths: [],
      local_checks: [],
      result_fingerprints: [],
      unresolved: defer ? [`${reason}: ${m.reason}`] : [],
      ...(defer ? {} : { critic_reason: m.reason }),
    })
  }
  let reassigned = 0
  for (const rid of result.reassign_ids) {
    const u = ledger.find(x => x.coverage_id === rid)
    if (!u || u.status === 'candidate') continue
    if (!archiveAttempt(u, `${id}: did not close`)) {
      console.log('NOT REASSIGNED', rid.slice(0, 80), `(status ${u.status}: only a finished unit can be reassigned)`)
      continue
    }
    u.wave = wave
    u.status = defer ? 'deferred' : 'planned'
    if (defer) u.unresolved = [`${id}: did not close; ${reason}`]
    else u.critic_reason = `${id}: did not close`
    reassigned++
  }
  ledger.sort(byString('coverage_id'))
  keepBefore(P(run).ledger, id)
  const next = stage(run, 'critic', P(run).ledger, ledger)
  const ok = install(run, 'critic', [['validate-coverage-ledger.cjs', next]])
  console.log(`${id}: added ${added}, reassigned ${reassigned}, stop=${result.stop}`, countBy(ledger, 'status'))
  if (ok && !defer && (added || reassigned)) console.log('planned units for the next wave: `plan-next` writes plan.json (one hunter per unit), then `hunters plan.json`')
}

/** `defer --reason <r>`: every planned unit to deferred (no budget for another wave). */
function cmdDefer(args) {
  const run = runDir(args)
  refuseLeftovers(run, 'defer', [P(run).ledger])
  const ledger = readJson(P(run).ledger)
  const reason = args.reason ?? 'budget_cannot_reserve_critics_and_validation'
  let n = 0
  for (const u of ledger) {
    if (u.status !== 'planned') continue
    u.status = 'deferred'
    u.unresolved = [...u.unresolved, u.critic_reason ? `${reason}: ${u.critic_reason}` : reason]
    n++
  }
  keepBefore(P(run).ledger, 'defer')
  const next = stage(run, 'defer', P(run).ledger, ledger)
  install(run, 'defer', [['validate-coverage-ledger.cjs', next]])
  console.log('deferred', n)
}

/** A short hunter-id slug from a unit's surface: "Pending invitations after …" → pending-invitations. */
export function slug(text, max = 24) {
  const words = String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  let out = ''
  for (const w of words) {
    const next = out ? `${out}-${w}` : w
    if (next.length > max) break
    out = next
  }
  return out || words[0]?.slice(0, max) || 'unit'
}

/**
 * `plan-next`: the next wave's plan.json, one hunter per planned unit (`{ id, units: [coverage
 * id] }`, ids numbered after every hunter so far). The previous plan.json is kept first as
 * plan-wave<N>.json. Edit the plan to group units before `hunters plan.json` if you want fewer.
 */
function cmdPlanNext(args) {
  const run = runDir(args)
  refuseLeftovers(run, 'plan-next', [P(run).ledger])
  const ledger = readJson(P(run).ledger)
  const planned = ledger.filter(u => u.status === 'planned')
  if (!planned.length) throw new Error('no planned units in the ledger: nothing for another wave (`status` shows the ledger)')
  const planFile = path.join(run, 'plan.json')
  const prev = exists(planFile) ? readJson(planFile) : null
  if (prev) {
    const kept = path.join(run, `plan-wave${prev.wave ?? 1}.json`)
    if (!exists(kept)) fs.copyFileSync(planFile, kept, fs.constants.COPYFILE_EXCL)
    else if (fs.readFileSync(kept, 'utf8') !== fs.readFileSync(planFile, 'utf8')) {
      throw new Error(`${path.basename(kept)} exists and differs from plan.json: plan.json is not wave ${prev.wave ?? 1}'s plan; keep it under another name first`)
    }
    console.log('kept', path.basename(kept))
  }
  const done = ledger.filter(u => u.status !== 'planned').map(u => u.wave)
  const wave = Math.max(...planned.map(u => u.wave), done.length ? Math.max(...done) + 1 : 1, (prev?.wave ?? 0) + 1)
  const used = [...agentIds(run), ...ledger.flatMap(u => [u.agent_id, ...(u.attempts ?? []).map(a => a.agent_id)])]
  let n = Math.max(0, ...used.map(id => Number(/^h(\d+)/.exec(id ?? '')?.[1] ?? 0)))
  const hunters = planned.map(u => {
    n++
    return { id: `h${String(n).padStart(2, '0')}-${slug(u.surface)}`, units: [u.coverage_id] }
  })
  for (const h of hunters) if (!ID.test(h.id)) throw new Error(`bad hunter id ${h.id}`)
  const plan = {
    wave,
    notes: `Wave ${wave}: the ledger's planned units, one hunter each.`,
    ...(prev?.architecture ? { architecture: prev.architecture } : {}),
    ...(prev?.maps ? { maps: prev.maps } : {}),
    hunters,
  }
  writeJson(planFile, plan)
  const meta = readJson(P(run).meta)
  const left = meta.budget_plan.hunters - agentCalls(run).hunters
  console.log(`wave ${wave}: ${hunters.length} hunters in plan.json (${left} hunters left in the allowance)`)
  for (const h of hunters) console.log(' ', h.id)
  if (hunters.length > left) console.log(`OVER the hunter allowance: group units in plan.json, \`defer\` some, or agree --over-budget with the owner`)
  console.log(`next: \`hunters ${planFile}\``)
}

/** `discard-next [file…]`: sets a leftover `.next.json` aside as `.discarded-N.json` (never deleted). */
function cmdDiscardNext(args) {
  const run = runDir(args)
  const names = args._.length ? args._ : leftovers(run).map(l => l.file)
  if (!names.length) {
    console.log('no leftover .next.json files')
    return
  }
  const pending = pendingOf(run)
  for (const name of names) {
    const file = path.join(run, path.basename(name.endsWith('.next.json') ? name : nextOf(name)))
    if (!exists(file)) throw new Error(`no ${path.basename(file)} in the run directory`)
    let k = 1
    const to = () => file.replace(/\.next\.json$/, `.discarded-${k}.json`)
    while (exists(to())) k++
    fs.renameSync(file, to())
    delete pending[path.basename(file)]
    console.log('set aside', path.basename(file), '→', path.basename(to()))
  }
  writeJson(pendingPath(run), pending)
}

/** `status`: one screen — phase and next step, units, agents, leftovers, budget. */
function cmdStatus(args) {
  const run = runDir(args)
  const meta = readJson(P(run).meta)
  const ledger = exists(P(run).ledger) ? readJson(P(run).ledger) : null
  const blocked = exists(P(run).blocked) ? readJson(P(run).blocked) : {}
  const rows = {}
  const waiting = []
  for (const id of agentIds(run)) {
    const kind = id.startsWith('recon') ? 'reconnaissance' : kindOf(id) ?? 'other'
    const dir = agentDir(run, id)
    const done =
      kind === 'reconnaissance'
        ? reconDone(dir)
        : exists(path.join(dir, SHAPES[kind]?.file ?? 'result.json'))
    const state = blocked[id] ? 'blocked' : done ? 'done' : 'waiting'
    if (!rows[kind]) rows[kind] = { done: 0, waiting: 0, blocked: 0 }
    rows[kind][state]++
    if (state === 'waiting') waiting.push(id)
  }
  const left = leftovers(run)
  const reverify = exists(reverifyPath(run)) ? readJson(reverifyPath(run)) : {}
  const units = ledger ? countBy(ledger, 'status') : {}
  const wave = ledger?.length ? Math.max(...ledger.filter(u => u.status !== 'planned').map(u => u.wave), 0) : 0
  const has = f => exists(path.join(run, f))
  let phase
  let next
  if (meta.finished) [phase, next] = ['finished', 'nothing: the audit is no longer active']
  else if (left.length) [phase, next] = ['stopped on a step that did not install', `fix it and rerun \`${left[0].by ?? 'the step that wrote it'}\` (or \`discard-next\`)`]
  else if (!ledger) [phase, next] = ['reconnaissance and planning', 'write plan.json, then `hunters plan.json`']
  else if (units.in_progress) [phase, next] = [`hunting wave ${wave}`, 'wait for the hunters, `collect`, `ingest`']
  else if (waiting.some(id => kindOf(id) === 'verifier')) [phase, next] = ['verifying', 'wait for the verifiers, `collect`']
  else if (waiting.some(id => kindOf(id) === 'critic')) [phase, next] = ['critique', 'wait for the critic, `collect`, `critic <id>`']
  else if (units.planned) [phase, next] = ['between waves', '`plan-next` (or `defer` when the budget is spent)']
  else if (!has('findings.json')) [phase, next] = ['before findings', '`consolidate` if new candidates are unverified, else `findings`']
  else if (waiting.some(id => kindOf(id) === 'reviewer')) [phase, next] = ['Phase 5 review', 'wait for the reviewers, `collect`, `apply-review`']
  else if (Object.values(reverify).some(e => !e.installed)) {
    const id = Object.entries(reverify).find(([, e]) => !e.installed)[0]
    ;[phase, next] = ['re-verifying a material review', `\`collect\`, then \`apply-reverify ${id}\``]
  } else if (!has('REPORT.md')) [phase, next] = ['findings', '`cite --all`, `review`/`apply-review`, then `report`']
  else [phase, next] = ['reported', '`finish`']
  const spent = agentCalls(run)
  console.log(`${meta.run_id} (${meta.profile}) ${run}`)
  console.log(`phase: ${phase}\nnext:  ${next}`)
  console.log(`units: ${ledger ? `${ledger.length} ${JSON.stringify(units)}` : 'no ledger yet'}`)
  for (const [kind, r] of Object.entries(rows)) console.log(`agents ${kind}: ${r.done} done, ${r.waiting} waiting${r.blocked ? `, ${r.blocked} blocked` : ''}`)
  if (waiting.length) console.log(`waiting: ${waiting.join(' ')}`)
  for (const l of left) console.log(`LEFTOVER ${l.file} (from ${l.by ? `\`${l.by}\`` : 'an unknown step'})`)
  console.log(`budget: ${spent.total} of ${meta.budget} calls spent (${Object.entries(spent).filter(([k, v]) => k !== 'total' && v).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}); hunters ${spent.hunters} of ${meta.budget_plan.hunters}`)
}

// ---------------------------------------------------------------------------------------------
// findings (Phase 4)

/** Shape fixes the parent applies to a verifier's record; each one is logged. */
function normaliseRecord(record, log) {
  const first = record.trace.findIndex(t => t.kind === 'sink')
  if (first !== -1 && first < record.trace.length - 1) {
    const before = record.trace.map(t => `${t.kind} ${t.file}:${t.line}`)
    if (record.trace.slice(first + 1).some(t => t.kind === 'entrypoint')) record.trace = record.trace.slice(0, first + 1)
    else record.trace = record.trace.map((t, i) => (i < record.trace.length - 1 && t.kind === 'sink' ? { ...t, kind: 'propagation' } : t))
    log({ sink_not_last: { before, after: record.trace.map(t => `${t.kind} ${t.file}:${t.line}`) } })
  }
  const extra = record.trace.filter((t, i) => t.kind === 'entrypoint' && i > 0)
  if (extra.length) {
    record.trace = record.trace.filter(t => !extra.includes(t))
    record.evidence.push(...extra.map(t => ({ file: t.file, line: t.line, description: `Parallel entry to the same path: ${t.description}` })))
    log({ moved_parallel_entrypoints_to_evidence: extra.map(t => `${t.file}:${t.line}`) })
  }
  if (record.severity) {
    const order = ['informational', 'low', 'medium', 'high', 'critical']
    const o = record.severity.overall_severity
    const i = record.severity.impact.score
    if (order.indexOf(o) > order.indexOf(i)) {
      record.severity.overall_severity = i
      log({ severity_capped_at_impact: { from: o, to: i } })
    }
  }
  return record
}

function priorFindings(meta) {
  const map = new Map()
  for (const r of meta.prior_runs) {
    const f = path.join(r, 'findings.json')
    if (exists(f)) for (const rec of readJson(f)) map.set(rec.fingerprint, rec)
  }
  return map
}

/**
 * `findings`: findings.json from every verifier's verdict plus the prior records this run
 * rediscovered (text and fingerprint unchanged), links each verifier's check into the ledger, and
 * installs both only if both validators pass.
 */
function cmdFindings(args) {
  const run = runDir(args)
  refuseLeftovers(run, 'findings', [P(run).ledger, P(run).findings])
  const meta = readJson(P(run).meta)
  const before = keepBefore(P(run).ledger, 'findings')
  const ledger = readJson(before)
  const byId = new Map(ledger.map(u => [u.coverage_id, u]))
  const consolidated = readJson(P(run).consolidated)
  const blocked = exists(P(run).blocked) ? readJson(P(run).blocked) : {}
  const decisions = exists(P(run).decisions) ? readJson(P(run).decisions) : {}
  const rediscoveries = exists(P(run).rediscoveries) ? readJson(P(run).rediscoveries) : {}
  const prior = priorFindings(meta)
  const alias = new Map([...Object.entries(decisions.carried ?? {}), ...Object.entries(decisions.aliases ?? {})])
  const reverify = exists(reverifyPath(run)) ? readJson(reverifyPath(run)) : {}
  const findings = []
  const corrections = []
  const blockedFps = []
  const missing = []
  for (const c of consolidated) {
    for (const r of c.raw_fingerprints) alias.set(r, c.fingerprint)
    if (Object.values(blocked).some(b => b.fingerprint === c.fingerprint) || blocked[c.verifier]) {
      blockedFps.push({ fingerprint: c.fingerprint, units: c.units.map(u => u.coverage_id) })
      continue
    }
    // A fresh verifier installed after a material review (apply-reverify) supersedes the first
    // one: its record stands, and both verifications are recorded on the units.
    const fresh = Object.entries(reverify)
      .filter(([, e]) => e.installed && e.fingerprint === c.fingerprint)
      .sort(([, a], [, b]) => (a.installed < b.installed ? -1 : 1))
      .map(([id]) => id)
    const verifiers = [c.verifier, ...fresh]
    let standing = null
    for (const vid of verifiers) {
      const vfile = path.join(agentDir(run, vid), 'verdict.json')
      if (!exists(vfile)) {
        missing.push(vid)
        continue
      }
      const { decision, record } = readJson(vfile)
      standing = { vid, record }
      const repoPaths = [...new Set([...record.trace, ...record.evidence].map(e => e.file).filter(f => !f.startsWith('agents/')))]
      const artifacts = exists(path.join(agentDir(run, vid), 'artifacts')) ? fs.readdirSync(path.join(agentDir(run, vid), 'artifacts')).sort() : []
      const art = artifacts.find(x => x.endsWith('.log')) ?? artifacts.find(x => x.endsWith('.test.ts'))
      for (const linked of c.units) {
        const u = byId.get(linked.coverage_id)
        if (!u) throw new Error(`unit missing from ledger: ${linked.coverage_id.slice(0, 60)}`)
        if (u.local_checks.some(k => k.agent_id === vid)) continue
        u.local_checks.push({ agent_id: vid, reviewed_paths: repoPaths, invariant: `Independent verification of candidate ${c.fingerprint}.`, method: art ? 'local' : 'source', result: `Decision: ${decision}.`, artifact: art ? `agents/${vid}/artifacts/${art}` : null })
        u.reviewed_paths = [...new Set([...u.reviewed_paths, ...repoPaths])]
      }
    }
    if (standing) findings.push(normaliseRecord(standing.record, x => corrections.push({ verifier: standing.vid, fingerprint: c.fingerprint, ...x })))
  }
  if (missing.length) throw new Error(`no verdict yet: ${missing.join(' ')} (collect, or block a stopped verifier)`)
  const have = new Set(findings.map(f => f.fingerprint))
  const carriedFps = [...new Set(Object.keys(rediscoveries))].filter(f => !have.has(f))
  for (const f of carriedFps) {
    const r = prior.get(f)
    if (!r) throw new Error(`rediscovery ${f} names neither a current nor a prior record`)
    findings.push(r)
  }
  for (const u of ledger) u.result_fingerprints = [...new Set(u.result_fingerprints.map(f => alias.get(f) ?? f))]
  for (const b of blockedFps) {
    for (const id of b.units) {
      const u = byId.get(id)
      const note = `Candidate ${b.fingerprint}: independent verification was stopped by a model safeguard and was not retried. Unverified; no verdict.`
      if (u && !u.unresolved.includes(note)) u.unresolved.push(note)
    }
  }
  const known = new Set(findings.map(f => f.fingerprint))
  const blockedSet = new Set(blockedFps.map(b => b.fingerprint))
  for (const u of ledger) for (const f of u.result_fingerprints) if (!known.has(f) && !blockedSet.has(f)) console.log('UNLINKED', f)
  findings.sort(byString('fingerprint'))
  ledger.sort(byString('coverage_id'))
  writeJson(path.join(run, 'parent-corrections.json'), corrections)
  writeJson(path.join(run, 'carried.json'), { carried: carriedFps, rediscoveries, blocked: blockedFps })
  if (exists(P(run).findings)) keepBefore(P(run).findings, 'findings')
  const nf = stage(run, 'findings', P(run).findings, findings)
  const nl = stage(run, 'findings', P(run).ledger, ledger)
  install(run, 'findings', [['validate-findings.cjs', nf], ['validate-coverage-ledger.cjs', nl]])
  console.log('corrections', corrections.length, 'carried', carriedFps.length, 'blocked', blockedFps.length, countBy(findings, 'verdict'), countBy(findings.filter(f => f.severity), f => f.severity.overall_severity))
}

// ---------------------------------------------------------------------------------------------
// cite · review · apply-review (Phase 5)

const carriedSet = run => new Set(exists(path.join(run, 'carried.json')) ? readJson(path.join(run, 'carried.json')).carried : [])

/**
 * `cite [--all]`: every repository citation of this run's confirmed records beside the source
 * line in the target, so the parent can check each claim by eye; exits 1 on a missing file, line
 * or artifact. `--all` also prints the lines; without it, only problems and counts.
 */
function cmdCite(args) {
  const run = runDir(args)
  refuseLeftovers(run, 'cite', [P(run).findings])
  const meta = readJson(P(run).meta)
  const carried = carriedSet(run)
  const own = readJson(P(run).findings).filter(f => f.verdict === 'confirmed' && !carried.has(f.fingerprint))
  const cache = new Map()
  const lines = f => {
    if (!cache.has(f)) {
      const p = path.join(meta.target, f)
      cache.set(f, exists(p) ? fs.readFileSync(p, 'utf8').split('\n') : null)
    }
    return cache.get(f)
  }
  let bad = 0
  let n = 0
  for (const f of own) {
    if (args.all) console.log(`\n# ${f.severity.overall_severity} ${f.fingerprint}`)
    for (const c of [...f.trace, ...f.evidence]) {
      n++
      if (c.file.startsWith('agents/')) {
        if (!exists(path.join(run, c.file))) {
          bad++
          console.log('  ARTIFACT MISSING', f.fingerprint, c.file)
        }
        continue
      }
      const text = lines(c.file)?.[c.line - 1]
      if (text === undefined) {
        bad++
        console.log('  MISSING', f.fingerprint, c.file, c.line)
        continue
      }
      if (args.all) console.log(`  ${c.file}:${c.line} | ${text.trim().slice(0, 96)} || ${c.description.slice(0, 80)}`)
    }
  }
  console.log(`confirmed ${own.length}, citations ${n}, bad ${bad}`)
  if (bad === 0) {
    meta.parent_citation_check = `${n} citations across the ${own.length} records this run confirmed resolve in ${meta.source_ref.installed_tree?.slice(0, 7) ?? meta.source_ref.kit.slice(0, 7)}; the parent read each against its claim.`
    writeJson(P(run).meta, meta)
  } else process.exitCode = 1
}

/**
 * `review [--groups groups.json]`: Phase 5 briefs. Deep: one reviewer per record. Standard: up to
 * three records per reviewer, grouped by area, a high or critical alone. Quick: none (its
 * verifiers already did the final check).
 */
function cmdReview(args) {
  const run = runDir(args)
  refuseLeftovers(run, 'review', [P(run).findings])
  const meta = readJson(P(run).meta)
  const mode = PROFILES[meta.profile].reviewers
  if (mode === 'none' && !args.groups) {
    console.log('quick run: the verifiers were the final record check; no reviewers')
    return
  }
  const findings = readJson(P(run).findings)
  const carried = carriedSet(run)
  const retained = findings.filter(f => f.verdict !== 'rejected' && !carried.has(f.fingerprint))
  let groups
  if (args.groups) groups = readJson(path.resolve(args.groups))
  else {
    const area = f => (f.trace?.[0]?.file ?? f.evidence?.[0]?.file ?? '').split('/').slice(0, 5).join('/')
    const sorted = [...retained].sort((a, b) => (area(a) < area(b) ? -1 : area(a) > area(b) ? 1 : 0))
    const out = []
    let cur = []
    for (const f of sorted) {
      const alone = mode === 'each' || (f.severity && sevRank[f.severity.overall_severity] <= sevRank.high)
      if (alone) {
        out.push([f.fingerprint])
        continue
      }
      if (cur.length === 3 || (cur.length && area(retained.find(x => x.fingerprint === cur[0])) !== area(f))) {
        out.push(cur)
        cur = []
      }
      cur.push(f.fingerprint)
    }
    if (cur.length) out.push(cur)
    groups = Object.fromEntries(out.map((g, i) => [`r${String(i + 1).padStart(2, '0')}`, g]))
  }
  const byFp = new Map(findings.map(f => [f.fingerprint, f]))
  const grouped = Object.values(groups).flat()
  const missing = retained.filter(f => !grouped.includes(f.fingerprint)).map(f => f.fingerprint)
  if (missing.length) throw new Error(`records with no reviewer: ${missing.join(' ')}`)
  for (const [id, fps] of Object.entries(groups)) {
    const dir = makeAgentDir(run, id)
    const records = fps.map(f => {
      if (!byFp.has(f)) throw new Error(`unknown record ${f}`)
      return byFp.get(f)
    })
    writeJson(path.join(dir, 'records.json'), records)
    writeFile(
      path.join(dir, 'prompt.md'),
      `You are an independent final reviewer in a defensive security audit of the repository owner's own code at ${meta.target}. You did not hunt or verify these candidates. Treat every statement in a record as a claim to check and try to find what is wrong with it.

Your records: ${path.join(dir, 'records.json')} (${records.length}). Paths starting agents/ are relative to ${run}; every other path is repository-relative. Read the relevant docs/CONCEPTS.md section, and the plugin's own CLAUDE.md if the record is about a plugin.

For each record with verdict "confirmed", check:
1. Every repository-relative trace and evidence path, line, scope and described operation.
2. The real entry interface and the exact local input shape.
3. Every condition, parser or policy step, source-visible preventing layer, and the observed local result. Read the cited proof and log under agents/. Re-run a proof when its log does not settle the claim.
4. The affected principal or resource, and the demonstrated impact: is it what the record says, no more?
5. Severity: realistic likelihood, demonstrated impact, overall no greater than impact.
6. The remediation: does the fix enforce the invariant rather than move the trust?

For each record with verdict "needs_validation", check:
1. The source path is real and supports only the claimed_root_cause.
2. Every blocker is decisive and not already answerable locally.
3. It names a boundary and a concrete possible result rather than a generic concern.
4. At least one validation_plan field is present and exact; never a plan that sends audit traffic to a deployment.
5. The fingerprint matches the root cause.

Also say whether a behaviour called undocumented really is absent from the Known gaps in docs/CONCEPTS.md. A record may be replaced with verdict "rejected" if it crosses no boundary in the threat model.

${rulesFor(run, id)}

Return exactly one strict JSON object and no surrounding prose, with one entry per record in the order given:

{"results":[{"decision":"verified","fingerprint":"..."},{"decision":"replace","reason":"...","record":{...}}]}

Use "verified" when the record holds. Use "replace" only when something is wrong, with the complete corrected record. Begin "reason" with "material:" (it changes verdict, root cause, trace, execution input, observed result, demonstrated impact or severity) or "non-material:". A replacement record must match its branch of this schema, with additionalProperties false:

${schemaText()}
`
    )
  }
  console.log(Object.keys(groups).length, 'reviewers;', grouped.length, 'records')
}

/** `apply-review`: reviewer results into findings.json; a material replacement is listed for a decision. */
function cmdApplyReview(args) {
  const run = runDir(args)
  refuseLeftovers(run, 'apply-review', [P(run).findings])
  const before = keepBefore(P(run).findings, 'review')
  const findings = readJson(before)
  const idx = new Map(findings.map((f, i) => [f.fingerprint, i]))
  const applied = []
  const material = []
  const reviewed = new Set()
  for (const id of agentIds(run)) {
    if (kindOf(id) !== 'reviewer') continue
    const file = path.join(agentDir(run, id), 'result.json')
    if (!exists(file)) {
      console.log('NO RESULT', id)
      continue
    }
    const want = readJson(path.join(agentDir(run, id), 'records.json')).map(r => r.fingerprint)
    readJson(file).results.forEach((r, i) => {
      const fp = r.fingerprint ?? r.record?.fingerprint
      if (fp !== want[i]) console.log('ORDER/FP MISMATCH', id, i, fp, want[i])
      if (!idx.has(fp)) return console.log('UNKNOWN RECORD', id, fp)
      reviewed.add(fp)
      if (r.decision === 'replace') {
        const old = findings[idx.get(fp)]
        if (r.record.verdict !== old.verdict) console.log('VERDICT CHANGE', fp, old.verdict, '→', r.record.verdict)
        if (old.severity && r.record.severity?.overall_severity !== old.severity.overall_severity) console.log('SEVERITY CHANGE', fp)
        if (!/^non-material:/.test(r.reason ?? '')) {
          material.push(fp)
          console.log('MATERIAL', fp, `(upstream: a material change needs a fresh verifier; run \`reverify ${fp}\`)`)
        }
        findings[idx.get(fp)] = r.record
      }
      applied.push({ reviewer: id, fingerprint: fp, decision: r.decision, reason: r.reason ?? null })
    })
  }
  const carried = carriedSet(run)
  const missing = findings.filter(f => f.verdict !== 'rejected' && !carried.has(f.fingerprint) && !reviewed.has(f.fingerprint)).map(f => f.fingerprint)
  writeJson(path.join(run, 'review-applied.json'), applied)
  const next = stage(run, 'apply-review', P(run).findings, findings)
  let ok = false
  if (missing.length) {
    console.log('UNREVIEWED', missing.join(' '), '— not installed')
    process.exitCode = 1
  } else ok = install(run, 'apply-review', [['validate-findings.cjs', next]])
  console.log('reviewed', reviewed.size, 'replaced', applied.filter(a => a.decision === 'replace').length)
  if (ok && material.length) {
    console.log(`next: a fresh verifier for each material replacement, one at a time:\n${material.map(fp => `  node ${path.join(TOOLS, 'audit.mjs')} reverify ${fp}`).join('\n')}`)
  }
}

// ---------------------------------------------------------------------------------------------
// reverify · apply-reverify (a fresh verifier after a material review)

const reverifyPath = run => path.join(run, 'reverify.json')
const DECISIONS = ['confirmed', 'needs_validation', 'rejected']

/** The first free id after `base`: v13 → v13b, v13c, … */
function nextSuffixId(run, base) {
  for (const s of 'bcdefghijklmnopqrstuvwxyz') {
    if (!exists(agentDir(run, `${base}${s}`))) return `${base}${s}`
  }
  throw new Error(`no free id after ${base}`)
}

/**
 * `reverify <fingerprint>`: after `apply-review` printed MATERIAL, a brief for a fresh verifier
 * (the original's id plus the next free letter, `v13` → `v13b`): the original verifier's brief
 * with every id and path renamed, and the reviewed record as the candidate.
 */
function cmdReverify(args) {
  const run = runDir(args)
  const fp = args._[0]
  if (!fp) throw new Error('usage: reverify <fingerprint> (apply-review prints it after MATERIAL)')
  refuseLeftovers(run, 'reverify', [P(run).findings])
  const record = readJson(P(run).findings).find(f => f.fingerprint === fp)
  if (!record) throw new Error(`no record ${fp} in findings.json`)
  const c = (exists(P(run).consolidated) ? readJson(P(run).consolidated) : []).find(x => x.fingerprint === fp || x.raw_fingerprints.includes(fp))
  if (!c) throw new Error(`${fp} has no verifier in candidates.consolidated.json (a carried record is not re-verified here)`)
  const applied = exists(path.join(run, 'review-applied.json')) ? readJson(path.join(run, 'review-applied.json')) : []
  const review = applied.filter(a => a.fingerprint === fp && a.decision === 'replace').at(-1)
  if (!review && !args.force) throw new Error(`no reviewer replaced ${fp}; reverify follows a MATERIAL replacement (pass --force to re-verify anyway)`)
  const from = c.verifier
  const brief = fs.readFileSync(path.join(agentDir(run, from), 'prompt.md'), 'utf8')
  const start = brief.indexOf('# The candidate')
  const end = brief.indexOf('# Linked coverage-unit checks')
  if (start === -1 || end < start) throw new Error(`${from}/prompt.md has no candidate section to replace`)
  const id = nextSuffixId(run, from)
  const token = new RegExp(`(?<![A-Za-z0-9_-])${from}(?![A-Za-z0-9_-])`, 'g')
  const rename = text => text.replace(token, id)
  const who = review ? `reviewer ${review.reviewer} then replaced its record (${review.reason ?? 'no reason given'})` : 'the parent asked for a fresh verification'
  const earlier = [from, review?.reviewer].filter(Boolean).map(x => `agents/${x}/`).join(' and ')
  const candidate = `# The candidate

This is a fresh verification after a review. A first verifier (${from}) verified this candidate; ${who}. Verify the reviewed record below from scratch, with proofs you write and run yourself. Earlier proofs under ${earlier} are claims to check, not evidence you may reuse. Decide the verdict and the severity yourself.

Keep this exact fingerprint in your record unless you find a genuinely different root cause: ${fp}

Reviewed record (claims to check):

${JSON.stringify(record, null, 1)}

`
  const dir = makeAgentDir(run, id)
  writeNew(path.join(dir, 'prompt.md'), `${rename(brief.slice(0, start))}${candidate}${rename(brief.slice(end))}`)
  const all = exists(reverifyPath(run)) ? readJson(reverifyPath(run)) : {}
  all[id] = { fingerprint: fp, from, reviewer: review?.reviewer ?? null, written: new Date().toISOString() }
  writeJson(reverifyPath(run), all)
  console.log(`${id}: fresh verifier for ${fp} (from ${from}${review ? `, after ${review.reviewer}` : ''}); brief ${path.join(dir, 'prompt.md')}`)
  console.log(`launch it, \`collect\`, then \`apply-reverify ${id}\``)
}

/**
 * `apply-reverify <id>`: the fresh verifier's record into findings.json in place of the reviewed
 * one. Refused unless its decision is confirmed, needs_validation or rejected, its record has that
 * verdict and the same fingerprint, and it passes the same checks as `check-result`.
 */
function cmdApplyReverify(args) {
  const run = runDir(args)
  const id = args._[0]
  if (!id) throw new Error('usage: apply-reverify <verifier-id>')
  refuseLeftovers(run, 'apply-reverify', [P(run).findings])
  const meta = readJson(P(run).meta)
  const entry = (exists(reverifyPath(run)) ? readJson(reverifyPath(run)) : {})[id]
  if (!entry) throw new Error(`${id} is not a reverify agent (reverify.json)`)
  const file = path.join(agentDir(run, id), 'verdict.json')
  if (!exists(file)) throw new Error(`${id} has no verdict.json yet: \`collect\` first`)
  const { decision, record } = readJson(file)
  const problems = []
  if (!DECISIONS.includes(decision)) problems.push(`decision is ${decision}, not ${DECISIONS.join('/')}`)
  if (record?.verdict !== decision) problems.push(`record verdict ${record?.verdict} differs from decision ${decision}`)
  if (record?.fingerprint !== entry.fingerprint) problems.push(`record fingerprint ${record?.fingerprint} is not ${entry.fingerprint}: a different root cause is the parent's decision, not an install`)
  if (!problems.length) {
    normaliseRecord(record, x => console.log('CORRECTED', id, Object.keys(x)[0]))
    problems.push(...recordProblems(run, meta, record, `${id}:${record.fingerprint}`))
  }
  for (const p of problems) console.log('PROBLEM', p)
  if (problems.length) {
    console.log(`${id}: NOT installed (${problems.length} problems)`)
    process.exitCode = 1
    return
  }
  const before = keepBefore(P(run).findings, `reverify-${id}`)
  const findings = readJson(P(run).findings)
  const i = findings.findIndex(f => f.fingerprint === entry.fingerprint)
  if (i === -1) throw new Error(`${entry.fingerprint} is no longer in findings.json`)
  const old = findings[i]
  findings[i] = record
  const next = stage(run, 'apply-reverify', P(run).findings, findings)
  if (!install(run, 'apply-reverify', [['validate-findings.cjs', next]])) return
  const all = readJson(reverifyPath(run))
  all[id] = { ...entry, decision, installed: new Date().toISOString() }
  writeJson(reverifyPath(run), all)
  const sev = r => r.severity?.overall_severity ?? '-'
  console.log(`${id}: ${decision} installed for ${entry.fingerprint} (was ${old.verdict} ${sev(old)}, now ${record.verdict} ${sev(record)}; previous copy ${path.basename(before)})`)
}

// ---------------------------------------------------------------------------------------------
// report (Phase 6)

const cell = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
const optional = (run, name) => (exists(path.join(run, name)) ? fs.readFileSync(path.join(run, name), 'utf8').trim() : null)

/**
 * `report`: run-metadata's final state, REPORT.md, FINDINGS-DETAIL.md and NEEDS-VALIDATION.md from
 * the final records. Parent prose comes from optional files in the run directory: posture.md,
 * deviations.md, positive-patterns.md. All of it is private.
 */
function cmdReport(args) {
  const run = runDir(args)
  refuseLeftovers(run, 'report', [P(run).ledger, P(run).findings])
  cmdCost({ run })
  const meta = readJson(P(run).meta)
  const findings = readJson(P(run).findings)
  const ledger = readJson(P(run).ledger)
  const carriedInfo = exists(path.join(run, 'carried.json')) ? readJson(path.join(run, 'carried.json')) : { carried: [], blocked: [] }
  const carried = new Set(carriedInfo.carried)
  const conf = findings.filter(f => f.verdict === 'confirmed').sort((a, b) => sevRank[a.severity.overall_severity] - sevRank[b.severity.overall_severity] || (a.fingerprint < b.fingerprint ? -1 : 1))
  const own = conf.filter(f => !carried.has(f.fingerprint))
  const nv = findings.filter(f => f.verdict === 'needs_validation')
  const rej = findings.filter(f => f.verdict === 'rejected')
  const counts = countBy(ledger, 'status')
  const sev = countBy(own, f => f.severity.overall_severity)
  const known = new Set(findings.map(f => f.fingerprint))
  const blocked = new Set(carriedInfo.blocked.map(b => b.fingerprint))
  const open = ledger.filter(u => u.status === 'candidate' && !u.result_fingerprints.some(fp => known.has(fp) || blocked.has(fp)))
  if (open.length) throw new Error(`${open.length} candidate units lack a final record`)
  if (ledger.some(u => ['planned', 'in_progress'].includes(u.status))) throw new Error('planned or in-progress units remain: hunt or defer them first')
  const deferred = ledger.filter(u => u.status === 'deferred')
  const calls = agentCalls(run)
  const scoped = Boolean(meta.scope) || meta.scope_paths.length > 0 || meta.profile === 'quick'
  meta.agent_calls = { planned: meta.budget, spent: calls.total, breakdown: calls }
  if (blocked.size) {
    meta.run_status = 'incomplete'
    meta.incomplete_reason = `No independent final disposition for ${[...blocked].join(', ')}: verification was stopped by a model safeguard and, as required, was not retried, reworded or moved to another model.`
  } else meta.run_status = 'complete'
  meta.coverage_note = `${scoped ? 'Scoped or quick: partial coverage. ' : ''}${deferred.length} units deferred.`
  meta.carried_from_prior = carriedInfo.carried
  writeJson(P(run).meta, meta)
  const dname = u => decodeURIComponent(u.surface ?? u.coverage_id)
  const posture = optional(run, 'posture.md')
  const deviations = optional(run, 'deviations.md')
  const positive = optional(run, 'positive-patterns.md')
  const ref = meta.source_ref
  const report = `# Security audit: ${meta.run_id} (${meta.profile}${scoped ? ', scoped' : ''})

## 1. Run profile and scope

- **Target:** \`${ref.installed_tree ?? ref.kit}\` (kit \`${ref.kit.slice(0, 7)}\`${ref.plugins ? `; ${ref.plugins.map(p => `${p.repo} \`${p.commit.slice(0, 7)}\``).join(', ')}` : ''}). The audit changed no source.
- **Scope:** ${meta.scope?.diff ? `the diff \`${meta.scope.diff}\` (${meta.scope_paths.length} files)` : meta.scope_paths.length ? meta.scope_paths.join(', ') : 'the whole target'}.
- **Execution:** sandboxed source and local only (${meta.sandbox ?? 'sandbox not recorded'}). No deployed environment was contacted.
- **Agent calls:** ${calls.total} of ${meta.budget} (${Object.entries(calls).filter(([k]) => k !== 'total').map(([k, v]) => `${v} ${k}`).join(', ')}).
- **Models:** hunters ${meta.models.hunters}; verifiers, critics and reviewers ${meta.models.verifiers}.
- **Status:** \`${meta.run_status}\`.${meta.incomplete_reason ? ` ${meta.incomplete_reason}` : ''}

One run finds about half of what is there. A clean area here is not evidence of no bugs.

${deferred.length ? `**Deferred:**\n${deferred.map(u => `- ${dname(u)} (${u.attack_class})`).join('\n')}\n` : ''}${deviations ? `\n**Deviations from the upstream procedure:**\n${deviations}\n` : ''}
## 2. Posture summary

This run confirmed ${own.length} findings${own.length ? ` (${Object.entries(sev).map(([k, v]) => `${v} ${k}`).join(', ')})` : ''} and independently rediscovered ${carried.size} from earlier runs. ${nv.length} need validation, ${rej.length} were rejected${blocked.size ? `, ${blocked.size} blocked` : ''}.
${posture ? `\n${posture}\n` : ''}
## 3. Confirmed findings

| Severity | Finding | Source | Title |
|---|---|---|---|
${conf.map(f => `| ${f.severity.overall_severity} | \`${cell(f.fingerprint)}\` | ${carried.has(f.fingerprint) ? 'earlier run, rediscovered' : meta.run_id} | ${cell(f.title)} |`).join('\n')}

## 4. Each confirmed finding from this run

${own.map(f => `### ${f.title}\n\n**${f.severity.overall_severity}** (likelihood ${f.severity.likelihood.score}, impact ${f.severity.impact.score}), \`${f.fingerprint}\`\n\n${f.root_cause}\n\n**Should:** ${f.intended_behavior}\n\n**Observed:** ${f.execution.observed_result}\n\n**Fix:** ${f.remediation.strategy}\n`).join('\n')}
## 5. Needs validation

| Finding | What is blocking it |
|---|---|
${nv.map(f => `| \`${cell(f.fingerprint)}\` | ${cell(f.blockers[0])} |`).join('\n')}

Plans are in \`NEEDS-VALIDATION.md\`.${blocked.size ? `\n\n**Blocked, no verdict:** ${[...blocked].map(b => `\`${b}\``).join(', ')}. The hunter's proposal is unverified.` : ''}

## 6. Hardening and positive patterns

**Rejected as vulnerabilities, kept as hardening:**
${rej.map(f => `- \`${f.fingerprint}\`: ${f.title}`).join('\n') || '- none'}
${positive ? `\n**Positive patterns seen working:**\n${positive}\n` : ''}
Unreviewed hardening notes from hunters are in \`hardening.raw.json\`.

## 7. Coverage summary

| Covered | Candidate | Blocked | Deferred | Out of scope |
|---|---|---|---|---|
| ${counts.covered ?? 0} | ${counts.candidate ?? 0} | ${counts.blocked ?? 0} | ${counts.deferred ?? 0} | ${counts.out_of_scope ?? 0} |

${meta.parent_citation_check ? `**Parent checks:** ${meta.parent_citation_check}` : '**Parent checks:** not recorded — run `audit.mjs cite` before reporting.'}

## 8. Cost

Measured from the Claude Code transcripts on ${meta.usage.measured_at.slice(0, 10)}, priced at ${meta.usage.prices.source} (checked ${meta.usage.prices.checked}); \`finish\` measures again and \`usage.json\` has every agent. API-equivalent: on a subscription it counts against plan limits instead.

${usageTable({ ...meta.usage })}
${meta.usage.unmeasured_agents.length ? `\nNo transcript found for ${meta.usage.unmeasured_agents.join(', ')}: the total is low by their share.\n` : ''}${meta.usage.total.unpriced_models.length ? `\nUnpriced models: ${meta.usage.total.unpriced_models.join(', ')}.\n` : ''}`
  const trace = f => f.trace.map(t => `- \`${t.file}:${t.line}\` (${t.kind}) ${t.scope}: ${t.description}`).join('\n')
  const proofs = f => f.evidence.filter(e => e.file.startsWith('agents/')).map(e => `\`${e.file}\``).join(', ')
  const detail = `# Confirmed findings from ${meta.run_id}, medium and above\n\n${own
    .filter(f => sevRank[f.severity.overall_severity] <= sevRank.medium)
    .map(f => `## ${f.title}\n\n\`${f.fingerprint}\`: **${f.severity.overall_severity}**. Likelihood ${f.severity.likelihood.score}: ${f.severity.likelihood.reason} Impact ${f.severity.impact.score}: ${f.severity.impact.reason}\n\n${f.description}\n\n**Root cause.** ${f.root_cause}\n\n**Intended.** ${f.intended_behavior}\n\n**Trace**\n${trace(f)}\n\n**Conditions**\n${f.conditions.map(c => `- ${c.kind}: ${c.description}`).join('\n')}\n\n**Reproduction**\n${f.execution.instructions.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n**Observed.** ${f.execution.observed_result}\n\n**Remediation.** ${f.remediation.strategy}\n\n**Confidence ${f.confidence.score}.** ${f.confidence.reason}${proofs(f) ? `\n\n**Artifacts.** ${proofs(f)}` : ''}\n`)
    .join('\n')}`
  const needs = `# Needs validation\n\nEach has a real source path and a local result, but a decisive fact could not be observed from source and the sandbox.\n\n${nv.map(f => `## ${f.title}\n\n\`${f.fingerprint}\`\n\n${f.description}\n\n**Claimed root cause.** ${f.claimed_root_cause}\n\n**Blockers**\n${f.blockers.map(b => `- ${b}`).join('\n')}\n\n**Validate locally.** ${f.validation_plan.local ?? 'None.'}\n\n**Owner check.** ${f.validation_plan.deployment ?? 'None.'}\n`).join('\n')}`
  writeFile(path.join(run, 'REPORT.md'), report)
  writeFile(path.join(run, 'FINDINGS-DETAIL.md'), detail)
  writeFile(path.join(run, 'NEEDS-VALIDATION.md'), needs)
  for (const [t, f] of [['validate-findings.cjs', P(run).findings], ['validate-coverage-ledger.cjs', P(run).ledger]]) {
    const r = validate(t, f)
    console.log(t, r.ok ? 'ok' : `FAILED\n${r.output.slice(0, 1500)}`)
    if (!r.ok) process.exitCode = 1
  }
  console.log({ status: meta.run_status, confirmed: conf.length, own: own.length, sev, nv: nv.length, rej: rej.length, coverage: counts, calls: calls.total })
}

// ---------------------------------------------------------------------------------------------
// public-report

/**
 * The only fields a public report may carry, per list. Anything else in the input is refused, so
 * a field someone adds later stays private until it is added here on purpose.
 */
export const PUBLIC_FIELDS = {
  top: ['repos', 'runs', 'findings', 'hardening'],
  run: ['date', 'commit', 'scope', 'coverage_units', 'agent_calls'],
  finding: ['severity', 'line', 'release', 'repo'],
  hardening: ['line', 'release'],
}
const PUBLIC_SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational']
const RELEASE_RE = /^\d+\.\d+\.\d+$/
const MAX_LINE = 200

/**
 * Every reason `input` may not be published, or [] when it may. Fail closed: an unknown field, a
 * missing one, a finding with no fixing release or from a repository not on the file's own
 * allowlist each refuse the whole file.
 */
export function publicReportProblems(input) {
  const problems = []
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  if (!isObject(input)) return ['the input must be a JSON object']
  const fields = (value, allowed, at) => {
    if (!isObject(value)) {
      problems.push(`${at}: must be an object`)
      return false
    }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) problems.push(`${at}: unknown field "${key}" (allowed: ${allowed.join(', ')})`)
    }
    for (const key of allowed) if (!(key in value)) problems.push(`${at}: missing "${key}"`)
    return true
  }
  const text = (value, at) => {
    if (typeof value !== 'string' || value.trim() === '') problems.push(`${at}: must be a non-empty string`)
    else if (/[\r\n]/.test(value)) problems.push(`${at}: must be one line`)
    else if (value.length > MAX_LINE) problems.push(`${at}: longer than ${MAX_LINE} characters`)
  }
  const count = (value, at) => {
    if (!Number.isInteger(value) || value < 0) problems.push(`${at}: must be a whole number`)
  }
  const release = (value, at) => {
    if (typeof value !== 'string' || !RELEASE_RE.test(value)) {
      problems.push(`${at}: needs the release that fixed it (X.Y.Z); an unfixed item is never published`)
    }
  }
  fields(input, PUBLIC_FIELDS.top, 'file')
  const lists = ['repos', 'runs', 'findings', 'hardening']
  for (const key of lists) if (key in input && !Array.isArray(input[key])) problems.push(`${key}: must be a list`)
  const repos = Array.isArray(input.repos) ? input.repos : []
  if (Array.isArray(input.repos)) {
    if (repos.length === 0) problems.push('repos: list at least one repository the report may name')
    repos.forEach((r, i) => text(r, `repos[${i}]`))
  }
  if (Array.isArray(input.runs)) {
    if (input.runs.length === 0) problems.push('runs: list at least one run')
    input.runs.forEach((run, i) => {
      const at = `runs[${i}]`
      if (!fields(run, PUBLIC_FIELDS.run, at)) return
      if (typeof run.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(run.date)) problems.push(`${at}.date: must be YYYY-MM-DD`)
      if (typeof run.commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(run.commit)) problems.push(`${at}.commit: must be a commit id`)
      text(run.scope, `${at}.scope`)
      count(run.coverage_units, `${at}.coverage_units`)
      count(run.agent_calls, `${at}.agent_calls`)
    })
  }
  if (Array.isArray(input.findings)) {
    input.findings.forEach((f, i) => {
      const at = `findings[${i}]`
      if (!fields(f, PUBLIC_FIELDS.finding, at)) return
      if (!PUBLIC_SEVERITIES.includes(f.severity)) problems.push(`${at}.severity: one of ${PUBLIC_SEVERITIES.join(', ')}`)
      text(f.line, `${at}.line`)
      release(f.release, `${at}.release`)
      if (!repos.includes(f.repo)) problems.push(`${at}.repo: "${f.repo}" is not in repos, so it may not be named`)
    })
  }
  if (Array.isArray(input.hardening)) {
    input.hardening.forEach((h, i) => {
      const at = `hardening[${i}]`
      if (!fields(h, PUBLIC_FIELDS.hardening, at)) return
      text(h.line, `${at}.line`)
      release(h.release, `${at}.release`)
    })
  }
  return problems
}

const byRelease = (a, b) => {
  const pa = a.release.split('.').map(Number)
  const pb = b.release.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

/** The report, built from the allowlisted fields alone: `{ json, markdown }`. */
export function publicReport(input) {
  const pick = (value, keys) => Object.fromEntries(keys.map(k => [k, value[k]]))
  const runs = input.runs.map(r => pick(r, PUBLIC_FIELDS.run))
  const findings = input.findings
    .map(f => pick(f, PUBLIC_FIELDS.finding))
    .sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || byRelease(a, b) || (a.line < b.line ? -1 : 1))
  const hardening = input.hardening.map(h => pick(h, PUBLIC_FIELDS.hardening)).sort(byRelease)
  const counts = Object.fromEntries(
    PUBLIC_SEVERITIES.map(s => [s, findings.filter(f => f.severity === s).length]).filter(([, n]) => n > 0)
  )
  const json = { runs, counts, findings, hardening }
  const md = ['# Security audit report', '', '## Runs', '']
  md.push('| Date | Commit | Scope | Coverage units | Agent calls |', '|---|---|---|---|---|')
  for (const r of runs) md.push(`| ${r.date} | \`${r.commit.slice(0, 12)}\` | ${cell(r.scope)} | ${r.coverage_units} | ${r.agent_calls} |`)
  md.push('', '## Fixed findings', '')
  if (findings.length === 0) md.push('None listed.')
  else {
    md.push(Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', '), '')
    md.push('| Severity | Repository | Fixed in | Finding |', '|---|---|---|---|')
    for (const f of findings) md.push(`| ${f.severity} | ${cell(f.repo)} | ${f.release} | ${cell(f.line)} |`)
  }
  md.push('', '## Hardening', '')
  if (hardening.length === 0) md.push('None listed.')
  else {
    md.push('| Fixed in | Change |', '|---|---|')
    for (const h of hardening) md.push(`| ${h.release} | ${cell(h.line)} |`)
  }
  md.push(
    '',
    'Only items fixed in a released version are listed. One run finds about half of what is there, so a',
    'clean area is not evidence that it has no bugs.',
    ''
  )
  return { json, markdown: md.join('\n') }
}

/**
 * `public-report <entries.json> [--out <file.md>]`: a publishable report from a file a person
 * curated by hand. It never reads a run directory or findings.json; it refuses the whole input on
 * any problem. `--out x.md` writes x.md and x.json (never over an existing file); without it the
 * markdown goes to stdout.
 */
function cmdPublicReport(args) {
  const file = args._[0]
  if (!file) throw new Error('public-report needs the curated entries file')
  if (path.basename(file) === 'findings.json') {
    throw new Error('public-report reads a hand-curated entries file, never findings.json')
  }
  let input
  try {
    input = readJson(path.resolve(file))
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e.message}`)
  }
  const problems = publicReportProblems(input)
  if (problems.length) {
    for (const p of problems) console.log('REFUSED', p)
    console.log(`public-report REFUSED (${problems.length}); nothing written`)
    process.exitCode = 1
    return
  }
  const { json, markdown } = publicReport(input)
  if (!args.out || args.out === true) {
    process.stdout.write(markdown)
    return
  }
  const out = path.resolve(args.out)
  if (!out.endsWith('.md')) throw new Error('--out names the markdown file (x.md); x.json is written beside it')
  const jsonOut = `${out.slice(0, -3)}.json`
  for (const f of [out, jsonOut]) if (exists(f)) throw new Error(`${f} exists; the report never overwrites`)
  writeNew(out, markdown)
  writeJsonNew(jsonOut, json)
  console.log(out)
  console.log(jsonOut)
}

// ---------------------------------------------------------------------------------------------
// guard

/**
 * `guard snapshot|check [--label x]`: what agents must not change, captured before a wave and
 * compared after it. The repository and the target checkout (HEAD, status, stash), every other
 * run's file list, the run's own shared files, files an agent wrote outside its scratch/ and poc/,
 * and the entries of a few home directories. `check` exits 1 on any difference.
 */
function snapshot(run, warn = false) {
  const marker = exists(markerPath()) ? readJson(markerPath()) : {}
  const repo = marker.repo ?? REPO
  const out = { repos: {}, otherRuns: {}, shared: {}, home: {} }
  for (const dir of [repo, P(run).host]) {
    if (!exists(path.join(dir, '.git'))) continue
    out.repos[dir] = {
      head: git(dir, 'rev-parse', 'HEAD'),
      status: git(dir, 'status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(l => !l.includes('.claude/worktrees')).sort(),
      stash: spawnSync('git', ['stash', 'list'], { cwd: dir, encoding: 'utf8' }).stdout.trim(),
    }
  }
  const root = runsRoot()
  const walk = (dir, acc, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'host' && rel === '') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), acc, r)
      else acc.push(`${r}:${fs.lstatSync(path.join(dir, e.name)).size}`)
    }
    return acc
  }
  for (const repoName of exists(root) ? fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : []) {
    for (const r of fs.readdirSync(path.join(root, repoName), { withFileTypes: true })) {
      const full = path.join(root, repoName, r.name)
      if (!r.isDirectory() || full === run || !/^run-\d+$/.test(r.name)) continue
      out.otherRuns[full] = walk(full, []).length
    }
  }
  for (const f of fs.readdirSync(run)) {
    const full = path.join(run, f)
    if (fs.lstatSync(full).isFile()) out.shared[f] = fs.readFileSync(full).length
  }
  out.strays = []
  if (exists(P(run).agents)) {
    for (const e of fs.readdirSync(P(run).agents, { withFileTypes: true })) {
      if (e.isDirectory()) continue
      // Not an agent: skipped, but listed, so a file that appears during a wave fails `check`.
      if (warn) console.log(`WARNING agents/${e.name} is not an agent directory; skipped`)
      out.strays.push(e.name)
    }
    for (const id of agentIds(run)) {
      for (const e of fs.readdirSync(agentDir(run, id), { withFileTypes: true })) {
        if (['scratch', 'poc', 'artifacts'].includes(e.name) && e.isDirectory()) continue
        if (['prompt.md', 'records.json', 'result.json', 'verdict.json'].includes(e.name) && e.isFile()) continue
        out.strays.push(`${id}/${e.name}`)
      }
    }
  }
  const home = process.env.HOME
  for (const d of ['', '.ssh', '.config', '.claude', 'work', '.rocketflare']) {
    const full = path.join(home, d)
    if (exists(full)) out.home[d || '~'] = fs.readdirSync(full).filter(n => !/^\.(zsh|bash)_history|\.lesshst|\.DS_Store|\.viminfo$/.test(n)).sort()
  }
  return out
}

function cmdGuard(args) {
  const run = runDir(args)
  const label = args.label ?? 'wave'
  const file = path.join(run, `guard-${label}.json`)
  if (args._[0] === 'snapshot') {
    writeJson(file, snapshot(run, true))
    console.log('snapshot', path.basename(file))
    return
  }
  if (args._[0] !== 'check') throw new Error('guard snapshot|check')
  const before = readJson(file)
  const after = snapshot(run)
  const problems = []
  for (const [dir, b] of Object.entries(before.repos)) {
    const a = after.repos[dir]
    if (!a) problems.push(`${dir}: checkout is gone`)
    else {
      if (a.head !== b.head) problems.push(`${dir}: HEAD moved`)
      if (a.stash !== b.stash) problems.push(`${dir}: stash changed`)
      const gone = b.status.filter(l => !a.status.includes(l))
      const added = a.status.filter(l => !b.status.includes(l))
      if (gone.length || added.length) problems.push(`${dir}: status changed (-${gone.length} +${added.length}) ${[...gone, ...added].slice(0, 8).join(' | ')}`)
    }
  }
  for (const [r, n] of Object.entries(before.otherRuns)) if (after.otherRuns[r] !== n) problems.push(`${r}: file count ${n} → ${after.otherRuns[r] ?? 'gone'}`)
  for (const [f, n] of Object.entries(before.shared)) if (after.shared[f] === undefined) problems.push(`shared file removed: ${f}`)
  for (const s of after.strays) if (!before.strays.includes(s)) problems.push(`agent wrote outside scratch/poc: ${s}`)
  for (const [d, names] of Object.entries(before.home)) {
    const now = after.home[d] ?? []
    const gone = names.filter(n => !now.includes(n))
    if (gone.length) problems.push(`${d}: entries removed: ${gone.slice(0, 8).join(', ')}`)
  }
  for (const p of problems) console.log('GUARD', p)
  console.log(problems.length ? `guard FAILED: ${problems.length} change(s) outside the run directory` : 'guard ok: nothing outside the run directory changed')
  if (problems.length) process.exitCode = 1
}

// ---------------------------------------------------------------------------------------------
// cost: measured tokens from the Claude Code transcripts, priced from prices.json

/** Session transcripts live in ~/.claude/projects/<project>/<session>.jsonl, subagents beside them. */
const transcriptsRoot = () => process.env.RF_SECURITY_TRANSCRIPTS ?? path.join(os.homedir(), '.claude', 'projects')
const TOKEN_KINDS = ['input', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'output']
const zero = () => ({ calls: 0, requests: 0, fast_requests: 0, input: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, output: 0, cost_usd: 0, unpriced_models: [] })

function priceOf(prices, model, usage) {
  const p = prices.models[model]
  if (!p) return null
  const geo = usage.inference_geo === 'us' ? prices.us_inference_multiplier : 1
  return (TOKEN_KINDS.reduce((sum, k) => sum + usage[k] * p[k], 0) / 1e6) * geo
}

/** Every assistant request in one transcript (streamed duplicates folded by message id). */
function transcriptRequests(file, from, to) {
  const out = []
  const seen = new Set()
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"usage"')) continue
    let j
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    const m = j.message
    if (j.type !== 'assistant' || !m?.usage || !m.model || m.model === '<synthetic>' || seen.has(m.id)) continue
    if ((from && j.timestamp < from) || (to && j.timestamp > to)) continue
    seen.add(m.id)
    const u = m.usage
    const cw5 = u.cache_creation?.ephemeral_5m_input_tokens
    const cw1 = u.cache_creation?.ephemeral_1h_input_tokens
    out.push({
      model: m.model,
      at: j.timestamp,
      input: u.input_tokens ?? 0,
      // Older records carry only the total; it is counted as a 5-minute write.
      cache_write_5m: cw5 ?? (cw1 === undefined ? (u.cache_creation_input_tokens ?? 0) : 0),
      cache_write_1h: cw1 ?? 0,
      cache_read: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      fast: u.speed === 'fast',
      inference_geo: u.inference_geo,
    })
  }
  return out
}

function firstUserText(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(256 * 1024)
    const text = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8')
    for (const line of text.split('\n')) {
      try {
        const j = JSON.parse(line)
        if (j.type !== 'user') continue
        const c = j.message?.content
        return typeof c === 'string' ? c : (c ?? []).map(x => x.text ?? '').join('\n')
      } catch {}
    }
  } finally {
    fs.closeSync(fd)
  }
  return ''
}

function addTo(bucket, reqs, prices) {
  for (const r of reqs) {
    bucket.requests++
    if (r.fast) bucket.fast_requests++
    for (const k of TOKEN_KINDS) bucket[k] += r[k]
    const c = priceOf(prices, r.model, r)
    if (c === null) {
      if (!bucket.unpriced_models.includes(r.model)) bucket.unpriced_models.push(r.model)
    } else bucket.cost_usd += c
  }
}

/**
 * The run's measured usage. A subagent belongs to the run when its brief names
 * `<run>/agents/<id>/` (every brief does, many times); the most-named id is the agent. The
 * parent's share is its session's requests between the run's start and end, in every session
 * whose transcript mentions the run directory.
 */
export function measureUsage(run, meta) {
  const prices = readJson(path.join(TOOLS, 'prices.json'))
  const root = transcriptsRoot()
  const from = meta.started ?? null
  const to = meta.finished ?? null
  const since = from ? Date.parse(from) - 60_000 : 0
  const needle = `${run}/agents/`
  const idRe = new RegExp(`${run.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/agents/([a-z0-9][a-z0-9_-]{0,63})/`, 'g')
  const roles = { recon: 'reconnaissance', h: 'hunters', c: 'critics', v: 'verifiers', r: 'reviewers' }
  const perAgent = {}
  const parentSessions = []
  const projects = exists(root) ? fs.readdirSync(root).map(d => path.join(root, d)).filter(d => fs.statSync(d).isDirectory()) : []
  for (const project of projects) {
    for (const entry of fs.readdirSync(project)) {
      const full = path.join(project, entry)
      if (entry.endsWith('.jsonl')) {
        if (fs.statSync(full).mtimeMs < since) continue
        if (fs.readFileSync(full, 'utf8').includes(run)) parentSessions.push(full)
        continue
      }
      const subs = path.join(full, 'subagents')
      if (!exists(subs)) continue
      for (const f of fs.readdirSync(subs).filter(n => n.endsWith('.jsonl'))) {
        const file = path.join(subs, f)
        if (fs.statSync(file).mtimeMs < since) continue
        const first = firstUserText(file)
        if (!first.includes(needle)) continue
        const counts = {}
        for (const m of first.matchAll(idRe)) counts[m[1]] = (counts[m[1]] ?? 0) + 1
        const id = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
        if (!id) continue
        ;(perAgent[id] ??= []).push(...transcriptRequests(file))
      }
    }
  }
  const usage = { measured_at: new Date().toISOString(), method: 'Claude Code transcripts', prices: { source: prices.source, checked: prices.checked }, by_role: {}, by_model: {}, parent: zero(), agents: {}, total: zero() }
  for (const [id, reqs] of Object.entries(perAgent).sort()) {
    const role = roles[id.startsWith('recon') ? 'recon' : id[0]] ?? 'other'
    const a = zero()
    a.calls = 1
    addTo(a, reqs, prices)
    usage.agents[id] = { role, models: [...new Set(reqs.map(r => r.model))], ...a }
    const b = (usage.by_role[role] ??= zero())
    b.calls++
    addTo(b, reqs, prices)
    for (const r of reqs) addTo((usage.by_model[r.model] ??= zero()), [r], prices)
  }
  // A run with no recorded start (before the runner): the parent's window is when its agents ran.
  const ats = Object.values(perAgent).flat().map(r => r.at).sort()
  const win = from ? [from, to] : [ats[0], ats.at(-1)]
  const parentReqs = win[0] ? parentSessions.flatMap(f => transcriptRequests(f, win[0], win[1])) : []
  addTo(usage.parent, parentReqs, prices)
  for (const r of parentReqs) addTo((usage.by_model[r.model] ??= zero()), [r], prices)
  usage.parent.sessions = parentSessions.length
  if (!from) usage.parent.note = 'run start not recorded: parent usage is its requests between the first and last agent request'
  for (const b of [...Object.values(usage.by_role), usage.parent]) {
    usage.total.calls += b.calls
    usage.total.requests += b.requests
    usage.total.fast_requests += b.fast_requests
    for (const k of TOKEN_KINDS) usage.total[k] += b[k]
    usage.total.cost_usd += b.cost_usd
    for (const m of b.unpriced_models) if (!usage.total.unpriced_models.includes(m)) usage.total.unpriced_models.push(m)
  }
  const round = o => {
    for (const v of Object.values(o)) if (v && typeof v === 'object' && 'cost_usd' in v) v.cost_usd = Math.round(v.cost_usd * 100) / 100
  }
  round(usage.by_role)
  round(usage.by_model)
  round(usage.agents)
  round({ p: usage.parent, t: usage.total })
  const withResult = agentIds(run).filter(id => kindOf(id) && ['result.json', 'verdict.json'].some(f => exists(path.join(agentDir(run, id), f))))
  usage.unmeasured_agents = withResult.filter(id => !usage.agents[id])
  return usage
}

const fmtTokens = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`)

/** One table of measured usage, for the terminal and for REPORT.md. */
function usageTable(u) {
  const row = (name, b) => `| ${name} | ${b.calls || '-'} | ${fmtTokens(b.input + b.cache_write_5m + b.cache_write_1h)} | ${fmtTokens(b.cache_read)} | ${fmtTokens(b.output)} | $${b.cost_usd.toFixed(2)} |`
  return [
    '| Part | Agent calls | Input + cache writes | Cache reads | Output | Cost (USD) |',
    '|---|---|---|---|---|---|',
    ...Object.entries(u.by_role).map(([k, b]) => row(k, b)),
    row('parent (orchestration)', u.parent),
    row('**total**', u.total),
  ].join('\n')
}

/** `cost [--no-write]`: measures the run's tokens and cost and stores them (usage.json + metadata). */
function cmdCost(args) {
  const run = runDir(args)
  const meta = readJson(P(run).meta)
  const usage = measureUsage(run, meta)
  console.log(usageTable(usage))
  for (const [m, b] of Object.entries(usage.by_model)) console.log(`${m}: ${b.requests} requests, $${b.cost_usd.toFixed(2)}`)
  if (usage.total.unpriced_models.length) console.log('UNPRICED models (add them to prices.json):', usage.total.unpriced_models.join(', '))
  if (usage.total.fast_requests) console.log(`${usage.total.fast_requests} fast-mode requests priced at standard rates: the cost is an underestimate`)
  if (usage.unmeasured_agents.length) console.log('no transcript found for:', usage.unmeasured_agents.join(' '))
  if (args['no-write']) return
  writeJson(path.join(run, 'usage.json'), usage)
  meta.usage = { measured_at: usage.measured_at, prices: usage.prices, total: usage.total, by_role: usage.by_role, by_model: usage.by_model, parent: usage.parent, unmeasured_agents: usage.unmeasured_agents }
  writeJson(P(run).meta, meta)
  console.log('stored in usage.json and run-metadata.json')
}

// ---------------------------------------------------------------------------------------------
// check-result (run by the agents themselves, before they hand back)

const PLACEHOLDER = /^(\.\.\.|…|TODO\b|TBD\b|<[^>]+>|\?+|placeholder|n\/a)$/i

function placeholders(value, at = '$', out = []) {
  if (typeof value === 'string') {
    if (PLACEHOLDER.test(value.trim()) || value.trim() === '') out.push(at)
  } else if (Array.isArray(value)) value.forEach((v, i) => placeholders(v, `${at}[${i}]`, out))
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) placeholders(v, `${at}.${k}`, out)
  return out
}

/** Problems with one finding record: upstream's schema, placeholders, citations in the target. */
function recordProblems(run, meta, record, label) {
  const problems = []
  const tmp = path.join(agentDir(run, label.split(':')[0]), 'scratch', '.check-record.json')
  writeJson(tmp, [record])
  const v = validate('validate-findings.cjs', tmp)
  if (!v.ok) problems.push(`${label}: schema: ${v.output.split('\n').slice(0, 8).join(' / ')}`)
  for (const p of placeholders(record)) problems.push(`${label}: placeholder or empty value at ${p}`)
  for (const c of [...(record.trace ?? []), ...(record.evidence ?? [])]) {
    if (c.file?.startsWith('agents/')) {
      const art = /^agents\/([^/]+)\/artifacts\/([^/]+)$/.exec(c.file)
      const src = art && ['poc', 'scratch', 'artifacts'].some(d => exists(path.join(agentDir(run, art[1]), d, art[2])))
      if (!src) problems.push(`${label}: artifact ${c.file} has no source file in that agent's poc/ or scratch/`)
      continue
    }
    const file = path.join(meta.target, c.file ?? '')
    const lines = exists(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8').split('\n') : null
    if (!lines) problems.push(`${label}: cited file not in the target: ${c.file}`)
    else if (!(c.line >= 1 && c.line <= lines.length)) problems.push(`${label}: ${c.file}:${c.line} is past the end (${lines.length} lines)`)
  }
  for (const pl of Object.values(record.validation_plan ?? {})) {
    // Reserved names (RFC 2606/6761) and loopback are fixtures; any other host is a deployment.
    const hosts = typeof pl === 'string' ? [...pl.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map(m => m[1].toLowerCase()) : []
    const real = hosts.filter(h => !/(^|\.)(example|test|invalid|localhost)$|^(localhost|127\.0\.0\.1|\[::1\])$|^example\.(com|net|org)$/.test(h))
    if (real.length) problems.push(`${label}: a validation plan names ${real.join(', ')}; plans never send traffic to a deployment`)
  }
  return problems
}

/**
 * `check-result --agent <id> [--file f]`: validates an agent's result file before it hands back.
 * Hunters: every assigned unit exactly once, local checks cite promotable artifacts. Verifiers and
 * reviewers: each record passes upstream's schema, has no placeholders, and every citation exists
 * in the target. Critics: the shape. Prints "check-result ok" or the problems; exits 1 on any.
 */
function cmdCheckResult(args) {
  const run = runDir(args)
  const meta = readJson(P(run).meta)
  const id = args.agent
  if (!id || !ID.test(id)) throw new Error('--agent <id> is required')
  const kind = kindOf(id)
  const file = args.file ? path.resolve(args.file) : path.join(agentDir(run, id), 'scratch', 'result.json')
  const problems = []
  let result = null
  try {
    result = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    problems.push(`not readable as one JSON object: ${e.message}`)
  }
  if (result && !SHAPES[kind].ok(result)) problems.push(`not the ${kind} shape: needs a top-level "${SHAPES[kind].key}"`)
  if (result && problems.length === 0) {
    if (kind === 'hunter') {
      const mine = readJson(P(run).ledger).filter(u => u.agent_id === id).map(u => u.coverage_id)
      const got = result.units.map(u => u.coverage_id)
      for (const m of mine) if (!got.includes(m)) problems.push(`unit missing: ${m.slice(0, 90)}`)
      for (const g of got) if (!mine.includes(g)) problems.push(`not your unit: ${g.slice(0, 90)}`)
      if (new Set(got).size !== got.length) problems.push('a unit appears more than once')
      const fps = new Set(result.candidates.map(c => c.fingerprint))
      for (const f of fps) if (typeof f !== 'string' || !FINGERPRINT.test(f)) problems.push(`fingerprint ${f} must match ${FINGERPRINT} (use ':' rather than '#')`)
      for (const u of result.units) {
        for (const f of u.candidate_fingerprints ?? []) if (!fps.has(f)) problems.push(`unit cites candidate ${f}, which is not in candidates`)
        for (const c of u.checks ?? []) {
          if (c.method !== 'local') continue
          const art = /^agents\/([^/]+)\/artifacts\/([^/]+)$/.exec(c.artifact ?? '')
          if (!art || art[1] !== id || !['poc', 'scratch'].some(d => exists(path.join(agentDir(run, id), d, art[2])))) problems.push(`local check artifact ${c.artifact} must be agents/${id}/artifacts/<file> with the file in your poc/ or scratch/`)
        }
      }
      for (const c of result.candidates) for (const p of placeholders(c)) problems.push(`candidate ${c.fingerprint}: placeholder or empty value at ${p}`)
    }
    if (kind === 'verifier') {
      if (!['confirmed', 'needs_validation', 'rejected'].includes(result.decision)) problems.push(`decision is ${result.decision}`)
      if (result.record.verdict !== result.decision) problems.push('record.verdict differs from decision')
      problems.push(...recordProblems(run, meta, result.record, `${id}:${result.record.fingerprint}`))
    }
    if (kind === 'reviewer') {
      const want = readJson(path.join(agentDir(run, id), 'records.json')).map(r => r.fingerprint)
      if (result.results.length !== want.length) problems.push(`${result.results.length} results for ${want.length} records`)
      result.results.forEach((r, i) => {
        const fp = r.fingerprint ?? r.record?.fingerprint
        if (fp !== want[i]) problems.push(`result ${i} is ${fp}, expected ${want[i]}`)
        if (r.decision === 'replace') {
          if (!/^(non-)?material:/.test(r.reason ?? '')) problems.push(`result ${i}: reason must start "material:" or "non-material:"`)
          problems.push(...recordProblems(run, meta, r.record, `${id}:${fp}`))
        } else if (r.decision !== 'verified') problems.push(`result ${i}: decision ${r.decision}`)
      })
    }
    if (kind === 'critic') {
      for (const m of result.missing_units) {
        const [file, name] = String(m.attack_class).split('#')
        if (!Object.values(COMPANIONS).includes(file) || !name) problems.push(`missing unit attack_class must be FILE.md#Block: ${m.attack_class}`)
        else if (!mdBlock(readUpstream(file), name)) problems.push(`no such upstream block: ${m.attack_class}`)
        if (!m.starting_paths?.length) problems.push(`missing unit "${m.surface}" has no starting_paths`)
      }
    }
  }
  for (const p of problems) console.log('PROBLEM', p)
  console.log(problems.length ? `check-result FAILED (${problems.length})` : 'check-result ok')
  if (problems.length) process.exitCode = 1
}

// ---------------------------------------------------------------------------------------------

const COMMANDS = {
  init: [cmdInit, 'init <quick|standard|deep> [--diff A..B | --scope <path>…] [--budget N] [--ref R]  new run dir + metadata; marks the audit active'],
  host: [cmdHost, 'host [--plugin <repo>:<subdir>]…  clone the target, add the sandbox, install plugins offline-safe, build + verify the image'],
  status: [cmdStatus, 'status  one screen: phase and next step, units, agents, leftovers, budget'],
  budget: [cmdBudget, 'budget [profile]  the split of a budget, or the active run’s spend'],
  'discard-next': [cmdDiscardNext, 'discard-next [file…]  set a failed step’s leftover .next.json aside (renamed, never deleted)'],
  hunters: [cmdHunters, 'hunters <plan.json> [--over-budget]  ledger units + one brief per hunter'],
  collect: [cmdCollect, 'collect [--map ids.json]  agents’ final JSON into result/verdict files; promote proofs and logs'],
  block: [cmdBlock, 'block <agent-id> [reason]  record an agent a model safeguard stopped (never retried)'],
  ingest: [cmdIngest, 'ingest  hunter results into the ledger; raw candidates, hardening, uncovered'],
  consolidate: [cmdConsolidate, 'consolidate [--critic id]  merge by root cause (decisions.json) → verifier briefs + critic brief'],
  critic: [cmdCritic, 'critic <id> [--defer] [--reason r]  a critic’s units into the ledger'],
  defer: [cmdDefer, 'defer [--reason r]  every planned unit to deferred'],
  'plan-next': [cmdPlanNext, 'plan-next  next wave’s plan.json from the planned units (keeps plan-waveN.json)'],
  findings: [cmdFindings, 'findings  findings.json from verdicts + rediscovered prior records; ledger links'],
  cite: [cmdCite, 'cite [--all]  every citation of this run’s confirmed records against the target'],
  review: [cmdReview, 'review [--groups g.json]  Phase 5 reviewer briefs'],
  'apply-review': [cmdApplyReview, 'apply-review  reviewer results into findings.json'],
  reverify: [cmdReverify, 'reverify <fingerprint> [--force]  brief for a fresh verifier (v13 → v13b) after a MATERIAL review'],
  'apply-reverify': [cmdApplyReverify, 'apply-reverify <id>  the fresh verifier’s record into findings.json'],
  report: [cmdReport, 'report  final metadata + REPORT.md, FINDINGS-DETAIL.md, NEEDS-VALIDATION.md'],
  cost: [cmdCost, 'cost [--no-write]  measured tokens and estimated USD (prices.json) into usage.json + metadata'],
  'check-result': [cmdCheckResult, 'check-result --agent <id> [--file f]  an agent checks its own result before handing back'],
  'public-report': [cmdPublicReport, 'public-report <entries.json> [--out <file.md>]  a publishable report from a hand-curated file (fixed items only; refuses unknown fields)'],
  guard: [cmdGuard, 'guard snapshot|check [--label x]  fail if anything outside the run dir changed'],
  finish: [cmdFinish, 'finish  the audit is no longer active (the guard hook stops)'],
}

export function main(argv) {
  const [command, ...rest] = argv
  if (!COMMANDS[command]) {
    console.log(`usage: node ${path.relative(process.cwd(), path.join(TOOLS, 'audit.mjs'))} <command>\n`)
    for (const [, help] of Object.values(COMMANDS)) console.log(`  ${help}`)
    process.exitCode = command && command !== 'help' ? 2 : 0
    return
  }
  COMMANDS[command][0](parseArgs(rest))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error(`audit: ${e.message}`)
    process.exitCode = 1
  }
}
