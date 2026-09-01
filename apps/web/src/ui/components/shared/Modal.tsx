import { XMarkIcon } from '@heroicons/react/24/outline'
import { type ReactNode, useEffect, useRef } from 'react'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  /** Footer buttons */
  actions?: ReactNode
  /** Show the top-right close button (default true) */
  closeButton?: boolean
  /** Extra classes on `.modal-box` (e.g. `max-w-2xl`) */
  className?: string
}

/**
 * `<dialog>`-based modal: native focus trap, Escape and backdrop close, `aria-modal` for free.
 * Controlled — the caller owns `open`. Falls back to the `open` attribute where `showModal()`
 * is unavailable (older jsdom).
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  actions,
  closeButton = true,
  className = '',
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close()
      else dialog.removeAttribute('open')
    }
  }, [open])

  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={e => {
        // Escape: keep React in charge of `open`
        e.preventDefault()
        onClose()
      }}
      onClose={onClose}
    >
      {/* Column layout with a bounded height: the BODY scrolls, the title and actions stay put —
          a long run timeline or a big output used to grow the box past the viewport. */}
      <div className={`modal-box popover-surface p-0 flex flex-col max-h-[85vh] ${className}`}>
        {(title || closeButton) && (
          <div className="flex items-start justify-between gap-4 px-5 pt-5 shrink-0">
            {title && <h3 className="text-base font-semibold leading-6">{title}</h3>}
            {closeButton && (
              <button
                type="button"
                className="btn btn-ghost btn-xs btn-circle -mr-1 -mt-1"
                onClick={onClose}
                aria-label="Close"
              >
                <XMarkIcon className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
        <div className="px-5 py-4 text-sm text-secondary overflow-y-auto min-h-0 flex-1">
          {children}
        </div>
        {actions && <div className="modal-action mt-0 px-5 pb-5 gap-2 shrink-0">{actions}</div>}
      </div>
      {/* Backdrop click closes: a native <form method="dialog"> submit fires `close` */}
      <form method="dialog" className="modal-backdrop">
        <button type="submit" aria-label="Close" tabIndex={-1} />
      </form>
    </dialog>
  )
}
