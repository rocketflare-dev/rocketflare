---
name: rf-agent-docs
description: Audits the files a coding agent loads in this repo — CLAUDE.md / AGENTS.md at every level, .claude/rules, .claude/skills — for what actually misleads an agent (stale paths and commands, files too large to load whole, rules whose globs never fire, levels that contradict each other, lines that cost context and change nothing), then fixes them from the checklist. Use when asked whether the repo is agent-ready, to audit or tidy CLAUDE.md, rules or skills, or after a refactor, rename or a large docs change.
argument-hint: "[audit | fix]"
---

# Agent docs — audit, then fix

An instruction file is an execution contract: every line is paid in every session it loads in,
and a wrong line is obeyed. Two questions decide each finding — **would removing this cause a
mistake?** (if not, it is dead weight) and **is it wrong on any plausible task here?** (if so, it
is harmful). This skill finds the lines that fail either, critical ones first. `audit` (default)
reports; `fix` — or the user saying yes to the report — applies the fixes.

## 1. Run the mechanical check

```bash
node .claude/skills/rf-agent-docs/check.mjs          # every finding
node .claude/skills/rf-agent-docs/check.mjs --quiet  # ✖ only
```

It proves existence, not truth: a backticked path, a `pnpm` script, a `/rf-*` skill, a link or a
rule's `paths:` glob still names something; no on-demand file is over the 40,000-char cap (the
tail of a longer one is not read on a 200K-context model); skill frontmatter is valid. `✖` is a
defect. `!` needs your judgement — a negation (`there is no X`), a file a plugin installs, or a
worked example is not stale. Mark a file of hypothetical paths with
`<!-- agent-docs-check: hypothetical -->` (comments are stripped before injection, so it is free).

## 2. Judge what the script cannot

Read root `CLAUDE.md`, then each nested `CLAUDE.md`, rule and skill the findings touch. Check, in
this order — the first three break agents, the rest cost them:

1. **It loads where it is needed.** Nested `CLAUDE.md` loads only when the agent touches that
   directory; a rule only when a file matching its `paths` is read. So a rule every task must obey
   (the Non-Negotiables) lives in root, never only nested. `AGENTS.md` is a symlink to
   `CLAUDE.md`, never a second copy.
2. **It is true.** Every `✖`; each `!` path you judge stale; commands are runnable *from where the
   file says to run them* — an `apps/web` script written as a bare root command fails from the
   root (write `pnpm web build:api`). A doc describing a gate, test or file that does not exist is the worst kind:
   the agent trusts a check that never runs.
3. **It agrees with itself.** The same fact in two places (root vs nested vs rule vs skill vs
   `docs/CONCEPTS.md`) says the same thing; where it does not, the code decides which is right,
   and one owner keeps it while the other points to it. Root's skills list matches
   `.claude/skills/`; the "you may run yourself" list holds no skill with
   `disable-model-invocation: true`, and every paid or destructive skill has it; `README.md`'s
   skills row matches.
4. **It earns its place.** Cut what the agent can read from the code, restates default agent
   behaviour, or is history ("previously", "since 0.x", "was renamed") — git and
   `docs/upgrades/` own history. A multi-step procedure belongs in a skill; detail needed by few
   tasks belongs in the nested file or rule for its directory.
5. **It fits.** Root under 200 lines (at the ceiling, adding a line means moving one); a file over
   the char cap splits by subtopic into the directory it concerns or a skill reference file —
   moved text leaves a pointer whose wording names *when* to read the target.
6. **Skills trigger right.** A description says what it does and when to use it, in the third
   person, with the words a user would say; a SKILL.md over 500 lines moves detail into a
   reference file one level deep.

## 3. Report

One table, worst first. Every row maps to a concrete edit — no "consider improving".

| # | Severity | File:line | Finding | Fix |
|---|---|---|---|---|
| 1 | breaks | `.claude/rules/ui.md:24` | names a contrast test that does not exist | drop the line, or add the test |

Severity: **breaks** (wrong, or never loads) · **misleads** (ambiguous, contradicts, runs from
the wrong dir) · **costs** (true but dead weight). End with the script's summary line.

## 4. Fix

- Minimal diffs at the line that is wrong — never rewrite a file wholesale; its wording was
  earned. Keep emphasis markers that exist because plain phrasing was ignored once.
- When a fix changes what the code should do (a missing gate), stop and ask; the doc is not
  always the side that is wrong.
- Re-run `check.mjs` until no `✖`, then re-score the report as before → after.
- Docs-only edits need no upgrade note; a change to this skill or its script does (kit repository
  only, `docs/upgrades/unreleased.md`). Commit only when asked, staging explicit paths.

Limits are Anthropic's: `code.claude.com/docs/en/memory`, `code.claude.com/docs/en/skills`.
