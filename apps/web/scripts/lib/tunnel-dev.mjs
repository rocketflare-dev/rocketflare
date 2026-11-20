// The children `scripts/tunnel-dev.mjs` runs, kept pure so a test can read them.
//
// `--var` beats `.dev.vars`, so the public URL wins over its `APP_URL` line. The flag goes
// straight after the script name, with NO `--`: pnpm 10 forwards a `--` literally, and wrangler
// then reads `--var` as a positional argument and drops it, so the Worker would keep
// `.dev.vars`'s localhost URL and advertise it in every redirect and discovery document.

/** `[command, args]` for the API and the UI, with the Worker's `APP_URL` set to `publicUrl`. */
export function tunnelChildren(publicUrl) {
  return [
    ['pnpm', ['dev:api', '--var', `APP_URL:${publicUrl}`]],
    ['pnpm', ['dev:ui']],
  ]
}
