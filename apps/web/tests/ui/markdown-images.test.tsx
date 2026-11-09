/**
 * Markdown from a model or a document never makes the browser fetch anything by itself: an image
 * is shown as a link the reader can choose to follow.
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Markdown } from '@/ui/components/ai/Markdown'
import { renderWithProviders } from './helpers/renderWithProviders'

describe('Markdown images', () => {
  it.each([
    'https://images.example/p.png?d=abc',
    '//images.example/p.png',
    '/auth/cli?redirect_uri=x',
    '/api/files/1',
  ])('renders %s as a link and loads nothing', src => {
    const { container } = renderWithProviders(<Markdown content={`See ![a chart](${src})`} />)
    expect(container.querySelector('img')).toBeNull()
    const link = screen.getByRole('link', { name: 'a chart' })
    expect(link).toHaveAttribute('href', src)
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('falls back to the address when the image has no description', () => {
    const src = 'https://images.example/p.png'
    renderWithProviders(<Markdown content={`![](${src})`} />)
    expect(screen.getByRole('link', { name: src })).toHaveAttribute('href', src)
  })

  it('shows only the description when the address is refused', () => {
    const { container } = renderWithProviders(
      <Markdown content={'![a chart](javascript:alert(1))'} />
    )
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(container).toHaveTextContent('a chart')
  })
})
