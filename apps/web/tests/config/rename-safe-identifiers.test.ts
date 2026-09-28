/**
 * `scripts/rename.mjs` turns every bare kit word into the app's slug, and a slug may be hyphenated
 * (`my-app`). In prose and strings that is harmless; as an identifier it is not — `report.my-app =`
 * does not parse, and `report.my-app ?? x` parses as a subtraction and throws at run time. So no
 * kit code may use the kit's name as a property after a dot or as a declared name: use the bracket
 * form (`report['rocketflare']`), which the rename turns into a valid string key.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { KIT } from '../../../../scripts/lib/rename-lib.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const CODE = /\.(?:[cm]?[jt]s|tsx)$/

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(f => CODE.test(f))

describe('the kit name is never an identifier in code (a hyphenated slug would not parse)', () => {
  it('no `x.<kit>` member access and no `const <kit>`-style declaration', () => {
    const kit = KIT.slug
    // A dot right after an identifier character, `)` or `]` (a member access — not `'.kit'` or
    // `~/.kit`), with no `-` `.` `/` `_` after the name (not `.kit.json`, `.kit-x`, `.kit/`).
    const member = new RegExp(`[\\w)\\]]\\.${kit}\\b(?![-./_])`)
    const declared = new RegExp(`\\b(?:const|let|var|function|class)\\s+${kit}\\b`)
    const offenders: string[] = []
    for (const file of files) {
      let text: string
      try {
        text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      } catch {
        continue // listed by the index but deleted on disk
      }
      text.split('\n').forEach((line, i) => {
        if (member.test(line) || declared.test(line))
          offenders.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
