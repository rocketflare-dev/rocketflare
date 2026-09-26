/**
 * One isolated world per case (D33): a fresh tenant and owner, a session cookie, the case's context
 * documents ingested through the real `ingestText`, and — with `--model` — an `agent_models` row
 * pinning the prompt keys the target uses. A tenant per case is what makes retrieval honest: the
 * model can only find what THIS case put there, and nothing a previous case left behind.
 *
 * Rows are left in the test database, as the test suites leave theirs (`.claude/rules/testing.md`).
 */
import type { EvalCase } from '@rocketflare/shared/ai/evals'
import { ingestText } from '@/api/services/ai/ingest'
import { agentModels, messages } from '@/db/schema'
import {
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../../web/tests/helpers/auth'
import { setupTestDatabase } from '../../web/tests/helpers/db'
import type { TestEnv } from '../../web/tests/mocks/bindings'
import { EVAL_MODEL, evalConfig, evalWorkerEnv } from './env'

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
