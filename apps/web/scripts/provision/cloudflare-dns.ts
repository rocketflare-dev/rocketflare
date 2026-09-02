/**
 * Cloudflare v4 API over plain `fetch` — the few calls wrangler has no command for. Facts
 * verified against https://developers.cloudflare.com/api/ on 2026-09-02:
 *   - `Authorization: Bearer <token>`; envelope `{ success, errors[], messages[], result }`
 *   - `GET /zones?name=<zone>&per_page=50` → `result: [{ id, name, status }]`
 *     (…/resources/zones/methods/list/); a token without a Zone scope gets `result: []`, not an
 *     error, so "no zone" and "no zone permission" look alike — `hasAnyZone()` tells them apart
 *   - `GET /zones/{zone}/dns_records?per_page=1` is the cheapest proof the token can READ DNS in
 *     that zone (`assertDnsRead`); `Zone: DNS — Edit` is what the kit asks for, which implies it
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

  /** Whether the token sees ANY zone in the account — false means the token lacks a Zone scope. */
  async hasAnyZone(): Promise<boolean> {
    const zones = await this.request<{ id: string }[]>('GET', '/zones?per_page=1')
    return zones.length > 0
  }

  /** Throws with the fix when the token cannot read DNS records in the zone (its own message, not the hint for a missing zone). */
  async assertDnsRead(zone: { id: string; name: string }): Promise<void> {
    try {
      await this.request('GET', `/zones/${zone.id}/dns_records?per_page=1`)
    } catch (err) {
      throw new ProvisionError(
        `the token cannot read DNS records in zone ${zone.name} (${zone.id}) — give CLOUDFLARE_API_TOKEN \`Zone: DNS — Edit\` on that zone (${err instanceof Error ? err.message : String(err)})`
      )
    }
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

// ---- pure helpers (tests/config/provision-zone.test.ts) ----------------------------------

export const WORKERS_DEV = 'workers.dev'

/**
 * The names preflight must resolve to a zone in the account: every custom host (anything but the
 * literal `workers.dev`) and the sending domain unless email is skipped. Lower-cased, deduplicated,
 * hosts first.
 */
export function hostsNeedingZone(
  answers: { hosts: Record<string, string>; domain?: string },
  skipEmail: boolean
): string[] {
  const out: string[] = []
  const add = (v: string | undefined) => {
    const name = v?.trim().toLowerCase().replace(/\.$/, '')
    if (name && name !== WORKERS_DEV && !out.includes(name)) out.push(name)
  }
  for (const host of Object.values(answers.hosts)) add(host)
  if (!skipEmail) add(answers.domain)
  return out
}

/** The one sentence a person sees when a host or sending domain is not a zone in the account. */
export const missingZoneHint = (apex: string): string =>
  `the domain ${apex} is not on this Cloudflare account. Add it first — register it at https://dash.cloudflare.com/?to=/:account/domains/register or add the site and move its nameservers (https://dash.cloudflare.com/?to=/:account/add-site) — or use workers.dev for the hosts and --skip-email.`
