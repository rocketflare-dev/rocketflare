/**
 * Built-in agent tools (D7, D18). `search_knowledge` runs the same hybrid search as `/search`,
 * scoped to the run's tenant: whole passages grouped by document, a per-answer budget that REPORTS
 * what it dropped, and — when nothing matches or no embeddings provider exists — a structured
 * answer carrying the documents that do exist so the model can re-aim instead of inventing.
 * `get_document` reads a document whole or by window with paging hints, and turns every dead end
 * (another tenant's id, an unknown id, an unconverted or failed upload) into an `error` + `hint`.
 * `list_documents` is the "what is in here at all" view the other two borrow. `buildAgentTools` is
 * what the runtime puts on `ctx.tools`.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  buildAgentTools,
  EVENT_PREVIEW_CHARS,
  GET_DOCUMENT_DEFAULT_CHARS,
  GET_DOCUMENT_MAX_CHARS,
  GET_DOCUMENT_TOOL,
  type GetDocumentResult,
  getDocumentTool,
  LIST_DOCUMENTS_TOOL,
  type ListDocumentsResult,
  listDocumentsTool,
  PASSAGE_MAX_CHARS,
  SEARCH_KNOWLEDGE_TOOL,
  type SearchKnowledgeResult,
  searchKnowledgeTool,
  summariseToolResult,
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
    expect(tools.map(t => t.name)).toEqual([
      SEARCH_KNOWLEDGE_TOOL,
      GET_DOCUMENT_TOOL,
      LIST_DOCUMENTS_TOOL,
    ])
    const search = handlerOf(searchKnowledgeTool({ db, cfg, env, tenantId: tenant.id }))
    const out = parse(await search({ query: 'how does a volcano erupt', limit: 5 }))
    expect(out.query).toBe('how does a volcano erupt')
    // Grouped by document, whole passages, position reported.
    expect(out.documents[0]).toMatchObject({
      documentId: volcano.id,
      title: 'Volcanoes',
      totalPassages: 1,
      matchingPassages: 1,
    })
    // Located in the document: passage 1 of 1, starting at character 0.
    const best = out.documents[0]?.passages[0]
    expect(best).toMatchObject({ rank: 1, passage: 1, charOffset: 0 })
    expect(best?.text).toBe('A volcano is a rupture in the crust. Volcano eruptions eject lava.')
    expect(best?.truncated).toBeUndefined()
    expect(out.passagesReturned).toBe(out.documents.flatMap(d => d.passages).length)

    // Another tenant with the same query sees nothing — and is told what it DOES have.
    const other = await createTestTenantWithUser(db, 'owner')
    const theirs = handlerOf(searchKnowledgeTool({ db, cfg, env, tenantId: other.tenant.id }))
    const empty = parse(await theirs({ query: 'volcano', limit: 5 }))
    expect(empty.documents).toEqual([])
    expect(empty.knowledgeBase).toEqual([])
    expect(empty.hint).toMatch(/knowledge base is empty/i)
  })

  it('returns the nearest passages for an off-topic query, and says relevance is the reader’s call', async () => {
    // Dense retrieval has no threshold: an unrelated query still gets the closest passages, so the
    // answer must tell the model to judge them rather than trust the ranking.
    const { tenant, env, cfg } = await seeded()
    const search = handlerOf(searchKnowledgeTool({ db, cfg, env, tenantId: tenant.id }))
    const out = parse(await search({ query: 'quarterly revenue in singapore' }))
    expect(out.passagesReturned).toBeGreaterThan(0)
    expect(out.note).toMatch(/not a relevance filter/)
    expect(out.knowledgeBase).toBeUndefined()
  })

  it('offers the documents that exist when the tenant has nothing indexed', async () => {
    const { tenant, user } = await createTestTenantWithUser(db, 'owner')
    const env = keywordEnv()
    const cfg = loadConfig(env)
    // A document that is still converting has no chunks — searchable content is genuinely absent.
    await db
      .insert(documents)
      .values({ tenantId: tenant.id, title: 'Slides', contentType: 'application/pdf' })
    const search = handlerOf(searchKnowledgeTool({ db, cfg, env, tenantId: tenant.id }))
    const empty = parse(await search({ query: 'anything' }))
    expect(empty.passagesReturned).toBe(0)
    expect(empty.knowledgeBase).toEqual([])
    expect(empty.hint).toMatch(/knowledge base is empty/i)

    // Once something IS indexed, the same dead end names it.
    const { document } = await ingestText(db, cfg, env, {
      tenantId: tenant.id,
      userId: user.id,
      title: 'Handbook',
      text: 'Access requests are reviewed by a global admin.',
    })
    const read = handlerOf(getDocumentTool({ db, cfg, env, tenantId: tenant.id }))
    const unknown = JSON.parse(await read({ documentId: crypto.randomUUID() })) as {
      knowledgeBase?: { documentId: string; title: string }[]
    }
    expect(unknown.knowledgeBase).toEqual([
      expect.objectContaining({ documentId: document.id, title: 'Handbook' }),
    ])
  })

  it('narrows with documentId, and caps a very long passage at the per-passage budget', async () => {
    const { tenant, env, cfg, banana } = await seeded()
    const tool = searchKnowledgeTool({ db, cfg, env, tenantId: tenant.id })
    const search = handlerOf(tool)
    const narrowed = parse(await search({ query: 'banana', limit: 5, documentId: banana.id }))
    expect(narrowed.documents.every(d => d.documentId === banana.id)).toBe(true)

    const { user } = await createTestTenantWithUser(db, 'owner')
    await ingestText(db, cfg, env, {
      tenantId: tenant.id,
      userId: user.id,
      title: 'Long',
      text: 'banana '.repeat(1200),
    })
    const long = parse(await search({ query: 'banana', limit: 3 })).documents.find(
      d => d.title === 'Long'
    )
    expect(long).toBeDefined()
    for (const passage of long?.passages ?? []) {
      expect(passage.text.length).toBeLessThanOrEqual(PASSAGE_MAX_CHARS + 1)
      // A passage under the cap arrives whole — only a longer one is marked.
      expect(passage.truncated ?? false).toBe(passage.text.endsWith('…'))
    }
  })

  it('validates its input with the shared limits and explains itself without a provider', async () => {
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const env = createTestEnv({ AI: undefined, EMBEDDINGS_API_KEY: undefined })
    const tool = searchKnowledgeTool({ db, cfg: loadConfig(env), env, tenantId: tenant.id })
    const search = handlerOf(tool)
    expect(tool.schema.safeParse({ query: '' }).success).toBe(false)
    expect(tool.schema.safeParse({ query: 'x', limit: 99 }).success).toBe(false)
    expect(tool.schema.parse({ query: 'x' })).toEqual({ query: 'x' })
    expect(tool.schema.parse({ query: 'x', limit: '3' })).toEqual({ query: 'x', limit: 3 })

    const answer = JSON.parse(await search({ query: 'anything', limit: 5 })) as {
      error: string
      hint: string
    }
    expect(answer.error).toBe('knowledge_search_unavailable')
    expect(answer.hint).toMatch(/no embeddings provider/)
  })
})

describe('get_document tool', () => {
  const parseDoc = (s: string) => JSON.parse(s) as GetDocumentResult

  it('reads a document in full, or a window with paging hints', async () => {
    const { tenant, env, cfg, volcano } = await seeded()
    const tool = getDocumentTool({ db, cfg, env, tenantId: tenant.id })
    const read = handlerOf(tool)
    expect(tool.schema.parse({ documentId: volcano.id })).toEqual({ documentId: volcano.id })
    // Small models send numbers as strings ("offset": "120"); coerce rather than fail the call.
    expect(tool.schema.parse({ documentId: volcano.id, offset: '120', maxChars: '900' })).toEqual({
      documentId: volcano.id,
      offset: 120,
      maxChars: 900,
    })
    expect(tool.schema.safeParse({ documentId: volcano.id, offset: 'soon' }).success).toBe(false)
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

  it('turns every dead end into an error + hint, with the real documents for an unknown id', async () => {
    const { tenant, env, cfg, volcano } = await seeded()
    const problem = (s: string) =>
      JSON.parse(s) as {
        error: string
        hint: string
        knowledgeBase?: { documentId: string; title: string }[]
      }

    // Another tenant's id does not exist HERE, and the answer offers this tenant's own documents.
    const other = await createTestTenantWithUser(db, 'owner')
    const theirs = handlerOf(getDocumentTool({ db, cfg, env, tenantId: other.tenant.id }))
    const crossTenant = problem(await theirs({ documentId: volcano.id, maxChars: 100 }))
    expect(crossTenant.error).toBe('document_not_found')
    expect(crossTenant.knowledgeBase).toEqual([])

    const mine = handlerOf(getDocumentTool({ db, cfg, env, tenantId: tenant.id }))
    const unknown = problem(await mine({ documentId: crypto.randomUUID(), maxChars: 100 }))
    expect(unknown.error).toBe('document_not_found')
    expect(unknown.knowledgeBase?.map(d => d.documentId)).toContain(volcano.id)
    expect(unknown.hint).toMatch(/Pick one of the documents/)

    const [pending] = await db
      .insert(documents)
      .values({ tenantId: tenant.id, title: 'Slides', contentType: 'application/pdf' })
      .returning()
    expect(problem(await mine({ documentId: pending?.id ?? '' })).error).toBe('not_yet_converted')
    await db
      .update(documents)
      .set({ status: 'failed', error: 'Conversion failed: corrupt' })
      .where(eq(documents.id, pending?.id ?? ''))
    const failed = problem(await mine({ documentId: pending?.id ?? '' }))
    expect(failed.error).toBe('conversion_failed')
    expect(failed.hint).toMatch(/Conversion failed: corrupt/)
  })
})

describe('summariseToolResult (the tool.end audit trail)', () => {
  it('keeps every hit identifiable and previews only the prose', async () => {
    const { tenant, env, cfg, volcano } = await seeded()
    const search = handlerOf(searchKnowledgeTool({ db, cfg, env, tenantId: tenant.id }))
    const raw = await search({ query: 'volcano' })
    const summary = summariseToolResult(SEARCH_KNOWLEDGE_TOOL, raw) as SearchKnowledgeResult

    // Parsed, not a JSON string: the drawer renders structure, not escaped quotes.
    expect(typeof summary).toBe('object')
    const doc = summary.documents.find(d => d.documentId === volcano.id)
    expect(doc).toMatchObject({ title: 'Volcanoes', totalPassages: 1 })
    // Identity survives so a person can find the passage; only long prose is previewed.
    expect(doc?.passages[0]).toMatchObject({ rank: 1, passage: 1, charOffset: 0 })
    expect(doc?.passages[0]?.text).toContain('lava')

    const long = JSON.stringify({
      query: 'q',
      documents: [
        { documentId: volcano.id, title: 'Long', passages: [{ rank: 1, text: 'x'.repeat(5000) }] },
      ],
    })
    const trimmed = summariseToolResult(SEARCH_KNOWLEDGE_TOOL, long) as {
      documents: Array<{ passages: Array<{ text: string; truncated?: boolean }> }>
    }
    const passage = trimmed.documents[0]?.passages[0]
    expect(passage?.text).toHaveLength(EVENT_PREVIEW_CHARS + 1) // + the ellipsis
    expect(passage?.truncated).toBe(true)
  })

  it('previews a document window, and passes a dead end or non-JSON answer through', () => {
    const windowed = summariseToolResult(
      GET_DOCUMENT_TOOL,
      JSON.stringify({
        documentId: 'd',
        title: 'T',
        totalChars: 9000,
        offset: 0,
        text: 'y'.repeat(3000),
        hasMore: true,
      })
    ) as { title: string; hasMore: boolean; text: string; truncated?: boolean }
    expect(windowed).toMatchObject({ title: 'T', hasMore: true, truncated: true })
    expect(windowed.text).toHaveLength(EVENT_PREVIEW_CHARS + 1)

    // `{ error, hint }` is already small and actionable — kept whole.
    const deadEnd = summariseToolResult(
      GET_DOCUMENT_TOOL,
      '{"error":"document_not_found","hint":"pick one"}'
    )
    expect(deadEnd).toEqual({ error: 'document_not_found', hint: 'pick one' })

    expect(summariseToolResult('whatever', 'not json at all')).toBe('not json at all')
  })
})

describe('list_documents tool', () => {
  const parseList = (s: string) => JSON.parse(s) as ListDocumentsResult

  it('lists indexed documents newest first, with sizes and paging', async () => {
    const { tenant, env, cfg, volcano, banana } = await seeded()
    const tool = listDocumentsTool({ db, cfg, env, tenantId: tenant.id })
    const list = handlerOf(tool)

    const all = parseList(await list({}))
    expect(all.total).toBe(2)
    expect(all.documents.map(d => d.documentId).sort()).toEqual([volcano.id, banana.id].sort())
    expect(all.documents.find(d => d.documentId === volcano.id)).toMatchObject({
      title: 'Volcanoes',
      contentType: 'text/plain',
      passages: 1,
      totalChars: 66,
    })
    expect(all.hasMore).toBe(false)
    expect(all.nextOffset).toBeNull()

    // Paged: two calls see each document exactly once.
    const page = parseList(await list({ limit: 1 }))
    expect(page).toMatchObject({ total: 2, hasMore: true, nextOffset: 1 })
    expect(page.hint).toMatch(/offset 1/)
    const rest = parseList(await list({ limit: 1, offset: page.nextOffset ?? 0 }))
    expect(rest.hasMore).toBe(false)
    expect([...page.documents, ...rest.documents].map(d => d.documentId).sort()).toEqual(
      [volcano.id, banana.id].sort()
    )
  })

  it('omits documents that are not indexed yet, and says so when there are none', async () => {
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const env = keywordEnv()
    const ctx = { db, cfg: loadConfig(env), env, tenantId: tenant.id }
    await db
      .insert(documents)
      .values({ tenantId: tenant.id, title: 'Converting', contentType: 'application/pdf' })
    const empty = parseList(await handlerOf(listDocumentsTool(ctx))({}))
    expect(empty).toMatchObject({ total: 0, documents: [], hasMore: false })
    expect(empty.hint).toMatch(/knowledge base is empty/i)
  })
})
