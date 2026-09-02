/**
 * Neon API v2 over plain `fetch` (no vendor CLI). Facts verified against
 * https://api-docs.neon.tech/reference/ on 2026-09-02:
 *   - base URL `https://console.neon.tech/api/v2`, `Authorization: Bearer <napi_…>`
 *     (https://api-docs.neon.tech/reference/getprojectoperation)
 *   - `GET /users/me` → `{ id, email, name, … }` (…/reference/getcurrentuserinfo)
 *   - `GET /projects?search=&limit=` → `{ projects: [{ id, name, region_id, pg_version }] }`
 *     (…/reference/listprojects); `POST /projects { project: { name, region_id, pg_version } }` →
 *     `{ project, connection_uris, roles, branch, endpoints, operations }`, pg_version 14–18
 *     accepted (…/reference/createproject)
 *   - `GET /projects/{id}/branches` → `{ branches: [{ id, name, parent_id, default, current_state }] }`
 *     (…/reference/listprojectbranches); `POST /projects/{id}/branches { branch: { name, parent_id },
 *     endpoints: [{ type: 'read_write' }] }` → `{ branch, endpoints, operations, roles, connection_uris }`
 *     (…/reference/createprojectbranch)
 *   - `GET /projects/{id}/branches/{b}/endpoints` → `{ endpoints: [{ id, host, type, branch_id,
 *     current_state }] }` — there is NO `pooler_host` field; `proxy_host` is deprecated
 *     (…/reference/listprojectbranchendpoints)
 *   - `GET …/branches/{b}/databases` → `{ databases: [{ name, owner_name }] }` (…/reference/listprojectbranchdatabases)
 *   - `GET …/branches/{b}/roles` → `{ roles: [{ name, protected }] }` (…/reference/listprojectbranchroles)
 *   - `GET …/roles/{r}/reveal_password` → `{ password }`, 412 when password storage is off
 *     (…/reference/getprojectbranchrolepassword)
 *   - `POST …/roles/{r}/reset_password` → `{ role: { password }, operations }` (…/reference/resetprojectbranchrolepassword)
 *   - `GET /projects/{id}/operations/{op}` → `{ operation: { status } }`, status ∈ scheduling |
 *     running | finished | failed | error | cancelling | cancelled | skipped (…/reference/getprojectoperation)
 *
 * Every response that can carry a credential is passed through `sanitizeNeon` before any debug
 * output; passwords are returned to the caller in memory only.
 */
import { toDirectNeonHost } from '../migrate'
import { ProvisionError, sleep } from './config'
import { safeJson } from './redact'

export const NEON_API = 'https://console.neon.tech/api/v2'
export const NEON_PG_VERSION = 17 // the local image is pgvector/pgvector:pg17

export interface NeonEndpoint {
  id: string
  host: string
  type: 'read_write' | 'read_only'
  branch_id: string
  current_state?: string
  /** Deprecated upstream; never used for a connection string. */
  proxy_host?: string
}
export interface NeonBranch {
  id: string
  name: string
  parent_id?: string
  default?: boolean
  primary?: boolean
  current_state?: string
}
export interface NeonOperation {
  id: string
  status: string
  action?: string
  error?: string
}

type Fetch = typeof fetch

export class NeonClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly debug = false
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${NEON_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json: any = {}
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      json = { raw: text }
    }
    if (!res.ok) {
      throw new ProvisionError(
        `Neon ${method} ${path} → ${res.status}: ${safeJson(json).slice(0, 400)}`
      )
    }
    if (this.debug) console.error(`[neon] ${method} ${path}\n${safeJson(json).slice(0, 2000)}`)
    return json as T
  }

  me() {
    return this.request<{ id: string; email: string; name?: string }>('GET', '/users/me')
  }

  async findProject(name: string) {
    const { projects } = await this.request<{ projects: any[] }>(
      'GET',
      `/projects?search=${encodeURIComponent(name)}&limit=400`
    )
    return projects.find(p => p.name === name) as
      | { id: string; name: string; region_id: string; pg_version: number }
      | undefined
  }

  async createProject(name: string, regionId: string) {
    const res = await this.request<{ project: any; branch: any; operations: NeonOperation[] }>(
      'POST',
      '/projects',
      { project: { name, region_id: regionId, pg_version: NEON_PG_VERSION } }
    )
    await this.waitForOperations(res.project.id, res.operations)
    return res.project as { id: string; name: string; region_id: string }
  }

  async listBranches(projectId: string) {
    const { branches } = await this.request<{ branches: NeonBranch[] }>(
      'GET',
      `/projects/${projectId}/branches`
    )
    return branches
  }

  async createBranch(projectId: string, name: string, parentId: string) {
    const res = await this.request<{ branch: NeonBranch; operations: NeonOperation[] }>(
      'POST',
      `/projects/${projectId}/branches`,
      { branch: { name, parent_id: parentId }, endpoints: [{ type: 'read_write' }] }
    )
    await this.waitForOperations(projectId, res.operations)
    return res.branch
  }

  async listEndpoints(projectId: string, branchId: string) {
    const { endpoints } = await this.request<{ endpoints: NeonEndpoint[] }>(
      'GET',
      `/projects/${projectId}/branches/${branchId}/endpoints`
    )
    return endpoints
  }

  async listDatabases(projectId: string, branchId: string) {
    const { databases } = await this.request<{ databases: { name: string; owner_name: string }[] }>(
      'GET',
      `/projects/${projectId}/branches/${branchId}/databases`
    )
    return databases
  }

  async listRoles(projectId: string, branchId: string) {
    const { roles } = await this.request<{ roles: { name: string; protected?: boolean }[] }>(
      'GET',
      `/projects/${projectId}/branches/${branchId}/roles`
    )
    return roles
  }

  /** `undefined` when Neon does not store passwords (412) — the caller falls back to a reset. */
  async revealPassword(projectId: string, branchId: string, role: string) {
    try {
      const { password } = await this.request<{ password: string }>(
        'GET',
        `/projects/${projectId}/branches/${branchId}/roles/${encodeURIComponent(role)}/reveal_password`
      )
      return password
    } catch (err) {
      if (err instanceof ProvisionError && /→ 412/.test(err.message)) return undefined
      throw err
    }
  }

  async resetPassword(projectId: string, branchId: string, role: string) {
    const res = await this.request<{ role: { password: string }; operations: NeonOperation[] }>(
      'POST',
      `/projects/${projectId}/branches/${branchId}/roles/${encodeURIComponent(role)}/reset_password`
    )
    await this.waitForOperations(projectId, res.operations)
    return res.role.password
  }

  async waitForOperations(
    projectId: string,
    ops: NeonOperation[] | undefined,
    timeoutMs = 180_000
  ) {
    const deadline = Date.now() + timeoutMs
    for (const op of ops ?? []) {
      let status = op.status
      while (!['finished', 'skipped'].includes(status)) {
        if (['failed', 'error', 'cancelled'].includes(status))
          throw new ProvisionError(`Neon operation ${op.action ?? op.id} ${status}`)
        if (Date.now() > deadline) throw new ProvisionError(`Neon operation ${op.id} timed out`)
        await sleep(2000)
        const { operation } = await this.request<{ operation: NeonOperation }>(
          'GET',
          `/projects/${projectId}/operations/${op.id}`
        )
        status = operation.status
      }
    }
  }
}

// ---- pure helpers (unit-tested) -------------------------------------------------------------

/**
 * The read-write endpoint of a branch. Neon endpoints expose `host` only; the `-pooler` variant
 * is a naming convention on the same host, so the result is additionally normalised through
 * `toDirectNeonHost` — Hyperdrive and DDL must both use the direct host (docs/DEPLOY.md).
 */
export function pickEndpoint(endpoints: NeonEndpoint[]): { id: string; host: string } {
  const rw = endpoints.find(e => e.type === 'read_write') ?? endpoints[0]
  if (!rw) throw new ProvisionError('branch has no compute endpoint')
  return { id: rw.id, host: toDirectNeonHost(rw.host) }
}

/** `postgresql://<role>:<pw>@<direct host>/<db>?sslmode=require` — the shape migrate.ts and Hyperdrive accept. */
export function buildConnectionUrl(input: {
  role: string
  password: string
  host: string
  database: string
}): string {
  const host = toDirectNeonHost(input.host)
  return `postgresql://${encodeURIComponent(input.role)}:${encodeURIComponent(input.password)}@${host}/${encodeURIComponent(input.database)}?sslmode=require`
}

/** Prefer the branch's own database over `postgres`; the default project has exactly one. */
export function pickDatabase(databases: { name: string; owner_name: string }[]) {
  const db = databases.find(d => d.name !== 'postgres') ?? databases[0]
  if (!db) throw new ProvisionError('branch has no database')
  return db
}

/** The owner role: the database owner when it is listed, else the first unprotected role. */
export function pickRole(roles: { name: string; protected?: boolean }[], ownerName?: string) {
  const owner = ownerName && roles.find(r => r.name === ownerName)
  const role = owner || roles.find(r => !r.protected) || roles[0]
  if (!role) throw new ProvisionError('branch has no role')
  return role.name
}
