---
version: unreleased
previous: 0.25.0
date: null
breaking: true
migrations: []
areas: [config, api, scripts, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The kit compiles with TypeScript 7.1, the native compiler: `tsconfig` `paths` no longer use `baseUrl`, and every script and test that parses source uses TypeScript 7's `typescript/sync` and `typescript/ast` API.

- `typescript` 7.1 in all five `package.json` files. TS 7.0 shipped no compiler API (`import ts from 'typescript'` returns only the version), and 7.1 restores one under `typescript/sync` and `typescript/ast`.
- TS 7 removed `baseUrl`, and a `paths` target must start with `./`. `apps/web` and `apps/evals` change; `tests/config/testkit-alias.test.ts` expects `./tests/kit/*`.
- `apps/web/src/api/index.ts`: the SPA catch-all handler is `async`. TS 7 does not accept a handler returning `Promise<Response> | Response` against Hono's overloads.
- New `scripts/lib/parse-source.mjs` (+ `.d.mts`): `parseSource(fileName, text)` returns a syntax tree from the tsgo process `typescript/sync` spawns, the one place the kit parses TypeScript.
- `scripts/lib/surface.mjs` and the config tests `driver-conformance`, `driver-results`, `shared-imports` and `unscoped-allowlist` parse through `parseSource` and walk with `typescript/ast`. A type-only import is now `importClause.phaseModifier === SyntaxKind.TypeKeyword`.
- `scripts/plugin-api-doc.mjs` builds its program with `createSnapshot` and reads exports, aliases and doc comments through the 7.1 checker. In `docs/plugin-api.md`, `{@link X}` in a summary reads as `X`, and `typeToString` prints string literals in single quotes; no member is added or removed.

## How to apply

1. In the root `package.json`, `apps/web/package.json`, `apps/cli/package.json`, `apps/evals/package.json` and `packages/shared/package.json`, set `"typescript": "^7.1.0"`, then run `pnpm install`.
2. In `apps/web/tsconfig.json`, delete `"baseUrl": "."` and set `"paths": { "@/*": ["./src/*"], "@testkit/*": ["./tests/kit/*"] }`.
3. In `apps/evals/tsconfig.json`, delete `"baseUrl": "."` and change the `vitest` path to `["./node_modules/vitest"]`.
4. In any other `tsconfig*.json` of yours that sets `baseUrl`, delete it and prefix each `paths` target with `./` (relative to that tsconfig).
5. In `apps/web/tests/config/testkit-alias.test.ts`, expect `paths['@testkit/*']` to equal `['./tests/kit/*']`.
6. In `apps/web/src/api/index.ts`, make the `app.all('*', …)` catch-all handler `async c => { … }`. Do the same for any handler of yours that `pnpm typecheck` reports as TS2769 because one branch returns a `Promise<Response>`.
7. Copy `scripts/lib/parse-source.mjs` and `scripts/lib/parse-source.d.mts` from the kit.
8. In `scripts/lib/surface.mjs`, change `typescript()` to load `{ ...require('typescript/ast'), ...require('./parse-source.mjs') }`, replace `ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)` with `ts.parseSource(fileName, source)`, replace `ts.forEachChild(node, visit)` with `node.forEachChild(visit)`, and replace `Boolean(clause?.isTypeOnly)` with `clause?.phaseModifier === ts.SyntaxKind.TypeKeyword`.
9. In `apps/web/tests/config/driver-conformance.test.ts`, `driver-results.test.ts`, `shared-imports.test.ts` and `unscoped-allowlist.test.ts`, keep your own allowlist entries and change only the parsing: `import ts from 'typescript'` becomes `import * as ts from 'typescript/ast'` plus `import { parseSource } from '../../../../scripts/lib/parse-source.mjs'`, each `ts.createSourceFile(name, text, …)` becomes `parseSource(name, text)`, each `ts.forEachChild(n, visit)` becomes `n.forEachChild(visit)`, `ts.isStringLiteralLike` becomes `ts.isStringLiteralLikeNode`, `ts.isPropertySignature` becomes `ts.isPropertySignatureDeclaration`, and `Boolean(node.importClause?.isTypeOnly)` becomes `node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword`.
10. In `driver-results.test.ts`, filter the `as` literal's members with `.filter(ts.isPropertySignatureDeclaration)` before the `.find`, and guard the `case` check with `ts.isSwitchStatement(node.parent.parent)`: a 7.1 `Node.parent` is untyped.
11. Replace `scripts/plugin-api-doc.mjs` with the kit's, then run `node scripts/plugin-api-doc.mjs` and commit `docs/plugin-api.md`.
12. Port any script or test of your own that imports `typescript` to `typescript/ast` (syntax) or `typescript/sync` (program and checker). `rg -n "from 'typescript'"` lists them.

## Conflicts to expect

- `apps/web/tsconfig.json`, `apps/evals/tsconfig.json` → `baseUrl` removed, `paths` relative → keep your own `paths` entries, each prefixed with `./`.
- `scripts/plugin-api-doc.mjs` → rewritten on the 7.1 API → take the kit's; your `ROLES` and `CAPABILITIES` rows are the only parts to carry over.
- `apps/web/tests/config/{driver-results,unscoped-allowlist}.test.ts` → parsing lines changed → keep your allowlist entries, take the kit's parsing lines.

## Verify

1. `pnpm exec tsc --version` prints `Version 7.1.` followed by a patch number.
2. `rg -n "baseUrl" --glob 'tsconfig*.json' --glob '!node_modules'` prints nothing.
3. `rg -n "from 'typescript'" --glob '!node_modules'` prints nothing.
4. `node scripts/plugin-api-doc.mjs --check` exits 0.
5. `pnpm gate` passes.
