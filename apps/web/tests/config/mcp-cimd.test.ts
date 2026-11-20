/**
 * The authorization server's pure rules: which `client_id` URLs it will fetch at all, the fetch's
 * guard (redirects, size, type, the document naming itself), the loopback redirect rule, how a
 * scope string is read, and the seal that lets a refresh retry get its successor back.
 */
import { describe, expect, it } from 'vitest'
import { parseScopes } from '@/api/services/mcp/authorization'
import {
  CIMD_MAX_BYTES,
  clientIdUrl,
  fetchClientDocument,
  isPublicHostname,
  OAuthClientError,
  redirectUriAllowed,
} from '@/api/services/mcp/cimd'
import { openWith, sealWith } from '@/api/services/mcp/seal'

const ID = 'https://client.example.com/oauth/metadata.json'
const doc = (over: Record<string, unknown> = {}) => ({
  client_id: ID,
  client_name: 'Example',
  redirect_uris: ['https://client.example.com/cb', 'http://127.0.0.1/callback'],
  token_endpoint_auth_method: 'none',
  ...over,
})
const answer = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })

async function refusal(fetcher: () => Promise<Response>) {
  const err = await fetchClientDocument(new URL(ID), fetcher).catch(e => e)
  expect(err).toBeInstanceOf(OAuthClientError)
  return (err as OAuthClientError).description
}

describe('which hosts a client_id may name', () => {
  it('public DNS names only', () => {
    for (const host of ['claude.ai', 'chatgpt.com', 'a.b.example.co.uk']) {
      expect(isPublicHostname(host), host).toBe(true)
    }
    for (const host of [
      'localhost',
      'intranet',
      '127.0.0.1',
      '10.0.0.8',
      '169.254.169.254',
      '[::1]',
      '0x7f.1',
      '2130706433',
      'printer.local',
      'db.internal',
      'app.localhost',
      'nas.home.arpa',
    ]) {
      expect(isPublicHostname(host), host).toBe(false)
    }
  })

  it('an https URL on the default port, with a path, exactly as sent', () => {
    expect(clientIdUrl(ID)?.toString()).toBe(ID)
    for (const bad of [
      'http://client.example.com/m.json',
      'https://client.example.com:8443/m.json',
      'https://client.example.com/',
      'https://user:pw@client.example.com/m.json',
      'https://client.example.com/m.json#frag',
      'https://CLIENT.example.com/m.json',
      'https://10.1.2.3/m.json',
      undefined,
      '',
    ]) {
      expect(clientIdUrl(bad), String(bad)).toBeNull()
    }
  })
})

describe('the document fetch', () => {
  it('accepts a well-formed document that names itself', async () => {
    const got = await fetchClientDocument(new URL(ID), async (_url, init) => {
      expect(init.redirect).toBe('manual')
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return answer(doc())
    })
    expect(got.client_name).toBe('Example')
  })

  it('refuses a redirect, an error status, a non-JSON type, a big body and a different client_id', async () => {
    expect(
      await refusal(
        async () => new Response(null, { status: 302, headers: { Location: 'http://10.0.0.1/' } })
      )
    ).toMatch(/redirects/)
    expect(await refusal(async () => answer(doc(), { status: 404 }))).toMatch(/404/)
    expect(
      await refusal(async () => answer(doc(), { headers: { 'Content-Type': 'text/html' } }))
    ).toMatch(/not JSON/)
    const huge = JSON.stringify(doc({ client_name: 'x'.repeat(CIMD_MAX_BYTES) }))
    expect(await refusal(async () => answer(huge))).toMatch(/too large/)
    expect(
      await refusal(async () => answer(doc({ client_id: 'https://other.example.com/m.json' })))
    ).toMatch(/different client_id/)
  })

  it('refuses a confidential client, an unusable redirect and a timeout', async () => {
    expect(
      await refusal(async () => answer(doc({ token_endpoint_auth_method: 'private_key_jwt' })))
    ).toMatch(/public clients/)
    for (const uri of [
      'javascript:alert(1)',
      'http://client.example.com/cb',
      'https://x.example/cb#f',
    ]) {
      expect(await refusal(async () => answer(doc({ redirect_uris: [uri] }))), uri).toMatch(
        /redirect URI/
      )
    }
    expect(
      await refusal(async () => {
        throw new DOMException('timed out', 'TimeoutError')
      })
    ).toMatch(/could not be fetched/)
  })
})

describe('redirect URIs', () => {
  const client = { redirectUris: ['https://client.example.com/cb', 'http://127.0.0.1/callback'] }
  it('an exact match, or a loopback one on any port with the same host and path', () => {
    expect(redirectUriAllowed(client, 'https://client.example.com/cb')).toBe(true)
    expect(redirectUriAllowed(client, 'http://127.0.0.1:61000/callback')).toBe(true)
    for (const bad of [
      'https://client.example.com/cb2',
      'https://client.example.com/cb?x=1',
      'http://localhost:61000/callback',
      'http://127.0.0.1:61000/other',
      undefined,
    ]) {
      expect(redirectUriAllowed(client, bad), String(bad)).toBe(false)
    }
  })
})

describe('scopes', () => {
  it('defaults to read; write implies read; anything else is refused', () => {
    expect(parseScopes(undefined)).toEqual(['mcp:read'])
    expect(parseScopes('mcp:write')).toEqual(['mcp:read', 'mcp:write'])
    expect(parseScopes('mcp:read  mcp:read')).toEqual(['mcp:read'])
    expect(parseScopes('mcp:read openid')).toBeNull()
  })
})

describe('the refresh successor seal', () => {
  it('opens only with the token it was sealed under', async () => {
    const sealed = await sealWith('mcprt_spent', { refreshToken: 'mcprt_next' })
    expect(sealed).not.toContain('mcprt_next')
    expect(await openWith('mcprt_spent', sealed)).toEqual({ refreshToken: 'mcprt_next' })
    expect(await openWith('mcprt_other', sealed)).toBeNull()
    expect(await openWith('mcprt_spent', 'garbage')).toBeNull()
  })
})
