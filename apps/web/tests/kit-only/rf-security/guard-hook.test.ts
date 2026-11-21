/**
 * The audit's PreToolUse guard (`.claude/skills/rf-security/tools/guard-hook.mjs`) judges a Bash
 * command by tokenizing it as a shell would, not by matching the raw string: `rm` inside a quoted
 * message is text, `=>` inside `node -e '…'` is not a redirect, and a `$VAR` redirect target that
 * resolves inside the run directory is allowed. Real deletes, moves, out-of-run writes and anything
 * it cannot parse are still refused. Both directions, as a table; plus the hook end to end.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { GUARD } from './fixture'

const RUN = '/tmp/rf-guard-fixture/runs/demo/run-1'
const CWD = '/tmp/rf-guard-fixture/repo'
const AGENT = `${RUN}/agents/h01-widgets`

let decide: (input: any, active: any) => string | null

beforeAll(async () => {
  // A computed specifier: the hook is plain JS with no declarations, imported for its export.
  const mod = await import(GUARD)
  decide = mod.decide
})

const bash = (command: string, sub = true) =>
  decide(
    { tool_name: 'Bash', tool_input: { command }, cwd: CWD, ...(sub ? { agent_id: 'a1' } : {}) },
    { run: RUN }
  )

const ALLOWED: string[] = [
  `git commit -m "rm the old helper and mv the docs"`,
  `git commit -m 'Tidy: rm -rf is never used here'`,
  `grep -rn "rm -rf\\|mv " src`,
  `grep -n 'unlink(' src/files.ts`,
  `node -e 'const f = x => x > 1; console.log([1, 2].filter(f))'`,
  `node -e "const ok = (a) => a >= 2; process.exit(ok(3) ? 0 : 1)"`,
  `R=${RUN}; node ${AGENT}/scratch/check.mjs > $R/agents/h01-widgets/scratch/out.log 2>&1`,
  `export R=${RUN} && echo done >> "$R/agents/h01-widgets/scratch/notes.txt"`,
  `D=${AGENT}/scratch; cat a.txt | tee "\${D}/copy.txt" > /dev/null`,
  `cd ${AGENT}/scratch && echo hi > notes.txt`,
  `node x.mjs 2>/dev/null | head -5`,
  `echo a >&2`,
  `ls -la ${RUN} && cat ${RUN}/plan.json`,
  `diff <(sort a.txt) <(sort b.txt)`,
  `cat <<'EOF' > ${AGENT}/scratch/brief.md\nnever rm -rf / or mv anything\nEOF`,
  `git log --oneline | grep -c "mv"`,
  `git stash list`,
  `find src -name '*.ts' -newer x.ts`,
  `echo "a; rm -rf b" # rm in a comment`,
  `command -v rm`,
  `for f in a b; do echo "$f" >> ${AGENT}/scratch/list.txt; done`,
]

const BLOCKED: [string, RegExp][] = [
  ['rm -rf /tmp/x', /deleting files/],
  ['echo ok && rm x', /deleting files/],
  ['/bin/rm x', /deleting files/],
  ['"rm" -f x', /deleting files/],
  ['\\rm x', /deleting files/],
  ['rmdir empty', /deleting files/],
  ['unlink a', /deleting files/],
  ['truncate -s 0 f', /deleting files/],
  ['mv a b', /moving files/],
  ['ls | xargs rm', /deleting files/],
  ['sudo rm -f x', /deleting files/],
  ['find . -name "*.log" -delete', /find -delete/],
  ['find . -exec rm {} \\;', /deleting files/],
  ['bash -c "rm -rf build"', /deleting files/],
  ["sh -c 'mv a b'", /moving files/],
  ['eval "rm x"', /deleting files/],
  ['echo $(rm x)', /deleting files/],
  ['for f in a b; do rm $f; done', /deleting files/],
  ['(cd /tmp && rm x)', /deleting files/],
  ['git clean -fdx', /destructive git/],
  ['git reset --hard HEAD~1', /destructive git/],
  ['git checkout -- .', /destructive git/],
  ['git stash', /destructive git/],
  ['git push origin main', /destructive git/],
  ['git rm file.ts', /destructive git/],
  ['rsync -a --delete a/ b/', /rsync/],
  ['dd if=/dev/zero of=disk.img', /dd/],
  ['HOME=/tmp claude', /resetting HOME/],
  ['export HOME=/tmp', /resetting HOME/],
  ['echo x > /tmp/out.txt', /outside the run directory/],
  ['echo x >> ~/.bashrc', /outside the run directory/],
  ['echo x > notes.txt', /outside the run directory/],
  [`echo x > ${RUN}/../escape.txt`, /outside the run directory/],
  ['echo x | tee /tmp/copy.txt', /tee to \/tmp\/copy\.txt, outside/],
  ['node a.mjs &> /tmp/all.log', /outside the run directory/],
  ['D=$(mktemp -d); echo x > $D/f', /cannot resolve/],
  ['echo x > $UNSET/f', /cannot resolve/],
  ['echo x > *.txt', /cannot resolve/],
  [`cd /tmp && echo x > ${RUN}/../../x`, /outside the run directory/],
  ['(cd /tmp && echo x) > rel.txt', /outside the run directory/],
  ['$CMD file', /cannot resolve/],
  ['echo "unterminated', /could not parse/],
  ["echo 'unterminated", /could not parse/],
  ['echo $(ls', /could not parse/],
  ['case $x in a) echo;; esac', /could not parse|does not parse/],
  ['cat <<EOF\n$(rm x)\nEOF', /could not parse/],
  ['cat .dev.vars', /credentials file/],
  ['pnpm test', /package managers/],
  ['npx vitest', /package managers/],
]

describe('rf-security guard hook: Bash', () => {
  it.each(ALLOWED)('allows %s', command => {
    expect(bash(command)).toBeNull()
  })

  it.each(BLOCKED)('blocks %s', (command, why) => {
    expect(bash(command)).toMatch(why)
  })

  it('lets the parent, but not a subagent, run package managers', () => {
    expect(bash('pnpm test', false)).toBeNull()
    expect(bash('pnpm test', true)).toMatch(/package managers/)
  })

  it('refuses a relative redirect when the working directory is unknown', () => {
    const why = decide(
      { tool_name: 'Bash', tool_input: { command: 'echo x > a.txt' } },
      { run: RUN }
    )
    expect(why).toMatch(/unknown directory/)
  })

  it('is inert with no active audit', () => {
    expect(decide({ tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }, null)).toBeNull()
  })
})

describe('rf-security guard hook: as a process', () => {
  it('exits 2 with the reason for a blocked command and 0 for an allowed one', () => {
    const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-guard-'))
    fs.writeFileSync(path.join(runs, '.active'), JSON.stringify({ run: RUN }))
    const hook = (command: string) =>
      spawnSync('node', [GUARD], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: CWD }),
        encoding: 'utf8',
        env: { ...process.env, RF_SECURITY_RUNS: runs },
      })
    const blocked = hook('mv a b')
    expect(blocked.status).toBe(2)
    expect(blocked.stderr).toContain('moving files')
    expect(hook('git commit -m "mv a b"').status).toBe(0)
  })
})
