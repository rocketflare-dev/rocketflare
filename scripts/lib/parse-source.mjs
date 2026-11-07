import { API } from 'typescript/sync'

let api

// The syntax tree is copied into this process, so the remote lease can go at once.
/** @returns {import('typescript/ast').SourceFile} */
export function parseSource(fileName, text) {
  api ??= new API({ cwd: process.cwd() })
  const retained = api.createSourceFile(fileName, text)
  const { sourceFile } = retained
  retained.dispose()
  return sourceFile
}
