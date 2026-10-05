/**
 * `ci.yml`'s `verified` job (scripts/lib/gate-verified-lib.mjs): CI skips lint, typecheck and test
 * only for a tree Launch's own GitHub App attested as gated. Every doubt must answer "not verified"
 * — that is the security property — so most of these are the ways an attestation is NOT one.
 * The GitHub API is a fake that records every path asked for, so "no API call" is checkable.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findVerified,
  githubApi,
  isAttestation,
  LAUNCH_GATE_CHECK,
  planLookup,
} from '../../../../scripts/lib/gate-verified-lib.mjs'

const REPO = path.resolve(__dirname, '../../../..')
const APP = 4242
const TREE = 'a'.repeat(40)
const OTHER_TREE = 'b'.repeat(40)
const MERGE = '1'.repeat(40) // the pull_request merge commit, or the pushed commit on main
const HEAD = '2'.repeat(40) // the PR head Launch attested
const MAIN = 'refs/heads/main'

/** A check run as the REST API returns it, Launch's by default. */
function run(over: Record<string, unknown> = {}) {
  return {
    name: LAUNCH_GATE_CHECK,
    status: 'completed',
    conclusion: 'success',
    external_id: `tree:${TREE}`,
    app: { id: APP },
    output: { text: JSON.stringify({ tree: TREE, sessionId: 's1', attempt: 1, steps: [] }) },
    ...over,
  }
}

/** A fake `api`: check runs per commit, PRs per commit; records every path. */
function fakeApi(opts: {
  runs?: Record<string, unknown[]>
  pulls?: Record<string, unknown[]>
  fail?: boolean
}) {
  const calls: string[] = []
  const api = async (p: string) => {
    calls.push(p)
    if (opts.fail) throw new Error('GET x: HTTP 403')
    const runs = p.match(/^commits\/([0-9a-f]{40})\/check-runs\?/)
    if (runs) return { total_count: 0, check_runs: opts.runs?.[runs[1] ?? ''] ?? [] }
    const pulls = p.match(/^commits\/([0-9a-f]{40})\/pulls\?/)
    if (pulls) return opts.pulls?.[pulls[1] ?? ''] ?? []
    throw new Error(`unexpected ${p}`)
  }
  return { api, calls }
}

function prPlan(appId = String(APP)) {
  const plan = planLookup({ appId, eventName: 'pull_request', sha: MERGE, prHeadSha: HEAD })
  if (!plan.lookup) throw new Error(plan.reason)
  return plan
}

function pushPlan() {
  const plan = planLookup({ appId: String(APP), eventName: 'push', ref: MAIN, sha: MERGE })
  if (!plan.lookup) throw new Error(plan.reason)
  return plan
}

describe('planLookup', () => {
  it('looks nothing up when LAUNCH_GATE_APP_ID is unset or empty', () => {
    for (const appId of [undefined, '', '  ']) {
      const plan = planLookup({ appId, eventName: 'pull_request', sha: MERGE, prHeadSha: HEAD })
      expect(plan).toEqual({ lookup: false, reason: 'LAUNCH_GATE_APP_ID is not set' })
    }
  })

  it('refuses an app id that is not a number', () => {
    const plan = planLookup({ appId: 'launch', eventName: 'push', ref: MAIN, sha: MERGE })
    expect(plan.lookup).toBe(false)
  })

  it('on a pull request, asks the PR head (where Launch posts) and the merge commit', () => {
    expect(prPlan()).toEqual({ lookup: true, appId: APP, commits: [HEAD, MERGE], pullsOf: null })
  })

  it('on a push to main, asks the pushed commit and the heads of its PRs', () => {
    expect(pushPlan()).toEqual({ lookup: true, appId: APP, commits: [MERGE], pullsOf: MERGE })
  })

  it('answers false for any other event — deploy.yml’s workflow_call on a tag or a dispatch', () => {
    const app = String(APP)
    for (const ctx of [
      { eventName: 'push', ref: 'refs/tags/1.2.3' },
      { eventName: 'push', ref: 'refs/heads/feature' },
      { eventName: 'workflow_dispatch', ref: MAIN },
      { eventName: 'pull_request', ref: 'refs/pull/7/merge' }, // no head sha
    ]) {
      expect(planLookup({ appId: app, sha: MERGE, ...ctx }).lookup, JSON.stringify(ctx)).toBe(false)
    }
  })
})

describe('isAttestation', () => {
  const want = { appId: APP, tree: TREE }

  it('accepts Launch’s check run for this tree', () => {
    expect(isAttestation(run(), want)).toBe(true)
    expect(isAttestation(run({ output: { text: null } }), want)).toBe(true)
  })

  it('rejects one from another app, with another name, or not a success', () => {
    expect(isAttestation(run({ app: { id: 999 } }), want)).toBe(false)
    expect(isAttestation(run({ app: null }), want)).toBe(false)
    expect(isAttestation(run({ name: 'launch/gate-x' }), want)).toBe(false)
    expect(isAttestation(run({ conclusion: 'failure' }), want)).toBe(false)
    expect(isAttestation(run({ conclusion: 'neutral' }), want)).toBe(false)
    expect(isAttestation(run({ status: 'in_progress', conclusion: null }), want)).toBe(false)
  })

  it('rejects another tree, in external_id or in output.text', () => {
    expect(isAttestation(run({ external_id: `tree:${OTHER_TREE}` }), want)).toBe(false)
    expect(isAttestation(run({ external_id: TREE }), want)).toBe(false)
    expect(isAttestation(run({ external_id: null }), want)).toBe(false)
    expect(
      isAttestation(run({ output: { text: JSON.stringify({ tree: OTHER_TREE }) } }), want)
    ).toBe(false)
    expect(isAttestation(run({ output: { text: '{not json' } }), want)).toBe(false)
  })
})

describe('findVerified', () => {
  it('pull request: verified when the PR head carries Launch’s attestation of the merge tree', async () => {
    const { api } = fakeApi({ runs: { [HEAD]: [run()] } })
    const r = await findVerified({ tree: TREE, plan: prPlan(), api })
    expect(r).toMatchObject({ verified: true, commit: HEAD })
  })

  it('asks for launch/gate from the trusted app only', async () => {
    const { api, calls } = fakeApi({ runs: { [HEAD]: [run()] } })
    await findVerified({ tree: TREE, plan: prPlan(), api })
    expect(calls[0]).toBe(
      `commits/${HEAD}/check-runs?check_name=launch%2Fgate&app_id=${APP}&filter=all&per_page=100`
    )
  })

  it('pull request: not verified when main moved, so the merge tree is not the attested one', async () => {
    const { api, calls } = fakeApi({
      runs: { [HEAD]: [run({ external_id: `tree:${OTHER_TREE}` })] },
    })
    const r = await findVerified({ tree: TREE, plan: prPlan(), api })
    expect(r.verified).toBe(false)
    expect(calls).toHaveLength(2) // the head, then the merge commit
  })

  it('not verified when the only launch/gate is from another app', async () => {
    const { api } = fakeApi({ runs: { [HEAD]: [run({ app: { id: 1 } })] } })
    expect((await findVerified({ tree: TREE, plan: prPlan(), api })).verified).toBe(false)
  })

  it('not verified when Launch’s check did not succeed', async () => {
    const { api } = fakeApi({ runs: { [HEAD]: [run({ conclusion: 'failure' })] } })
    expect((await findVerified({ tree: TREE, plan: prPlan(), api })).verified).toBe(false)
  })

  it('verified when the attested run is one of several', async () => {
    const runs = [run({ conclusion: 'failure' }), run({ app: { id: 1 } }), run()]
    const { api } = fakeApi({ runs: { [HEAD]: runs } })
    expect((await findVerified({ tree: TREE, plan: prPlan(), api })).verified).toBe(true)
  })

  it('push to main: verified on the pushed commit itself', async () => {
    const { api, calls } = fakeApi({ runs: { [MERGE]: [run()] } })
    const r = await findVerified({ tree: TREE, plan: pushPlan(), api })
    expect(r).toMatchObject({ verified: true, commit: MERGE })
    expect(calls.filter(c => c.includes('/check-runs?'))[0]).toContain(`commits/${MERGE}/`)
  })

  it('push to main: verified through the merged PR whose head Launch attested, same tree', async () => {
    const { api, calls } = fakeApi({
      pulls: { [MERGE]: [{ number: 7, merged_at: '2026-10-05T00:00:00Z', head: { sha: HEAD } }] },
      runs: { [HEAD]: [run()] },
    })
    const r = await findVerified({ tree: TREE, plan: pushPlan(), api })
    expect(r).toMatchObject({ verified: true, commit: HEAD })
    expect(calls[0]).toBe(`commits/${MERGE}/pulls?per_page=100`)
  })

  it('push to main: not verified when main’s tree moved past the attested PR head', async () => {
    const { api } = fakeApi({
      pulls: { [MERGE]: [{ number: 7, head: { sha: HEAD } }] },
      runs: { [HEAD]: [run({ external_id: `tree:${OTHER_TREE}` })] },
    })
    // main's tree is TREE; Launch gated OTHER_TREE (main had moved when the PR merged).
    expect((await findVerified({ tree: TREE, plan: pushPlan(), api })).verified).toBe(false)
  })

  it('throws on an API error (the script turns it into the full gate)', async () => {
    const { api } = fakeApi({ fail: true })
    await expect(findVerified({ tree: TREE, plan: prPlan(), api })).rejects.toThrow(/403/)
  })

  it('rejects a malformed tree without asking anything', async () => {
    const { api, calls } = fakeApi({})
    expect((await findVerified({ tree: 'HEAD', plan: prPlan(), api })).verified).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('githubApi', () => {
  it('GETs the repository path with the token, and throws on a non-2xx without echoing it', async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = []
    const fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: (init?.headers as Record<string, string>)?.authorization })
      return new Response(url.includes('bad') ? 'no' : '[]', {
        status: url.includes('bad') ? 404 : 200,
      })
    }) as unknown as typeof globalThis.fetch
    const api = githubApi({ token: 'ghs_secret', repository: 'acme/app', fetch })
    expect(await api('commits/x/pulls')).toEqual([])
    expect(seen[0]).toEqual({
      url: 'https://api.github.com/repos/acme/app/commits/x/pulls',
      auth: 'Bearer ghs_secret',
    })
    const err = await api('bad').catch((e: Error) => e)
    expect(String(err)).toContain('HTTP 404')
    expect(String(err)).not.toContain('ghs_secret')
  })
})

describe('scripts/gate-verified.mjs', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  /** Runs the script; GITHUB_API_URL points at a closed port, so any API call fails loudly. */
  function script(env: Record<string, string>) {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-verified-'))
    dirs.push(dir)
    const output = path.join(dir, 'output')
    writeFileSync(output, '')
    const r = spawnSync('node', [path.join(REPO, 'scripts/gate-verified.mjs')], {
      cwd: REPO,
      env: {
        ...process.env,
        // nothing of a CI runner's own context leaks in
        LAUNCH_GATE_APP_ID: '',
        GITHUB_EVENT_NAME: '',
        GITHUB_REF: '',
        PR_HEAD_SHA: '',
        GITHUB_STEP_SUMMARY: '',
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: 'acme/app',
        GITHUB_TOKEN: 't',
        GITHUB_API_URL: 'http://127.0.0.1:9',
        GITHUB_SHA: MERGE,
        ...env,
      },
      encoding: 'utf8',
    })
    expect(r.status, r.stderr).toBe(0)
    return { output: readFileSync(output, 'utf8'), stdout: r.stdout }
  }

  it('variable unset: verified=false, and no lookup at all', () => {
    const { output, stdout } = script({ GITHUB_EVENT_NAME: 'pull_request', PR_HEAD_SHA: HEAD })
    expect(output).toBe('verified=false\ntree=\n')
    expect(stdout).toContain('LAUNCH_GATE_APP_ID is not set')
    expect(stdout).not.toContain('::warning::')
  })

  it('variable set but the API is unreachable: verified=false, exit 0', () => {
    const { output, stdout } = script({
      LAUNCH_GATE_APP_ID: String(APP),
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: MAIN,
    })
    expect(output).toMatch(/^verified=false\ntree=[0-9a-f]{40}\n$/)
    expect(stdout).toContain('::warning::')
  })
})
