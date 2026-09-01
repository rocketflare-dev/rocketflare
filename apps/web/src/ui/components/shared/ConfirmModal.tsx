import type { ReactNode } from 'react'
import { Modal } from './Modal'

interface ConfirmModalProps {
  isOpen: boolean
  title: string
  message: ReactNode
  confirmText?: string
  cancelText?: string
  /** `btn-primary` (default), `btn-error` for destructive actions, `btn-warning` */
  confirmButtonClass?: 'btn-primary' | 'btn-error' | 'btn-warning'
  isLoading?: boolean
  onCancel: () => void
  onConfirm: () => void
}

/** Two-button confirmation on the `<dialog>` Modal. */
export function ConfirmModal({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  confirmButtonClass = 'btn-primary',
  isLoading = false,
  onCancel,
  onConfirm,
}: ConfirmModalProps) {
  return (
    <Modal
      open={isOpen}
      onClose={onCancel}
      title={title}
      closeButton={false}
      actions={
        <>
          <button type="button" className="btn btn-sm" onClick={onCancel} disabled={isLoading}>
            {cancelText}
          </button>
          <button
            type="button"
            className={`btn btn-sm ${confirmButtonClass}`}
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading ? <span className="loading loading-spinner loading-xs" /> : confirmText}
          </button>
        </>
      }
    >
      {typeof message === 'string' ? <p>{message}</p> : message}
    </Modal>
  )
}
