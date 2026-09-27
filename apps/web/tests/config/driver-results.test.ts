/**
 * D35: `apps/web/src` runs on two drivers, and the one place they differ is the shape of a raw
 * result. postgres.js returns the rows array itself (with `.count`); Neon returns `{ rows,
 * rowCount }`. `Database` is the base both share, so `db.execute()` is typed `unknown` and most
 * wrong reads are type errors already. What still compiles is a CAST — `(await db.execute(…)) as
 * unknown as Row[]`, `(result as unknown as { count })` — and that passes every test on one driver
 * and breaks on the other. The gate runs `postgres`, so without this scan a postgres.js-only read
 * would first fail on a fresh copy's `neon` deployment.
 *
 * The rules, over every `.ts`/`.tsx` under `src/` (installed plugins included) except
 * `db/client.ts`, which is where the two shapes are read:
 * 1. an `execute(…)` result is never cast, indexed or read for `.rows` / `.rowCount` / `.count` /
 *    `.length` — pass it to `rows()` or `affected()` from `@/db/client` instead;
 * 2. no cast to a type literal with a `count`, `rowCount` or `rows` member (an insert / update /
 *    delete result read by hand) — `affected()`;
 * 3. no driver import (`postgres`, `@neondatabase/serverless`, `drizzle-orm/postgres-js`,
 *    `drizzle-orm/neon-*`) — `openDatabase` picks the driver.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '../../src')
const EXEMPT = new Set([path.join(SRC, 'db/client.ts')])
const DRIVER_MODULES = [
  /^postgres$/,
  /^@neondatabase\/serverless$/,
  /^drizzle-orm\/postgres-js(\/|$)/,
  /^drizzle-orm\/neon-/,
]
const RESULT_MEMBERS = new Set(['rows', 'rowCount', 'count', 'length'])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : []
  })
}

/** Climb through `await` and parentheses to the expression that consumes the call's value. */
function consumer(node: ts.Node): ts.Node {
  let current = node
  while (ts.isAwaitExpression(current.parent) || ts.isParenthesizedExpression(current.parent)) {
    current = current.parent
  }
  return current.parent
}

function isExecuteCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'execute'
  )
}

function findViolations(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const at = (node: ts.Node, message: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
    found.push(`${path.relative(SRC, file)}:${line + 1} ${message}`)
  }
  const visit = (node: ts.Node) => {
    if (isExecuteCall(node)) {
      const parent = consumer(node)
      if (ts.isAsExpression(parent)) at(node, 'execute() result cast — use rows() / affected()')
      else if (ts.isElementAccessExpression(parent)) {
        at(node, 'execute() result indexed — use rows()')
      } else if (ts.isPropertyAccessExpression(parent) && RESULT_MEMBERS.has(parent.name.text)) {
        at(node, `execute() result .${parent.name.text} — use rows() / affected()`)
      }
    }
    if (ts.isAsExpression(node) && ts.isTypeLiteralNode(node.type)) {
      const member = node.type.members.find(
        m =>
          m.name && ts.isIdentifier(m.name) && ['count', 'rowCount', 'rows'].includes(m.name.text)
      )
      if (member?.name && ts.isIdentifier(member.name)) {
        at(node, `cast to { ${member.name.text} } — a query result read by hand, use affected()`)
      }
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      DRIVER_MODULES.some(re => re.test((node.moduleSpecifier as ts.StringLiteral).text))
    ) {
      at(node, `imports the driver '${node.moduleSpecifier.text}' — use openDatabase()`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('driver-specific result reads (D35)', () => {
  it('src/ reads raw results only through rows() / affected() and imports no driver', () => {
    const violations = sourceFiles(SRC)
      .filter(file => !EXEMPT.has(file))
      .flatMap(file => findViolations(file, readFileSync(file, 'utf8')))
    expect(violations).toEqual([])
  })

  it('catches the shapes it exists for', () => {
    const sample = `
      import postgres from 'postgres'
      async function f(db: any) {
        const a = (await db.execute(sql\`select 1\`)) as unknown as Row[]
        const b = (await db.execute(sql\`select 1\`))[0]
        const c = (await db.execute(sql\`select 1\`)).rows
        const d = (result as unknown as { count?: number }).count
        const ok = rows(await db.execute(sql\`select 1\`))
      }`
    const found = findViolations(path.join(SRC, 'sample.ts'), sample)
    expect(found).toHaveLength(5)
    expect(found.join('\n')).toMatch(/imports the driver 'postgres'/)
    expect(found.join('\n')).toMatch(/result cast/)
    expect(found.join('\n')).toMatch(/result indexed/)
    expect(found.join('\n')).toMatch(/result \.rows/)
    expect(found.join('\n')).toMatch(/cast to \{ count \}/)
  })
})
