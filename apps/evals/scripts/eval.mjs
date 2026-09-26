#!/usr/bin/env node
/**
 * `pnpm eval` (D33) — run the eval suites locally, outside the gate.
 *
 *   pnpm eval [suite…] [--model x] [--judge-model y] [--case id,id] [--compare [baseline|<run.json>]]
 *             [--threshold 0.1] [--concurrency 2]
 *   pnpm eval:baseline [suite…] [--from <run.json>]   write baselines/<suite>.json from a run (default: latest)
 *   pnpm eval:view [a.json [b.json]] [--compare …]    print the score diff, then the vitest-evals report UI
 *
 * `run` loads the TEST database from `apps/web/.env.test` and the AI keys (only those) from
 * `apps/web/.dev.vars`, runs `vitest --config vitest.config.ts` with the vitest-evals reporter plus a
 * JSON report at `.evals/runs/<timestamp>-<sha>.json`, stamps that file with the git sha, models and
 * prompt hashes, prints a score/cost/latency table, and — with `--compare` — the regressions, exiting
 * 1 past the threshold.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseEnv } from 'dotenv'
import {
  baselinesFrom,
  compareScores,
  extractCases,
  parseArgs,
  renderComparison,
  renderSummary,
  runHeader,
  scoreIndex,
} from './lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB = path.resolve(ROOT, '../web')
const RUNS = path.join(ROOT, '.evals', 'runs')
const BASELINES = path.join(ROOT, 'baselines')
const VITEST = path.join(ROOT, 'node_modules', '.bin', 'vitest')

/** The only `.dev.vars` keys a run reads: model and embeddings keys, and a tracing backend. */
const DEV_VARS_KEYS = [
  'ANTHROPIC_API_KEY',
  'EMBEDDINGS_API_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
]

function readEnvFile(file) {
  return existsSync(file) ? parseEnv(readFileSync(file)) : {}
}

function git(...args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

function latestRun() {
  if (!existsSync(RUNS)) return null
  const files = readdirSync(RUNS)
    .filter(f => f.endsWith('.json'))
    .sort()
  return files.length ? path.join(RUNS, files.at(-1)) : null
}

function readReport(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function loadBaselines() {
  if (!existsSync(BASELINES)) return {}
  const out = {}
  for (const f of readdirSync(BASELINES).filter(f => f.endsWith('.json'))) {
    const b = JSON.parse(readFileSync(path.join(BASELINES, f), 'utf8'))
    out[b.suite ?? f.replace(/\.json$/, '')] = b
  }
  return out
}

function run(opts) {
  const env = {
    ...readEnvFile(path.join(WEB, '.env.test')),
    ...Object.fromEntries(
      Object.entries(readEnvFile(path.join(WEB, '.dev.vars'))).filter(
        ([k, v]) => DEV_VARS_KEYS.includes(k) && v
      )
    ),
  }
  // A real environment variable (CI's secret) wins over both files.
  for (const [k, v] of Object.entries(process.env)) if (v) env[k] = v
  env.NODE_ENV = 'test'
  if (opts.model) env.EVAL_MODEL = opts.model
  if (opts.judgeModel) env.EVAL_JUDGE_MODEL = opts.judgeModel
  if (opts.cases) env.EVAL_CASE = opts.cases
  if (opts.concurrency) env.EVAL_CONCURRENCY = opts.concurrency
  if (!env.ANTHROPIC_API_KEY) {
    console.warn(
      '! No ANTHROPIC_API_KEY (apps/web/.dev.vars or the environment): every suite will skip.'
    )
  }

  mkdirSync(RUNS, { recursive: true })
  const sha = git('rev-parse', '--short', 'HEAD') || 'nogit'
  const createdAt = new Date().toISOString()
  const file = path.join(RUNS, `${createdAt.replace(/[:.]/g, '-')}-${sha}.json`)
  const result = spawnSync(
    VITEST,
    [
      'run',
      '--config',
      'vitest.config.ts',
      '--reporter=vitest-evals/reporter',
      '--reporter=json',
      `--outputFile.json=${file}`,
      ...opts.filters,
    ],
    { cwd: ROOT, env, stdio: 'inherit' }
  )
  if (!existsSync(file)) {
    console.error('✗ vitest produced no report — see the output above.')
    return result.status ?? 1
  }

  const report = readReport(file)
  const cases = extractCases(report)
  report.rocketflare = runHeader({
    sha,
    dirty: git('status', '--porcelain').length > 0,
    createdAt,
    filters: opts.filters,
    model: opts.model,
    judgeModel: opts.judgeModel,
    cases,
  })
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\n${renderSummary(cases)}\n\nrun: ${path.relative(process.cwd(), file)}`)

  if (opts.compare) {
    const base =
      opts.compare === 'baseline'
        ? scoreIndex(loadBaselines())
        : scoreIndex(extractCases(readReport(path.resolve(opts.compare))))
    const diff = compareScores(base, scoreIndex(cases), opts.threshold)
    console.log(`\ncompared with ${opts.compare}:\n${renderComparison(diff, opts.threshold)}`)
    if (diff.regressions.length) return 1
  }
  return result.status ?? 0
}

function baseline(opts) {
  const source = opts.from ? path.resolve(opts.from) : latestRun()
  if (!source) {
    console.error('✗ No run to baseline from — run `pnpm eval` first.')
    return 1
  }
  const report = readReport(source)
  const header = report.rocketflare ?? runHeader({ createdAt: new Date().toISOString(), cases: [] })
  const all = baselinesFrom(extractCases(report), header)
  const wanted = opts.filters.length
    ? Object.keys(all).filter(s => opts.filters.some(f => s.includes(f)))
    : Object.keys(all)
  if (wanted.length === 0) {
    console.error('✗ That run has no scored cases for those suites (were they skipped?).')
    return 1
  }
  mkdirSync(BASELINES, { recursive: true })
  for (const suite of wanted) {
    const target = path.join(BASELINES, `${suite}.json`)
    writeFileSync(target, `${JSON.stringify(all[suite], null, 2)}\n`)
    console.log(
      `✓ ${path.relative(process.cwd(), target)} (${Object.keys(all[suite].cases).length} cases, from ${path.basename(source)})`
    )
  }
  return 0
}

function previousRun() {
  if (!existsSync(RUNS)) return null
  const files = readdirSync(RUNS)
    .filter(f => f.endsWith('.json'))
    .sort()
  return files.length > 1 ? path.join(RUNS, files.at(-2)) : null
}

/**
 * `pnpm eval:view [a.json [b.json]] [--compare [baseline|<run.json>]]`. The report UI (run list,
 * case ledger, transcripts, judge rationales) has no side-by-side view, so the DIFF is printed here
 * first — every per-case, per-judge score that moved between the two — and the UI then serves both
 * runs so each changed case can be opened. Two files diff each other; one file (or none: the latest)
 * diffs against `--compare`, defaulting to the run before it.
 */
function view(opts) {
  const files = opts.filters.map(f => path.resolve(f))
  const current = files.at(-1) ?? latestRun()
  if (!current) {
    console.error('✗ No runs in .evals/runs yet — run `pnpm eval` first.')
    return 1
  }
  const against =
    files.length >= 2
      ? files[0]
      : opts.compare && opts.compare !== 'baseline'
        ? path.resolve(opts.compare)
        : opts.compare === 'baseline'
          ? 'baseline'
          : previousRun()
  if (against) {
    const base =
      against === 'baseline'
        ? scoreIndex(loadBaselines())
        : scoreIndex(extractCases(readReport(against)))
    const diff = compareScores(base, scoreIndex(extractCases(readReport(current))), 0)
    const label = against === 'baseline' ? 'the baselines' : path.basename(against)
    console.log(`${path.basename(current)} vs ${label}:\n${renderComparison(diff, 0)}\n`)
  }
  const inputs = files.length ? files : [RUNS]
  const bin = path.join(ROOT, 'node_modules', '.bin', 'vitest-evals')
  return spawnSync(bin, ['serve', ...inputs], { cwd: ROOT, stdio: 'inherit' }).status ?? 0
}

const [command = 'run', ...rest] = process.argv.slice(2)
let opts
try {
  opts = parseArgs(rest)
} catch (err) {
  console.error(`✗ ${err.message}`)
  process.exit(2)
}
const commands = { run, baseline, view }
if (!commands[command]) {
  console.error(`✗ unknown command "${command}" (run | baseline | view)`)
  process.exit(2)
}
process.exit(commands[command](opts))
