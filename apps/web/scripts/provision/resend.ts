/**
 * Resend REST API over plain `fetch` (no SDK). Facts verified against
 * https://resend.com/docs/api-reference/ on 2026-09-02:
 *   - `Authorization: Bearer re_…`; `GET /domains` → `{ data: [{ id, name, status, region }] }`
 *     with NO `records` in the list (…/domains/list-domains)
 *   - `POST /domains { name, region?, custom_return_path? }` — region ∈ us-east-1 | eu-west-1 |
 *     sa-east-1 | ap-northeast-1 and is permanent per domain; the response carries `records[]`
 *     `{ record: SPF|DKIM|MX|Tracking, name, type: TXT|CNAME|MX, ttl, status, value, priority? }`
 *     (…/domains/create-domain)
 *   - `GET /domains/{id}` → `{ id, name, status: not_started | pending | verified | failed |
 *     temporary_failure, records[] }` (…/domains/get-domain)
 *   - `POST /domains/{id}/verify` → `{ object: 'domain', id }`, asynchronous — poll GET
 *     (…/domains/verify-domain)
 *   - `POST /api-keys { name (≤ 50), permission: full_access | sending_access, domain_id }` →
 *     `{ id, token }`; `domain_id` only with `sending_access` (…/api-keys/create-api-key)
 *
 * Record NAMES are mixed: `send` and `<hash>._domainkey` are relative to the domain while the
 * Tracking record already comes back fully qualified (`links.example.com`), so
 * `resendRecordsToDns` qualifies only what is not already under the domain
 * (https://resend.com/docs/dashboard/domains/cloudflare: "omit your domain from the record …
 * DKIM: Proxy status DNS only").
 */
import { ProvisionError } from './config'
import { redact } from './redact'

export const RESEND_API = 'https://api.resend.com'
export const RESEND_DEFAULT_REGION = 'us-east-1'

export interface ResendRecord {
  record: string
  name: string
  type: string
  ttl?: string
  status?: string
  value: string
  priority?: number | string
}
export interface ResendDomain {
  id: string
  name: string
  status: string
  region?: string
  records?: ResendRecord[]
}

export interface DnsRecordInput {
  type: string
  name: string
  content: string
  ttl: number
  proxied: boolean
  priority?: number
}

type Fetch = typeof fetch

export class ResendClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: Fetch = fetch
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${RESEND_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
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
    if (!res.ok)
      throw new ProvisionError(
        `Resend ${method} ${path} → ${res.status}: ${redact(JSON.stringify(json)).slice(0, 400)}`
      )
    return json as T
  }

  async listDomains(): Promise<ResendDomain[]> {
    const { data } = await this.request<{ data: ResendDomain[] }>('GET', '/domains')
    return data ?? []
  }

  getDomain(id: string): Promise<ResendDomain> {
    return this.request<ResendDomain>('GET', `/domains/${id}`)
  }

  createDomain(name: string, region = RESEND_DEFAULT_REGION): Promise<ResendDomain> {
    return this.request<ResendDomain>('POST', '/domains', { name, region })
  }

  verifyDomain(id: string) {
    return this.request<{ object: string; id: string }>('POST', `/domains/${id}/verify`)
  }

  /** A sending-only key scoped to one domain; the token is returned ONCE and never logged. */
  createSendingKey(name: string, domainId: string) {
    return this.request<{ id: string; token: string }>('POST', '/api-keys', {
      name: name.slice(0, 50),
      permission: 'sending_access',
      domain_id: domainId,
    })
  }
}

// ---- pure helpers (unit-tested) -------------------------------------------------------------

/** `send` + `mail.example.com` → `send.mail.example.com`; an already-qualified name is kept. */
export function qualifyRecordName(name: string, domain: string): string {
  const n = name.trim().replace(/\.$/, '')
  if (n === '' || n === '@' || n === domain) return domain
  if (n.endsWith(`.${domain}`)) return n
  return `${n}.${domain}`
}

/** Resend's `records[]` → Cloudflare `dns_records` bodies: FQDN names, `ttl: 1` (auto), never proxied. */
export function resendRecordsToDns(records: ResendRecord[], domain: string): DnsRecordInput[] {
  return records.map(r => {
    const out: DnsRecordInput = {
      type: r.type.toUpperCase(),
      name: qualifyRecordName(r.name, domain),
      content: r.value,
      ttl: 1,
      proxied: false, // DKIM CNAME/TXT and MX must resolve to Resend's values, not Cloudflare's edge
    }
    if (out.type === 'MX') out.priority = Number(r.priority ?? 10)
    return out
  })
}

/**
 * Zone lookup order for a sending domain: the domain itself, then every parent, stopping before
 * the TLD — `mail.app.example.co.uk` → [`mail.app.example.co.uk`, `app.example.co.uk`,
 * `example.co.uk`, `co.uk`]. The first one that exists as a zone in the account wins (`co.uk`
 * never will, which is fine).
 */
export function zoneCandidates(domain: string): string[] {
  const labels = domain.toLowerCase().replace(/\.$/, '').split('.')
  const out: string[] = []
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join('.'))
  return out
}

export const emailFromFor = (appName: string, domain: string): string =>
  `${appName} <noreply@${domain}>`
