import type { ReactNode } from 'react'

interface SettingRowProps {
  label: ReactNode
  description?: ReactNode
  /** The control: toggle, input, select, button… */
  children: ReactNode
  /** Associates the label with the control */
  htmlFor?: string
  className?: string
}

/** "Label + description on the left, control on the right" — the settings-page row. */
export function SettingRow({
  label,
  description,
  children,
  htmlFor,
  className = '',
}: SettingRowProps) {
  return (
    <div
      className={`flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between border-b border-[color:var(--border-subtle)] last:border-b-0 ${className}`}
    >
      <div className="min-w-0 sm:max-w-[60%]">
        <label htmlFor={htmlFor} className="block text-sm font-medium">
          {label}
        </label>
        {description && <p className="text-sm text-secondary mt-0.5">{description}</p>}
      </div>
      <div className="flex items-center gap-2 sm:shrink-0">{children}</div>
    </div>
  )
}

interface SettingToggleProps {
  id: string
  label: ReactNode
  description?: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}

/** Toggle variant. */
export function SettingToggle({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
}: SettingToggleProps) {
  return (
    <SettingRow label={label} description={description} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        className="toggle toggle-primary"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
      />
    </SettingRow>
  )
}

interface SettingInputProps {
  id: string
  label: ReactNode
  description?: ReactNode
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: 'text' | 'email' | 'url' | 'number'
  disabled?: boolean
  error?: string
}

/** Single-line input variant. */
export function SettingInput({
  id,
  label,
  description,
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
  error,
}: SettingInputProps) {
  return (
    <SettingRow label={label} description={description} htmlFor={id}>
      <div className="w-full sm:w-72">
        <input
          id={id}
          type={type}
          className={`input input-sm w-full ${error ? 'input-error' : ''}`}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          onChange={e => onChange(e.target.value)}
        />
        {error && <p className="text-xs text-error mt-1">{error}</p>}
      </div>
    </SettingRow>
  )
}
