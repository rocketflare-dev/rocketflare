import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ThemeToggle from '@/ui/components/ThemeToggle'

describe('ThemeToggle', () => {
  it('defaults to rocketflare-light and toggles to rocketflare-dark, persisting to localStorage', () => {
    render(<ThemeToggle />)

    expect(document.documentElement.getAttribute('data-theme')).toBe('rocketflare-light')

    fireEvent.click(screen.getByRole('button'))

    expect(document.documentElement.getAttribute('data-theme')).toBe('rocketflare-dark')
    expect(localStorage.getItem('theme')).toBe('rocketflare-dark')

    fireEvent.click(screen.getByRole('button'))

    expect(document.documentElement.getAttribute('data-theme')).toBe('rocketflare-light')
    expect(localStorage.getItem('theme')).toBe('rocketflare-light')
  })

  it('restores a saved theme from localStorage on mount', () => {
    localStorage.setItem('theme', 'rocketflare-dark')
    render(<ThemeToggle />)
    expect(document.documentElement.getAttribute('data-theme')).toBe('rocketflare-dark')
  })

  it('ignores an unknown stored theme instead of desyncing from the DOM', () => {
    localStorage.setItem('theme', 'some-old-theme')
    render(<ThemeToggle />)
    expect(document.documentElement.getAttribute('data-theme')).toBe('rocketflare-light')
    expect(localStorage.getItem('theme')).toBe('rocketflare-light')
  })
})
