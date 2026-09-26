/**
 * Datasets are code (D33): `apps/evals/datasets/<name>.jsonl`, one `EvalCase` per line, parsed with
 * the shared schema so a promoted case (`rocketflare evals promote`) and a hand-written one are the
 * same thing. A malformed line fails the suite at collection time with its line number — a dataset
 * that silently drops a case is a regression suite that silently stops checking it.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type EvalCase, evalCaseSchema } from '@rocketflare/shared/ai/evals'

export const DATASETS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../datasets'
)

export function parseDataset(name: string, text: string): EvalCase[] {
  const cases: EvalCase[] = []
  const ids = new Set<string>()
  text.split('\n').forEach((line, index) => {
    if (!line.trim() || line.trim().startsWith('//')) return
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch (err) {
      throw new Error(`${name}.jsonl:${index + 1}: not JSON (${(err as Error).message})`)
    }
    const parsed = evalCaseSchema.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new Error(
        `${name}.jsonl:${index + 1}: ${issue?.path.join('.') || '(case)'} ${issue?.message ?? 'invalid'}`
      )
    }
    if (ids.has(parsed.data.id)) {
      throw new Error(`${name}.jsonl:${index + 1}: duplicate case id "${parsed.data.id}"`)
    }
    ids.add(parsed.data.id)
    cases.push(parsed.data)
  })
  return cases
}

/** Every case in `datasets/<name>.jsonl`; `EVAL_CASE` (comma-separated ids) narrows it. */
export function loadDataset(name: string, dir = DATASETS_DIR): EvalCase[] {
  const cases = parseDataset(name, readFileSync(path.join(dir, `${name}.jsonl`), 'utf8'))
  const only = process.env.EVAL_CASE?.split(',').filter(Boolean)
  return only?.length ? cases.filter(c => only.includes(c.id)) : cases
}
