export function isGitCommit(command: unknown): boolean
export function commitsAll(command: unknown): boolean
export function versionOf(text: unknown): string | null
export function versionChange(
  before: string | null | undefined,
  after: string | null | undefined
): { from: string | null; to: string } | null
export function siteReminder(input: {
  from: string | null
  to: string
  kind: 'kit' | 'plugins'
  wwwDir?: string
}): string
export function hookJson(message: string, notice?: string): string
