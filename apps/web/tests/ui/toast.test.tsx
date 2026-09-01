import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { showToast, ToastContainer, useToastStore } from '@/ui/components/shared/Toast'

describe('Toast', () => {
  it('renders a toast via showToast and can be dismissed', () => {
    render(<ToastContainer />)

    act(() => {
      showToast('Saved successfully', 'success')
    })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Saved successfully')
    expect(alert).toHaveClass('alert-success')

    act(() => {
      const { toasts, removeToast } = useToastStore.getState()
      removeToast(toasts[0].id)
    })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('dismisses via the close button', () => {
    render(<ToastContainer />)
    act(() => {
      showToast('Heads up', 'warning', 0)
    })
    expect(screen.getByRole('alert')).toHaveClass('alert-warning')
    act(() => {
      screen.getByRole('button', { name: 'Dismiss' }).click()
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
