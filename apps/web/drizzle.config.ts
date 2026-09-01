import { defineConfig } from 'drizzle-kit'

// Run via `pnpm db:generate` / `pnpm db:studio`, which load `.dev.vars` with dotenv-cli.
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://gmgo:gmgo_pass@localhost:5432/gmgo_dev',
  },
  verbose: true,
  strict: true,
})
