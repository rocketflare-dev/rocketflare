/**
 * A CORPUS is a directory of documents with answer keys, ingested once and shared by every case that
 * asks about it — the retrieval suite, the corpus chat cases and (with extraction) the facts suite.
 * Where a dataset case brings its own two or three documents, a corpus is a whole business's worth:
 * enough documents that ranking matters, near-duplicates that make a wrong hit possible, and facts
 * planted on purpose so extraction can be scored.
 *
 * Layout, under `datasets/` at any depth (the kit's own lives in `datasets/kit-only/<name>/`):
 *
 * ```
 * <name>/docs/<doc-id>.md   front matter (title, date, origin, source, kind) + a markdown body
 * <name>/retrieval.jsonl    { id, query, expected: [{ doc, passage }], tags }
 * <name>/chat.jsonl         EvalCase lines whose documents are the corpus (`context: []`)
 * <name>/entities.jsonl     { entityType, name, aliases }
 * <name>/facts.jsonl        { id, entityType, entity, key, value, doc, quote, validFrom, validTo }
 * <name>/conflicts.jsonl    { id, entityType, entity, key, a, b, winner, why }
 * ```
 *
 * Every answer key names PASSAGE TEXT, never a chunk id, so it survives a change to the chunker.
 * Pure: no database, no model — `checkCorpus` runs in the gate (`tests/corpus.test.ts`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { type EvalCase, evalCaseSchema } from '@rocketflare/shared/ai/evals'
import { z } from 'zod'
import { DATASETS_DIR } from './dataset'

const docId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'a doc id is kebab-case')

export const corpusDocMetaSchema = z.object({
  title: z.string().min(1),
  /** When the document was written — what a relative date in it is resolved against. */
  date: z.iso.date(),
  /** `upload` = a person put it in; `integration` = a connector synced it (weaker evidence). */
  origin: z.enum(['upload', 'integration']),
  /** `documents.source` at ingest. */
  source: z.string().min(1),
  kind: z.string().min(1),
})

export interface CorpusDoc extends z.infer<typeof corpusDocMetaSchema> {
  id: string
  /** The body after the front matter — exactly what is ingested. */
  text: string
}

export const retrievalCaseSchema = z.object({
  id: docId,
  query: z.string().min(1),
  expected: z.array(z.object({ doc: docId, passage: z.string().min(1) })).min(1),
  tags: z.array(z.string()).default([]),
})
export type RetrievalCase = z.infer<typeof retrievalCaseSchema>

export const corpusEntitySchema = z.object({
  entityType: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
})
export type CorpusEntity = z.infer<typeof corpusEntitySchema>

export const plantedFactSchema = z.object({
  id: docId,
  entityType: z.string().min(1),
  entity: z.string().min(1),
  key: z.string().min(1),
  value: z.unknown(),
  doc: docId,
  quote: z.string().min(1),
  validFrom: z.iso.date().nullable().default(null),
  validTo: z.iso.date().nullable().default(null),
})
export type PlantedFact = z.infer<typeof plantedFactSchema>

export const plantedConflictSchema = z.object({
  id: docId,
  entityType: z.string().min(1),
  entity: z.string().min(1),
  key: z.string().min(1),
  a: docId,
  b: docId,
  winner: z.enum(['a', 'b']),
  why: z.string().default(''),
})
export type PlantedConflict = z.infer<typeof plantedConflictSchema>

export interface Corpus {
  /** Its path under `datasets/`, e.g. `kit-only/brightside`. */
  name: string
  dir: string
  docs: CorpusDoc[]
  retrieval: RetrievalCase[]
  chat: EvalCase[]
  entities: CorpusEntity[]
  facts: PlantedFact[]
  conflicts: PlantedConflict[]
}

/** `---\nkey: value\n---\n<body>` → meta + body. Values are plain scalars; nothing else is parsed. */
export function parseFrontMatter(raw: string, where: string): { meta: unknown; body: string } {
  const text = raw.replace(/\r\n?/g, '\n')
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) throw new Error(`${where}: no front matter (--- … ---) at the top`)
  const meta: Record<string, string> = {}
  for (const line of (match[1] ?? '').split('\n')) {
    if (!line.trim()) continue
    const colon = line.indexOf(':')
    if (colon < 1) throw new Error(`${where}: front matter line "${line}" is not "key: value"`)
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  return { meta, body: text.slice(match[0].length).trim() }
}

function readJsonl<T>(file: string, schema: z.ZodType<T>): T[] {
  if (!existsSync(file)) return []
  const name = path.basename(file)
  const out: T[] = []
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (!line.trim() || line.trim().startsWith('//')) return
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch (err) {
        throw new Error(`${name}:${index + 1}: not JSON (${(err as Error).message})`)
      }
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new Error(
          `${name}:${index + 1}: ${issue?.path.join('.') || '(line)'} ${issue?.message ?? 'invalid'}`
        )
      }
      out.push(parsed.data)
    })
  return out
}

/** Every corpus under `root`, by its relative path — a directory that holds a `docs/` folder. */
export function listCorpora(root = DATASETS_DIR): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (!statSync(full).isDirectory()) continue
      if (entry === 'docs') found.push(path.relative(root, dir).split(path.sep).join('/'))
      else walk(full)
    }
  }
  if (existsSync(root)) walk(root)
  return found.sort()
}

export function loadCorpus(name: string, root = DATASETS_DIR): Corpus {
  const dir = path.join(root, name)
  const docsDir = path.join(dir, 'docs')
  const docs = readdirSync(docsDir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(file => {
      const where = `${name}/docs/${file}`
      const { meta, body } = parseFrontMatter(readFileSync(path.join(docsDir, file), 'utf8'), where)
      const parsed = corpusDocMetaSchema.safeParse(meta)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new Error(`${where}: ${issue?.path.join('.')} ${issue?.message}`)
      }
      return { id: file.replace(/\.md$/, ''), ...parsed.data, text: body }
    })
  const chatOnly = process.env.EVAL_CASE?.split(',').filter(Boolean)
  const chat = readJsonl(path.join(dir, 'chat.jsonl'), evalCaseSchema)
  return {
    name,
    dir,
    docs,
    retrieval: readJsonl(path.join(dir, 'retrieval.jsonl'), retrievalCaseSchema),
    chat: chatOnly?.length ? chat.filter(c => chatOnly.includes(c.id)) : chat,
    entities: readJsonl(path.join(dir, 'entities.jsonl'), corpusEntitySchema),
    facts: readJsonl(path.join(dir, 'facts.jsonl'), plantedFactSchema),
    conflicts: readJsonl(path.join(dir, 'conflicts.jsonl'), plantedConflictSchema),
  }
}

/** Whitespace-collapsed and lower-cased: how a passage is compared with a chunk. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Everything that would make a score meaningless, as a list of problems (empty = sound): a key
 * naming a document that does not exist, a quote or passage that is not verbatim in its document,
 * a duplicate id, a conflict whose sides disagree on entity or key, an entity nobody declared.
 */
export function checkCorpus(corpus: Corpus): string[] {
  const problems: string[] = []
  const docs = new Map(corpus.docs.map(d => [d.id, d]))
  const inDoc = (doc: string, text: string, what: string) => {
    const d = docs.get(doc)
    if (!d) problems.push(`${what}: no document "${doc}"`)
    else if (!d.text.includes(text)) problems.push(`${what}: not verbatim in ${doc}: "${text}"`)
  }
  const unique = (file: string, ids: string[]) => {
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) problems.push(`${file}: duplicate id "${id}"`)
      seen.add(id)
    }
  }
  unique(
    'retrieval.jsonl',
    corpus.retrieval.map(r => r.id)
  )
  unique(
    'facts.jsonl',
    corpus.facts.map(f => f.id)
  )
  unique(
    'conflicts.jsonl',
    corpus.conflicts.map(c => c.id)
  )
  unique(
    'chat.jsonl',
    corpus.chat.map(c => c.id)
  )
  for (const r of corpus.retrieval) {
    for (const e of r.expected) inDoc(e.doc, e.passage, `retrieval ${r.id}`)
  }
  const entities = new Set(corpus.entities.map(e => `${e.entityType}:${e.name}`))
  const facts = new Map(corpus.facts.map(f => [f.id, f]))
  for (const f of corpus.facts) {
    inDoc(f.doc, f.quote, `fact ${f.id}`)
    if (!entities.has(`${f.entityType}:${f.entity}`)) {
      problems.push(`fact ${f.id}: entity ${f.entityType} "${f.entity}" is not in entities.jsonl`)
    }
  }
  for (const c of corpus.conflicts) {
    const a = facts.get(c.a)
    const b = facts.get(c.b)
    if (!a || !b) {
      problems.push(`conflict ${c.id}: ${!a ? c.a : c.b} is not in facts.jsonl`)
      continue
    }
    for (const side of [a, b]) {
      if (side.entity !== c.entity || side.key !== c.key || side.entityType !== c.entityType) {
        problems.push(`conflict ${c.id}: ${side.id} is not ${c.entityType} "${c.entity}" ${c.key}`)
      }
    }
    if (JSON.stringify(a.value) === JSON.stringify(b.value)) {
      problems.push(`conflict ${c.id}: both sides hold the same value`)
    }
  }
  return problems
}
