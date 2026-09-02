/**
 * Cloudflare v4 API over plain `fetch` — the few calls wrangler has no command for. Facts
 * verified against https://developers.cloudflare.com/api/ on 2026-09-02:
 *   - `Authorization: Bearer <token>`; envelope `{ success, errors[], messages[], result }`
 *   - `GET /zones?name=<zone>&per_page=50` → `result: [{ id, name, status }]`
 *     (…/resources/zones/methods/list/)
 *   - `GET /zones/{zone}/dns_records?name=&type=&per_page=` and `POST /zones/{zone}/dns_records
 *     { type, name, content, ttl (1 = automatic), proxied, priority (MX), comment }` → `result.id`
 *     (…/resources/dns/subresources/records/methods/create/); `PUT …/dns_records/{id}` overwrites
 *     a record with the same body (…/resources/dns/subresources/records/methods/update/ — "Overwrite
 *     DNS Record")
 *   - `GET /accounts/{account}/workers/subdomain` → `result: { subdomain }`, Workers Scripts Read
 *     (…/resources/workers/subresources/subdomains/methods/get/)
 */
import { ProvisionError } from './config'
import { redact } from './redact'
import type { DnsRecordInput } from './resend'

export const CF_API = 'https://api.cloudflare.com/client/v4'

export interface DnsRecord extends DnsRecordInput {
  id: string
}

type Fetch = typeof fetch

export class CloudflareClient {
  constructor(
    private readonly apiToken: string,
    private readonly fetchImpl: Fetch = fetch
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${CF_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const json: any = await res.json().catch(() => ({}))
    if (!res.ok || json.success === false) {
      const errors = (json.errors ?? []).map((e: any) => `${e.code}: ${e.message}`).join('; ')
      throw new ProvisionError(
        `Cloudflare ${method} ${path} → ${res.status} ${redact(errors || JSON.stringify(json)).slice(0, 400)}`
      )
    }
    return json.result as T
  }

  async findZone(name: string) {
    const zones = await this.request<{ id: string; name: string; status: string }[]>(
      'GET',
      `/zones?name=${encodeURIComponent(name)}&per_page=50`
    )
    return zones.find(z => z.name === name)
  }

  /** First candidate (most specific first) that is a zone in this account. */
  async findZoneFor(candidates: string[]) {
    for (const c of candidates) {
      const z = await this.findZone(c)
      if (z) return z
    }
    return undefined
  }

  listRecords(zoneId: string, name: string, type?: string) {
    const q = `name=${encodeURIComponent(name)}${type ? `&type=${type}` : ''}&per_page=100`
    return this.request<DnsRecord[]>('GET', `/zones/${zoneId}/dns_records?${q}`)
  }

  /**
   * Find-or-create by (name, type[, content for multi-value types]). TXT and MX may legitimately
   * hold several records at one name (SPF + DKIM), so those match on content too; CNAME is
   * single-valued and is overwritten when its target differs.
   */
  async upsertRecord(
    zoneId: string,
    rec: DnsRecordInput
  ): Promise<'exists' | 'created' | 'updated'> {
    const existing = await this.listRecords(zoneId, rec.name, rec.type)
    const same = existing.find(r => normalise(r.content) === normalise(rec.content))
    if (same) return 'exists'
    if (rec.type === 'CNAME' && existing[0]) {
      await this.request('PUT', `/zones/${zoneId}/dns_records/${existing[0].id}`, withComment(rec))
      return 'updated'
    }
    await this.request('POST', `/zones/${zoneId}/dns_records`, withComment(rec))
    return 'created'
  }

  async workersSubdomain(accountId: string): Promise<string> {
    const r = await this.request<{ subdomain?: string }>(
      'GET',
      `/accounts/${accountId}/workers/subdomain`
    )
    if (!r?.subdomain)
      throw new ProvisionError(
        'the account has no workers.dev subdomain yet — pick one in the dashboard (Workers & Pages → Overview) or pass a custom host'
      )
    return r.subdomain
  }
}

const withComment = (rec: DnsRecordInput) => ({ ...rec, comment: 'rocketflare provision: Resend' })
const normalise = (v: string) => v.trim().replace(/^"|"$/g, '').replace(/\.$/, '').toLowerCase()
