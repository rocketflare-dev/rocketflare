---
name: rf-start
description: Start a new app from a fresh clone of the kit — detach it from the kit's history, get it running on this machine, design the app with its owner (rf-design), then rename it (rf-adapt). The one entry point the website's prompt names
argument-hint: "[folder]"
---

# Start an app

Someone pasted the website's prompt, so you have just cloned the kit into a folder (default
`my-app`) and read its `CLAUDE.md`. They may never have run a terminal command. This skill takes
them from that clone to a running, renamed app with a written design, in five steps, always in this
order:

1. detach the clone from the kit's history (§1)
2. prerequisites and setup, one problem at a time (§2)
3. the design conversation, `/rf-design` (§3)
4. the rename, `/rf-adapt`, which applies the brand and the licence from the design (§4)
5. hand over: restart Claude inside the folder, then build Stage 1 (§5)

Don't settle anything about the app's design before §3: no tenancy, no names and no features. If
they start describing the app early, write it down and say it will come up in the design step.
Their pasted prompt asked you to wait, and the design step exists because deciding tenancy before
anything asked about it once cost a builder most of a stage.

## Constraints on you (Claude)

- The session's working directory is probably the folder ABOVE the clone. Run every command as
  `cd <folder> && …`, or with absolute paths. `$ARGUMENTS` names the folder if they gave one.
  Otherwise use the one you just cloned into.
- This session did not load the project's hooks (`.claude/settings.json` loads only when Claude
  starts inside the folder). That is why §5 ends with a restart. Until then, run `pnpm gate`
  yourself before any commit.
- Say what each step does to their machine in one sentence before running it, then run it. Show
  every `✔`/`✖` line the scripts print as they come. They are written for this person to read.
- Use `AskUserQuestion` at every choice, one question at a time, and never several in one message.

## 0. Say what's about to happen

In at most five lines, say:
- the five steps above;
- that the whole thing takes 20 to 40 minutes, most of it the design conversation;
- that they can stop after any step and pick up later by asking for `/rf-start` again.

Each step checks whether it is already done. Then begin.

## 1. Detach from the kit's history

```
cd <folder> && bash scripts/detach.sh
```

One sentence first: *the clone still carries the kit's own history; this replaces it with one
commit of yours, and records which kit commit you started from, so later kit improvements can be
ported in (`pnpm kit:upgrade`).* A fresh clone holds nothing of theirs, so this loses nothing.

| Output | Meaning |
|---|---|
| `✔ detached …` | done; go on |
| `already detached …` | they used the one-line installer, or this is a re-run; go on |
| exit 3, `origin is …` | not a clone of the kit's repository. If they cloned a fork or a mirror on purpose, ask, then re-run with `--force`. If this is the kit itself, stop |
| exit 3, `the tree has changes` | something was edited before detaching. Show `git status --short` and ask |

## 2. Prerequisites and setup

Run setup exactly as `/rf-setup` describes (`.claude/skills/rf-setup/SKILL.md` §1 to §3: the
bootstrap with `--no-dev` and a 10-minute timeout, the exit-code table, then starting the app and
signing in). Skip its §0, because §1 here already detached, and its §4, because this skill decides
what comes next.

Prerequisites come one at a time. `scripts/bootstrap.sh` stops at the first missing one with exit
3 and a `fix:` line. For each one:
1. Say in plain words what is missing and why the kit needs it.
2. Give the one fix. If it needs their password, a reboot or an installer window, ask them to run
   it themselves: in Claude Code, typing `! <command>` runs it here so you both see the output.
3. Re-run the bootstrap. It is idempotent.

Never offer the next prerequisite before this one passes. Someone on Windows meets WSL first:
`SETUP.md` Part 1 has the Windows steps, and the bootstrap names what it found.

Stop at the end of `/rf-setup` §3, with the app running and them signed in as
`owner@example.test`. Let them look for a minute: this is the kit as it ships, before it becomes
theirs. Then ask whether to go on to the design. They may want to click around first.

## 3. Design the app

Run `/rf-design` (`.claude/skills/rf-design/SKILL.md`). Ask first whether they already have a
written spec, brief or notes:
- **Yes:** `/rf-design --review <path>`. Review mode reads their document and asks only about what
  it leaves open or settles without saying why. This is the common case.
- **No:** `/rf-design` from a blank page.

It ends with a design signed off by them in `docs/design/`, the design rendered as local pages in their brand,
and, if they said yes, a GitHub repository with the stages as issues. Don't move on until they
have signed it off. The rename reads its names, brand and licence from that design.

## 4. Rename it

Run `/rf-adapt` with the slug, display name and domain from `docs/design/design.json`
(`app.slug`, `app.name`, `app.domain`). It renames the kit and, when the design has them, applies
`docs/design/brand.css` and the licence answer (its `checklist.md` rows (e), (h)).

If the dev stack from §2 is running, stop it first (`pnpm dev:stop`), and take the database down
as `rf-adapt` §1 says. The rename changes the container's name.

## 5. Hand over

The app now has its own name, brand, licence and design. Say what is true, in at most six lines:
- the folder;
- the app's name;
- where the design lives (`docs/design/`, and `docs/design/html/index.html`);
- the repository and its Stage 1 issue, if one was made;
- that `pnpm dev` starts it again.

Then the one instruction that matters. **Quit Claude and start it again inside the folder**
(`cd <folder>` then `claude`, or open the folder in the desktop app). The project's hooks and
settings load only in a session started there, and the build needs them.

In that new session, Stage 1 starts from its issue: "build Stage 1 of docs/design". `/rf-how-do-i`
turns each slice into a plan before any code. End the turn here: there is nothing to ask.

## In an app that already exists

This skill stays in every copy, like `/rf-adapt`. In a renamed app with a signed-off design, every
step below is already done: say so in one line and point at `/rf-design` to revisit the design.

## Re-running

`/rf-start` again in the same folder picks up where it stopped:
- "already detached" skips §1;
- `pnpm preflight` passing skips §2;
- a signed-off `docs/design/design.json` (`"status": "signed-off"`) skips §3;
- a `.rocketflare.json` whose `app` is no longer null skips §4.

Say which steps you skipped, and why.
