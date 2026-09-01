/**
 * Storage seam (D23): key building and filename sanitising are pure; `createR2Storage` is exercised
 * over the in-memory R2 bucket the whole api suite uses, so the adapter and the mock agree.
 */
import { describe, expect, it } from 'vitest'
import {
  buildStorageKey,
  createR2Storage,
  MAX_FILENAME_LENGTH,
  sanitizeFilename,
  tenantStoragePrefix,
} from '@/api/services/storage'
import { MemoryR2Bucket } from '../mocks/bindings'

const TENANT = '11111111-1111-4111-8111-111111111111'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('sanitizeFilename', () => {
  it('keeps only the last path segment — no traversal, no separators', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('C:\\Users\\me\\photo.png')).toBe('photo.png')
    expect(sanitizeFilename('/tmp/../x.txt')).toBe('x.txt')
  })

  it('reduces to [A-Za-z0-9._-], collapsing runs and stripping leading dots', () => {
    expect(sanitizeFilename('My Photo (1).PNG')).toBe('My_Photo_1_.PNG')
    expect(sanitizeFilename('.htaccess')).toBe('htaccess')
    expect(sanitizeFilename('a  b   c.jpg')).toBe('a_b_c.jpg')
    expect(sanitizeFilename('café résumé.pdf')).toMatch(/^[\w.-]+\.pdf$/)
  })

  it('never returns an empty name', () => {
    expect(sanitizeFilename('')).toBe('file')
    expect(sanitizeFilename('///')).toBe('file')
    expect(sanitizeFilename('...')).toBe('file')
  })

  it('bounds the length but keeps the extension', () => {
    const long = `${'a'.repeat(300)}.jpeg`
    const out = sanitizeFilename(long)
    expect(out.length).toBe(MAX_FILENAME_LENGTH)
    expect(out.endsWith('.jpeg')).toBe(true)
  })
})

describe('buildStorageKey', () => {
  it('is tenants/<tenant>/<scope>/<uuid>-<sanitised name>', () => {
    expect(
      buildStorageKey({ tenantId: TENANT, scope: 'avatars', name: 'me.png', id: 'fixed-id' })
    ).toBe(`tenants/${TENANT}/avatars/fixed-id-me.png`)
    const key = buildStorageKey({ tenantId: TENANT, scope: 'uploads', name: '../x y.txt' })
    const [, tenant, scope, tail] = key.split('/')
    expect(tenant).toBe(TENANT)
    expect(scope).toBe('uploads')
    expect(tail?.slice(0, 36)).toMatch(UUID_RE)
    expect(tail?.slice(36)).toBe('-x_y.txt')
  })

  it('two uploads of the same filename never collide', () => {
    const a = buildStorageKey({ tenantId: TENANT, scope: 'uploads', name: 'same.txt' })
    const b = buildStorageKey({ tenantId: TENANT, scope: 'uploads', name: 'same.txt' })
    expect(a).not.toBe(b)
  })

  it('tenantStoragePrefix scopes a tenant, optionally one scope', () => {
    expect(tenantStoragePrefix(TENANT)).toBe(`tenants/${TENANT}/`)
    expect(tenantStoragePrefix(TENANT, 'avatars')).toBe(`tenants/${TENANT}/avatars/`)
    expect(buildStorageKey({ tenantId: TENANT, scope: 'avatars', name: 'a' })).toContain(
      tenantStoragePrefix(TENANT, 'avatars')
    )
  })
})

describe('createR2Storage', () => {
  it('put → head/get → list → delete round-trips through the bucket', async () => {
    const bucket = new MemoryR2Bucket()
    const storage = createR2Storage(bucket as unknown as R2Bucket)
    const key = `tenants/${TENANT}/uploads/k1-hello.txt`

    const meta = await storage.put(key, 'hello', {
      contentType: 'text/plain',
      metadata: { tenantId: TENANT },
    })
    expect(meta).toMatchObject({ key, size: 5, contentType: 'text/plain' })
    expect(meta.etag).toMatch(/^".*"$/)
    expect(bucket.objects.has(key)).toBe(true)

    const head = await storage.head(key)
    expect(head).toMatchObject({ key, size: 5, contentType: 'text/plain', etag: meta.etag })
    expect(head?.metadata).toEqual({ tenantId: TENANT })

    const got = await storage.get(key)
    expect(got).not.toBeNull()
    expect(await new Response(got?.body).text()).toBe('hello')

    await storage.put(`tenants/${TENANT}/avatars/k2-a.png`, new Uint8Array([1, 2, 3]), {
      contentType: 'image/png',
    })
    const all = await storage.list(tenantStoragePrefix(TENANT))
    expect(all.map(o => o.key).sort()).toEqual([key, `tenants/${TENANT}/avatars/k2-a.png`].sort())
    expect((await storage.list(tenantStoragePrefix(TENANT, 'avatars'))).map(o => o.key)).toEqual([
      `tenants/${TENANT}/avatars/k2-a.png`,
    ])

    await storage.delete(key)
    await storage.delete(key) // idempotent
    expect(await storage.get(key)).toBeNull()
    expect(await storage.head(key)).toBeNull()
  })

  it('defaults an unknown content type to application/octet-stream', async () => {
    const bucket = new MemoryR2Bucket()
    await bucket.put('raw', 'x')
    const storage = createR2Storage(bucket as unknown as R2Bucket)
    expect((await storage.head('raw'))?.contentType).toBe('application/octet-stream')
  })
})
