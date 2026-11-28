/**
 * `apps/web/scripts/dev-db.mjs up` and the port it publishes the dev database on, run for real
 * against a throwaway tree with a fake `docker` on PATH. A field report: `.dev.vars` carried
 * :5682, which the old scan (5432–5451 only) never probed, so it read as "taken by something
 * else" and the database moved, silently, onto :5432 — another project's container. A chosen port
 * is now kept or refused with its holder named; only a fresh checkout's default moves.
 */
import { spawn } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const sandboxes: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true })
  await Promise.all(servers.splice(0).map(s => new Promise(r => s.close(r))))
})

const url = (port: number) =>
  `postgresql://rocketflare:rocketflare_pass@localhost:${port}/rocketflare_dev`

/**
 * The script, its library and a `.dev.vars` on `port`; `docker ps` answers `published`, and
 * every `docker compose` call succeeds having started nothing.
 */
function makeTree(port: number | null, published = '') {
  const root = mkdtempSync(path.join(tmpdir(), 'rf-dev-db-'))
  sandboxes.push(root)
  cpSync(path.join(REPO_ROOT, 'scripts/lib'), path.join(root, 'scripts/lib'), { recursive: true })
  mkdirSync(path.join(root, 'apps/web/scripts'), { recursive: true })
  cpSync(
    path.join(REPO_ROOT, 'apps/web/scripts/dev-db.mjs'),
    path.join(root, 'apps/web/scripts/dev-db.mjs')
  )
  writeFileSync(path.join(root, 'apps/web/docker-compose.dev.yml'), 'services: {}\n')
  writeFileSync(path.join(root, 'apps/web/.dev.vars.example'), `DATABASE_URL=${url(5432)}\n`)
  if (port !== null)
    writeFileSync(path.join(root, 'apps/web/.dev.vars'), `DATABASE_URL=${url(port)}\n`)
  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'ps.txt'), published)
  writeFileSync(
    path.join(bin, 'docker'),
    `#!/bin/sh\nif [ "$1" = "ps" ]; then cat "${path.join(bin, 'ps.txt')}"; fi\nexit 0\n`
  )
  chmodSync(path.join(bin, 'docker'), 0o755)
  return { root, bin }
}

/** Async, so a server this test process holds can answer the script's connect probe. */
function up(
  tree: { root: string; bin: string },
  args: string[] = [],
  env: Record<string, string> = {}
) {
  return new Promise<{ status: number; out: string }>(resolve => {
    const child = spawn(
      process.execPath,
      [path.join(tree.root, 'apps/web/scripts/dev-db.mjs'), 'up', '--json', ...args],
      {
        cwd: path.join(tree.root, 'apps/web'),
        env: { ...process.env, DEV_DB_PORT: '', ...env, PATH: `${tree.bin}:${process.env.PATH}` },
      }
    )
    let out = ''
    child.stdout.on('data', d => {
      out += d
    })
    child.stderr.on('data', d => {
      out += d
    })
    child.on('close', code => resolve({ status: code ?? 1, out }))
  })
}

/** A port nothing listens on, found by asking the OS. */
async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  const { port } = s.address() as { port: number }
  await new Promise(r => s.close(r))
  return port
}

/** A port this test holds on loopback only — what a bind test on 0.0.0.0 alone would miss. */
async function heldPort(): Promise<number> {
  const s = createServer()
  servers.push(s)
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  return (s.address() as { port: number }).port
}

const lastJson = (out: string) => JSON.parse(out.trim().split('\n').at(-1) ?? '{}')

describe('dev-db up: the port', () => {
  it('keeps a chosen port outside the old scan range when it is free', async () => {
    const port = await freePort()
    const tree = makeTree(port)
    const r = await up(tree)
    expect(r.status, r.out).toBe(0)
    expect(lastJson(r.out)).toMatchObject({ port, moved: false })
  })

  it('refuses a chosen port another container publishes, naming it, and writes nothing', async () => {
    const port = await freePort()
    const tree = makeTree(port, `other-project-db\t0.0.0.0:${port}->5432/tcp\n`)
    const r = await up(tree)
    expect(r.status).toBe(1)
    expect(r.out).toContain(`port ${port}`)
    expect(r.out).toContain('container other-project-db')
    expect(readFileSync(path.join(tree.root, 'apps/web/.dev.vars'), 'utf8')).toBe(
      `DATABASE_URL=${url(port)}\n`
    )
  })

  it('refuses a chosen port a loopback-only server holds', async () => {
    const port = await heldPort()
    const r = await up(makeTree(port))
    expect(r.status).toBe(1)
    expect(r.out).toContain(`port ${port} (DATABASE_URL in apps/web/.dev.vars) is taken`)
  })

  it('honours --port and DEV_DB_PORT, and refuses either when it is held', async () => {
    const port = await freePort()
    const tree = makeTree(null)
    const flagged = await up(tree, ['--port', String(port)])
    expect(flagged.status, flagged.out).toBe(0)
    expect(lastJson(flagged.out)).toMatchObject({ port })

    const held = await heldPort()
    const refused = await up(makeTree(null), [], { DEV_DB_PORT: String(held) })
    expect(refused.status).toBe(1)
    expect(refused.out).toContain(`port ${held} is taken`)
  })

  it("moves a fresh checkout off the example's port past a container, saying who holds it", async () => {
    const ps = 'one\t0.0.0.0:5432->5432/tcp\ntwo\t0.0.0.0:5434->5432/tcp\n'
    const r = await up(makeTree(5432, ps))
    expect(r.status, r.out).toBe(0)
    const chosen = lastJson(r.out)
    expect(chosen.moved).toBe(true)
    expect([5432, 5433, 5434]).not.toContain(chosen.port)
    expect(chosen.reason).toBe(':5432 is taken by container one')
  })
})
