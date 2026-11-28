---
breaking: false
migrations: []
areas: [config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Every job in `ci.yml`, `deploy.yml` and `evals.yml` runs on `${{ vars.RF_RUNNER || 'ubuntu-latest' }}`, so a repository variable picks faster runners (Blacksmith, larger or self-hosted) without editing a workflow; unset, nothing changes.

- `runs-on: ubuntu-latest` becomes `runs-on: ${{ vars.RF_RUNNER || 'ubuntu-latest' }}` in every job; checkouts stay `actions/checkout` pinned to a commit.
- `docs/DEPLOY.md` ("CI runners") and `docs/CONCEPTS.md` §4 describe the variable.

## How to apply

- In each job of `.github/workflows/ci.yml`, `deploy.yml` and `evals.yml` (and any workflow of your own), replace `runs-on: ubuntu-latest` with `runs-on: ${{ vars.RF_RUNNER || 'ubuntu-latest' }}`.
- Optionally set the variable: `gh variable set RF_RUNNER -b <runner label>`. Install the runner provider's GitHub app for the repository first, or the jobs queue with no runner to take them.

## Conflicts to expect

A workflow you already moved to another runner: keep your label as the variable's value instead.

## Verify

- `grep -n 'runs-on' .github/workflows/*.yml` shows only the expression.
- A pull request's CI starts on the runner the variable names, or on `ubuntu-latest` with it unset.
