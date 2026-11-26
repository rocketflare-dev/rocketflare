/**
 * `scripts/provision/r2-uploads.ts` pure helpers (no network): the buckets a toml binds, the two
 * `[vars]` the Worker presigns with, and the CORS policy every bucket gets — in R2's
 * `{ rules: [{ allowed }] }` shape, which `wrangler r2 bucket cors set` reads (S3's `CORSRules`
 * shape is refused).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { r2BucketBlocks, uploadCorsPolicy, uploadVars } from '../../scripts/provision/r2-uploads'

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')

const TOML = `
[vars]
APP_URL = "https://app.example.com"

[[r2_buckets]]
binding = "FILES"
bucket_name = "acme-files-staging"

[[r2_buckets]]
binding = "SITES_MEDIA"
bucket_name = "acme-sites-media-staging"

[[queues.producers]]
binding = "JOBS_QUEUE"
queue = "acme-jobs-staging"
`

describe('r2BucketBlocks', () => {
  it('lists every [[r2_buckets]] block in file order and stops at the next table', () => {
    expect(r2BucketBlocks(TOML)).toEqual([
      { binding: 'FILES', bucketName: 'acme-files-staging' },
      { binding: 'SITES_MEDIA', bucketName: 'acme-sites-media-staging' },
    ])
  })

  it('reads the kit fixtures, which bind FILES', () => {
    for (const name of ['wrangler.toml', 'wrangler.staging.toml']) {
      expect(r2BucketBlocks(fixture(name)).map(b => b.binding)).toContain('FILES')
    }
  })
})

describe('uploadVars', () => {
  it('names the account and the FILES bucket', () => {
    expect(uploadVars(TOML, 'acct123')).toEqual({
      R2_ACCOUNT_ID: 'acct123',
      FILES_BUCKET_NAME: 'acme-files-staging',
    })
  })

  it('writes only the account when the toml binds no FILES bucket', () => {
    expect(uploadVars('[vars]\n', 'acct123')).toEqual({ R2_ACCOUNT_ID: 'acct123' })
  })
})

describe('uploadCorsPolicy', () => {
  it("allows PUT from the app's origin alone, with the two signed headers", () => {
    expect(uploadCorsPolicy('https://app.example.com/some/path')).toEqual({
      rules: [
        {
          allowed: {
            origins: ['https://app.example.com'],
            methods: ['PUT'],
            headers: ['content-type', 'if-none-match'],
          },
          exposeHeaders: ['ETag'],
          maxAgeSeconds: 3600,
        },
      ],
    })
  })
})
