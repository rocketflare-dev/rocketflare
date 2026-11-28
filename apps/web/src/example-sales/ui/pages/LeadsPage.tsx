/**
 * The example sales domain's page: leads, a form to add one, and who owns each. Qualifying runs
 * the `example-sales.qualify-lead` agent from the Agents page (or `rocketflare agents run`).
 */
import {
  type createLeadSchema,
  leadListResponseSchema,
  leadSchema,
} from '@rocketflare/shared/example-sales/index'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { z } from 'zod'
import { api, EmptyState, SectionPanel } from '@/plugins/api/ui'
import { leadKeys } from '../query-keys'

type CreateLeadBody = z.input<typeof createLeadSchema>

export default function LeadsPage() {
  const queryClient = useQueryClient()
  const leads = useQuery({
    queryKey: leadKeys.list(1),
    queryFn: () => api.get('/api/example-sales/leads?page=1', { schema: leadListResponseSchema }),
  })
  const create = useMutation({
    mutationFn: (body: CreateLeadBody) =>
      api.post('/api/example-sales/leads', body, { schema: leadSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: leadKeys.all }),
  })
  const [name, setName] = useState('')
  const [company, setCompany] = useState('')

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    create.mutate(
      { name: name.trim(), company: company.trim() },
      {
        onSuccess: () => {
          setName('')
          setCompany('')
        },
      }
    )
  }

  return (
    <div className="space-y-6">
      <SectionPanel
        title="Leads"
        description="An example app domain that depends on the HR one: apps/web/src/example-sales."
      >
        <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
          <input
            className="input input-bordered input-sm min-w-48 flex-1"
            placeholder="Name"
            value={name}
            maxLength={200}
            onChange={e => setName(e.target.value)}
          />
          <input
            className="input input-bordered input-sm min-w-48 flex-1"
            placeholder="Company"
            value={company}
            maxLength={200}
            onChange={e => setCompany(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-sm btn-primary"
            disabled={create.isPending || name.trim() === ''}
          >
            Add lead
          </button>
        </form>
      </SectionPanel>

      <SectionPanel title="Pipeline">
        {leads.data && leads.data.items.length === 0 ? (
          <EmptyState
            message="No leads yet"
            description="Add one above, or run pnpm seed --demo."
          />
        ) : (
          <ul className="divide-y divide-[color:var(--border-subtle)]">
            {leads.data?.items.map(lead => (
              <li key={lead.id} className="flex items-center justify-between gap-4 py-3 text-sm">
                <div>
                  <p className="font-medium">{lead.name}</p>
                  <p className="text-muted">
                    {lead.company || 'No company'} · {lead.status}
                    {lead.score === null ? '' : ` · score ${lead.score}`}
                  </p>
                </div>
                <span className="text-muted">{lead.ownerUserId ? 'Owned' : 'In the pool'}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionPanel>
    </div>
  )
}
