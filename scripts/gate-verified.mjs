#!/usr/bin/env node
/**
 * `ci.yml`'s `verified` job: was the tree CI is about to test already gated by Launch? Writes
 * `verified=true|false` and `tree=<sha>` to `$GITHUB_OUTPUT` and always exits 0 — any doubt (an API
 * error included) is `verified=false`, which means the full `pnpm gate`. The rules, and why the
 * merge commit's tree is the one compared on a pull request: `lib/gate-verified-lib.mjs`.
 *
 * Env: LAUNCH_GATE_APP_ID (repo variable; empty → no API call at all), GITHUB_TOKEN,
 * GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_SHA, PR_HEAD_SHA, GITHUB_REPOSITORY, GITHUB_API_URL.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { findVerified, githubApi, planLookup } from './lib/gate-verified-lib.mjs'

const env = process.env

function finish(verified, reason, tree = '') {
  console.log(`${verified ? '✔ verified' : '· not verified'}: ${reason}`)
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `verified=${verified}\ntree=${tree}\n`)
  if (env.GITHUB_STEP_SUMMARY) {
    const line = verified
      ? `Launch already gated this tree — \`Gate\` runs gitleaks and \`pnpm gate build\` only. ${reason}`
      : `Full \`pnpm gate\`: ${reason}`
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`)
  }
  process.exit(0)
}

const plan = planLookup({
  appId: env.LAUNCH_GATE_APP_ID,
  eventName: env.GITHUB_EVENT_NAME,
  ref: env.GITHUB_REF,
  sha: env.GITHUB_SHA,
  prHeadSha: env.PR_HEAD_SHA,
})
if (!plan.lookup) finish(false, plan.reason)

let tree = ''
try {
  // The checked-out commit — on a pull request, GitHub's merge commit: the tree the gate would test.
  tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY)
    finish(false, 'no GITHUB_TOKEN or GITHUB_REPOSITORY', tree)
  const api = githubApi({
    token: env.GITHUB_TOKEN,
    repository: env.GITHUB_REPOSITORY,
    apiUrl: env.GITHUB_API_URL || undefined,
  })
  const result = await findVerified({ tree, plan, api })
  finish(result.verified, result.reason, tree)
} catch (err) {
  console.log(
    `::warning::Could not check for a Launch attestation (${err instanceof Error ? err.message : err}); running the full gate.`
  )
  finish(false, 'lookup failed', tree)
}
