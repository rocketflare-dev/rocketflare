import type http from 'node:http'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import type { HttpProxy } from 'vite'
import { defineConfig } from 'vite'
import { devAllowedHosts, devPorts } from '../../scripts/lib/dev-ports.mjs'

/** Prevent proxy errors from crashing Vite when the API (wrangler dev) is restarting */
function onProxyError(proxy: HttpProxy.ProxyServer) {
  proxy.on('error', (err: Error, _req: http.IncomingMessage, res: unknown) => {
    console.warn(`[proxy] ${err.message}`)
    const response = res as http.ServerResponse
    if (response?.writeHead && !response.headersSent) {
      response.writeHead(502, { 'Content-Type': 'text/plain' })
      response.end('API server unavailable — waiting for restart')
    }
  })
}

// When served through a Cloudflare tunnel (`pnpm dev:tunnel`), cfld injects the public HTTPS
// URL as PUBLIC_URL. Allow that host and point HMR at the tunnel's wss endpoint.
const tunnelHost = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).host : undefined

// The dev ports (default :3000 UI / :3001 API) and any extra hosts Vite must answer for (a
// sandbox preview hostname) — DEV_UI_PORT / DEV_API_PORT / DEV_ALLOWED_HOSTS, from the shell or
// apps/web/.dev.vars (scripts/lib/dev-ports.mjs).
const ports = devPorts()
const allowedHosts = [...new Set([...devAllowedHosts(), ...(tunnelHost ? [tunnelHost] : [])])]

const API = `http://localhost:${ports.api}`
const proxyTo = (target = API, extra: Record<string, unknown> = {}) => ({
  target,
  changeOrigin: true,
  secure: false,
  configure: onProxyError,
  ...extra,
})

export default defineConfig({
  plugins: [react()],
  root: 'src/ui',
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
  },
  server: {
    port: ports.ui,
    // Never silently move to another port: the next one is `wrangler dev`, and a Vite that lands there
    // serves the UI from the API's port while the proxy talks to itself. Fail loudly instead —
    // `pnpm dev` runs scripts/dev-server.mjs --preflight to clear or name the squatter first.
    strictPort: true,
    host: true,
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    ...(tunnelHost ? { hmr: { protocol: 'wss', host: tunnelHost, clientPort: 443 } } : {}),
    watch: {
      // The UI only depends on src/ui, src/shared and the plugins' UI halves (src/plugins/*/ui,
      // reached through the src/plugins/ui.ts barrel) — allowlist those so API/migration/doc edits
      // don't churn the Vite watcher. wrangler dev watches the API side. Leaving src/plugins out
      // meant a plugin's UI edits never hot-reloaded: the browser kept the module it had.
      ignored: (filePath: string) => {
        const rel = path.relative(import.meta.dirname, filePath)
        if (rel.startsWith('..')) return false
        if (rel === '' || rel === 'src') return false
        if (rel.startsWith('node_modules')) return false
        return !(
          rel === 'vite.config.ts' ||
          rel === 'postcss.config.js' ||
          rel.startsWith('src/ui') ||
          rel.startsWith('src/shared') ||
          rel.startsWith('src/plugins')
        )
      },
    },
    // Everything the Worker serves in production is proxied to `wrangler dev` here.
    // An installed plugin's own prefixes land here as `coreEdits` its manifest declares — `pnpm
    // plugin add` writes them and `remove` reverts them. The analytics plugin's are `/cubejs-api`
    // and `/mcp`.
    proxy: {
      '/api': proxyTo(),
      '/auth': proxyTo(),
      '/ws': proxyTo(`ws://localhost:${ports.api}`, { ws: true }),
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      // An installed plugin may need an alias of its own: a `coreEdits` entry in its manifest,
      // which `pnpm plugin add` writes here and `remove` reverts. The analytics plugin
      // needs two: `'@nivo/heatmap'` pointed at its own stub (drizzle-cube's heat-map chunk names
      // that OPTIONAL peer, and Rolldown fails the build without the package), and `'recharts'`
      // added to `dedupe` below, because drizzle-cube's chart chunks import it.
    },
    dedupe: ['react', 'react-dom'],
  },
})
