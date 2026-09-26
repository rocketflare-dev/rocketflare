/**
 * `rocketflare evals promote <messageId|runId> --dataset <name>` (D33) — turn one real answer into
 * a draft eval case and append it to `apps/evals/datasets/<name>.jsonl` for review in a pull
 * request.
 *
 * The draft comes from `GET /api/evals/export` (admin+): the question, the conversation before it,
 * the passages the knowledge tools retrieved, the tools called, and the OBSERVED answer as
 * `expected.output` — a starting point a person corrects, never a gold answer. **It is tenant
 * data**, so the command says so and will not write without `--yes` or a confirmed prompt; a
 * dataset in a repository must not quietly accumulate customers' conversations.
 *
 * `<id>` is tried as a message first and as an agent run on a 404 (`--run` skips the first try).
 */
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  type EvalCase,
  evalCaseSchema,
  evalExportResponseSchema,
} from '@rocketflare/shared/ai/evals'
import { CliApiError } from '../api'
import { type CommandContext, requireClient } from '../context'
import { CliError } from '../errors'

export const DATASETS_DIR = path.join('apps', 'evals', 'datasets')
const DATASET_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/

export interface EvalsPromoteOptions {
  dataset: string
  /** Directory holding `<dataset>.jsonl`; default: `apps/evals/datasets` found from the cwd up. */
  dir?: string
  /** The id is an agent run — skip the message lookup. */
  run?: boolean
  /** Override the case id (default `message-<8>` / `run-<8>`). */
  id?: string
  /** Write without asking. Required when stdin is not a terminal. */
  yes?: boolean
  /** Injected for tests: where to start looking for `apps/evals/datasets`. */
  cwd?: string
  /** Injected for tests: answer the confirmation prompt. */
  confirm?: (question: string) => Promise<boolean>
}

/** The nearest `apps/evals/datasets` at or above `start`, or null. */
export function findDatasetsDir(start: string): string | null {
  let dir = path.resolve(start)
  for (;;) {
    const candidate = path.join(dir, DATASETS_DIR)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function exportCase(ctx: CommandContext, id: string, asRun: boolean) {
  const client = requireClient(ctx)
  const get = (query: Record<string, string>) =>
    client.request('GET', '/api/evals/export', { schema: evalExportResponseSchema, query })
  if (!asRun) {
    try {
      return await get({ messageId: id })
    } catch (error) {
      if (!(error instanceof CliApiError) || error.status !== 404) throw error
    }
  }
  return get({ runId: id })
}

async function existingIds(file: string): Promise<Set<string>> {
  if (!existsSync(file)) return new Set()
  const ids = new Set<string>()
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue
    try {
      const id = (JSON.parse(line) as { id?: unknown }).id
      if (typeof id === 'string') ids.add(id)
    } catch {
      // A malformed line is the suite's problem to report, not a reason to refuse a new case.
    }
  }
  return ids
}

async function askOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim())
  } finally {
    rl.close()
  }
}

export async function runEvalsPromote(
  ctx: CommandContext,
  id: string,
  options: EvalsPromoteOptions
): Promise<void> {
  if (!DATASET_NAME_RE.test(options.dataset)) {
    throw new CliError(`Invalid dataset name "${options.dataset}"`, {
      hint: 'Use lowercase letters, digits, dot, dash or underscore — it becomes <name>.jsonl.',
    })
  }
  const dir = options.dir ?? findDatasetsDir(options.cwd ?? process.cwd())
  if (!dir) {
    throw new CliError(`Could not find ${DATASETS_DIR} from here`, {
      hint: 'Run this inside the app repository, or pass --dir <path>.',
    })
  }

  const { data, raw } = await exportCase(ctx, id, Boolean(options.run))
  const evalCase: EvalCase = evalCaseSchema.parse({
    ...data.case,
    ...(options.id ? { id: options.id } : {}),
  })
  const file = path.join(dir, `${options.dataset}.jsonl`)
  if ((await existingIds(file)).has(evalCase.id)) {
    throw new CliError(`${options.dataset}.jsonl already has a case "${evalCase.id}"`, {
      hint: 'Pass --id <new-id> to add it under another id.',
    })
  }

  ctx.log.warn(
    'This case is TENANT DATA: a real question, the documents retrieved for it and the answer given.'
  )
  ctx.log.hint(
    'Review and redact it before committing, and correct expected.output — it is the OBSERVED answer, not a gold one.'
  )
  if (!options.yes) {
    const ask = options.confirm ?? (process.stdin.isTTY ? askOnTerminal : undefined)
    if (!ask) {
      throw new CliError('Refusing to write tenant data without confirmation', {
        hint: 'Re-run with --yes once you have decided the case belongs in the repository.',
      })
    }
    if (!(await ask(`Append "${evalCase.id}" to ${path.relative(process.cwd(), file) || file}?`))) {
      ctx.log.info('Nothing written.')
      return
    }
  }

  await mkdir(dir, { recursive: true })
  await appendFile(file, `${JSON.stringify(evalCase)}\n`, 'utf8')
  ctx.out.data({ ...(raw as object), file, id: evalCase.id }, () => `${file}  +${evalCase.id}`)
  ctx.log.success(`Added ${evalCase.id} to ${options.dataset}.jsonl`)
  ctx.log.hint(
    'Next: draft the expected output and rubric with the rf-evals skill, then run pnpm eval.'
  )
}
