/**
 * The structure an indexed chunk carries and what ingest does with a text it has seen before:
 *
 * - every chunk is an exact slice of `documents.content` at `[char_start, char_end)`, with its
 *   heading path, its embedder's model, and the heading path prefixed to what was EMBEDDED (not to
 *   the stored text); a search hit says which section it came from and where it starts;
 * - `documents.content_hash` is sha-256 of the normalised text;
 * - a plain ingest of the same text under the same source answers the existing document (200,
 *   `deduplicated: true`) — between tenant-wide documents only — and a text upload does the same
 *   without storing a second original; an external-id upsert of an unchanged text embeds nothing
 *   and keeps its chunks, while its metadata still follows the source;
 * - the dense leg reads only chunks of the query vector's model: another model's chunk is still
 *   found by keyword.
 */
import { createHash } from 'node:crypto'
import { documentSchema, searchResponseSchema } from '@rocketflare/shared/ai/embeddings'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { ingestText } from '@/api/services/ai/ingest'
import { loadConfig } from '@/config'
import { chunks, documents, files } from '@/db/schema'
import { createTestSession, createTestTenantWithUser, sessionCookieHeader } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { json, request } from '../helpers/request'
import { directUpload } from '../helpers/uploads'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const db = setupTestDatabase()

function axis(i: number): number[] {
  const v = new Array<number>(1024).fill(0)
  v[i] = 1
  return v
}
const TOPICS = ['volcano', 'banana', 'railway'] as const
/** Texts about a topic embed to that topic's axis; anything else to a far-away axis. */
function vectorFor(text: string): number[] {
  const idx = TOPICS.findIndex(topic => text.toLowerCase().includes(topic))
  return axis(idx === -1 ? 900 : idx)
}

/** The env, and every text the embedder was asked to embed. */
function embeddingsEnv(): { env: TestEnv; embedded: string[] } {
  const env = createTestEnv()
  const embedded: string[] = []
  const ai = stubs(env).ai
  if (ai) {
    ai.respond = (_model, inputs) => {
      const texts = Array.isArray(inputs.text) ? (inputs.text as string[]) : [String(inputs.text)]
      embedded.push(...texts)
      return { shape: [texts.length, 1024], data: texts.map(vectorFor) }
    }
  }
  return { env, embedded }
}

async function actor(role: 'owner' | 'admin' | 'member' = 'member') {
  const { user, tenant } = await createTestTenantWithUser(db, role)
  return {
    user,
    tenant,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant.id)),
  }
}

const ingest = (
  cookie: Record<string, string>,
  env: TestEnv,
  body: { title: string; text: string; source?: string }
) => request('/api/ai/documents/ingest', { method: 'POST', headers: cookie }, { env, json: body })

const search = (cookie: Record<string, string>, env: TestEnv, body: Record<string, unknown>) =>
  request('/api/ai/documents/search', { method: 'POST', headers: cookie }, { env, json: body })

function upload(env: TestEnv, cookie: Record<string, string>, bytes: string, name: string) {
  return directUpload(env, cookie, 'documents', { bytes, name, type: '' })
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

// Each section is padded past half a window, so no two pack into one chunk and every section is
// a chunk of its own — what this test reads paths and offsets from.
const PAD = 'Filler words that say nothing in particular. '.repeat(40).trim()
const GUIDE = [
  'Read this first.',
  PAD,
  '# Pricing',
  'Monthly plans renew every month.',
  PAD,
  '## Annual plans',
  'An annual railway pass is cheaper per trip.',
  PAD,
  '# Support',
  'Email the volcano observatory.',
  PAD,
].join('\n\n')

const chunksOf = (tenantId: string, documentId: string) =>
  db
    .select()
    .from(chunks)
    .where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, documentId)))
    .orderBy(chunks.seq)

describe('chunk structure', () => {
  it('stores exact slices with heading paths and the model; embeds the path; hits carry it', async () => {
    const a = await actor()
    const { env, embedded } = embeddingsEnv()
    const res = await ingest(a.cookie, env, { title: 'Guide', text: GUIDE })
    expect(res.status).toBe(201)
    const doc = documentSchema.parse(await json(res))
    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id))
    expect(row?.contentHash).toBe(sha256(GUIDE))

    const rows = await chunksOf(a.tenant.id, doc.id)
    expect(rows.map(r => r.headingPath)).toEqual([
      null,
      'Pricing',
      'Pricing › Annual plans',
      'Support',
    ])
    for (const r of rows) {
      expect(row?.content?.slice(r.charStart ?? -1, r.charEnd ?? -1)).toBe(r.text)
      expect(r.embeddingModel).toBe(row?.embeddingModel)
      expect(r.page).toBeNull()
    }
    expect(
      rows[2]?.text.startsWith('## Annual plans\n\nAn annual railway pass is cheaper per trip.')
    ).toBe(true)
    // The heading path is context for the embedder only.
    expect(embedded).toContain(`Pricing › Annual plans\n\n${rows[2]?.text}`)

    const hits = searchResponseSchema.parse(
      await json(await search(a.cookie, env, { query: 'railway pass', limit: 3 }))
    ).hits
    expect(hits[0]).toMatchObject({
      chunkId: rows[2]?.id,
      headingPath: 'Pricing › Annual plans',
      page: null,
      charOffset: rows[2]?.charStart,
    })
    // The heading path is lexically indexed too: a word only the heading holds still matches.
    const byHeading = searchResponseSchema.parse(
      await json(await search(a.cookie, env, { query: 'annual', limit: 5 }))
    ).hits
    expect(byHeading.some(h => h.chunkId === rows[2]?.id && h.lexicalRank !== null)).toBe(true)
  })

  it('the dense leg skips another model’s chunks; keyword search still finds them', async () => {
    const a = await actor()
    const { env } = embeddingsEnv()
    const doc = documentSchema.parse(
      await json(await ingest(a.cookie, env, { title: 'Bananas', text: 'Bananas are yellow.' }))
    )
    await db
      .update(chunks)
      .set({ embeddingModel: 'retired-model' })
      .where(and(eq(chunks.tenantId, a.tenant.id), eq(chunks.documentId, doc.id)))
    const hits = searchResponseSchema.parse(
      await json(await search(a.cookie, env, { query: 'bananas', limit: 3 }))
    ).hits
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ documentId: doc.id, denseRank: null, lexicalRank: 1 })
  })
})

describe('content hash', () => {
  it('the same text again under the same source answers the existing document (200)', async () => {
    const a = await actor()
    const { env, embedded } = embeddingsEnv()
    const first = await ingest(a.cookie, env, { title: 'Volcano', text: 'The volcano erupted.' })
    expect(first.status).toBe(201)
    const created = await json<{ id: string; deduplicated: boolean }>(first)
    expect(created.deduplicated).toBe(false)
    const calls = embedded.length

    // CRLF and surrounding whitespace do not make it a different text.
    const again = await ingest(a.cookie, env, {
      title: 'Volcano (copy)',
      text: '  The volcano erupted.\r\n',
    })
    expect(again.status).toBe(200)
    expect(await json(again)).toMatchObject({
      id: created.id,
      deduplicated: true,
      title: 'Volcano',
    })
    expect(embedded.length).toBe(calls)

    // Another source is another document; so is another tenant.
    const other = await ingest(a.cookie, env, {
      title: 'Volcano',
      text: 'The volcano erupted.',
      source: 'notes',
    })
    expect(other.status).toBe(201)
    const b = await actor()
    expect(
      (await ingest(b.cookie, env, { title: 'Volcano', text: 'The volcano erupted.' })).status
    ).toBe(201)
  })

  it('never deduplicates against (or into) a document restricted to groups', async () => {
    const a = await actor('owner')
    const { env } = embeddingsEnv()
    const cfg = loadConfig(env)
    const base = { tenantId: a.tenant.id, userId: a.user.id, title: 'Secret', source: 'hr' }
    const restricted = await ingestText(db, cfg, env, {
      ...base,
      text: 'Railway salaries.',
      visibility: 'groups',
      groupIds: [],
    })
    const open = await ingestText(db, cfg, env, { ...base, text: 'Railway salaries.' })
    expect(open.deduplicated).toBe(false)
    expect(open.document.id).not.toBe(restricted.document.id)
    const restrictedAgain = await ingestText(db, cfg, env, {
      ...base,
      text: 'Railway salaries.',
      visibility: 'groups',
      groupIds: [],
    })
    expect(restrictedAgain.deduplicated).toBe(false)
  })

  it('an unchanged external-id upsert embeds nothing and keeps its chunks; metadata still moves', async () => {
    const a = await actor('owner')
    const { env, embedded } = embeddingsEnv()
    const cfg = loadConfig(env)
    const input = {
      tenantId: a.tenant.id,
      userId: a.user.id,
      title: 'Message',
      text: 'The railway reopens on Monday.',
      source: 'test:mail',
      externalId: 'msg-1',
    }
    const first = await ingestText(db, cfg, env, input)
    expect(first.mode).toBe('inline')
    const before = await chunksOf(a.tenant.id, first.document.id)
    const calls = embedded.length

    const second = await ingestText(db, cfg, env, { ...input, title: 'Message (renamed)' })
    expect(second).toMatchObject({ mode: 'unchanged', deduplicated: false })
    expect(second.document).toMatchObject({ id: first.document.id, title: 'Message (renamed)' })
    expect(second.document.status).toBe('indexed')
    expect(embedded.length).toBe(calls)
    expect((await chunksOf(a.tenant.id, first.document.id)).map(c => c.id)).toEqual(
      before.map(c => c.id)
    )

    // A changed text is re-chunked and re-embedded as before.
    const third = await ingestText(db, cfg, env, { ...input, text: 'The railway stays shut.' })
    expect(third.mode).toBe('inline')
    expect(embedded.length).toBeGreaterThan(calls)
    expect((await chunksOf(a.tenant.id, first.document.id))[0]?.text).toBe(
      'The railway stays shut.'
    )
  })

  it('a text upload of the same file again answers the existing document and stores nothing', async () => {
    const a = await actor()
    const { env } = embeddingsEnv()
    const first = await upload(env, a.cookie, '# Notes\n\nBananas ripen.', 'notes.md')
    expect(first.status).toBe(201)
    const created = await json<{ id: string; fileId: string }>(first)
    const objects = stubs(env).files.objects.size

    const again = await upload(env, a.cookie, '# Notes\r\n\r\nBananas ripen.\r\n', 'notes.md')
    expect(again.status).toBe(200)
    expect(await json(again)).toMatchObject({
      id: created.id,
      fileId: created.fileId,
      deduplicated: true,
    })
    expect(stubs(env).files.objects.size).toBe(objects)
    const fileRows = await db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.tenantId, a.tenant.id), eq(files.scope, 'documents')))
    expect(fileRows).toHaveLength(1)
  })
})
