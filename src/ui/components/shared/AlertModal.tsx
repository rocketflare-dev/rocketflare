import { Modal } from './Modal'
import type { ToastType } from './Toast'

interface AlertModalProps {
  isOpen: boolean
  title: string
  message: string
  type?: ToastType
  onClose: () => void
}

// Built from a prop → safelisted via `@source inline` in index.css
const alertClass: Record<ToastType, string> = {
  success: 'alert-success',
  error: 'alert-error',
  warning: 'alert-warning',
  info: 'alert-info',
}

/** One-button acknowledgement on the `<dialog>` Modal. */
export function AlertModal({ isOpen, title, message, type = 'info', onClose }: AlertModalProps) {
  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={title}
      actions={
        <button type="button" className="btn btn-sm" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className={`alert ${alertClass[type]}`} role="status">
        <span>{message}</span>
      </div>
    </Modal>
  )
}
