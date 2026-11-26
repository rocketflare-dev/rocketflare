/**
 * Direct-to-storage uploads (`services/uploads`) need two things from provisioning beyond the
 * bucket itself:
 *
 * - the `[vars]` the Worker presigns with: `R2_ACCOUNT_ID` (the S3 endpoint is
 *   `<account>.r2.cloudflarestorage.com`) and `FILES_BUCKET_NAME` (the binding cannot tell the
 *   Worker its own bucket's name);
 * - a CORS rule on every bucket of the toml, so the browser may `PUT` from the app's origin with
 *   the two headers the URL signs (`Content-Type`, `If-None-Match`). Written with
 *   `wrangler r2 bucket cors set <bucket> --file <json> --force` (R2's `{ rules: [{ allowed }] }`
 *   shape, never S3's `CORSRules`).
 *
 * The key pair itself (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) is an R2 API token scoped to
 * these buckets, created in the dashboard and copied by `provision secrets <env>` (docs/DEPLOY.md).
 */

export interface R2BucketBlock {
  binding: string
  bucketName: string
}

/** Every `[[r2_buckets]]` block's binding and bucket name, in file order. */
export function r2BucketBlocks(toml: string): R2BucketBlock[] {
  const out: R2BucketBlock[] = []
  for (const block of toml.split(/^\[\[r2_buckets\]\]\s*$/m).slice(1)) {
    const body = block.split(/^\[/m)[0] ?? ''
    const binding = /^binding\s*=\s*"([^"]+)"/m.exec(body)?.[1]
    const bucketName = /^bucket_name\s*=\s*"([^"]+)"/m.exec(body)?.[1]
    if (binding && bucketName) out.push({ binding, bucketName })
  }
  return out
}

/** The `[vars]` the Worker presigns with, for one environment's toml. */
export function uploadVars(toml: string, accountId: string): Record<string, string> {
  const files = r2BucketBlocks(toml).find(b => b.binding === 'FILES')
  return {
    R2_ACCOUNT_ID: accountId,
    ...(files ? { FILES_BUCKET_NAME: files.bucketName } : {}),
  }
}

/** The CORS policy every bucket gets: `PUT` from the app's origin with the signed headers. */
export function uploadCorsPolicy(appUrl: string): {
  rules: {
    allowed: { origins: string[]; methods: string[]; headers: string[] }
    exposeHeaders: string[]
    maxAgeSeconds: number
  }[]
} {
  return {
    rules: [
      {
        allowed: {
          origins: [new URL(appUrl).origin],
          methods: ['PUT'],
          headers: ['content-type', 'if-none-match'],
        },
        exposeHeaders: ['ETag'],
        maxAgeSeconds: 3600,
      },
    ],
  }
}
