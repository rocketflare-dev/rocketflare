# docs/archive — superseded documents

Documents land here when they stop describing the code but still explain a decision. Nothing in
this folder is authoritative; `docs/CONCEPTS.md`, `docs/DEPLOY.md`, `docs/RLS.md` and `SETUP.md`
are.

## Convention

1. Move, don't delete: `git mv docs/<name>.md docs/archive/<name>.md` keeps history intact.
2. Add a row to the table below stating what replaced it and why it is worth keeping.
3. Prepend a one-line banner to the moved file: `> Archived <YYYY-MM-DD>. Superseded by <path>.`
4. Fix every link that pointed at the old path (grep `docs/<name>.md` across the repo, including
   `CLAUDE.md` and `.claude/rules/`). A dangling doc link is the kind of drift this kit forbids.
5. Analysis documents that predate the code (`docs/analysis/0*.md`) are provenance, not archive:
   they stay where they are and are never updated to match the code.

## Archived documents

| File | Archived | Superseded by | Why kept |
|---|---|---|---|
| _(none yet)_ | | | |
