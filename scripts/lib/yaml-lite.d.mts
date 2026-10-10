/** Hand-written types for `yaml-lite.mjs` (no `allowJs`). */
export class YamlError extends Error {}
// biome-ignore lint/suspicious/noExplicitAny: a parsed YAML document
export function parseYaml(text: string): any
