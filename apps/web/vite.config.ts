import type http from 'node:http'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import type { HttpProxy } from 'vite'
import { defineConfig } from 'vite'

/** Prevent proxy errors from crashing Vite when the API (wrangler dev) is restarting */
function onProxyError(proxy: HttpProxy.Server) {
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

const API = 'http://localhost:3001'
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
    minify: 'esbuild',
  },
  server: {
    port: 3000,
    // Never silently move to another port: 3001 is `wrangler dev`, and a Vite that lands there
    // serves the UI from the API's port while the proxy talks to itself. Fail loudly instead —
    // `pnpm dev` runs scripts/dev-server.mjs --preflight to clear or name the squatter first.
    strictPort: true,
    host: true,
    ...(tunnelHost
      ? {
          allowedHosts: [tunnelHost],
          hmr: { protocol: 'wss', host: tunnelHost, clientPort: 443 },
        }
      : {}),
    watch: {
      // The UI only depends on src/ui and src/shared — allowlist those so API/migration/doc
      // edits don't churn the Vite watcher. wrangler dev watches the API side.
      ignored: (filePath: string) => {
        const rel = path.relative(__dirname, filePath)
        if (rel.startsWith('..')) return false
        if (rel === '' || rel === 'src') return false
        if (rel.startsWith('node_modules')) return false
        return !(
          rel === 'vite.config.ts' ||
          rel === 'postcss.config.js' ||
          rel.startsWith('src/ui') ||
          rel.startsWith('src/shared')
        )
      },
    },
    // Everything the Worker serves in production is proxied to `wrangler dev` here.
    proxy: {
      '/api': proxyTo(),
      '/auth': proxyTo(),
      '/cubejs-api': proxyTo(),
      '/mcp': proxyTo(),
      '/ws': proxyTo('ws://localhost:3001', { ws: true }),
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // D19: drizzle-cube's heat-map chunk names an export of this OPTIONAL peer; without the
      // package Rollup fails the build. The stub renders a notice (src/ui/lib/stubs).
      '@nivo/heatmap': path.resolve(__dirname, './src/ui/lib/stubs/nivo-heatmap.tsx'),
    },
    // D19: drizzle-cube's chart chunks import recharts; one copy, shared with any kit chart.
    dedupe: ['react', 'react-dom', 'recharts'],
  },
})
