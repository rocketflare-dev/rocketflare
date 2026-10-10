/** Hand-written types for `toml-lite.mjs` (no `allowJs`). */
export class TomlError extends Error {}
// biome-ignore lint/suspicious/noExplicitAny: a parsed TOML document
export function parseToml(text: string): Record<string, any>
