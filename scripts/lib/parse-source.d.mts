import type { SourceFile } from 'typescript/ast'

export function parseSource(fileName: string, text: string): SourceFile
