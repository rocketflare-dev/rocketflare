/**
 * The presigner (`services/uploads/sigv4.ts`) against the presigned-URL example in the AWS S3
 * documentation ("Authenticating Requests: Using Query Parameters", GET examplebucket/test.txt on
 * 2013-05-24): if the canonical request, scope or HMAC chain drift, the signature differs.
 */
import { describe, expect, it } from 'vitest'
import { presignUrl, uriEncode } from '@/api/services/uploads/sigv4'

describe('presignUrl', () => {
  it('reproduces the AWS documented signature', async () => {
    const url = await presignUrl({
      method: 'GET',
      origin: 'https://examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      expiresIn: 86400,
      date: new Date('2013-05-24T00:00:00Z'),
    })
    const q = new URL(url).searchParams
    expect(q.get('X-Amz-SignedHeaders')).toBe('host')
    expect(q.get('X-Amz-Signature')).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
    )
  })

  it('signs every header it is given, lower-cased and sorted', async () => {
    const url = await presignUrl({
      method: 'PUT',
      origin: 'https://acct.r2.cloudflarestorage.com',
      path: '/bucket/tenants/t/a b.txt',
      region: 'auto',
      accessKeyId: 'k',
      secretAccessKey: 's',
      expiresIn: 600,
      headers: { 'Content-Type': 'text/plain', 'If-None-Match': '*', 'Content-Length': '5' },
    })
    expect(new URL(url).pathname).toBe('/bucket/tenants/t/a%20b.txt')
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;if-none-match'
    )
  })

  it('uriEncode keeps only the unreserved set (and / when asked)', () => {
    expect(uriEncode('a/b c~*é')).toBe('a%2Fb%20c~%2A%C3%A9')
    expect(uriEncode('a/b', true)).toBe('a/b')
  })
})
