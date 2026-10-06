/**
 * A WebSocket → Postgres TCP relay on 127.0.0.1 — what Neon's wsproxy does — for tests that run
 * the REAL `@neondatabase/serverless` driver against the test Postgres (`NEON_LOCAL_PROXY` /
 * `routeNeonThroughProxy` point it here; the driver speaks the Postgres protocol over the
 * WebSocket). It can refuse the first `refuse` upgrades (the socket destroyed: the driver's empty
 * `ErrorEvent`) and drop every live connection on demand (`dropAll`) — the network failures a
 * sandbox sees, on a laptop.
 */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'

export interface PgRelay {
  /** `http://127.0.0.1:<port>` — a `NEON_LOCAL_PROXY` value. */
  url: string
  upgrades: () => number
  /** Destroy every connection open now (both sides), as a network blip would. */
  dropAll: () => void
  close: () => void
}

/** Start a relay to `DATABASE_URL`'s Postgres that refuses its first `refuse` upgrades. */
export async function relay(refuse = 0): Promise<PgRelay> {
  const target = new URL(process.env.DATABASE_URL ?? '')
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
    const pg = connect(Number(target.port || 5432), target.hostname)
    sockets.add(pg)
    pg.on('data', (chunk: Buffer) => {
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
          pg.end()
          socket.end()
          return
        }
        pg.write(payload)
      }
    })
    socket.on('error', () => pg.destroy())
    pg.on('error', () => socket.destroy())
    pg.on('close', () => socket.destroy())
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
