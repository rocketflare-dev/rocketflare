import { Link } from 'react-router-dom'

export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="text-center">
        <p className="font-mono text-muted text-sm mb-2">404</p>
        <h1 className="text-xl font-semibold mb-2">Page not found</h1>
        <p className="text-secondary mb-6">This page does not exist or has moved.</p>
        <Link to="/" className="btn btn-primary btn-sm">
          Back home
        </Link>
      </div>
    </div>
  )
}
