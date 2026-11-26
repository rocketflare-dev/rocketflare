/**
 * AWS Signature Version 4 query-string presigning (S3, and R2's S3-compatible API), over Web
 * Crypto. Written here rather than taken from a library because WHICH headers are signed is the
 * whole point: an upload URL is only a limit if `content-length`, `content-type` and
 * `if-none-match` are in `X-Amz-SignedHeaders`, and a presigner that quietly drops one leaves the
 * upload unbounded. The payload is `UNSIGNED-PAYLOAD` (the body is not known when the URL is made)
 * and `x-amz-content-sha256` is never signed — R2 refuses a query-signed request that signs it.
 *
 * Verified against the presigned-URL example in the AWS S3 documentation
 * (`tests/api/uploads-sigv4.test.ts`).
 */

export interface PresignInput {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE'
  /** `https://<host>` — no path. */
  origin: string
  /** The object's path, unencoded, starting with `/` (`/<bucket>/<key>` for path-style). */
  path: string
  region: string
  service?: string
  accessKeyId: string
  secretAccessKey: string
  /** Seconds the URL is valid for (1 … 604 800). */
  expiresIn: number
  /** Headers the client MUST send with exactly these values. `host` is added. */
  headers?: Record<string, string>
  /** Defaults to now — injectable for the test vector. */
  date?: Date
}

const encoder = new TextEncoder()

/** RFC 3986 encoding as SigV4 wants it: everything but `A-Za-z0-9-_.~` is `%XX`, uppercase. */
export function uriEncode(value: string, keepSlash = false): string {
  let out = ''
  for (const byte of encoder.encode(value)) {
    const ch = String.fromCharCode(byte)
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === '/')) out += ch
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')

async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

async function hmac(
  key: ArrayBuffer | Uint8Array<ArrayBuffer>,
  value: string
): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  return crypto.subtle.sign('HMAC', k, encoder.encode(value))
}

/** `20130524T000000Z` */
const amzDate = (d: Date): string =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')

/** A presigned URL: the signature covers the method, path, query and the named headers. */
export async function presignUrl(input: PresignInput): Promise<string> {
  const service = input.service ?? 's3'
  const date = input.date ?? new Date()
  const stamp = amzDate(date)
  const day = stamp.slice(0, 8)
  const scope = `${day}/${input.region}/${service}/aws4_request`
  const host = new URL(input.origin).host

  const headers = new Map<string, string>([['host', host]])
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers.set(name.toLowerCase(), value.trim().replace(/\s+/g, ' '))
  }
  const names = [...headers.keys()].sort()
  const signedHeaders = names.join(';')

  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.accessKeyId}/${scope}`],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(input.expiresIn)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ]
  const canonicalQuery = query
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const canonicalPath = uriEncode(input.path, true)

  const canonicalRequest = [
    input.method,
    canonicalPath,
    canonicalQuery,
    names.map(n => `${n}:${headers.get(n)}\n`).join(''),
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256Hex(canonicalRequest)].join(
    '\n'
  )

  let key = await hmac(encoder.encode(`AWS4${input.secretAccessKey}`), day)
  key = await hmac(key, input.region)
  key = await hmac(key, service)
  key = await hmac(key, 'aws4_request')
  const signature = hex(await hmac(key, stringToSign))

  return `${input.origin}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`
}
