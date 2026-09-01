/**
 * The Rocketflare mark — a rocket launching from a cloud — inlined so it needs no request and
 * scales with `className`. The fills are the brand illustration colours, fixed on purpose (the mark
 * is multi-coloured, so it does not take `currentColor` like a monochrome glyph would); the same
 * art is `public/logo.svg` and `public/favicon.svg`. Rebrand: replace the paths in all three.
 */
export function LogoMark({ className = 'w-7 h-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={`flex-none ${className}`} role="img" aria-hidden="true">
      {/* Rocket body */}
      <path
        fill="#3B82C4"
        d="M256 72C222 100 205 144 205 200L205 286C205 302 216 313 232 313L280 313C296 313 307 302 307 286L307 200C307 144 290 100 256 72Z"
      />
      {/* Nose cone */}
      <path fill="#F2C94C" d="M256 72C237 88 224 108 216 132L296 132C288 108 275 88 256 72Z" />
      {/* Window */}
      <circle cx="256" cy="184" r="23" fill="#F4F1E8" />
      <circle cx="256" cy="184" r="15" fill="#91D4E8" />
      {/* Fins */}
      <path fill="#E65A3A" d="M205 231C180 245 165 270 160 307L205 289Z" />
      <path fill="#E65A3A" d="M307 231C332 245 347 270 352 307L307 289Z" />
      {/* Engine and exhaust */}
      <path fill="#5D6670" d="M232 307H280L274 333H238Z" />
      <path fill="#F2C94C" d="M242 331C246 349 251 361 256 371C261 361 266 349 270 331Z" />
      <path fill="#E65A3A" d="M249 331C251 344 253 353 256 360C259 353 261 344 263 331Z" />
      {/* Launch cloud */}
      <path
        fill="#E8872F"
        d="M91 409C91 377 117 351 149 351C154 351 159 352 164 353C174 320 205 296 241 296C279 296 311 322 319 358C328 351 339 347 351 347C382 347 407 372 409 403C431 405 449 423 449 446L449 452L63 452L63 438C63 422 75 410 91 409Z"
      />
    </svg>
  )
}
