---
version: unreleased
previous: 0.45.0
date: null
breaking: true
migrations: ["pending_uploads (new tenant table + RLS policy)"]
areas: [api, cli, db, shared, ui, plugins, config, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Uploads move to `/api/uploads` (presign, PUT, confirm): straight to R2 once an R2 API token is set, through the Worker otherwise; plugins gain `uploadTargets`, and `uploadPaths` / `uploadLimits` keep working, deprecated.

- `POST /api/uploads` and `POST /api/uploads/:id/confirm` (new): the presign runs every check the old routes ran (401/403, 413, 415, 400 `file_empty`, 503 `storage_not_configured` / `conversion_not_configured`); confirm answers what they answered (a `files` row 201; a document 201, or 200 `deduplicated: true`). Design: `docs/CONCEPTS.md` §6.
- Removed: multipart `POST /api/files?scope=` and `POST /api/ai/documents/upload`, with `uploadBodyLimit`, `UPLOAD_PATHS` / `isUploadPath` and `uploadQuerySchema` (`@rocketflare/shared/files`). No core route takes a body above 1 MB.
- `apiBodyLimit` takes one options object (`{ overrides, workerUpload, pluginUploadPaths, uploadLimits }`) instead of positional arguments.
- Confirm errors (new codes): 404 for another tenant's or person's id or a second confirm, 410 `upload_expired`, 400 `upload_missing`, 400 `upload_mismatch` (object deleted). Unknown target → 400 `unknown_upload_target`.
- The URL signs `Content-Type`, `Content-Length` and `If-None-Match: *` (`services/uploads/sigv4.ts`, SigV4 over WebCrypto). Confirm `head`s the object and compares size and type.
- `pending_uploads` table (new). The nightly `prunePendingUploads` task (`0 4 * * *`) deletes unconfirmed uploads with their objects.
- Dedupe of a document now happens at confirm. A duplicate's bytes are stored, then deleted.
- Direct uploads are opt-in. Config (new): `R2_ACCOUNT_ID`, `FILES_BUCKET_NAME` (`[vars]`, both tomls); `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (Worker secrets).
- Without the key pair `POST /api/uploads` hands out the Worker's own `/api/upload-content/:id?token=`, which holds the same rules. Deployed, that path takes at most `MAX_WORKER_UPLOAD_BYTES` (10 MB; larger → 413 `details.directUploads: false`); `development` takes the target's own limit.
- `pnpm provision cloudflare <env>` writes the two vars and a CORS rule (PUT from `APP_URL`) on every `[[r2_buckets]]` bucket; `provision secrets <env>` puts the key pair, and says uploads stay on the Worker when it is missing.
- Plugin seam: `ServerPlugin.uploadTargets` (`PluginUploadTarget` from `@/plugins/api`, `docs/CONCEPTS.md` §16) is new. `uploadPaths` and `uploadLimits` still work unchanged and are deprecated, so an installed plugin's multipart route keeps working.
- UI: `api.upload(target, file, { fields, schema })` replaces `api.upload(url, formData, …)`; `api` no longer sends `FormData`.
- CLI: `ApiClient.upload(target, { name, contentType, bytes }, { fields, schema })` replaces `postForm`.
- Fix: a document upload now keeps its `visibility` and `groupIds`, which the old form post dropped.

## How to apply

1. Run `pnpm db:generate` after porting `apps/web/src/db/schema/pending-uploads.ts` and its export from `schema/index.ts`. Review the SQL (table, RLS policy, `(tenant_id, expires_at)` index), then run `pnpm db:migrate`.
2. Add `R2_ACCOUNT_ID = ""` and `FILES_BUCKET_NAME = "<the FILES bucket_name>"` to `[vars]` in BOTH `apps/web/wrangler.toml` and `apps/web/wrangler.staging.toml`, each with that toml's own bucket name.
3. Add blank `R2_ACCESS_KEY_ID=` and `R2_SECRET_ACCESS_KEY=` lines to `apps/web/.dev.vars.example`. Local development needs neither.
4. Optional, for direct uploads in a deployed environment: create an R2 API token (dashboard → R2 → Manage API tokens, Object Read & Write, scoped to that environment's buckets), put its key pair in `apps/web/.provision.env`, then run `pnpm provision cloudflare <env>` and `pnpm provision secrets <env>` (`docs/DEPLOY.md` § Direct uploads). Without the token, uploads go through the Worker at up to 10 MB a file.
5. Replace every app call of `api.upload(url, formData, options)` with `api.upload('<target>', file, { fields, ...options })`. The core targets are `avatars`, `uploads` and `documents`.
6. Replace every CLI call of `client.postForm(path, form)` with `client.upload('<target>', { name, contentType, bytes }, { fields, schema })`.
7. Leave each installed plugin's `uploadPaths` / `uploadLimits` as they are: both still work. A plugin moves to an `uploadTargets` entry in its own release (`id: '<plugin id>.<name>'`, `maxBytes`, `prepare` for the checks, `confirm` for what the route did once the bytes were stored).
8. Replace any call of `apiBodyLimit(overrides, uploadPaths, uploadLimits)` in app code with `apiBodyLimit({ overrides, pluginUploadPaths, uploadLimits })`.
9. Replace any app test that posted `FormData` to an upload route with `directUpload(env, cookie, target, file, fields)` from `apps/web/tests/helpers/uploads.ts`.

## Conflicts to expect

- `apps/web/src/api/middleware/body-limit.ts` → core upload caps removed, `apiBodyLimit` takes an options object → take the kit's file, then re-add any app cap.
- `apps/web/src/api/routes/files.ts`, `routes/ai-documents.ts` → the multipart `POST` handlers removed → move an app's custom upload checks into the target's `prepare` in `services/uploads/targets.ts`.
- `apps/web/src/plugins/types.ts` → `uploadTargets` added beside the deprecated `uploadPaths` / `uploadLimits` → keep all three.
- `apps/web/src/ui/lib/api-client.ts` → `FormData` branch removed, `upload` re-signed → take the kit's file.

## Verify

1. `pnpm gate` passes.
2. `pnpm test api apps/web/tests/api/uploads.test.ts` passes.
3. `curl -s -X POST https://<staging-host>/api/uploads -H 'Authorization: Bearer <key>' -H 'Content-Type: application/json' -d '{"target":"uploads","name":"a.txt","contentType":"text/plain","size":5}'` answers 201 with a `url`: on `<account>.r2.cloudflarestorage.com` once the R2 key pair is set, else on the app's own `/api/upload-content/`.
4. Uploading an avatar on staging's Profile page shows the new image.
5. With the key pair set: `pnpm --filter @rocketflare/web exec wrangler r2 bucket cors list <bucket> -c wrangler.staging.toml` lists a `PUT` rule for the app's origin.
