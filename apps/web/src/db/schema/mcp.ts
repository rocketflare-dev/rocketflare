/**
 * The MCP server's tables. All four are tenant-scoped and call `tenantIsolation()`.
 *
 * - `mcp_settings` — one row per organisation that has touched its MCP settings (no row = every
 *   default: off, read-only tools, everyone may connect).
 * - `mcp_grants` — one CONNECTION: one person, in one organisation, through one client, bound to
 *   the URL it was made for (`resource`: `/mcp` or `/mcp/t/<slug>`). Revocation is a column, so a
 *   revoked connection keeps its history. Made by the consent, live once its code is exchanged
 *   (`activatedAt`).
 * - `mcp_tokens` — the access and refresh tokens of a grant, stored as SHA-256 hashes. A refresh
 *   rotates (`rotatedFrom` points at the token it replaced, `usedAt` marks it spent, and
 *   `successorSealed` lets a retry inside the grace get the same pair back).
 * - `mcp_tool_calls` — the call log: who called which tool through which connection, how it ended
 *   and how long it took. **Never the arguments or the result**: those are the organisation's data
 *   and the client's prompt, and a log is the wrong place to keep either.
 */
import type {
  McpCallOutcome,
  McpConnectPolicy,
  McpExposure,
  McpScope,
} from '@rocketflare/shared/mcp'
import { relations } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantRef, timestamps } from './_helpers'
import { tenantIsolation } from './rls'
import { tenants } from './tenants'
import { users } from './users'

export const mcpSettings = pgTable(
  'mcp_settings',
  {
    tenantId: tenantRef(tenants).primaryKey(),
    enabled: boolean('enabled').notNull().default(false),
    exposure: text('exposure').$type<McpExposure>().notNull().default('read_only'),
    exposedTools: text('exposed_tools').array().notNull().default([]),
    connectPolicy: text('connect_policy').$type<McpConnectPolicy>().notNull().default('everyone'),
    /** Group ids, no FK: a deleted group simply matches nobody, and the page drops it on save. */
    connectGroupIds: uuid('connect_group_ids').array().notNull().default([]),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  () => [tenantIsolation('mcp_settings')]
)

export const mcpGrants = pgTable(
  'mcp_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The client's `client_id` — for a metadata-document client, the document's https URL. */
    clientId: text('client_id').notNull(),
    scopes: text('scopes').array().$type<McpScope[]>().notNull(),
    /** The exact URL the grant is for; a token is refused on any other (the audience check). */
    resource: text('resource').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * When the client first exchanged a code for tokens. A consent makes the grant before the
     * client has redeemed anything; until this is set it is not a connection — not listed, not
     * counted, and swept by the nightly retention once its code could no longer be redeemed.
     */
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    /** Touched at most once a minute by a call; the idle limit counts from it. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    /** The absolute end, fixed when the grant is made. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    revokeReason: text('revoke_reason'),
  },
  table => [
    index('mcp_grants_tenant_user_idx').on(table.tenantId, table.userId),
    index('mcp_grants_tenant_client_idx').on(table.tenantId, table.clientId),
    tenantIsolation('mcp_grants'),
  ]
)

export const MCP_TOKEN_KINDS = ['access', 'refresh'] as const
export type McpTokenKind = (typeof MCP_TOKEN_KINDS)[number]

export const mcpTokens = pgTable(
  'mcp_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    grantId: uuid('grant_id')
      .notNull()
      .references(() => mcpGrants.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: MCP_TOKEN_KINDS }).notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** The refresh token this pair replaced. */
    rotatedFrom: uuid('rotated_from'),
    /** A refresh token is spent once it has been exchanged. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    /**
     * On a SPENT refresh token: the pair it was exchanged for, sealed with a key derived from this
     * token's own plaintext (which is never stored). Only a client presenting the spent token again
     * can open it, and only inside the retry grace — so a network retry of a refresh gets the same
     * answer instead of killing the connection. Cleared once the grace has passed.
     */
    successorSealed: text('successor_sealed'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('mcp_tokens_grant_idx').on(table.tenantId, table.grantId),
    // The nightly sweep of expired tokens.
    index('mcp_tokens_expires_idx').on(table.expiresAt),
    tenantIsolation('mcp_tokens'),
  ]
)

export const mcpToolCalls = pgTable(
  'mcp_tool_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantRef(tenants),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Set null, not cascade: deleting a connection must not erase what it did. */
    grantId: uuid('grant_id').references(() => mcpGrants.id, { onDelete: 'set null' }),
    clientId: text('client_id').notNull(),
    tool: text('tool').notNull(),
    outcome: text('outcome').$type<McpCallOutcome>().notNull(),
    code: text('code'),
    durationMs: integer('duration_ms').notNull(),
    /** Reserved for the call's own model spend; nothing attributes it yet, so it is always null. */
    costMicrocents: bigint('cost_microcents', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    // The log page, the per-tool 30-day counts, and the nightly prune.
    index('mcp_tool_calls_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
    index('mcp_tool_calls_tenant_tool_idx').on(table.tenantId, table.tool, table.createdAt),
    index('mcp_tool_calls_grant_idx').on(table.tenantId, table.grantId),
    tenantIsolation('mcp_tool_calls'),
  ]
)

export const mcpGrantsRelations = relations(mcpGrants, ({ one }) => ({
  tenant: one(tenants, { fields: [mcpGrants.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [mcpGrants.userId], references: [users.id] }),
}))

export type McpSettingsRow = typeof mcpSettings.$inferSelect
export type McpGrantRow = typeof mcpGrants.$inferSelect
export type NewMcpGrantRow = typeof mcpGrants.$inferInsert
export type McpTokenRow = typeof mcpTokens.$inferSelect
export type McpToolCallRow = typeof mcpToolCalls.$inferSelect
