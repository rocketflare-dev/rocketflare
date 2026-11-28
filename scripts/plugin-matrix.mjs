#!/usr/bin/env node
/**
 * The plugin matrix's logic (`.github/workflows/plugin-matrix.yml`, issue #180): the LATEST
 * release of each published plugin, installed into ONE kit ref, one job each plus a full-house job
 * with every plugin installed together.
 *
 *   node scripts/plugin-matrix.mjs resolve [--plugins-repo <url>] [--plugins-ref <ref>]
 *                                          [--only a,b] [--no-full-house] [--github-output]
 *   node scripts/plugin-matrix.mjs result  --id <id> --version <v> --kit-ref <ref> --kit-sha <sha>
 *                                          --run-url <url> --out <file> [--log <gate.log>]
 *                                          [--check <check.json>]    (STEPS = toJSON(steps))
 *   node scripts/plugin-matrix.mjs summary --dir <dir of result.json files> [--expect <matrix json>]
 *                                          [--github-output]
 *
 * It reports through the run and nothing else: a failing plugin job fails the run, the summary job
 * writes one table row per plugin (pass/fail, failing step, value-check warnings, kit sha), and
 * `scripts/release.mjs` prints `⚠ <plugin> fails on main: <step>, <run>` from the same run. No
 * issue is created, edited or closed — that was decided against.
 *
 * **Self-contained on purpose**: Node built-ins and `git` only, so the workflow can run it from a
 * sparse checkout of the kit's `main` while proving an OLDER kit tag, and so another repository
 * (the commercial plugins) can vendor this one file. Kit-only: the rename deletes it.
 *
 * Exit 0 ok · 1 error · 2 usage.
 */
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const PLUGINS_REPO = 'https://github.com/rocketflare-dev/rocketflare-plugins.git'
export const FULL_HOUSE = 'full-house'
export const MANIFEST = 'rocketflare-plugin.json'

/**
 * The workflow's step names, by step id, in the order they run. The FIRST failed one is the
 * failing step; `release.mjs` reads the same names back from the GitHub jobs API, so a rename here
 * is a rename in `plugin-matrix.yml` too (`tests/kit-only/plugin-matrix.test.ts` pins both).
 */
export const STEP_NAMES = Object.freeze({
  deps: 'Install the kit dependencies',
  db: 'Start the test database',
  install: 'Install the plugin(s) into the kit',
  migrate: 'Apply the generated migrations',
  check: 'pnpm plugin check',
  rehearse: 'Rehearsal: fail on purpose',
  gate: 'The kit gate',
})

const BARE_VERSION = /^\d+\.\d+\.\d+$/

/**
 * Plugins in install order — every `requires.plugins` before the plugin that needs it (a
 * depth-first post-order), so `pnpm plugin add`, which refuses a plugin whose requirement is
 * missing, always finds it. An unknown requirement or a cycle throws, naming the plugin.
 */
export function installOrder(plugins, ids) {
  const byId = new Map(plugins.map(p => [p.id, p]))
  const order = []
  const visit = (id, trail) => {
    if (trail.includes(id))
      throw new Error(`requires.plugins forms a cycle: ${[...trail, id].join(' -> ')}`)
    if (order.some(p => p.id === id)) return
    const plugin = byId.get(id)
    if (!plugin) {
      throw new Error(
        trail.length > 0
          ? `${trail.at(-1)} requires plugin '${id}', which the plugins repository does not publish`
          : `'${id}' is not a published plugin`
      )
    }
    for (const dep of plugin.requires ?? []) visit(dep, [...trail, id])
    order.push(plugin)
  }
  for (const id of ids) visit(id, [])
  return order
}

/**
 * The matrix's `include` list: one entry per selected plugin (its requirements installed first),
 * then the full house — EVERY published plugin, whatever `only` selected, because a collision
 * between two plugins is a fault of neither alone. `installs` is `id=subdir` pairs, space
 * separated, in install order: a subdir is a path in a git repository and never holds whitespace,
 * which is asserted rather than assumed.
 */
export function matrixEntries(plugins, { only = [], fullHouse = true } = {}) {
  const ids = only.length > 0 ? only : plugins.map(p => p.id)
  const pairs = list => {
    for (const p of list) {
      if (/\s/.test(p.subdir))
        throw new Error(`${p.id}: directory '${p.subdir}' contains whitespace`)
    }
    return list.map(p => `${p.id}=${p.subdir}`).join(' ')
  }
  const entries = ids.map(id => {
    const order = installOrder(plugins, [id])
    const plugin = order.at(-1)
    return { id, version: plugin.version, installs: pairs(order) }
  })
  if (fullHouse && plugins.length > 1) {
    entries.push({
      id: FULL_HOUSE,
      version: `${plugins.length} plugins`,
      installs: pairs(
        installOrder(
          plugins,
          plugins.map(p => p.id)
        )
      ),
    })
  }
  return entries
}

/** Every `rocketflare-plugin.json` under `root` (node_modules and dot directories skipped). */
export function readPlugins(root) {
  const plugins = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.'))
        continue
      const sub = path.join(dir, entry.name)
      const file = path.join(sub, MANIFEST)
      if (existsSync(file)) {
        let m
        try {
          m = JSON.parse(readFileSync(file, 'utf8'))
        } catch (err) {
          throw new Error(`${path.relative(root, file)} is not valid JSON: ${err.message}`)
        }
        if (!m.id) throw new Error(`${path.relative(root, file)} declares no id`)
        if (plugins.some(p => p.id === m.id))
          throw new Error(`plugin id '${m.id}' is declared twice`)
        plugins.push({
          id: m.id,
          version: m.version ?? null,
          subdir: path.relative(root, sub).split(path.sep).join('/'),
          requires: (m.requires?.plugins ?? []).map(r =>
            typeof r === 'object' && r ? r.id : String(r)
          ),
        })
      }
      walk(sub)
    }
  }
  walk(root)
  return plugins.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * The newest `X.Y.Z` tag in `ls-remote --sort=version:refname` output. Git orders the versions,
 * so nothing here compares them. Every plugin in the public repository ships at one lockstep
 * version and tag (`release.mjs`), so its newest tag IS each plugin's latest release; per-plugin
 * versions (#181) change this one function.
 */
export function newestTag(lsRemote) {
  const tags = lsRemote
    .split('\n')
    .map(l => l.split('refs/tags/')[1]?.trim())
    .filter(t => t && BARE_VERSION.test(t))
  return tags.at(-1) ?? null
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/**
 * What failed inside the gate's log, as stable names (line numbers and timings dropped, so a moved
 * line is not a new failure): the gate's own steps (`✖ pnpm gate failed: test`), vitest's `FAIL`
 * lines, and TypeScript errors as `file TSxxxx`. At most 20 of each.
 */
export function parseFailures(log) {
  const gateSteps = new Set()
  const tests = new Set()
  for (const raw of log.replace(ANSI, '').split('\n')) {
    const line = raw.trimEnd()
    const gate = line.match(/✖ pnpm gate failed: (.+)$/)
    if (gate) for (const s of gate[1].split(',')) gateSteps.add(s.trim())
    const fail = line.match(/^\s*FAIL\s+(.+?)(?:\s+\[[^\]]*\])?(?:\s+\d+(?:\.\d+)?m?s)?$/)
    if (fail) tests.add(fail[1].trim())
    const ts = line.match(/^(\S+\.[cm]?tsx?)\(\d+,\d+\): error (TS\d+)/)
    if (ts) tests.add(`${ts[1]} ${ts[2]}`)
  }
  return { gateSteps: [...gateSteps].filter(Boolean), tests: [...tests].slice(0, 20) }
}

/**
 * How many value-check warnings `pnpm plugin check --json` raised for this plugin (a finding id
 * is `<plugin>:<check>…`), or every warning for the full house. `null` when there is no report —
 * a kit older than `check --json` — which the summary shows as `n/a`. This is where a contract's
 * readiness signal comes from: #197's `egress` check is a warning first, and its commit waits
 * for zero.
 */
export function countWarnings(checkJson, id) {
  if (!checkJson) return null
  let report
  try {
    report = JSON.parse(checkJson)
  } catch {
    return null
  }
  if (!Array.isArray(report?.warnings)) return null
  if (id === FULL_HOUSE) return report.warnings.length
  return report.warnings.filter(w => String(w.id ?? '').startsWith(`${id}:`)).length
}

/**
 * The first failed step, by name, from the workflow's `steps` context (`{ <id>: { outcome } }`),
 * read in `STEP_NAMES` order. The gate's own failing steps ride along: `The kit gate (test)`.
 */
export function failingStep(steps, gateSteps = []) {
  for (const [id, name] of Object.entries(STEP_NAMES)) {
    if (steps?.[id]?.outcome !== 'failure') continue
    return id === 'gate' && gateSteps.length > 0 ? `${name} (${gateSteps.join(', ')})` : name
  }
  return null
}

/** One job's result, as the summary and the artifact carry it. */
export function buildResult({
  id,
  version,
  kitRef,
  kitSha,
  runUrl,
  steps,
  log = '',
  checkJson = null,
}) {
  const { gateSteps, tests } = parseFailures(log)
  const step = failingStep(steps, gateSteps)
  const ran = Object.keys(STEP_NAMES).some(
    k => steps?.[k]?.outcome && steps[k].outcome !== 'skipped'
  )
  return {
    id,
    version,
    kitRef,
    kitSha,
    runUrl,
    outcome: step ? 'failure' : ran ? 'success' : 'unknown',
    step,
    tests: step ? tests : [],
    warnings: countWarnings(checkJson, id),
  }
}

const cell = v =>
  String(v ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')

/** A placeholder result for each expected matrix entry that recorded none (cancelled, runner lost). */
export function missingResults(expected, results) {
  const kitRef = results[0]?.kitRef ?? null
  const kitSha = results[0]?.kitSha ?? null
  return (expected ?? [])
    .filter(e => !results.some(r => r.id === e.id))
    .map(e => ({
      id: e.id,
      version: e.version ?? null,
      kitRef,
      kitSha,
      runUrl: null,
      outcome: 'unknown',
      step: 'no result recorded (job cancelled or lost)',
      tests: [],
      warnings: null,
    }))
}

/** The job summary: one row per plugin, failures first. Markdown, for `$GITHUB_STEP_SUMMARY`. */
export function summaryTable(results) {
  const sorted = [...results].sort(
    (a, b) =>
      (a.outcome === 'success') - (b.outcome === 'success') ||
      (a.id === FULL_HOUSE) - (b.id === FULL_HOUSE) ||
      a.id.localeCompare(b.id)
  )
  const failed = results.filter(r => r.outcome !== 'success').length
  const kit = results[0]
    ? `kit \`${results[0].kitRef}\` (\`${String(results[0].kitSha).slice(0, 12)}\`)`
    : 'no results'
  const lines = [
    '## Plugin matrix',
    '',
    `${kit}: ${results.length - failed} of ${results.length} green.`,
    '',
    '| Plugin | Version | Result | Failing step | Warnings | Kit sha |',
    '|---|---|---|---|---|---|',
  ]
  for (const r of sorted) {
    const mark =
      r.outcome === 'success' ? '✔ pass' : r.outcome === 'failure' ? '✖ fail' : '? unknown'
    lines.push(
      `| ${cell(r.id)} | ${cell(r.version)} | ${mark} | ${cell(r.step ?? '')} | ${r.warnings ?? 'n/a'} | \`${cell(String(r.kitSha).slice(0, 12))}\` |`
    )
  }
  const withTests = sorted.filter(r => r.tests?.length > 0)
  for (const r of withTests) {
    lines.push('', `**${r.id}** failing:`, ...r.tests.map(t => `- \`${t.replace(/`/g, "'")}\``))
  }
  return `${lines.join('\n')}\n`
}

/**
 * `release.mjs`'s verdicts, from `gh run view --json jobs`: one per `matrix <id>` job (a caller's
 * prefix — `ci / matrix x` — is allowed), with the first failed step's name.
 */
export function jobVerdicts(jobs) {
  const verdicts = []
  for (const job of jobs ?? []) {
    const m = String(job.name ?? '').match(/(?:^|\/ )matrix (\S+)/)
    if (!m) continue
    const failedStep = (job.steps ?? []).find(s => s.conclusion === 'failure')
    verdicts.push({
      plugin: m[1],
      ok: job.conclusion === 'success',
      conclusion: job.conclusion ?? job.status ?? 'unknown',
      step: failedStep?.name ?? null,
      url: job.url ?? null,
    })
  }
  return verdicts
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--no-')) args[a.slice(5)] = false
    else if (a.startsWith('--')) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true
      else {
        args[a.slice(2)] = next
        i++
      }
    } else args._.push(a)
  }
  return args
}

const output = (name, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

function cmdResolve(args) {
  const repo = typeof args['plugins-repo'] === 'string' ? args['plugins-repo'] : PLUGINS_REPO
  let ref =
    typeof args['plugins-ref'] === 'string' && args['plugins-ref'] ? args['plugins-ref'] : null
  const git = (...a) =>
    execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (!ref) {
    ref = newestTag(git('ls-remote', '--tags', '--refs', '--sort=version:refname', repo))
    if (!ref) throw new Error(`${repo} has no X.Y.Z release tag`)
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'plugin-matrix-'))
  try {
    git('clone', '--depth', '1', '--branch', ref, '--quiet', repo, dir)
    const plugins = readPlugins(dir)
    const only = typeof args.only === 'string' ? args.only.split(/[\s,]+/).filter(Boolean) : []
    const include = matrixEntries(plugins, { only, fullHouse: args['full-house'] !== false })
    const resolved = { repo, ref, plugins, include }
    process.stdout.write(
      [
        `plugins ${repo} @ ${ref}`,
        ...include.map(e => `  matrix ${e.id} (${e.version}): ${e.installs}`),
        '',
      ].join('\n')
    )
    if (args['github-output']) {
      output('plugins_ref', ref)
      output('matrix', JSON.stringify(include))
    }
    return resolved
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function cmdResult(args) {
  for (const k of ['id', 'out'])
    if (typeof args[k] !== 'string') throw new Error(`result needs --${k}`)
  const readIf = f => (typeof f === 'string' && existsSync(f) ? readFileSync(f, 'utf8') : null)
  let steps = {}
  try {
    steps = JSON.parse(process.env.STEPS || '{}')
  } catch {}
  const result = buildResult({
    id: args.id,
    version: args.version ?? null,
    kitRef: args['kit-ref'] ?? null,
    kitSha: args['kit-sha'] ?? null,
    runUrl: args['run-url'] ?? null,
    steps,
    log: readIf(args.log) ?? '',
    checkJson: readIf(args.check),
  })
  writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`)
  const warnings = result.warnings ?? 'n/a'
  process.stdout.write(
    result.outcome === 'failure'
      ? `✖ ${result.id} ${result.version}: ${result.step} (warnings: ${warnings})\n`
      : `✔ ${result.id} ${result.version}: ${result.outcome} (warnings: ${warnings})\n`
  )
  return result
}

function cmdSummary(args) {
  if (typeof args.dir !== 'string') throw new Error('summary needs --dir')
  const results = existsSync(args.dir)
    ? readdirSync(args.dir, { recursive: true })
        .filter(f => String(f).endsWith('.json'))
        .map(f => JSON.parse(readFileSync(path.join(args.dir, String(f)), 'utf8')))
    : []
  // Every matrix entry the run expected and no job recorded: a row saying so, never a silent gap.
  if (typeof args.expect === 'string' && args.expect) {
    results.push(...missingResults(JSON.parse(args.expect), results))
  }
  process.stdout.write(summaryTable(results))
  if (args['github-output']) {
    output(
      'results',
      JSON.stringify(
        results.map(({ id, version, outcome, step, warnings, kitSha }) => ({
          id,
          version,
          outcome,
          step,
          warnings,
          kitSha,
        }))
      )
    )
  }
  return results
}

export function main(argv) {
  const args = parseArgs(argv)
  const [command] = args._
  try {
    if (command === 'resolve') cmdResolve(args)
    else if (command === 'result') cmdResult(args)
    else if (command === 'summary') cmdSummary(args)
    else {
      process.stderr.write(
        'usage: node scripts/plugin-matrix.mjs resolve|result|summary [options]\n'
      )
      return 2
    }
    return 0
  } catch (err) {
    process.stderr.write(`::error::${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2))
