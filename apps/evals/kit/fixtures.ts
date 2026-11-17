/**
 * One isolated world per case: a fresh tenant and owner, a session cookie, the case's context
 * documents ingested through the real `ingestText`, the `--provider`'s `ai_configs` row when it is
 * not the platform tier, and — with `--model` — an `agent_models` row pinning the prompt keys the
 * target uses. A tenant per case is what makes retrieval honest: the
 * model can only find what THIS case put there, and nothing a previous case left behind.
 *
 * Rows are left in the test database, as the test suites leave theirs (`.claude/rules/testing.md`).
 */
import type { EvalCase } from '@rocketflare/shared/ai/evals'
import { and, eq } from 'drizzle-orm'
import { ingestText } from '@/api/services/ai/ingest'
import { agentModels, documents, messages } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../../web/tests/helpers/auth'
import { setupTestDatabase } from '../../web/tests/helpers/db'
import type { TestEnv } from '../../web/tests/mocks/bindings'
import type { Corpus } from './corpus'
import { EVAL_MODEL, EVAL_PROVIDER, EVAL_RERANK, evalConfig, evalWorkerEnv } from './env'
import { useEmbeddings, useProvider, useRerank } from './providers'

export const evalDb = () => setupTestDatabase()

export interface CaseWorld {
  db: ReturnType<typeof setupTestDatabase>
  env: TestEnv
  cfg: ReturnType<typeof evalConfig>
  tenantId: string
  tenantName: string
  userId: string
  cookie: Record<string, string>
}

export async function caseWorld(
  evalCase: EvalCase,
  promptKeys: readonly string[]
): Promise<CaseWorld> {
  const db = evalDb()
  const env = evalWorkerEnv()
  const cfg = evalConfig(env)
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
  await useProvider(db, cfg, tenant.id, EVAL_PROVIDER, EVAL_MODEL)
  if (EVAL_MODEL) {
    await db
      .insert(agentModels)
      .values(promptKeys.map(promptKey => ({ tenantId: tenant.id, promptKey, model: EVAL_MODEL })))
  }
  for (const doc of evalCase.context) {
    await ingestText(
      db,
      cfg,
      env,
      { tenantId: tenant.id, userId: user.id, title: doc.title, text: doc.text },
      { jobs: env.JOBS_QUEUE }
    )
  }
  return {
    db,
    env,
    cfg,
    tenantId: tenant.id,
    tenantName: tenant.name,
    userId: user.id,
    cookie,
  }
}

/** Seed a conversation's earlier turns, oldest first, one second apart so ordering is stable. */
export async function seedHistory(
  world: CaseWorld,
  conversationId: string,
  history: EvalCase['messages']
): Promise<void> {
  if (history.length === 0) return
  const start = Date.now() - history.length * 1000 - 1000
  await world.db.insert(messages).values(
    history.map((m, i) => ({
      tenantId: world.tenantId,
      conversationId,
      role: m.role,
      content: m.content,
      createdAt: new Date(start + i * 1000),
    }))
  )
}

/** A corpus ingested into one tenant, shared by every case in the process that asks about it. */
export interface CorpusWorld extends CaseWorld {
  corpus: Corpus
  /** `documents.id` → the corpus doc id, and back. */
  docIdOf: Map<string, string>
  documentIdOf: Map<string, string>
}

const corpusWorlds = new Map<string, Promise<CorpusWorld>>()

/**
 * Ingest `corpus` once per process (memoised by name) through the real `ingestText` — an
 * `origin: integration` document marked as a plugin's sync would be — with a REAL
 * embedder (`useEmbeddings`) and the `--rerank` reranker (`useRerank`), each document back-dated to its front-matter `date` so "when was this
 * written" reads true. Every case then runs in this tenant: a corpus is too big to re-ingest per
 * case, and its cases only read it. A document that fails to index fails the world — a corpus with
 * a hole scores a regression that is not one.
 */
export function corpusWorld(corpus: Corpus, promptKeys: readonly string[]): Promise<CorpusWorld> {
  const existing = corpusWorlds.get(corpus.name)
  if (existing) return existing
  const world = (async () => {
    const db = evalDb()
    const env = evalWorkerEnv()
    const cfg = evalConfig(env)
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    await useProvider(db, cfg, tenant.id, EVAL_PROVIDER, EVAL_MODEL)
    await useEmbeddings(db, cfg, tenant.id)
    await useRerank(db, cfg, tenant.id, EVAL_RERANK)
    if (EVAL_MODEL) {
      await db
        .insert(agentModels)
        .values(
          promptKeys.map(promptKey => ({ tenantId: tenant.id, promptKey, model: EVAL_MODEL }))
        )
    }
    const docIdOf = new Map<string, string>()
    const documentIdOf = new Map<string, string>()
    for (const doc of corpus.docs) {
      const { document } = await ingestText(
        db,
        cfg,
        env,
        {
          tenantId: tenant.id,
          userId: user.id,
          title: doc.title,
          text: doc.text,
          source: doc.source,
          contentType: 'text/markdown',
          // What `@/plugins/api` `ingestDocument` sets for a plugin's sync: the facts read from an
          // `integration` document carry that (weaker) trust (D43).
          origin: doc.origin,
        },
        { jobs: env.JOBS_QUEUE }
      )
      if (document.status !== 'indexed') {
        throw new Error(
          `corpus ${corpus.name}: ${doc.id} did not index (${document.status}: ${document.error ?? 'queued'})`
        )
      }
      const written = new Date(`${doc.date}T09:00:00Z`)
      await db
        .update(documents)
        .set({ createdAt: written, updatedAt: written })
        .where(and(eq(documents.id, document.id), eq(documents.tenantId, tenant.id)))
      docIdOf.set(document.id, doc.id)
      documentIdOf.set(doc.id, document.id)
    }
    return {
      db,
      env,
      cfg,
      tenantId: tenant.id,
      tenantName: tenant.name,
      userId: user.id,
      cookie,
      corpus,
      docIdOf,
      documentIdOf,
    }
  })()
  corpusWorlds.set(corpus.name, world)
  return world
}
