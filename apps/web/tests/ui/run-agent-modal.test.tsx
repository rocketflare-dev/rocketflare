/**
 * "Run <agent>" with a form GENERATED from the agent's JSON Schema (`schemaForm`, the rung every
 * agent without a hand-written form lands on — any plugin's agent, most of an app's). Typing must
 * keep the same input mounted: `schemaForm` returns a new `Component` per call, so the modal builds
 * the form once, and a regression here is an input that loses focus after every keystroke.
 */
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunAgentModal } from '@/ui/pages/agents/RunAgentModal'
import { FIXTURE_AGENT } from '../helpers/fixture-agents'
import { makeSession, renderWithProviders, stubFetch } from './helpers/renderWithProviders'

const agent = {
  key: FIXTURE_AGENT,
  title: 'Fixture agent',
  description: 'A test fixture agent.',
  promptKey: FIXTURE_AGENT,
  exclusive: true,
  approvers: 'requester' as const,
  inputJsonSchema: {
    type: 'object',
    properties: { question: { type: 'string', title: 'Question' } },
    required: ['question'],
  },
}

describe('RunAgentModal with a schema-generated form', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the same field mounted and focused while typing', async () => {
    stubFetch({})
    renderWithProviders(<RunAgentModal agent={agent} onClose={() => {}} onStarted={() => {}} />, {
      session: makeSession(),
    })
    const field = (await screen.findByLabelText(/Question/)) as HTMLInputElement
    field.focus()
    fireEvent.change(field, { target: { value: 'H' } })
    fireEvent.change(screen.getByLabelText(/Question/), { target: { value: 'Ho' } })

    const after = screen.getByLabelText(/Question/) as HTMLInputElement
    expect(after).toBe(field)
    expect(after.value).toBe('Ho')
    expect(document.activeElement).toBe(field)
  })
})
