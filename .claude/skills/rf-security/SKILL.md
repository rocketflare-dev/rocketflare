---
name: rf-security
description: Run a multi-agent security audit of this codebase with independently verified findings, or re-audit what changed between two refs, using the threat model in docs/THREAT-MODEL.md. Use when asked for a security audit, red-team or pen-test of the code, to look for data leakage or cross-tenant holes, or before a release. Findings stay outside the repository until fixed.
argument-hint: "[quick|standard|deep] [path | <ref>..<ref>]"
---

# Security audit

**Run it only when the user asks** (it spends agent calls: see the cost table) and agree the
budget first. Docker must be running. The method, cadence and how to read the outputs are in
`docs/SECURITY-AUDIT.md`; the threat model it audits against is `docs/THREAT-MODEL.md`, which this
app owns and may edit (`init` refuses to start without one).

Wraps Cloudflare's security-audit skill, vendored at a pinned commit in `upstream/` (see
`upstream/VENDOR.md`). Read `upstream/SKILL.md` and follow its full audit workflow with the
overrides below. **Where they differ, this file wins.** Every mechanical step goes through the
runner, `tools/audit.mjs` (`node .claude/skills/rf-security/tools/audit.mjs help`); you make the
judgement calls it asks for and it does the rest the same way every run.

## Safety overrides (not negotiable)

1. **Never delete, empty, move or "clear" anything to create an environment.** No `rm`, no
   resetting `HOME`. A clean environment is what the sandbox container already is.
2. **While an audit is active** (`audit.mjs init` until `audit.mjs finish`), a PreToolUse hook in
   `.claude/settings.json` (`tools/guard-hook.mjs`) refuses deletes, moves, `git clean`-style
   commands, credential files and writes outside the run directory, for you and every subagent.
   A skill's own hooks do not reach subagents; settings hooks do. If `.claude/settings.json` does
   not register `guard-hook.mjs` (a copy that upgraded by hand), stop and have the user add it. It tokenizes a Bash command as a
   shell would, so `rm` inside a quoted commit message or `=>` inside `node -e '…'` passes, a
   redirect through `$VAR` is judged by where the variable points, and a command it cannot parse
   (an unterminated quote, `case`, an unresolvable target) is refused: split it up. Around every
   wave run `audit.mjs guard snapshot` and `guard check`: a failed check stops the run until you
   know why.
3. **Target code runs only in the sandbox:** `node <host>/scripts/security-sandbox.mjs test --run
   <agent-dir>`. `audit.mjs host` builds and verifies it; if `verify` fails, no target code runs and
   execution-dependent leads stay `needs_validation`.
4. Agents read source and write proofs; they do not run pnpm, npm, npx, docker or any repo script
   on the host. The one exception is a parent-run check named in the audit plan, on a local dev
   server with the zero-credential `.dev.vars`, for behaviour that needs workerd or a browser.
5. Never read `.dev.vars`, `.provision.env` or `~/.rocketflare/config.json`. Never probe a deployed
   environment; a validation plan never sends traffic to one.

**The repository is public.** Findings, proofs and reports stay in
`~/.rocketflare/security-runs/<repo>/run-<N>`, and out of the repository, issues, PRs and commit
messages, until the fix has released. Fix commits describe the behaviour, not the attack.

## Choosing a run

| Ask | Profile | Default budget (agent calls) | Typical cost | Shape |
|---|---|---|---|---|
| Quick look, a re-run, a renamed copy | `quick` | 16 | ≈ $35 | one wave, one critic (its units deferred), each verifier is also the final check |
| Before a release; what changed on a branch | `standard`, `--diff <base>..HEAD` | 50 | ≈ $110–150 | waves until the critic is clean or the budget stops it; Phase 5 grouped, a high alone |
| First audit; auth, tenancy or AI changed a lot | `deep` | 90 | ≈ $200+ | as standard, one Phase 5 reviewer per record; run it twice, one run finds about half |

`audit.mjs budget <profile> [--budget N]` shows the split (reconnaissance, critics, a follow-up
reserve for the final critic's units, validation, hunters). Measured at API prices, an agent call
costs about $2.00–2.50, three quarters of it the verifiers and reviewers on the stronger model; the
parent's orchestration adds about $15 to a deep run. A deep run can go past its default budget.
**Agree the budget, and what it costs, with the user before reconnaissance.** `hunters` refuses a
plan over the hunter allowance unless the user agrees to `--over-budget`.

## The run

```bash
A=".claude/skills/rf-security/tools/audit.mjs"
node $A init standard --diff 0.29.0..HEAD          # run dir + metadata; marks the audit active
node $A host --plugin ../my-plugins:plugins/inbox …   # target clone + sandbox image
```

1. **Reconnaissance** (upstream RECONNAISSANCE.md). Give it `docs/THREAT-MODEL.md`; write
   `architecture.md` (and any maps) into the run directory. Give each reconnaissance agent the id
   `recon-N` and have it write notes to `<run>/agents/recon-N/scratch/`: the brief naming that
   directory is how its cost is attributed. On a diff run, `scope-diff.json` lists
   the changed files. Prior runs are read from `run-metadata.json` `prior_runs`.
2. **Plan wave 1** as `plan.json`: hunters, each `{ id: "hNN-…", subsystem, surface, boundary,
   paths, classes: ["W:Block name", "O:Access control", …] }` (codes in `tools/lib.mjs`
   `COMPANIONS`), `{ id, prior: [surface prefix] }` for a prior run's deferred unit, and `excluded`
   blocks with reasons. Always select `DATA-ISOLATION-AND-LIFECYCLE`, `WEB-PROTOCOL-AND-AUTH`,
   `AI-AND-LLM`, `CLIENT-SIDE`, `PROTOCOLS-RPC-AND-MESSAGING`, `SUPPLY-CHAIN-AND-RELEASE`.
   `node $A hunters plan.json` writes the ledger and `agents/<id>/prompt.md`.
3. **Hunt.** `guard snapshot`, launch one agent per brief (its prompt is the file), wait, `collect`,
   `ingest`, `guard check`. Agents write `scratch/result.json` and run `check-result` on it before
   handing back, so a truncated or placeholder result is caught at the source. `ingest` renames a
   `#` in a hunter's fingerprint to `:` (upstream's pattern refuses `#`) and exits 1 whenever the
   ledger is not installed.
   **A step that does not install leaves `<file>.next.json` and exits 1**, and every other step
   refuses to run while it is there (it would read the stale file): fix what it reported and rerun
   that step, or set the leftover aside with `discard-next` (renamed, never deleted).
   `status` shows the phase, the next step, units by status, agents waiting, leftovers and budget.
4. **Consolidate.** Read `candidates.raw.json` and write `decisions.json`: `carried` (a prior
   record re-found), `aliases` (the same root cause as a current one), `merges`, `leads` (scan items
   no hunter produced, straight to a verifier). `consolidate` writes `vNN` briefs and the critic's.
5. **Verify and critique.** One fresh verifier per candidate, **on a different model from the
   hunters**; never give hunters a list of suspected bugs. `collect`. Run the critic, `collect`,
   `critic <id>`; standard and deep hunt the planned units in another wave while the budget allows:
   `plan-next` writes `plan.json` (one hunter per planned unit, `{ id, units: [...] }`; the previous
   plan is kept as `plan-wave<N>.json`; group units by hand if you want fewer hunters), then
   `hunters plan.json`. A unit the critic reassigns keeps its finished attempt in `attempts` and
   goes to a fresh hunter id. Then the final critic with `--defer`.
6. **Findings:** `findings`, then `cite --all` and **read every line it prints against its claim**:
   the validators check shape only, so a made-up finding passes them.
7. **Phase 5:** `review` (quick skips it), launch, `collect`, `apply-review`. A `MATERIAL` line
   needs a fresh verifier before the record stands: `reverify <fingerprint>` writes its brief
   (`v13` → `v13b`, the next free letter: the original verifier's brief, renamed, with the
   reviewed record as the candidate); launch it, `collect`, then `apply-reverify <id>` installs its
   record only if the decision is a verdict for the same fingerprint and the record passes the
   same checks as `check-result`.
8. **Report:** write `posture.md`, `deviations.md` and `positive-patterns.md` in the run
   directory, then `report`, then `finish`. Both measure the run's tokens from the Claude Code
   transcripts and price them from `tools/prices.json` into `usage.json` and `run-metadata.json`
   `usage` (`cost` does it on demand; `budget` shows calls so far, reconnaissance agents included
   once they have written notes to their `scratch/`). Report the total cost with the
   counts. Check `prices.json` against its source URL when a model or price changes.

**Confirmed means proven.** A `confirmed` finding has a vitest proof that fails on untouched code,
using `request` from `tests/helpers/request.ts` and the factories in `tests/helpers/auth.ts`.
Tests run under Node, not workerd: a runtime-specific claim needs the parent check in rule 4, and a
real-model question belongs in a prompt-injection eval, not in `needs_validation`.

**A model safeguard can stop an agent doing legitimate defensive work.** Record it with
`block <agent-id>`; do not retry it, reword it or move it to another model. The run ends
`incomplete` with that candidate unverified; tell the owner, who can apply for Anthropic's Cyber
Verification Program if the work needs it.

## Public report

Nothing from a run directory is ever published. When fixes have released, a person writes an
entries file by hand and `node $A public-report <entries.json> [--out report.md]` renders it
(`report.md` and `report.json`; stdout without `--out`):

```json
{
  "repos": ["my-app"],
  "runs": [{ "date": "2026-01-02", "commit": "abc1234", "scope": "whole repository", "coverage_units": 40, "agent_calls": 90 }],
  "findings": [{ "severity": "high", "line": "A neutral one-line description.", "release": "1.4.0", "repo": "my-app" }],
  "hardening": [{ "line": "A neutral one-line description.", "release": "1.4.0" }]
}
```

It fails closed and writes nothing when an item has no fixing release, a finding's `repo` is not
in `repos`, or any field is not one of those above. It never reads `findings.json`. Write each
`line` as the behaviour that was wrong, never how to reproduce it.

## After the run

Report the counts, then each confirmed finding with its severity, and everything
`needs_validation` with its blocking fact. The audit does not change source. When a finding is
fixed, its proof moves to `apps/web/tests/api/security/` as a permanent regression test. State the
coverage honestly: a clean run is not proof of no bugs, and a quick or scoped run is partial.
