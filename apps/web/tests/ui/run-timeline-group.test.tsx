/**
 * A stage header is a disclosure only when there is something to disclose: a stage that recorded
 * no rows is a plain line — no button, no `aria-expanded`, no chevron that turns and opens nothing.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TimelineGroup } from '@/ui/pages/agents/run/timeline/TimelineGroup'
import type { TimelineGroup as Group } from '@/ui/pages/agents/run/timeline/timelineModel'

const at = new Date('2026-01-01T00:00:00Z')

const group = (rows: Group['rows']): Group => ({
  key: 'answer',
  step: { key: 'answer', label: 'Writing the answer', status: 'done' },
  status: 'done',
  rows,
  headerId: 'h1',
  at,
  toolCount: rows.filter(row => row.kind === 'tool').length,
  modelCount: 0,
})

describe('TimelineGroup', () => {
  it('renders a stage with no rows as a plain line', () => {
    const { container } = render(
      <TimelineGroup group={group([])} expanded={false} onToggle={vi.fn()} />
    )
    expect(screen.getByText('Writing the answer')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('[aria-expanded]')).toBeNull()
    expect(container.querySelector('svg.rotate-90, svg.transition-transform')).toBeNull()
  })

  it('renders a stage with a tool row as a disclosure', () => {
    const tool = {
      kind: 'tool' as const,
      id: 't1',
      seq: 2,
      name: 'search_knowledge',
      isError: false,
      done: true,
      at,
    }
    const { container } = render(
      <TimelineGroup group={group([tool])} expanded={false} onToggle={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: /Writing the answer/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(container.querySelector('svg.transition-transform')).not.toBeNull()
  })
})
