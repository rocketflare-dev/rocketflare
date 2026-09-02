/** Hand-written types for `bootstrap-lib.mjs` (no `allowJs`); keep in step with the module. */

export function parseNvmrc(text: string): number
export function versionAtLeast(vString: string | undefined, major: number): boolean

export interface FillDevVarsResult {
  text: string
  /** Required keys that were empty or absent and are now generated. */
  filled: string[]
  /** Optional keys the example declares and the file lacks (warn, never fail). */
  missing: string[]
}
export function fillDevVars(
  exampleText: string,
  existingText: string | null,
  generate: () => string,
  requiredKeys: string[]
): FillDevVarsResult
export function readDevVars(text: string): Record<string, string>

export type AiBlockState = 'on' | 'off' | 'absent'
export function aiBlockState(tomlText: string): AiBlockState
export function toggleAiBlock(tomlText: string, mode: 'on' | 'off'): string

export function extractSeedKey(stdout: string): string | undefined

export interface WhoamiResult {
  loggedIn: boolean
  email?: string
  account?: string
}
export function parseWhoami(stdout: string | undefined): WhoamiResult

export const TEST_DB_PORT: number
export interface ChooseDevDbPortOptions {
  /** The port already in use by this checkout (from `.dev.vars`), kept when still available. */
  preferred?: number | null
  /** "Free, or already published by this checkout's own container." */
  isAvailable: (port: number) => boolean
  start?: number
  count?: number
  skip?: number[]
}
export function chooseDevDbPort(options: ChooseDevDbPortOptions): number | null
export function databaseUrlPort(url: string): number | null
export function withDatabaseUrlPort(url: string, port: number): string
export function upsertDevVar(text: string, key: string, value: string): string
export function checkoutTag(absolutePath: string): string
