/**
 * Visibility flows through the MCP server unchanged. A document shared only with a group — and
 * every fact read from it, and the entity known only from it — does not exist for a member outside
 * that group, through EVERY core tool a client can call, and the answers are exactly what the
 * same person gets from the same tool in chat (and, for the list, from the HTTP route).
 *
 * The case table is keyed by tool name and checked against what the server actually lists: a new
 * core tool that reaches MCP without a visibility case here fails this file.
 */
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { accessScopeForUser } from '@/api/services/access'
import { CORE_TOOL_NAMES, toolsFor } from '@/api/services/agents/tools'
import { setTenantOverride } from '@/api/services/features'
import { MCP_GET_DOCUMENT_MAX_CHARS } from '@/api/services/mcp/server'
import { loadConfig } from '@/config'
import { documents, groupMembers, groups, groupTypes } from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { seedEntity, seedFact } from '../../helpers/knowledge-facts'
import { connectMcp, enableMcp, mcpClient, mcpTestEnv, toolJson } from '../../helpers/mcp'
import { json, request } from '../../helpers/request'
import { stubs } from '../../mocks/bindings'

const db = setupTestDatabase()

function axis(i: number): number[] {
  const v = new Array<number>(1024).fill(0)
  v[i] = 1
  return v
}
/** Everything about volcanoes embeds to one axis, so both documents match the same query. */
const env = mcpTestEnv()
const ai = stubs(env).ai
if (ai) {
  ai.respond = (_model, inputs) => {
    const texts = Array.isArray(inputs.text) ? (inputs.text as string[]) : [String(inputs.text)]
    return {
      shape: [texts.length, 1024],
      data: texts.map(t => axis(t.toLowerCase().includes('volcano') ? 1 : 900)),
    }
  }
}
const cfg = loadConfig(env)

const SECRET_MARK = 'XYZZY-BOARD-ONLY'
const SECRET_TITLE = 'Volcano board minutes'
const SECRET_ENTITY = 'Ferncliff Nurseries'

interface Reader {
  userId: string
  cookie: Record<string, string>
  token: string
}

let tenantId: string
let groupId: string
let secretId: string
let openId: string
let insider: Reader
let outsider: Reader

async function reader(inGroup: boolean): Promise<Reader> {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenantId, 'member')
  if (inGroup) await db.insert(groupMembers).values({ tenantId, groupId, userId: user.id })
  const { accessToken } = await connectMcp(db, env, { tenantId, userId: user.id })
  return {
    userId: user.id,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenantId)),
    token: accessToken,
  }
}

async function ingest(
  cookie: Record<string, string>,
  body: Record<string, unknown>
): Promise<string> {
  const res = await request(
    '/api/ai/documents/ingest',
    { method: 'POST', headers: cookie },
    { env, json: body }
  )
  expect(res.status, await res.clone().text()).toBeLessThan(300)
  const created = await json<{ id?: string; document?: { id: string } }>(res)
  const id = created.document?.id ?? created.id
  if (!id) throw new Error('ingest returned no id')
  return id
}

/** The same tool, as the same person, the way chat builds it. */
async function inChat(who: Reader, name: string, args: unknown): Promise<unknown> {
  const tools = await toolsFor('chat', {
    db,
    cfg,
    env,
    scope: await accessScopeForUser(db, tenantId, who.userId),
    features: ['knowledge-facts', 'mcp'],
    maxDocumentChars: MCP_GET_DOCUMENT_MAX_CHARS,
  })
  const tool = tools.find(t => t.name === name)
  if (!tool?.handler) throw new Error(`no chat tool ${name}`)
  return JSON.parse(await tool.handler(args as never))
}

async function overMcp(who: Reader, name: string, args: Record<string, unknown>) {
  const client = await mcpClient(env, who.token)
  try {
    return toolJson(await client.callTool({ name, arguments: args }))
  } finally {
    await client.close()
  }
}

beforeAll(async () => {
  tenantId = (await createTestTenant(db)).id
  const owner = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenantId, 'owner')
  await enableMcp(db, tenantId, owner.id)
  await setTenantOverride(db, 'knowledge-facts', tenantId, true, owner.id)
  const ownerCookie = sessionCookieHeader(await createTestSession(db, owner.id, tenantId))

  const [type] = await db.insert(groupTypes).values({ tenantId, name: 'Dept' }).returning()
  const [group] = await db
    .insert(groups)
    .values({ tenantId, groupTypeId: type?.id ?? '', name: 'Board' })
    .returning()
  groupId = group?.id ?? ''

  openId = await ingest(ownerCookie, {
    title: 'Volcano field guide',
    text: 'A volcano is a rupture in the crust. Volcano eruptions eject lava and ash.',
  })
  secretId = await ingest(ownerCookie, {
    title: SECRET_TITLE,
    text: `The volcano project budget is ${SECRET_MARK}. ${SECRET_ENTITY} supplies the volcano site.`,
    visibility: 'groups',
    groupIds: [groupId],
  })
  const [indexed] = await db
    .select({ status: documents.status })
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.id, secretId)))
  expect(indexed?.status).toBe('indexed')

  const entity = await seedEntity(db, { tenantId, name: SECRET_ENTITY })
  await seedFact(db, { tenantId, entityId: entity.id, documentId: secretId, value: 4242 })

  insider = await reader(true)
  outsider = await reader(false)
})

/** What each core tool is asked, per visibility case. */
const CASES: Record<string, Record<string, unknown>> = {
  search_knowledge: { query: 'volcano budget' },
  list_documents: {},
  get_document: { documentId: '' },
  lookup_facts: { entity: SECRET_ENTITY },
}

function argsFor(name: string): Record<string, unknown> {
  const args = CASES[name]
  if (!args) throw new Error(`no visibility case for MCP tool ${name}`)
  return name === 'get_document' ? { documentId: secretId } : args
}

describe('a group-only document over MCP', () => {
  it('has a visibility case for every core tool the server lists', async () => {
    const client = await mcpClient(env, outsider.token)
    const listed = (await client.listTools()).tools.map(t => t.name)
    await client.close()
    // Core tools only: an installed plugin's tools are listed too, and each plugin proves its own
    // scoping with `callMcpTool` in its own tests.
    const core = listed.filter(name => CORE_TOOL_NAMES.includes(name))
    expect(core.sort()).toEqual(Object.keys(CASES).sort())
  })

  it('does not exist for an outsider through any tool — no text, title, id, fact or entity', async () => {
    for (const name of Object.keys(CASES)) {
      // A tool may echo what it was asked (`get_document`'s id, `lookup_facts`' name) — the
      // caller's own words, not a leak — so the arguments are blanked before looking.
      let answer = JSON.stringify(await overMcp(outsider, name, argsFor(name)))
      for (const value of Object.values(argsFor(name))) {
        if (typeof value === 'string' && value) answer = answer.replaceAll(value, 'ASKED')
      }
      for (const leak of [SECRET_MARK, SECRET_TITLE, secretId, SECRET_ENTITY, '4242']) {
        expect(answer, `${name} leaked ${leak}`).not.toContain(leak)
      }
    }
  })

  it('reaches an insider', async () => {
    expect(
      JSON.stringify(await overMcp(insider, 'search_knowledge', argsFor('search_knowledge')))
    ).toContain(secretId)
    expect(
      JSON.stringify(await overMcp(insider, 'get_document', argsFor('get_document')))
    ).toContain(SECRET_MARK)
    expect(
      JSON.stringify(await overMcp(insider, 'lookup_facts', argsFor('lookup_facts')))
    ).toContain('4242')
  })

  it('answers a hidden id exactly like an id that does not exist', async () => {
    const hidden = await overMcp(outsider, 'get_document', { documentId: secretId })
    const unknown = await overMcp(outsider, 'get_document', {
      documentId: '00000000-0000-4000-8000-000000000000',
    })
    expect(JSON.stringify(hidden).replaceAll(secretId, 'ID')).toEqual(
      JSON.stringify(unknown).replaceAll('00000000-0000-4000-8000-000000000000', 'ID')
    )
  })

  it('answers every tool exactly as chat answers the same person', async () => {
    // Every pair at once: they only read, and in sequence they were the slowest case here.
    const pairs = [insider, outsider].flatMap(who =>
      Object.keys(CASES).map(name => ({ who, name }))
    )
    const answers = await Promise.all(
      pairs.map(async ({ who, name }) => ({
        name,
        mcp: await overMcp(who, name, argsFor(name)),
        chat: await inChat(who, name, argsFor(name)),
      }))
    )
    for (const { name, mcp, chat } of answers) expect(mcp, name).toEqual(chat)
  })

  it('lists exactly the documents the HTTP route lists for the same person', async () => {
    for (const who of [insider, outsider]) {
      const http = await json<{ items: { id: string }[] }>(
        await request('/api/ai/documents', { headers: who.cookie }, { env })
      )
      const mcp = (await overMcp(who, 'list_documents', {})) as {
        documents: { documentId: string }[]
      }
      const ids = mcp.documents.map(d => d.documentId)
      expect(ids.sort()).toEqual(http.items.map(d => d.id).sort())
      expect(ids).toContain(openId)
    }
  })
})
