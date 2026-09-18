/**
 * The example feature's page (D30, D31). Everything here exists to be deleted.
 *
 * It is reachable only while `example-feature` is on for the session's organisation. Note what that
 * means: a global admin, who holds `manage all`, is ALSO kept out — because the guard reads
 * `session.features`, not the ability. That is the difference between a flag and a permission, and
 * it is why the route guard and the nav item share one const in `../index.ts`.
 *
 * It is lazy (`lazy(() => import(...))` in the UI entry), so none of this — nor the plugin's hooks,
 * nor its contracts — reaches the main bundle for the readers who never open it.
 */
import { useState } from 'react'
// The COMPONENTS half of the UI kit (D31). A page may import it because a page is lazy and ships in
// its own chunk; the plugin's `ui/index.ts` may not, because that one is in everybody's first
// download. `showToast` comes from here and only here — it is reachable in the kit by two public
// paths, and one plugin took each, which is how two call sites of one function come to look like two.
import { EmptyState, SectionPanel, showToast, useAuth, usePermissions } from '@/plugins/api/ui'
import {
  useCreateExampleNote,
  useDeleteExampleNote,
  useExampleNotes,
  usePingExampleQueue,
} from '../hooks/useExampleNotes'

export default function ExampleFeaturePage() {
  const { user } = useAuth()
  const { can } = usePermissions()
  const notes = useExampleNotes()
  const create = useCreateExampleNote()
  const remove = useDeleteExampleNote()
  const ping = usePingExampleQueue()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!title.trim()) return
    create.mutate(
      { title: title.trim(), body: body.trim() },
      {
        onSuccess: () => {
          setTitle('')
          setBody('')
        },
      }
    )
  }

  return (
    <div className="space-y-6">
      <SectionPanel
        title="Example feature"
        description="A page, a table and a queue job that exist only while a feature flag says they do."
      >
        <div className="space-y-3 text-sm">
          <p>
            You are seeing this because <code>example-feature</code> is on for this organisation.
            Turn it off under Admin → Feature flags and this page, its nav item and the whole{' '}
            <code>/api/example-feature</code> mount disappear — for every role, including a global
            admin.
          </p>
          <p className="text-muted">
            All of it is one plugin: <code>apps/web/src/plugins/example-feature</code>,{' '}
            <code>packages/shared/src/plugins/example-feature</code> and{' '}
            <code>apps/cli/src/plugins/example-feature</code>, wired in by five barrel lines. Remove
            those and the kit is bare again — including the <code>example_notes</code> table, whose{' '}
            <code>DROP</code> the next <code>pnpm db:generate</code> writes for you.
          </p>
          <div>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              disabled={ping.isPending}
              onClick={() =>
                ping.mutate(undefined, {
                  onSuccess: job =>
                    showToast(
                      `Queued ${job.type} (${job.jobId.slice(0, 8)}) — watch wrangler dev`,
                      'success'
                    ),
                })
              }
            >
              Send a queue ping
            </button>
          </div>
        </div>
      </SectionPanel>

      <SectionPanel
        title="Notes"
        description="A tenant-scoped table with an RLS policy, reachable only by this organisation."
      >
        <form className="mb-4 space-y-2" onSubmit={submit}>
          <input
            className="input input-bordered w-full"
            placeholder="Title"
            value={title}
            maxLength={200}
            onChange={e => setTitle(e.target.value)}
          />
          <textarea
            className="textarea textarea-bordered w-full"
            placeholder="Anything worth writing down"
            value={body}
            maxLength={4000}
            rows={2}
            onChange={e => setBody(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-sm btn-primary"
            disabled={create.isPending || title.trim() === ''}
          >
            Add note
          </button>
        </form>

        {notes.data && notes.data.items.length === 0 ? (
          <EmptyState
            message="No notes yet"
            description="Add one above, or run pnpm seed --demo."
          />
        ) : (
          <ul className="divide-y divide-[color:var(--border-subtle)]">
            {notes.data?.items.map(note => (
              <li key={note.id} className="flex items-start justify-between gap-4 py-3">
                <div>
                  <p className="font-medium">{note.title}</p>
                  <p className="text-muted whitespace-pre-wrap text-sm">{note.body}</p>
                </div>
                {(note.ownerUserId === user?.id || can('delete', 'ExampleNote')) && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(note.id)}
                  >
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionPanel>
    </div>
  )
}
