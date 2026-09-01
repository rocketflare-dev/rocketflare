/**
 * Built-in agent tools (D7, D18): `search_knowledge` runs the same hybrid search as `/search`,
 * scoped to the run's tenant — it finds an indexed document, never another tenant's, narrows with
 * `documentId`, truncates long passages, validates its input with the shared limits, and answers
 * in plain text (no throw) when the tenant has no embeddings provider. `get_document` reads a
 * document whole or by character window with paging hints, and answers in prose for another
 * tenant's / unknown / not-yet-converted documents. `buildAgentTools` is what the runtime puts on
 * `ctx.tools`.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  buildAgentTools,
  GET_DOCUMENT_DEFAULT_CHARS,
  GET_DOCUMENT_MAX_CHARS,
  GET_DOCUMENT_TOOL,
  type GetDocumentResult,
  getDocumentTool,
  SEARCH_KNOWLEDGE_EXCERPT_CHARS,
  SEARCH_KNOWLEDGE_TOOL,
  type SearchKnowledgeResult,
  searchKnowledgeTool,
} from '@/api/services/agents/tools'
import { ingestText } from '@/api/services/ai/ingest'
import { loadConfig } from '@/config'
import { documents } from '@/db/schema'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

/** A unit vector along axis `i` (1024-dim); texts about a topic embed to that topic's axis. */
function axis(i: number): number[] {
  const v = new Array<number>(1024).fill(0)
  v[i] = 1
  return v
}
const TOPICS = ['volcano', 'banana'] as const
function keywordEnv(): TestEnv {
  const env = createTestEnv()
  const ai = stubs(env).ai
  if (ai) {
    ai.respond = (_model, inputs) => {
      const texts = Array.isArray(inputs.text) ? (inputs.text as string[]) : [String(inputs.text)]
      return {
        shape: [texts.length, 1024],
        data: texts.map(t => {
          const idx = TOPICS.findIndex(topic => t.toLowerCase().includes(topic))
          return axis(idx === -1 ? 900 : idx)
        }),
      }
    }
  }
  return env
}

async function seeded() {
  const { tenant, user } = await createTestTenantWithUser(db, 'owner')
  const env = keywordEnv()
  const cfg = loadConfig(env)
  const ingest = (title: string, text: string) =>
    ingestText(db, cfg, env, { tenantId: tenant.id, userId: user.id, title, text })
  const volcano = (
    await ingest('Volcanoes', 'A volcano is a rupture in the crust. Volcano eruptions eject lava.')
  ).document
  const banana = (await ingest('Bananas', 'The banana is an edible fruit rich in potassium.'))
    .document
  return { tenant, env, cfg, volcano, banana }
}

const parse = (s: string) => JSON.parse(s) as SearchKnowledgeResult

/** A tool's handler is optional in the `Tool` type (a terminal tool has none); ours always has one. */
function handlerOf<T>(tool: { name: string; handler?: (input: T) => Promise<string> }) {
  const { handler } = tool
  if (!handler) throw new Error(`${tool.name} has no handler`)
  return handler
}

describe('search_knowledge tool', () => {
  it('is on ctx.tools and finds the indexed document for the run tenant only', async () => {
    const { tenant, env, cfg, volcano } = await seeded()
    const tools = buildAgentTools({ db, cfg, env, tenantId: tenant.id })
    expect(tools.map(t => t.name)).toEqual([SEARCH_KNOWLEDGE_TOOL, GET_DOCUMENT_TOOL])
    const search = handlerOf(searchKnowledgeTool({ db, cfg, env, tenantId: tenant.id }))
    const out = parse(await search({ query: 'how does a volcano erupt', limit: 5 }))
    expect(out.query).toBe('how does a volcano erupt')
    expect(out.hits[0]).toMatchObject({ rank: 1, documentId: volcano.id, title: 'Volcanoes' })
    expect(out.hits[0]?.excerpt).toContain('lava')
    expect(typeof out.hits[0]?.score).toBe('number')

    // Another tenant with the same query sees nothing.
    const other = await createTestTenantWithUser(db, 'owner')
    const theirs = handlerOf(searchKnowledgeTool({ db, cfg, env, tenantId: other.tenant.id }))
    expect(parse(await theirs({ query: 'volcano', limit: 5 })).hits).toEqual([])
  })

  it('narrows with documentId and truncates long passages', async () => {
    const { tenant, env, cfg, banana } = await seeded()
    const tool = searchKnowledgeTool({ db, cfg, env, tenantId: tenant.id })
    const search = handlerOf(tool)
    const narrowed = parse(await search({ query: 'volcano', limit: 5, documentId: banana.id }))
    expect(narrowed.hits.every(h => h.documentId === banana.id)).toBe(true)

    const { user } = await createTestTenantWithUser(db, 'owner')
    const long = 'banana '.repeat(600)
    await ingestText(db, cfg, env, {
      tenantId: tenant.id,
      userId: user.id,
      title: 'Long',
      text: long,
    })
    const hit = parse(await search({ query: 'banana', limit: 3 })).hits.find(
      h => h.title === 'Long'
    )
    expect(hit).toBeDefined()
    expect(hit?.excerpt.length).toBeLessThanOrEqual(SEARCH_KNOWLEDGE_EXCERPT_CHARS + 1)
    expect(hit?.excerpt.endsWith('…')).toBe(true)
  })

  it('validates its input with the shared limits and answers in prose without a provider', async () => {
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const env = createTestEnv({ AI: undefined, EMBEDDINGS_API_KEY: undefined })
    const tool = searchKnowledgeTool({ db, cfg: loadConfig(env), env, tenantId: tenant.id })
    const search = handlerOf(tool)
    expect(tool.schema.safeParse({ query: '' }).success).toBe(false)
    expect(tool.schema.safeParse({ query: 'x', limit: 99 }).success).toBe(false)
    expect(tool.schema.parse({ query: 'x' })).toEqual({ query: 'x' })

    const answer = await search({ query: 'anything', limit: 5 })
    expect(answer).toMatch(/not available/)
    expect(() => JSON.parse(answer)).toThrow()
  })
})

describe('get_document tool', () => {
  const parseDoc = (s: string) => JSON.parse(s) as GetDocumentResult

  it('reads a document in full, or a window with paging hints', async () => {
    const { tenant, env, cfg, volcano } = await seeded()
    const tool = getDocumentTool({ db, cfg, env, tenantId: tenant.id })
    const read = handlerOf(tool)
    expect(tool.schema.parse({ documentId: volcano.id })).toEqual({ documentId: volcano.id })
    // Omitted window = the default page from the start.
    const defaulted = parseDoc(await read({ documentId: volcano.id }))
    expect(defaulted).toMatchObject({ offset: 0, hasMore: false })
    expect(defaulted.text.length).toBeLessThanOrEqual(GET_DOCUMENT_DEFAULT_CHARS)
    expect(
      tool.schema.safeParse({ documentId: volcano.id, maxChars: GET_DOCUMENT_MAX_CHARS + 1 })
        .success
    ).toBe(false)

    const full = parseDoc(await read({ documentId: volcano.id, offset: 0, maxChars: 20_000 }))
    expect(full).toMatchObject({
      documentId: volcano.id,
      title: 'Volcanoes',
      contentType: 'text/plain',
      status: 'indexed',
      offset: 0,
      hasMore: false,
      nextOffset: null,
    })
    expect(full.text).toContain('Volcano eruptions eject lava.')
    expect(full.totalChars).toBe(full.text.length)

    const first = parseDoc(await read({ documentId: volcano.id, offset: 0, maxChars: 10 }))
    expect(first.text).toBe(full.text.slice(0, 10))
    expect(first).toMatchObject({ hasMore: true, nextOffset: 10 })
    const rest = parseDoc(await read({ documentId: volcano.id, offset: 10, maxChars: 20_000 }))
    expect(first.text + rest.text).toBe(full.text)
    expect(rest.hasMore).toBe(false)
    // Past the end: empty window, not an error.
    const past = parseDoc(await read({ documentId: volcano.id, offset: 10_000, maxChars: 10 }))
    expect(past.text).toBe('')
    expect(past.offset).toBe(full.totalChars)
  })

  it('answers in prose for another tenant, an unknown id, or an unconverted / failed upload', async () => {
    const { tenant, env, cfg, volcano } = await seeded()
    const other = await createTestTenantWithUser(db, 'owner')
    const theirs = handlerOf(getDocumentTool({ db, cfg, env, tenantId: other.tenant.id }))
    expect(await theirs({ documentId: volcano.id, offset: 0, maxChars: 100 })).toMatch(
      /No document with id/
    )
    const mine = handlerOf(getDocumentTool({ db, cfg, env, tenantId: tenant.id }))
    expect(await mine({ documentId: crypto.randomUUID(), offset: 0, maxChars: 100 })).toMatch(
      /No document with id/
    )

    const [pending] = await db
      .insert(documents)
      .values({ tenantId: tenant.id, title: 'Slides', contentType: 'application/pdf' })
      .returning()
    expect(await mine({ documentId: pending?.id ?? '', offset: 0, maxChars: 100 })).toMatch(
      /still being converted/
    )
    await db
      .update(documents)
      .set({ status: 'failed', error: 'Conversion failed: corrupt' })
      .where(eq(documents.id, pending?.id ?? ''))
    expect(await mine({ documentId: pending?.id ?? '', offset: 0, maxChars: 100 })).toMatch(
      /could not be indexed \(Conversion failed: corrupt\)/
    )
  })
})
