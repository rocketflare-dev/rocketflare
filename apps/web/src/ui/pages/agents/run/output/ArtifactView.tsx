/**
 * One artifact, dispatched on its kind — the closed set from `@rocketflare/shared/ai/artifacts`
 * (decision 7), so a sixth kind is a type error here until it has a branch.
 *
 * `document` and `file` carry IDS, never content: the bytes live behind routes that enforce tenancy
 * and, for a document, group visibility (D29). Rendering them as links is not a shortcut, it is the
 * only correct thing to do with them.
 */
import { ArrowDownTrayIcon, DocumentMagnifyingGlassIcon } from '@heroicons/react/24/outline'
import type { AgentArtifact } from '@rocketflare/shared/ai/artifacts'
import { documentPath } from '@rocketflare/shared/ai/embeddings'
import { filePath } from '@rocketflare/shared/files'
import { Link } from 'react-router-dom'
import { Markdown } from '@/ui/components/ai/Markdown'
import { formatBytes } from '@/ui/lib/format'
import { JsonDisclosure, pretty, truncate } from '../timeline/toolResults'

export function ArtifactView({ artifact }: { artifact: AgentArtifact }) {
  return (
    <section className="surface-panel space-y-2" data-artifact-kind={artifact.kind}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{artifact.title}</h3>
        <span className="badge badge-ghost badge-sm">{artifact.kind}</span>
      </div>
      {artifact.description && <p className="text-xs text-secondary">{artifact.description}</p>}
      <ArtifactBody artifact={artifact} />
    </section>
  )
}

function ArtifactBody({ artifact }: { artifact: AgentArtifact }) {
  const data = artifact.data
  switch (data.kind) {
    case 'document':
      return (
        <Link
          to={documentPath(data.documentId)}
          className="link link-primary text-sm inline-flex items-center gap-1.5"
        >
          <DocumentMagnifyingGlassIcon className="w-4 h-4" />
          Open the document
        </Link>
      )
    case 'file':
      return (
        <a
          href={filePath(data.fileId)}
          className="link link-primary text-sm inline-flex items-center gap-1.5"
          download
        >
          <ArrowDownTrayIcon className="w-4 h-4" />
          {data.filename ?? 'Download'}
          {data.sizeBytes !== undefined && (
            <span className="text-muted">({formatBytes(data.sizeBytes)})</span>
          )}
        </a>
      )
    case 'markdown':
      return <Markdown content={data.markdown} className="text-sm" />
    case 'table':
      return (
        <div className="overflow-x-auto">
          <table className="data-table" aria-label={artifact.title}>
            <thead>
              <tr>
                {data.columns.map(column => (
                  <th key={column.key} style={{ textAlign: column.align ?? 'left' }}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, index) => (
                // Rows are arbitrary records with no id of their own; position is the only key.
                // biome-ignore lint/suspicious/noArrayIndexKey: the table is immutable once written
                <tr key={index}>
                  {data.columns.map(column => (
                    <td key={column.key} style={{ textAlign: column.align ?? 'left' }}>
                      {cell(row[column.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'json':
      return (
        <pre className="surface-inset rounded-md p-2 text-xs whitespace-pre-wrap break-words max-h-80 overflow-auto">
          {truncate(pretty(data.json), 20_000)}
        </pre>
      )
  }
}

function cell(value: unknown) {
  if (value === null || value === undefined) return <span className="text-muted">—</span>
  if (typeof value === 'object') return <JsonDisclosure summary="value" value={value} />
  return String(value)
}
