# Security audit

`/rf-security` is a multi-agent security review of this codebase. Separate agents look for holes,
other agents check each candidate from scratch, and a finding counts as confirmed only when a test
proves it on untouched code. It reads the threat model in `docs/THREAT-MODEL.md`, runs any code it
needs in a locked-down container, and keeps everything it finds outside the repository.

It is built on Cloudflare's [security-audit skill](https://github.com/cloudflare/security-audit-skill)
(MIT), vendored at a pinned commit in `.claude/skills/rf-security/upstream/` with its licence and
`VENDOR.md`. Rocketflare's overrides live in `.claude/skills/rf-security/SKILL.md`, and the
mechanical steps are done by a runner, `.claude/skills/rf-security/tools/audit.mjs`, so each run
follows the same steps.

To report a vulnerability, follow [`SECURITY.md`](../SECURITY.md). Do not open an issue.

## Before you run it

- **Docker** must be running. The audit builds a sandbox image and refuses to run target code
  without it.
- **A model budget.** The audit spends agent calls, and an agent call costs about $2.00–2.50 at
  API prices. Agree the mode and the budget before it starts; the skill asks.
- **A threat model.** `docs/THREAT-MODEL.md` must exist. In a copy it is yours to rewrite for your
  product, and the audit reads whatever it says.
- A coding agent runs it only when asked. It never starts on its own.

## Modes

| Mode | Default budget (agent calls) | Cost | When |
|---|---|---|---|
| `quick` | 16 | ≈ $35 | a quick look, a re-run, a renamed copy's first check |
| `standard` | 50 | ≈ $110–150 | before a release, over what changed (`<ref>..<ref>`) |
| `deep` | 90 | ≈ $200+ | a first audit, or after auth, tenancy or AI changed a lot |

```text
/rf-security quick
/rf-security standard 1.4.0..HEAD
/rf-security deep
/rf-security standard apps/web/src/api/auth
```

**Diff-scoped runs.** `standard 1.4.0..HEAD` audits the files changed between two refs and the
code paths that reach them. Reconnaissance still reads the whole system, so a change is judged in
context. A path argument scopes a run to one directory in the same way.

`node .claude/skills/rf-security/tools/audit.mjs budget <mode>` prints how a budget splits between
reconnaissance, hunters, verifiers, critics and reviewers. `--budget N` changes it; the runner
refuses a hunting plan larger than the budget unless the user agrees to go over.

## How it works

1. **Reconnaissance** maps the system against the threat model: entry points, trust boundaries,
   the tenancy and auth paths.
2. **Hunters** each get one narrow unit (a subsystem, a boundary and a list of attack classes) and
   report candidates. A hunter never sees another hunter's results or a list of suspected bugs.
3. **Consolidation** merges candidates that share a root cause.
4. **Verifiers** check each candidate from scratch, on a **different model from the hunters**, so
   a mistake one model tends to make is not repeated by the model checking it. A verifier rejects
   the candidate, marks it `needs_validation` with the fact that blocks it, or confirms it with a
   proof.
5. **A critic** reads the coverage ledger and names what nobody looked at. In `standard` and `deep`
   that becomes the next wave of hunters, until the critic is satisfied or the budget runs out.
6. **Reviewers** (Phase 5) challenge each confirmed record: `standard` groups them, with any high
   reviewed alone, and `deep` reviews each record separately. A review that changes a record
   materially sends it to a **fresh verifier** before it stands.
7. **The report** is written in the run directory, with the measured token cost.

**Confirmed means proven.** A confirmed finding has a vitest proof, built with the kit's own test
helpers, that fails on untouched code. Every cited file and line is checked against the code.

## Where the results go, and why

Everything a run writes stays in `~/.rocketflare/security-runs/<app>/run-N/`, outside the
repository: findings, proofs, ledgers, reports, agent prompts and scratch files. The repository
is often public, and a finding published before its fix has released is a recipe against every
deployment that has not taken the fix yet. Keep findings out of issues, PRs and commit messages too;
a fix commit describes the behaviour, not the attack.

When a finding is fixed, its proof becomes a permanent regression test in
`apps/web/tests/api/security/`, named for the behaviour.

## The sandbox and the guard

**The sandbox** (`pnpm security:sandbox`, `apps/web/docker-compose.security.yml`) is where every
proof runs:

- The image is built from a `git archive` of one ref, so untracked files such as `.dev.vars` cannot
  reach it.
- The runner shares a network namespace with its own Postgres on tmpfs, on an internal network
  with no route out. The shared test database on the host is never touched.
- The root filesystem is read-only, all capabilities are dropped, privilege escalation is off, and
  memory, CPU, process and file-size limits are set. Only the agent's scratch directory is
  writable; its proofs are mounted read-only.
- `security:sandbox verify` proves the isolation holds before a run. If it fails, no target code
  runs and execution-dependent candidates stay `needs_validation`.

Agents read source and write proofs. They never run pnpm, npm, npx, docker or a repository script
on the host, never read `.dev.vars`, `.provision.env` or the CLI's config, and never send traffic
to a deployed environment.

**The guard** is a `PreToolUse` hook in `.claude/settings.json`
(`.claude/skills/rf-security/tools/guard-hook.mjs`). It does nothing unless an audit is active.
During one, it refuses deletes, moves, `git clean`-style commands, credential files and writes
outside the run directory, for the parent agent and every subagent. Around each wave the runner
snapshots the repository, the target checkout and a few home directories, and stops the run if
anything outside the run directory changed.

## Reading the outputs

| File | What it is |
|---|---|
| `REPORT.md` | the summary: posture, confirmed findings by severity, what needs validation, hardening, coverage, cost |
| `FINDINGS-DETAIL.md` | each confirmed record in full: severity reasoning, trace, root cause, reproduction, remediation, proof |
| `NEEDS-VALIDATION.md` | each unresolved candidate with the fact that blocks it |
| `findings.json` | every final record, in upstream's report schema |
| `coverage-ledger.json` | every unit hunted, by whom, with what was checked; deferred units |
| `posture.md`, `positive-patterns.md`, `deviations.md` | the parent's view of the codebase and of where the run departed from plan |
| `usage.json`, `run-metadata.json` | tokens and estimated cost by role; scope, commit, models, status |

Read the confirmed findings first and fix them by severity. A `needs_validation` item is not
cleared: it names one fact the audit could not settle, often behaviour that needs workerd or a
browser, and it waits for a person to settle it. A run that ends `incomplete` had a candidate a
model safeguard would not verify; the run says which.

## Publishing a report

Nothing from a run directory is published. After the fixes have released, a person writes an
entries file by hand (the runs, plus one neutral line per fixed finding with its severity,
repository and fixing release) and renders it:

```bash
node .claude/skills/rf-security/tools/audit.mjs public-report entries.json --out report.md
```

It writes `report.md` and `report.json` from an allowlist of fields. It refuses the whole file on
an item with no fixing release, a repository not on the file's own `repos` list, or any field it
does not know, and it never reads `findings.json`. The format is in the skill's `SKILL.md`.

## Limits

- **One run finds about half of what is there**, which is why `deep` is meant to be run twice. A
  clean area is not evidence that it has no bugs.
- A `quick` or scoped run is partial by design, and says so.
- Proofs run under Node against the real Hono app and Postgres, not under workerd. Behaviour
  specific to the Workers runtime needs a separate check on a local dev server.
- Real model behaviour (prompt injection that depends on what a model chooses) belongs in an eval,
  not in a proof.
- The audit reads code. Deployed configuration, Cloudflare account settings and secrets are out
  of scope.
- It runs on a developer's machine. There is no scheduled or CI audit.

## Cadence

- **Before a release** that touches authentication, tenancy or row-level security, the identity or
  plugin seams, or how the model is given tools: a diff-scoped `standard` run from the previous
  release (`/rf-security standard <previous>..HEAD`). In the kit repository, `pnpm kit:release`
  prints a warning when the changes since the last tag touch those paths. It is a reminder, not a
  gate.
- **Quarterly**: a `deep` run over the whole codebase with your plugins installed.

Nothing runs this on a schedule for you. Put the dates in your own release checklist.
