// Applies the saved theme before React mounts so there is no flash. Only the two known theme names
// are accepted; anything else falls back to the OS preference, so a stale value can never desync
// the toggle (ThemeToggle.tsx normalises the same way). A file rather than an inline script because
// the Worker's CSP refuses inline script, and app navigations can reach the Worker.
// Set here because a classic script runs before any module: zod otherwise probes `new Function` to
// choose a faster parser, which a strict CSP reports as a violation.
globalThis.__zod_globalConfig = { jitless: true }

;(() => {
  var saved = localStorage.getItem('theme')
  if (saved !== 'rocketflare-light' && saved !== 'rocketflare-dark') {
    saved = window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'rocketflare-dark'
      : 'rocketflare-light'
  }
  document.documentElement.setAttribute('data-theme', saved)
})()
