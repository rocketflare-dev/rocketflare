/**
 * The sign-in panel's drawing: the rocket from `shared/LogoMark` redrawn as tonal linework, large,
 * climbing out of the panel's top edge with its launch cloud cropped off the bottom. Every colour
 * comes from the panel's tokens (`.login-art*` in index.css: the rail tones for the lines and
 * the body, `--flare` for the flame), so a new brand recolours it. Replace it with your own
 * imagery, or set `LOGIN_PANEL.art = 'type'` in lib/login-panel.ts for a type-only panel.
 */
export function LoginArt({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 800 1000"
      preserveAspectRatio="xMidYMid slice"
      className={`login-art ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        {/* Two speed lines along the climb */}
        <path
          className="login-art-faint"
          vectorEffect="non-scaling-stroke"
          strokeWidth="1.25"
          d="M70 690 C 140 580 210 470 290 345"
        />
        <path
          className="login-art-faint"
          vectorEffect="non-scaling-stroke"
          strokeWidth="1.25"
          d="M150 760 C 205 672 250 600 300 520"
        />

        {/* Launch cloud, cropped off the bottom edge */}
        <g transform="translate(-170 160) scale(1.9)">
          <path
            className="login-art-fill"
            vectorEffect="non-scaling-stroke"
            strokeWidth="1.5"
            d="M91 409C91 377 117 351 149 351C154 351 159 352 164 353C174 320 205 296 241 296C279 296 311 322 319 358C328 351 339 347 351 347C382 347 407 372 409 403C431 405 449 423 449 446L449 452L63 452L63 438C63 422 75 410 91 409Z"
          />
          <path
            className="login-art-faint"
            vectorEffect="non-scaling-stroke"
            strokeWidth="1.25"
            d="M164 353C170 368 172 380 171 394M319 358C314 370 312 382 313 395"
          />
        </g>

        {/* The rocket, tilted into its climb and cropped off the top edge */}
        <g transform="translate(520 250) rotate(32) scale(2.3) translate(-256 -230)">
          {/* Flame: the flare's gold, the one bright note */}
          <path
            className="login-art-flare"
            vectorEffect="non-scaling-stroke"
            strokeWidth="1.5"
            d="M236 333C241 380 248 430 256 492C264 430 271 380 276 333Z"
          />
          <path
            className="login-art-core"
            vectorEffect="non-scaling-stroke"
            strokeWidth="1.25"
            d="M247 335C250 368 253 398 256 436C259 398 262 368 265 335Z"
          />
          {/* Fins */}
          <path
            className="login-art-fill"
            vectorEffect="non-scaling-stroke"
            strokeWidth="1.5"
            d="M205 231C180 245 165 270 160 307L205 289ZM307 231C332 245 347 270 352 307L307 289Z"
          />
          {/* Engine bell */}
          <path
            className="login-art-fill"
            vectorEffect="non-scaling-stroke"
            strokeWidth="1.5"
            d="M232 307H280L274 333H238Z"
          />
          {/* Body */}
          <path
            className="login-art-fill"
            vectorEffect="non-scaling-stroke"
            strokeWidth="1.75"
            d="M256 72C222 100 205 144 205 200L205 286C205 302 216 313 232 313L280 313C296 313 307 302 307 286L307 200C307 144 290 100 256 72Z"
          />
          {/* Nose-cone seam, body bands, centre line */}
          <path
            vectorEffect="non-scaling-stroke"
            strokeWidth="1.25"
            d="M216 132C240 138 272 138 296 132"
          />
          <path
            className="login-art-faint"
            vectorEffect="non-scaling-stroke"
            strokeWidth="1.25"
            d="M205 252C236 258 276 258 307 252M256 214V306"
          />
          {/* Window */}
          <circle vectorEffect="non-scaling-stroke" strokeWidth="1.5" cx="256" cy="184" r="23" />
          <circle
            className="login-art-faint"
            vectorEffect="non-scaling-stroke"
            strokeWidth="1.25"
            cx="256"
            cy="184"
            r="15"
          />
        </g>
      </g>
    </svg>
  )
}
