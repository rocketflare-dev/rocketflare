import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ThemeToggle from '@/ui/components/ThemeToggle'

describe('ThemeToggle', () => {
  it('defaults to gm-light and toggles to gm-dark, persisting to localStorage', () => {
    render(<ThemeToggle />)

    expect(document.documentElement.getAttribute('data-theme')).toBe('gm-light')

    fireEvent.click(screen.getByRole('button'))

    expect(document.documentElement.getAttribute('data-theme')).toBe('gm-dark')
    expect(localStorage.getItem('theme')).toBe('gm-dark')

    fireEvent.click(screen.getByRole('button'))

    expect(document.documentElement.getAttribute('data-theme')).toBe('gm-light')
    expect(localStorage.getItem('theme')).toBe('gm-light')
  })

  it('restores a saved theme from localStorage on mount', () => {
    localStorage.setItem('theme', 'gm-dark')
    render(<ThemeToggle />)
    expect(document.documentElement.getAttribute('data-theme')).toBe('gm-dark')
  })

  it('ignores an unknown stored theme instead of desyncing from the DOM', () => {
    localStorage.setItem('theme', 'some-old-theme')
    render(<ThemeToggle />)
    expect(document.documentElement.getAttribute('data-theme')).toBe('gm-light')
    expect(localStorage.getItem('theme')).toBe('gm-light')
  })
})
