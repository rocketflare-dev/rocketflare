/**
 * The conformance suite stays a conformance suite (D35, tests/driver/CLAUDE.md).
 *
 * `tests/driver/` proves the driver seam: each test states one equivalence and passes UNCHANGED
 * under `postgres` and `neon`. The easy wrong fix for a test that fails under one driver is to
 * skip it there, or to branch its expectation on the driver — both of which turn a seam bug into
 * a green gate. So, over every file in the directory:
 *
 * 1. no `.skip`, `.skipIf`, `.runIf`, `.todo` or `.only` on `describe` / `it` / `test`;
 * 2. no conditional on the driver (`if`, `?:`, `&&`, `||`, `??`, `switch` naming `driver`,
 *    `DATABASE_DRIVER` or `databaseDriver(…)`) INSIDE a test. Module-level setup may still pick
 *    what to dial per driver (unreachable.test.ts points the proxy at the dead port), because that
 *    is setup, not an expectation.
 *
 * And the suite ships to every copy: no `kitOnly` glob in `.rocketflare.json` may reach it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const DRIVER_DIR = path.resolve(__dirname, '../driver')
const REPO = path.resolve(__dirname, '../../../..')
const RUNNERS = new Set(['describe', 'it', 'test'])
const MODIFIERS = new Set(['skip', 'skipIf', 'runIf', 'todo', 'only'])

function namesTheDriver(node: ts.Node): boolean {
  let found = false
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && ['driver', 'databaseDriver', 'DATABASE_DRIVER'].includes(n.text)) {
      found = true
    }
    if (!found) ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

/** Is this node inside the callback of an `it(…)` / `test(…)` call? */
function insideATest(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) continue
    const call = current.parent
    if (call && ts.isCallExpression(call) && ts.isIdentifier(call.expression)) {
      if (call.expression.text === 'it' || call.expression.text === 'test') return true
    }
  }
  return false
}

function conditionOf(node: ts.Node): ts.Node | null {
  if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
    return ts.isIfStatement(node) ? node.expression : node.condition
  }
  if (ts.isSwitchStatement(node)) return node.expression
  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(node.operatorToken.kind)
  ) {
    return node.left
  }
  return null
}

function findConformanceViolations(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const at = (node: ts.Node, message: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
    found.push(`${path.basename(file)}:${line + 1} ${message}`)
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      RUNNERS.has(node.expression.text) &&
      MODIFIERS.has(node.name.text)
    ) {
      at(node, `${node.expression.text}.${node.name.text} — the conformance suite runs every test`)
    }
    const condition = conditionOf(node)
    if (condition && namesTheDriver(condition) && insideATest(node)) {
      at(node, 'a test branches on the driver — an equivalence holds under both, unchanged')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function driverFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return driverFiles(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

describe('the driver conformance suite (tests/driver/)', () => {
  it('skips nothing and expects the same under both drivers', () => {
    const files = driverFiles(DRIVER_DIR)
    expect(files.length).toBeGreaterThan(0)
    const violations = files.flatMap(f => findConformanceViolations(f, readFileSync(f, 'utf8')))
    expect(violations).toEqual([])
  })

  it('catches the shapes it exists for', () => {
    const sample = `
      const driver = databaseDriver(process.env)
      const env = { NEON_LOCAL_PROXY: driver === 'neon' ? 'http://127.0.0.1:1' : undefined }
      describe.skip('x', () => {})
      it.skipIf(driver === 'neon')('y', () => {})
      it.todo('z')
      describe('d', () => {
        it('a', () => {
          if (driver !== 'neon') return
          expect(1).toBe(1)
        })
        it('b', () => {
          expect(x).toEqual(driver === 'neon' ? ['x'] : '{x}')
        })
        it('c', () => {
          expect(process.env.DATABASE_DRIVER || 'postgres').toBe(driver)
        })
      })`
    const found = findConformanceViolations('/x/sample.test.ts', sample)
    expect(found.map(f => f.replace(/^\S+ /, ''))).toEqual([
      expect.stringMatching(/^describe\.skip/),
      expect.stringMatching(/^it\.skipIf/),
      expect.stringMatching(/^it\.todo/),
      expect.stringMatching(/branches on the driver/),
      expect.stringMatching(/branches on the driver/),
      expect.stringMatching(/branches on the driver/),
    ])
  })

  it('ships to every copy: no kitOnly glob reaches it', () => {
    const manifestPath = path.join(REPO, '.rocketflare.json')
    if (!existsSync(manifestPath)) return
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { kitOnly?: string[] }
    for (const glob of manifest.kitOnly ?? []) {
      const prefix = glob.replace(/\*.*$/, '')
      expect('apps/web/tests/driver/driver.test.ts'.startsWith(prefix), glob).toBe(false)
    }
  })
})
