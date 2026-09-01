/**
 * Document → text for the knowledge base (D18 uploads). Text-like types (`kind: 'text'` in
 * `DOCUMENT_UPLOAD_TYPES`) are decoded as UTF-8 here and never need a model. Everything else goes
 * through Workers AI Markdown Conversion on the `AI` binding (`env.AI.toMarkdown({ name, blob })`
 * — PDF, Word, Excel, OpenDocument, HTML, XML). The binding is OPTIONAL in code: without it a
 * binary upload is a 503 `conversion_not_configured` at the route (before any byte is stored),
 * text uploads keep working. Conversion of documents is free on Workers AI (images, which the
 * allowlist excludes, are the billed case), so removing `[ai]` stays the only spend switch.
 *
 * `ConversionFailedError` is PERMANENT (the platform answered `format: 'error'` — a corrupt or
 * unsupported file); anything thrown by the binding itself is transient and left for the queue's
 * retry.
 */
import { resolveDocumentUploadType } from '@rocketflare/shared/ai/embeddings'
import { type AiEnv, type MarkdownDocumentInput, markdownConverterOf } from './types'

export class ConversionFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConversionFailedError'
  }
}

/** `true` when the content type needs `toMarkdown`; `false` for text-like types decoded inline. */
export function needsConversion(contentType: string): boolean {
  return resolveDocumentUploadType('', contentType)?.kind === 'convert'
}

/** `true` when this Worker can convert binary uploads (the `AI` binding exposes `toMarkdown`). */
export function canConvert(env: AiEnv): boolean {
  return markdownConverterOf(env) !== null
}

/** UTF-8 decode with the BOM dropped and CRLF normalised — what a pasted text would look like. */
export async function decodeText(blob: Blob): Promise<string> {
  const text = new TextDecoder('utf-8', { ignoreBOM: false }).decode(await blob.arrayBuffer())
  return text.replace(/\r\n?/g, '\n')
}

export interface ConversionResult {
  text: string
  /** `text` for the inline decode, otherwise what the platform answered. */
  format: 'text' | 'markdown'
}

/**
 * Turn one stored upload into indexable text. Throws `ConversionFailedError` for a permanent
 * platform refusal, or `Error('conversion_not_configured')` when a binary type meets a Worker
 * without the binding (the route pre-checks this; the job hits it only after a config change).
 */
export async function convertToText(
  env: AiEnv,
  input: MarkdownDocumentInput & { contentType: string }
): Promise<ConversionResult> {
  if (!needsConversion(input.contentType)) {
    return { text: await decodeText(input.blob), format: 'text' }
  }
  const convert = markdownConverterOf(env)
  if (!convert)
    throw new ConversionFailedError('Document conversion is not configured on this server')
  const result = await convert({ name: input.name, blob: input.blob })
  if (result.format === 'error') {
    throw new ConversionFailedError(`Conversion failed: ${result.error}`)
  }
  return { text: result.data, format: result.format }
}
