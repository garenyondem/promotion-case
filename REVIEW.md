# REVIEW — ModaCo Promotion Management API

QA audit for future QA agents. This document records how the codebase was tested, what
was verified live, what is broken, and how to reproduce every finding.

Reviewed: 2026-07-31. Branch/commit context: `git log --oneline -3` →
`5c01360`, `4e5b618`, `b42fefe`. Uncommitted work present (see §8).

---

## 1. Executive summary

The API is functionally solid on the happy path — the advertised scenarios (product CRUD,
promotion create/cancel/assign, precedence, ingestion with idempotent upsert) all work.
The automated suite is green: **26/26 tests pass**, plus `lint`, `format`, and `build` are
clean.

However, a live end-to-end pass exposed **9 confirmed bugs**, several of which are
data-integrity or availability issues that the test suite cannot see because it never
exercises the failing inputs:

| # | Severity | Finding | Confirmed live |
|---|---|---|---|
| 1 | Critical | Ingestion job never reaches `COMPLETED` when any row is skipped | Yes |
| 2 | High | Empty `basePrice` / `stockQuantity` CSV cells silently ingest as `0` (free products) | Yes |
| 3 | High | Headerless CSV silently drops the first data row | Yes |
| 4 | High | Client error inputs return HTTP 500 instead of 400/404 (bad UUID, numeric overflow, malformed JSON) | Yes |
| 5 | Medium | `GET /products?category=*` collides with the unfiltered listing cache key and returns the whole catalog | Yes |
| 6 | Medium | `POST /promotions/:id/assign` mutates a `CANCELLED` promotion (returns 200) | Yes |
| 7 | Medium | `productId` + `category` accepted together on one promotion (mutual exclusion not enforced) | Yes |
| 8 | Medium | Uploaded files are never deleted — `data/uploads/` grows on every upload (storage leak / DoS) | Yes |
| 9 | Medium | No auth / no rate limit / no upload size cap on any endpoint | Static + documented |

The rest of this file is a recipe to reproduce each item and to keep the review honest.

---

## 2. Verified environment

- OS: Windows 11, Node 24, Docker Desktop with compose plugin.
- Stack running: `modaco-postgres` (postgres:16-alpine, healthy), `modaco-redis`
  (redis:7-alpine, healthy), `modaco-minio` (minio/minio:latest).
- `.env` mirrors `.env.example` except the AWS keys are unset (expected for local).
  `CACHE_DRIVER=redis`, `STORAGE_DRIVER=local`, `PORT=3000`,
  `INGEST_CHUNK_SIZE=1000`, `INGEST_MAX_CONCURRENCY=4`.
- Prisma client generated; `npm run db:seed` seeds 5 products + 1 active 20% category
  promotion.

## 3. How to run the checks

All commands run from `modaco-promotion-api/`.

```bash
npm install
docker compose up -d
cp .env.example .env
npm run prisma:generate
npm run db:push          # dev DB; tests use a separate modaco_test DB
npm run db:seed
npm run dev              # http://localhost:3000
```

Verification pipeline (all currently green):

```bash
npm run lint
npm run format           # prettier --check
npm run build            # tsc (typecheck)
npm test                 # 26 tests: 10 unit + 16 integration, 4.65s
```

Test quirks to remember:

- `npm test` pushes the schema into a **separate** `modaco_test` DB
  (`tests/setup.ts`) and forces `CACHE_DRIVER=memory`. It is destructive to that DB
  only, and it is not hermetic (needs Docker Postgres).
- The single ingestion test polls 10×50ms and can be flaky under load.
- Nothing asserts the "26 tests" count; README.md / DEPLOYMENT.md both claim it.

## 4. What was verified live (real-user flows through a browser)

Server started with `npm run dev`, then driven like a user via a browser
(Playwright/Chromium MCP) hitting `http://localhost:3000`:

| Flow | Request | Result |
|---|---|---|
| Health | `GET /health` | 200 `{"status":"ok"}` |
| List products | `GET /products` | 200, `{data, pagination}` |
| Filter + sort | `GET /products?category=Accessories&sort=price_desc&limit=2` | 200, correct order |
| Get by id | `GET /products/:id` | 200 |
| Create product | `POST /products` (NEW-ACC-1, Accessories, 40) | 201, `effectivePrice` 32 (20% promo applied) |
| Precedence | create PRODUCT 50% promo over the CATEGORY 20% | product effectivePrice → 20 (PRODUCT wins) |
| Update | `PATCH /products/:id` | 200 |
| Cancel promo | `POST /promotions/:id/cancel` | 200, price restored to next active promo (32) |
| List promos | `GET /promotions` | 200 |
| Assign | `POST /promotions/:id/assign` | 200 (works, but see finding 6) |
| Upload CSV | `POST /ingest` (multipart) | 202 `{jobId, status:"PROCESSING"}` |
| Poll job | `GET /ingest/:id` | 200 → `COMPLETED` (only when 0 skipped) |
| Idempotency | re-upload same CSV | row count unchanged (verified in Postgres) |
| Bulk recompute | FIXED_AMOUNT $5 category promo | all Apparel products −$5; cancel restores base |
| Cached read | two consecutive `GET /products?category=Accessories` | ~7ms then ~3ms (small dataset) |

Postgres spot checks used:
`docker compose exec -T postgres psql -U modaco -d modaco -c "<SQL>"`.

## 5. Confirmed bugs (with reproduction)

### 5.1 — Ingestion job stuck in `PROCESSING` when any row is skipped — CRITICAL

- **Code**: `src/ingest/jobs.ts:23-31` (`maybeComplete`) checks
  `processedRecords >= totalRecords` and ignores `skippedRecords`.
- **Repro**:
  1. Upload a CSV with one malformed row (e.g. `a,b,c` short row) and several good rows.
  2. Poll `GET /ingest/:id`.
  3. `skippedRecords` = 1, `processedRecords` < `totalRecords`, status never leaves
     `PROCESSING`.
- **Observed**: job `aa4dba54-5032-4668-8003-8f2e1c25c388` stayed `PROCESSING`
  indefinitely; final DB state showed 1 job in `PROCESSING` out of 4.
- **Impact**: any real vendor file with a single bad row never reports completion.
  The UI/operator has no way to know the job finished.

### 5.2 — Empty numeric CSV cells become 0 — HIGH

- **Code**: `src/ingest/processor.ts:25-35` — `Number('') === 0`, and the guards only
  reject `NaN` / negatives / non-integers; compounded by `relax_column_count: true` in
  `src/ingest/chunker.ts:8` which pads short rows with empty cells.
- **Repro**: upload `sku,name,category,basePrice,stockQuantity` row with an empty
  `basePrice` (or empty `stockQuantity`).
- **Observed**: `ING-003` (missing price) ingested with `basePrice = 0.00`;
  `ING-004` (missing stock) with `stockQuantity = 0`.
- **Impact**: a vendor file with an empty price silently creates **free products**.

### 5.3 — Headerless CSV silently drops first row — HIGH

- **Code**: `src/ingest/chunker.ts:11-15` skips the first record unconditionally as a
  header. The dropped row is not counted, so `processed + skipped === total` still holds.
- **Repro**: upload a CSV with **no header** and two data rows.
- **Observed**: job `5acefb4f-c496-467c-b806-e68bc659c6bf` → `totalRecords: 1`; only the
  second row landed (`HDRLESS-1` lost).
- **Impact**: silent data loss; `HDRLESS-1` never upserted and never reported.

### 5.4 — Client errors return HTTP 500 — HIGH

- **Code**: `src/shared/middleware.ts:10-27` only maps `AppError` and `ZodError`;
  everything else is 500. Root causes:
  - non-UUID `:id` → Prisma `P2023` (`product.repository.ts:35`,
    `promotion.repository.ts:18`, `jobs.ts:41`);
  - numeric overflow of `Decimal(12,2)`/`int4` → Postgres `22003`
    (`product.controller.ts:16-17`, `promotion.controller.ts:8`);
  - malformed JSON / body too large → body-parser `SyntaxError` / `PayloadTooLargeError`
    (`app.ts:16`).
- **Repro** (all verified live):
  - `GET /products/not-a-uuid` → **500**
  - `GET /ingest/not-a-uuid` → **500**
  - `POST /products` with `basePrice: 10000000000` → **500**
  - `POST /products` with `stockQuantity: 2147483648` → **500**
  - `POST /promotions` with `value: 10000000000` (FIXED_AMOUNT) → **500**
  - `POST /products` with malformed JSON body → **500**
  - `POST /ingest` with no body → **500**
- **Expected**: 400 (invalid input) or 404 (bad id). Duplicate-SKU race also yields 500
  instead of 409 (sequential duplicate correctly returns 409).
- Server log captured full stack traces for every one of the above.

### 5.5 — `category=*` collides with unfiltered listing cache key — MEDIUM

- **Code**: `src/cache/index.ts:50` key = `products:<gen>:<category ?? '*'>::<sort>:<page>:<limit>`.
  A product whose category is literally `*` makes `?category=*` and no-filter share a key.
- **Repro** (verified live): create product with `category: "*"`, then
  `GET /products?category=*` returned **all 13 products across all categories**, identical
  to `GET /products`.
- **Impact**: filtered request served unfiltered cached data (wrong results from cache).

### 5.6 — `assign` can mutate a `CANCELLED` promotion — MEDIUM

- **Code**: `src/modules/promotions/promotion.service.ts:104-157` — no status guard.
- **Repro** (verified live): `POST /promotions/:id/assign` on a `CANCELLED` promo → 200,
  `productId` changed, promo stays `CANCELLED`.
- **Impact**: a cancelled promotion can be silently re-pointed; a later UI showing the
  wrong product association. (Price is not applied since status is CANCELLED.)

### 5.7 — `productId` + `category` accepted together — MEDIUM

- **Code**: `src/modules/promotions/promotion.controller.ts:12-13` — no mutual exclusion.
- **Repro** (verified live): POST with `scope: "PRODUCT"`, a `productId`, and a `category`
  → 201; both columns persisted; the engine ignores the stray `category`.
- **Impact**: data pollution; inconsistent promotion semantics.

### 5.8 — Uploaded files are never deleted — MEDIUM

- **Code**: `Storage.deleteFile` (`src/ingest/storage.ts:21,39,63`) has **zero call sites**.
- **Repro** (verified live): `data/uploads/` count grew with each upload
  (23 → 26 during this review); my `qa-ingest.csv` and `idempotency.csv` remain on disk.
- **Impact**: unbounded disk/S3 growth; repeat uploads (the README's own idempotency
  scenario) leak storage indefinitely. Also no busboy `limits` (`ingest.routes.ts:17`) →
  no file-size cap.

### 5.9 — No auth / no rate limit / no body-size limit on any endpoint — MEDIUM (documented)

- **Code**: `src/app.ts:14-26`; confirmed `grep` for `auth|apiKey|Bearer|helmet|rateLimit`
  across `src/` = no matches. `ADR.md:400-401` acknowledges the missing auth.
- **Impact**: `POST /ingest`, `POST /products`, `POST /promotions` are fully open, with an
  uncapped multipart body → unauthenticated disk-exhaustion vector.

## 6. Static-analysis findings (not yet reproduced live, high value)

These come from code review; reproduction is either heavyweight or requires concurrency.

1. **Non-atomic promotion writes** (`promotion.service.ts:76-82,94-100,144-155`): the
   promotion row is committed before `recompute` + `bumpGeneration()`. If recompute throws,
   the promo persists with no price update and no cache invalidation.
2. **Cache bump after the blocking recompute** (`promotion.service.ts:77-82`,
   `recompute.service.ts:51-99`): generation is bumped *after* a ~9s recompute, so cached
   listings keep serving pre-sale prices during the recompute, and readers see a **mixed**
   new/old price set because recompute runs in 2000-row autocommit batches. Contradicts
   ADR.md:360-362 ("reads use the previous values").
3. **Local queue is at-most-once** (`src/ingest/queue.ts:54-56`): message file is deleted
   at claim time; a crash between claim and `deleteMessage` loses the rows. Contradicts
   ADR.md:254 ("at-least-once"). Stranded `.lock` files are never reaped
   (evidence: `data/queue/debug-queue-test3/`).
4. **Serverless job tracking broken** (`lambdas/orchestrator.ts:19`): `setTotalRecords`
   overwrites the real total with `0`, so a worker marks the job `COMPLETED` after the
   first chunk. No tests cover the lambdas.
5. **SQS batch retry semantics broken** (`lambdas/pricing-worker.ts:9-15`):
   `template.yaml:80-82` expects `batchItemFailures`, handler never returns them → one
   poison message retries every valid message, then DLQ.
6. **Pre-drain failure leaves job `PROCESSING` forever** (`src/ingest/orchestrator.ts:42-49`):
   `failJob` only runs inside the per-chunk catch; a throw from `orchestrate()` skips it.
7. **SKU / overlap TOCTOU** (`product.service.ts:76-92`, `promotion.service.ts:57-74`):
   read-then-write with no transaction → concurrent duplicate SKUs return 500, concurrent
   overlapping ACTIVE promotions possible (engine resolves by array order).
8. **`INGEST_CHUNK_SIZE` unvalidated** (`config/env.ts:15`): > ~7,281 rows/chunk exceeds
   Postgres 65,535-parameter limit; non-numeric values produce `NaN` and crash.
9. **Redis outage after startup = full outage** (`cache/index.ts:58-69`): fallback to
   MemoryCache only on initial connect; later failures propagate to 500s.
10. **`minimumPriceRule` dead code** (`shared/pricing/rules.ts:34-41`): exported, never
    used; if a minimum-price guarantee was intended, it does not exist.

## 7. Security notes

- **No SQL injection, prototype pollution, or path traversal found.** All dynamic SQL
  builds placeholders from array lengths and binds user data as parameters; zod strips
  unknown keys; upload filenames go through `basename()`.
- Gaps: no auth, no rate limiting, no `helmet`, no CORS policy, `X-Powered-By: Express`
  leaked, server binds all interfaces, busboy has no `limits`, no file-type check,
  `data/uploads` + `data/queue` never cleaned, known dev credentials
  (`docker-compose.yml`: `modaco:modaco`, MinIO `modaco:modaco123`), prod compose
  defaults to `modaco` password if `POSTGRES_PASSWORD` unset, Redis without
  `requirepass` by default in prod compose.

## 8. Docs vs. code inconsistencies

- `AGENTS.md:6` says "DEPLOYMENT.md does not exist" — it does (and is referenced by
  `opencode.json`). AGENTS.md setup still says `db:push`; README/DEPLOYMENT.md use
  `prisma:migrate`.
- `README.md:143` says fixture ~15 MB; the actual generated file is ~23.5 MB.
- `README.md:82` documents `price_asc`/`price_desc` only; `sort=created_at` also accepted.
- `README.md:10-11` promises promotion "CRUD … and cancel/restore" but there is no
  update/delete/restore endpoint (only cancel + assign).
- `ADR.md:199-207` (ADR-004) says writes "delete the affected product keys";
  `CacheService.del`/`RedisCache.del` are dead code — only the generation counter bumps.
- `DEPLOYMENT.md:64` claims "26 tests" (matches README only while all pass; nothing
  enforces it).
- Git state: `DEPLOYMENT.md`, `Dockerfile`, `docker-compose.prod.yml`, `.dockerignore`,
  `prisma/migrations/`, root `AGENTS.md`, and `opencode.json` are **untracked**.

## 9. Test-coverage gaps (why the suite is green but the bugs exist)

- No tests for: lambda handlers, `LocalQueue` (lock contention / crash recovery), chunker,
  processor edge cases, storage drivers, or any error path (bad UUID, overflows, malformed
  JSON, missing file).
- Integration tests only exercise well-formed inputs; the 500-class findings in §5.4 are
  completely invisible to the suite.
- No test asserts job completion with `skippedRecords > 0`, headerless CSV, or empty
  numeric cells — exactly the three data-integrity bugs in §5.1–5.3.
- Serverless S3/SQS/Lambda path is never built (`dist-lambda/` absent) or deployed.

## 10. Recommended priorities for the next agent / owner

1. Fix `maybeComplete` to count skipped rows (5.1) and make `failJob` cover the whole
   pipeline (6.6).
2. Treat empty numeric cells as invalid/skipped (5.2); count the headerless first row
   correctly or validate the header (5.3).
3. Map Prisma/body-parser errors to proper 400/404/409 in `middleware.ts` (5.4) and add
   upper bounds to zod schemas.
4. Bump the cache generation *before* the recompute, and wrap recompute in a transaction
   (6.1, 6.2).
5. Add busboy `limits`, file-type validation, and call `deleteFile` after the pipeline
   finishes (5.8).
6. Reconsider `assign` on cancelled promotions and enforce productId/category mutual
   exclusion (5.6, 5.7).
7. Add the missing integration/unit tests listed in §9 before touching behavior.

## 11. Repo hygiene notes for future agents

- Repo-root `package.json` / `package-lock.json` / `node_modules/` are a stray trimmed
  copy — **never** `npm install` at the root. Work inside `modaco-promotion-api/`.
- `.env` is gitignored and untracked; read it only to check keys, never to copy secrets.
- The `data/queue/` tree contains job dirs and debug folders (`debug-*`) from earlier
  sessions; harmless but noisy. Do not commit them.
- The API returns JSON in a browser; use the DevTools Network panel or `fetch()` in the
  page context to drive POST/PATCH/DELETE like a user.
