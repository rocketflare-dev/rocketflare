/**
 * Was this exact tree already gated by Launch? (docs/CONCEPTS.md §4, `ci.yml`'s `verified` job.)
 *
 * After a green sandbox gate, Launch's GitHub App posts a check run on the pushed commit:
 * `name: launch/gate`, `conclusion: success`, `external_id: tree:<tree sha>`, and `output.text`
 * JSON `{ tree, sessionId, attempt, steps }`. A tree sha names the exact bytes — workflows
 * included — so when the tree CI is about to test equals an attested tree, lint, typecheck and test
 * have already passed on it and the `Gate` job runs only what the sandbox does not (gitleaks,
 * `pnpm gate build`).
 *
 * Trust is the app id alone: anyone with `checks: write` can post a check run NAMED `launch/gate`,
 * but only Launch's App can post one whose `app.id` is `LAUNCH_GATE_APP_ID`. Every doubt — no
 * variable, another event, an API error, a malformed id — answers "not verified", so the fallback is
 * always the full gate. `scripts/gate-verified.mjs` runs this in CI; unit-tested with a fake fetch
 * in `apps/web/tests/config/gate-verified.test.ts`.
 */

export const LAUNCH_GATE_CHECK = 'launch/gate'

/** The branch whose pushes look up the merged PR's attestation (ci.yml's `push` trigger). */
const MAIN_REF = 'refs/heads/main'

/**
 * Which commits may carry an attestation for the tree under test — or why nothing is looked up.
 *
 * - `pull_request`: the checkout is GitHub's synthetic merge commit (`github.sha`), and its tree is
 *   what the gate would test. Launch attested the PR HEAD (`pull_request.head.sha`), so the head is
 *   where to look — but the attestation counts only when its tree equals the MERGE tree, which is
 *   true exactly when the branch already contains the base tip. When main has moved since, the merge
 *   tree differs from anything Launch tested, and the full gate runs. The merge commit itself is
 *   also asked (harmless; nothing posts there today).
 * - `push` to main: the pushed commit itself, then the heads of the PRs associated with it
 *   (`GET /commits/{sha}/pulls`, resolved by `findVerified`). A squash or merge of an up-to-date PR
 *   leaves main's tree equal to the attested head tree; anything else differs and gates in full.
 * - anything else (`workflow_call` from deploy.yml on a tag or a dispatch, a push to another ref):
 *   not looked up. deploy.yml has its own "already gated?" check.
 *
 * @param {{ appId?: string, eventName?: string, ref?: string, sha?: string, prHeadSha?: string }} ctx
 * @returns {{ lookup: false, reason: string } | { lookup: true, appId: number, commits: string[], pullsOf: string | null }}
 */
export function planLookup(ctx) {
  const raw = (ctx.appId ?? '').trim()
  if (!raw) return { lookup: false, reason: 'LAUNCH_GATE_APP_ID is not set' }
  if (!/^\d+$/.test(raw)) {
    return { lookup: false, reason: `LAUNCH_GATE_APP_ID is not a numeric app id ('${raw}')` }
  }
  const appId = Number(raw)
  const sha = ctx.sha ?? ''
  if (!isSha(sha)) return { lookup: false, reason: 'no commit sha to look up' }
  if (ctx.eventName === 'pull_request') {
    const head = ctx.prHeadSha ?? ''
    if (!isSha(head)) return { lookup: false, reason: 'pull_request event without a head sha' }
    return { lookup: true, appId, commits: unique([head, sha]), pullsOf: null }
  }
  if (ctx.eventName === 'push' && ctx.ref === MAIN_REF) {
    return { lookup: true, appId, commits: [sha], pullsOf: sha }
  }
  return {
    lookup: false,
    reason:
      `not a pull_request or a push to main (${ctx.eventName ?? '?'} ${ctx.ref ?? ''})`.trim(),
  }
}

/**
 * Is this check run Launch's attestation of `tree`? Every field must hold: the trusted app, the
 * name, completed + success, `external_id == tree:<tree>`, and — when `output.text` is the JSON
 * Launch writes — its `tree` agrees.
 *
 * @param {any} run a check run as the REST API returns it
 * @param {{ appId: number, tree: string }} want
 */
export function isAttestation(run, { appId, tree }) {
  if (!run || typeof run !== 'object') return false
  if (run.app?.id !== appId) return false
  if (run.name !== LAUNCH_GATE_CHECK) return false
  if (run.status !== 'completed' || run.conclusion !== 'success') return false
  if (run.external_id !== `tree:${tree}`) return false
  const text = run.output?.text
  if (typeof text === 'string' && text.trim()) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return false
    }
    if (parsed && typeof parsed === 'object' && 'tree' in parsed && parsed.tree !== tree) {
      return false
    }
  }
  return true
}

/**
 * Looks for an attestation of `tree` on the planned commits (and, on a push, on the heads of the
 * PRs that commit belongs to). Throws on an API error — the caller turns that into "not verified".
 *
 * @param {{ tree: string, plan: { appId: number, commits: string[], pullsOf: string | null }, api: (path: string) => Promise<any> }} args
 * @returns {Promise<{ verified: boolean, reason: string, commit?: string }>}
 */
export async function findVerified({ tree, plan, api }) {
  if (!isSha(tree)) return { verified: false, reason: `not a tree sha ('${tree}')` }
  const commits = [...plan.commits]
  if (plan.pullsOf) {
    const pulls = await api(`commits/${plan.pullsOf}/pulls?per_page=100`)
    if (!Array.isArray(pulls)) throw new Error(`commits/${plan.pullsOf}/pulls: not a list`)
    for (const pr of pulls) {
      const head = pr?.head?.sha
      if (isSha(head)) commits.push(head)
    }
  }
  for (const commit of unique(commits)) {
    const query = `check_name=${encodeURIComponent(LAUNCH_GATE_CHECK)}&app_id=${plan.appId}&filter=all&per_page=100`
    const body = await api(`commits/${commit}/check-runs?${query}`)
    const runs = body?.check_runs
    if (!Array.isArray(runs)) throw new Error(`commits/${commit}/check-runs: no check_runs list`)
    if (runs.some(run => isAttestation(run, { appId: plan.appId, tree }))) {
      return {
        verified: true,
        reason: `${LAUNCH_GATE_CHECK} attested tree ${tree} on ${commit}`,
        commit,
      }
    }
  }
  return {
    verified: false,
    reason: `no ${LAUNCH_GATE_CHECK} from app ${plan.appId} attests tree ${tree} (looked at ${unique(commits).join(', ')})`,
  }
}

/**
 * A GitHub REST reader for one repository: `api('commits/<sha>/pulls')` → parsed JSON. Non-2xx
 * throws (status and path, never the token).
 *
 * @param {{ token: string, repository: string, apiUrl?: string, fetch?: typeof fetch }} opts
 */
export function githubApi({
  token,
  repository,
  apiUrl = 'https://api.github.com',
  fetch: f = fetch,
}) {
  return async path => {
    const res = await f(`${apiUrl}/repos/${repository}/${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'gate-verified',
      },
    })
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`)
    return res.json()
  }
}

/** @param {unknown} s */
function isSha(s) {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s)
}

/** @param {string[]} xs */
function unique(xs) {
  return [...new Set(xs)]
}
