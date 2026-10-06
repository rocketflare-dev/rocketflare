/**
 * `tests/helpers/ws-pg-relay.ts` negotiates TLS with its upstream the way libpq does, so the Neon
 * relay tests (`tests/api/neon-pool-errors.test.ts`) reach a real Neon gate branch — which refuses
 * plaintext ("connection is insecure") and routes by SNI ("Endpoint ID is not specified") — as
 * well as the local test Postgres. A fake upstream on loopback answers the SSLRequest with `S` and
 * records the SNI of the TLS ClientHello that follows; it never finishes the handshake, so no
 * certificate is needed.
 */
import { createServer, type Server, type Socket } from 'node:net'
import { TLSSocket } from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import { type PgRelay, relay, SSL_REQUEST } from '../helpers/ws-pg-relay'

const opened: Array<{ close: () => void }> = []
afterEach(() => {
  for (const o of opened.splice(0)) o.close()
})

/** An upstream that wants TLS: resolves the SSLRequest bytes and the ClientHello's servername. */
async function tlsUpstream() {
  let seen: (value: { request: Buffer; servername: string | null }) => void = () => {}
  const result = new Promise<{ request: Buffer; servername: string | null }>(r => {
    seen = r
  })
  const sockets = new Set<Socket>()
  const server: Server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('data', (request: Buffer) => {
      socket.write('S')
      const tls = new TLSSocket(socket, {
        isServer: true,
        SNICallback: (servername, cb) => {
          seen({ request, servername })
          cb(new Error('captured'), undefined)
        },
      })
      tls.on('error', () => seen({ request, servername: null }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  opened.push({
    close: () => {
      for (const s of sockets) s.destroy()
      server.close()
    },
  })
  return { port, result }
}

function dial(r: PgRelay): WebSocket {
  const ws = new WebSocket(`${r.url.replace('http', 'ws')}/v2`)
  ws.addEventListener('error', () => {})
  opened.push({ close: () => ws.close() })
  return ws
}

describe('ws-pg-relay upstream TLS', () => {
  it('sends an SSLRequest, then TLS with SNI = the DATABASE_URL hostname', async () => {
    const upstream = await tlsUpstream()
    const r = await relay(0, `postgresql://u:p@localhost:${upstream.port}/db`)
    opened.push(r)
    dial(r)
    const { request, servername } = await upstream.result
    expect(request).toEqual(SSL_REQUEST)
    expect(servername).toBe('localhost')
  })

  it('an IP-literal host gets no SNI (Node refuses an IP servername)', async () => {
    const upstream = await tlsUpstream()
    const r = await relay(0, `postgresql://u:p@127.0.0.1:${upstream.port}/db`)
    opened.push(r)
    dial(r)
    // No SNI extension: the callback is never asked, the handshake fails without a certificate.
    expect((await upstream.result).servername).toBeNull()
  })
})
