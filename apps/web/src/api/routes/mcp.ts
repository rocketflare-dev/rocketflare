/**
 * `/mcp` and `/mcp/t/<slug>`: the app's MCP server — stateless Streamable HTTP, POST only, JSON
 * answers. `/mcp` serves whichever organisation the connection was made for; `/mcp/t/<slug>` is
 * the same server pinned to one organisation, for a client that keys connectors by URL and so
 * cannot hold two connections to `/mcp`. A grant is bound to the exact URL it was made on, so a
 * token never crosses from one to the other.
 *
 * Mounted in `api/index.ts` BEFORE the mount table, outside the global CORS (which allows
 * credentials) and outside `authMiddleware` (which takes cookies and API keys — neither is a
 * credential here: only an OAuth access token is). In order, per request:
 *
 * 1. the deployment gate — 404 unless the deployment ships the `mcp` feature;
 * 2. the Origin rule — absent is fine (every non-browser client), present must be ours;
 * 3. POST only — 405 for GET and DELETE (no SSE stream, no session to end);
 * 4. the caller (`services/mcp/caller.ts`) — 401 with the challenge, or 403 with the reason;
 * 5. one message per request — a JSON-RPC batch is refused (-32600) in every protocol era, so
 *    every call passes the call limits one at a time;
 * 6. the caller's tools: `toolsFor('mcp')` built from THEIR access scope and CASL grant, then
 *    the organisation's exposure — once, outside the SDK's server factory;
 * 7. the SDK's handler, inside the tenant scope, with the response buffered so no tool runs
 *    after the scope's transaction has closed.
 */
import { createMcpHandler } from '@modelcontextprotocol/server'
import { ERROR_CODES } from '@rocketflare/shared/errors'
import { cors } from 'hono/cors'
import { createMiddleware } from 'hono/factory'
import { withTenantScope } from '../../db/tenant-scope'
import { deploymentFeatures } from '../../permissions/features'
import { allowedOrigins } from '../middleware/cors'
import { isAllowedOrigin } from '../middleware/csrf'
import type { RateLimitKv } from '../middleware/rate-limit'
import { noopTracer } from '../observability/tracer'
import { McpChallengeError, resolveMcpCaller } from '../services/mcp/caller'
import { buildMcpServer } from '../services/mcp/server'
import { mcpResourceMetadataUrl, mcpResourceUrl, touchMcpGrant } from '../services/mcp/tokens'
import { mcpToolsFor } from '../services/mcp/tools'
import type { AppContext, AppEnv } from '../types'
import { NotFoundError } from '../utils/core/errors'
import { makeDefer } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'

export const mcpRouter = createRouter()

/**
 * Any origin may call it (a client in a browser tab is a client), with NO credentials — a cookie
 * is never a credential here — and the challenge header readable, because that is how a browser
 * client finds the authorization server.
 */
const mcpCors = cors({
  origin: '*',
  credentials: false,
  allowMethods: ['POST', 'OPTIONS'],
  allowHeaders: [
    'Authorization',
    'Content-Type',
    'Accept',
    'Mcp-Protocol-Version',
    'Mcp-Method',
    'Mcp-Name',
    'Mcp-Session-Id',
    'Last-Event-ID',
  ],
  exposeHeaders: ['WWW-Authenticate', 'Mcp-Protocol-Version'],
  maxAge: 600,
})

/**
 * The kit's error envelope for what is refused before the protocol starts (no such route, a
 * foreign Origin, the wrong method) — the same shape as every other route; JSON-RPC errors are the
 * SDK's, for what it refuses inside the protocol.
 */
function refuse(c: AppContext, status: 403 | 405, code: string, error: string) {
  return c.json({ error, statusCode: status, code }, status)
}

/**
 * 404 on a deployment that does not ship the server — the surface does not exist there. The
 * authorization server's routes and documents sit behind the same gate.
 */
export const mcpDeploymentGate = createMiddleware<AppEnv>(async (c, next) => {
  const deployed = await deploymentFeatures(c.get('config'))
  if (!deployed.includes('mcp')) {
    throw new NotFoundError(`Not found: ${c.req.path}`, ERROR_CODES.featureDisabled)
  }
  await next()
})

/**
 * A browser that sends an Origin must be on our own — the DNS-rebinding and drive-by defence the
 * transport spec asks for. No Origin is every desktop, CLI and hosted client, and is allowed.
 */
const originRule = createMiddleware<AppEnv>(async (c, next) => {
  const origin = c.req.header('Origin')
  if (origin && !isAllowedOrigin(origin, allowedOrigins(c.get('config'), c.req.url))) {
    return refuse(c, 403, ERROR_CODES.forbidden, 'Origin not allowed')
  }
  await next()
})

mcpRouter.use('*', mcpCors, mcpDeploymentGate, originRule)

/**
 * A JSON-RPC batch (an array body) — refused in every protocol era. The 2026 era's SDK already
 * refuses one; the 2025 era would dispatch its calls concurrently, and the call limits count one
 * call at a time. The body is bounded by `jsonBodyLimit`; anything that does not parse is left to
 * the SDK, which answers it with its own parse error.
 */
async function isBatch(req: Request): Promise<boolean> {
  try {
    return Array.isArray(JSON.parse(await req.clone().text()))
  } catch {
    return false
  }
}

function batchRefused(): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Bad Request: JSON-RPC batches are not supported' },
    },
    { status: 400 }
  )
}

async function serve(c: AppContext, slug: string | undefined): Promise<Response> {
  if (c.req.method !== 'POST') {
    c.header('Allow', 'POST')
    return refuse(c, 405, 'method_not_allowed', 'Method not allowed')
  }
  // A listen stream never ends, and the tool list is never pushed (`listChanged: false`). The
  // header must agree with the body — the SDK refuses a mismatch with -32020 — so it is enough.
  if (c.req.header('Mcp-Method')?.trim() === 'subscriptions/listen') {
    return refuse(c, 405, 'method_not_allowed', 'This server does not push list changes')
  }
  const cfg = c.get('config')
  const db = c.get('db')
  const resource = mcpResourceUrl(cfg, slug)
  let caller: Awaited<ReturnType<typeof resolveMcpCaller>>
  try {
    caller = await resolveMcpCaller({
      db,
      cfg,
      authorization: c.req.header('Authorization'),
      resource,
    })
  } catch (err) {
    if (err instanceof McpChallengeError) c.header('WWW-Authenticate', err.challenge)
    throw err
  }

  if (await isBatch(c.req.raw)) return batchRefused()

  const defer = makeDefer(c)
  defer(() => touchMcpGrant(db, caller.grant))
  const { auth } = caller
  const tracer = (() => {
    try {
      return c.get('tracer') ?? noopTracer
    } catch {
      return noopTracer
    }
  })()

  return withTenantScope(db, auth.tenantId, cfg.TENANT_SCOPE_MODE, async sdb => {
    const tools = await mcpToolsFor({
      db: sdb,
      cfg,
      env: c.env,
      auth,
      settings: caller.settings,
    })

    const handler = createMcpHandler(
      () =>
        buildMcpServer(
          {
            caller,
            cfg,
            db,
            kv: c.env.RATE_LIMIT_KV as RateLimitKv | undefined,
            logger: c.get('logger'),
            tracer,
            defer,
          },
          tools
        ),
      {
        // `auto` answers one JSON body unless a handler emits a message before its result, which
        // none here does; `json` would say the same and log a warning on every request.
        responseMode: 'auto',
        onerror: err => c.get('logger').debug({ err }, 'mcp: request rejected'),
      }
    )
    const res = await handler.fetch(c.req.raw, {
      authInfo: {
        token: '',
        clientId: caller.grant.clientId,
        scopes: caller.scopes,
        resourceMetadataUrl: mcpResourceMetadataUrl(resource),
      },
    })
    // Buffered inside the scope: the 2025-era leg answers as an SSE stream whose body is written
    // as the handler runs, and a tool must never run after the scoped transaction has ended.
    const body = await res.arrayBuffer()
    return new Response(body, { status: res.status, headers: res.headers })
  })
}

mcpRouter.all('/', c => serve(c, undefined))
mcpRouter.all('/t/:slug', c => serve(c, c.req.param('slug')))
