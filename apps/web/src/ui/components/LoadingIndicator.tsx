interface LoadingIndicatorProps {
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** Fill the viewport and centre (app-level boot) */
  centered?: boolean
  /** Fill the container (min 400px) and centre (page-level) */
  fullPage?: boolean
  className?: string
}

const sizeMap = {
  sm: 'loading-sm',
  md: 'loading-md',
  lg: 'loading-lg',
  xl: 'loading-xl',
}

/** DaisyUI spinner in the primary colour. */
export function LoadingIndicator({
  size = 'md',
  centered = false,
  fullPage = false,
  className = '',
}: LoadingIndicatorProps) {
  const spinner = (
    <span
      className={`loading loading-spinner text-primary ${sizeMap[size]} ${className}`}
      role="status"
      aria-label="Loading"
    />
  )

  if (centered) {
    return <div className="min-h-screen flex items-center justify-center">{spinner}</div>
  }
  if (fullPage) {
    return <div className="flex items-center justify-center min-h-[400px] w-full">{spinner}</div>
  }
  return spinner
}

export default LoadingIndicator
