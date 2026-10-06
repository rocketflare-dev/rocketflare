/**
 * A WebSocket → Postgres TCP relay on 127.0.0.1 — what Neon's wsproxy does — for tests that run
 * the REAL `@neondatabase/serverless` driver against the test database (`NEON_LOCAL_PROXY` /
 * `routeNeonThroughProxy` point it here; the driver speaks the Postgres protocol over the
 * WebSocket). It can refuse the first `refuse` upgrades (the socket destroyed: the driver's empty
 * `ErrorEvent`) and drop every live connection on demand (`dropAll`) — the network failures a
 * sandbox sees, on a laptop.
 *
 * The driver speaks PLAINTEXT Postgres to a proxy, so the relay negotiates TLS upstream itself,
 * as libpq's `sslmode=prefer` does: an SSLRequest first, then TLS on `S` (a Neon gate branch,
 * which refuses plaintext with "connection is insecure") or plaintext on `N` (the local test
 * Postgres). A REMOTE upstream that answers `N` is dropped — a password never crosses the network
 * in the clear. A remote certificate is verified; a local one (self-signed) is not.
 */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { connect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

/** Int32 length 8, then the SSLRequest code 80877103 (the Postgres protocol's SSL negotiation). */
export const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * Connect to `target`'s Postgres and negotiate TLS: resolves the socket to speak the protocol on
 * (a TLS socket on `S`, the raw one on a LOCAL `N`). `track` sees every socket made, so `dropAll`
 * reaches one still negotiating.
 */
function openUpstream(target: URL, track: (socket: Socket) => void): Promise<Socket> {
  const host = target.hostname
  const local = LOCAL_HOSTS.has(host)
  const raw = connect(Number(target.port || 5432), host)
  track(raw)
  return new Promise((resolve, reject) => {
    // Permanent: a no-op once settled, and the raw socket under TLS still needs an error listener.
    raw.on('error', reject)
    raw.on('close', () => reject(new Error('upstream closed during SSL negotiation')))
    raw.once('connect', () => raw.write(SSL_REQUEST))
    raw.once('data', (answer: Buffer) => {
      const reply = String.fromCharCode(answer[0] ?? 0)
      if (reply === 'N' && local) return resolve(raw)
      if (reply !== 'S') {
        raw.destroy()
        return reject(new Error(`upstream ${host} answered '${reply}' to SSLRequest`))
      }
      // SNI is the URL's HOSTNAME: Neon routes a connection to its endpoint by it ("Endpoint ID
      // is not specified" without it). An IP literal sends none (Node refuses an IP servername).
      const secure = tlsConnect({
        socket: raw,
        servername: isIP(host) ? undefined : host,
        rejectUnauthorized: !local,
      })
      track(secure)
      secure.on('error', reject)
      secure.once('secureConnect', () => resolve(secure))
    })
  })
}

export interface PgRelay {
  /** `http://127.0.0.1:<port>` — a `NEON_LOCAL_PROXY` value. */
  url: string
  upgrades: () => number
  /** Destroy every connection open now (both sides), as a network blip would. */
  dropAll: () => void
  close: () => void
}

/**
 * Start a relay to `DATABASE_URL`'s Postgres — local, or a Neon gate branch — that refuses its
 * first `refuse` upgrades. `databaseUrl` overrides the target (`tests/config/ws-pg-relay.test.ts`).
 */
export async function relay(
  refuse = 0,
  databaseUrl = process.env.DATABASE_URL ?? ''
): Promise<PgRelay> {
  const target = new URL(databaseUrl)
  let upgrades = 0
  const sockets = new Set<Socket>()
  const server: Server = createServer((_req, res) => res.writeHead(404).end())
  server.on('upgrade', (req, socket: Socket) => {
    sockets.add(socket)
    upgrades++
    if (upgrades <= refuse) {
      socket.destroy()
      return
    }
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    // Payloads the driver sends before the upstream is ready (its startup message) wait here.
    let pg: Socket | undefined
    let closed = false
    const pending: Buffer[] = []
    openUpstream(target, s => sockets.add(s)).then(
      upstream => {
        if (closed) return upstream.destroy()
        pg = upstream
        upstream.on('data', (chunk: Buffer) => {
          const len = chunk.length
          const head =
            len < 126
              ? Buffer.from([0x82, len])
              : len < 65536
                ? Buffer.from([0x82, 126, len >> 8, len & 255])
                : Buffer.concat([
                    Buffer.from([0x82, 127]),
                    Buffer.alloc(4),
                    Buffer.from([len >>> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255]),
                  ])
          socket.write(Buffer.concat([head, chunk]))
        })
        upstream.on('error', () => socket.destroy())
        upstream.on('close', () => socket.destroy())
        for (const payload of pending.splice(0)) upstream.write(payload)
      },
      () => socket.destroy()
    )
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (buf.length < 2) return
        const opcode = (buf[0] ?? 0) & 0x0f
        let len = (buf[1] ?? 0) & 0x7f
        let at = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          at = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          len = Number(buf.readBigUInt64BE(2))
          at = 10
        }
        if (buf.length < at + 4 + len) return
        const mask = buf.subarray(at, at + 4)
        const payload = Buffer.from(buf.subarray(at + 4, at + 4 + len))
        for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0)
        buf = buf.subarray(at + 4 + len)
        if (opcode === 8) {
          closed = true
          pg?.end()
          socket.end()
          return
        }
        if (pg) pg.write(payload)
        else pending.push(payload)
      }
    })
    const hangUp = () => {
      closed = true
      pg?.destroy()
    }
    socket.on('error', hangUp)
    socket.on('close', hangUp)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    upgrades: () => upgrades,
    dropAll: () => {
      for (const s of sockets) s.destroy()
      sockets.clear()
    },
    close: () => {
      for (const s of sockets) s.destroy()
      server.close()
    },
  }
}
