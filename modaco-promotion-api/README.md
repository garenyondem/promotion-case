# ModaCo Promotion Management API

Internal REST API for the ModaCo product catalog and promotions.

Built with Node.js 24, TypeScript, Express 4, Prisma 6, PostgreSQL 16, Redis 7.

## Features

- Product CRUD with category filter, price sort, and pagination.
- Promotion CRUD with product or category scope, overlap conflict detection,
  and cancel/restore.
- Serverless-style ingestion pipeline (S3 + SQS + Lambda) for vendor CSV files
  of about 500,000 rows.
- Flash-sale recompute over large categories without blocking reads.
- Redis cache-aside with a generation counter for correct invalidation.

Measured on a Windows 11 laptop:

- 500,000-row ingest: about 17.2 seconds (4 workers, chunk size 1,000).
- Flash-sale recompute over 100,000 products: about 9.1 seconds.
- Cached product read: about 2.5 ms. Cold read: about 51 ms.

## Prerequisites

- Node.js 24 (LTS).
- Docker Desktop with the compose plugin.
- No global TypeScript or Prisma install is needed.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the infrastructure (PostgreSQL, Redis, MinIO):

   ```bash
   docker compose up -d
   ```

3. Create the environment file:

   ```bash
   cp .env.example .env
   ```

   The defaults match the docker-compose services.

4. Create the database schema and seed the sample data:

   ```bash
   npm run prisma:generate
   npm run db:push
   npm run db:seed
   ```

   `db:push` applies the schema in `prisma/schema.prisma`.

5. Start the API:

   ```bash
   npm run dev
   ```

   The API listens on http://localhost:3000.

## API

### Health

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Liveness check |

### Products

| Method | Path | Description |
| --- | --- | --- |
| GET | `/products` | List products. Query: `category`, `sort` (`price_asc`, `price_desc`), `page`, `limit` |
| GET | `/products/:id` | Get one product |
| POST | `/products` | Create a product. Applies active promotions |
| PATCH | `/products/:id` | Update a product |

### Promotions

| Method | Path | Description |
| --- | --- | --- |
| GET | `/promotions` | List promotions |
| POST | `/promotions` | Create a promotion. Recomputes affected prices |
| POST | `/promotions/:id/cancel` | Cancel a promotion. Restores prices |
| POST | `/promotions/:id/assign` | Assign a product promotion to a product |

Promotion body example (category scope):

```json
{
  "name": "Flash sale 50% Accessories",
  "discountType": "PERCENTAGE",
  "value": 50,
  "startAt": "2026-07-01T00:00:00.000Z",
  "endAt": "2026-12-31T23:59:59.000Z",
  "scope": "CATEGORY",
  "category": "Accessories"
}
```

Precedence rule: a product-specific promotion wins over a category promotion.
Both can exist at the same time.

### Ingestion

| Method | Path | Description |
| --- | --- | --- |
| POST | `/ingest` | Upload a CSV file (multipart). Returns a job ID |
| GET | `/ingest/:id` | Get the job status and counts |

CSV format (header required):

```csv
sku,name,category,basePrice,stockQuantity
SKU-00000001,T-Shirt Basic,Apparel,12.99,150
```

## Tests

```bash
npm test
```

The suite has 26 tests:

- 10 unit tests for the pricing engine (`tests/unit/pricing-engine.test.ts`).
- 16 integration tests for the API (`tests/integration/api.test.ts`).

The integration tests use a separate database (`modaco_test`). They push the
schema and reset it before each run. They use an in-memory cache.

## Scenario A: 500K-row ingestion

1. Generate the fixture (500,000 rows, ~15 MB):

   ```bash
   npm run fixture
   ```

   The file is written to `data/fixtures/products.csv`.

2. Start the API in a second terminal:

   ```bash
   npm run dev
   ```

3. Upload the file and record the job ID:

   ```bash
   curl -s -F "file=@data/fixtures/products.csv" http://localhost:3000/ingest
   ```

4. Poll the job status until `COMPLETED`:

   ```bash
   curl -s http://localhost:3000/ingest/<jobId>
   ```

   Expected: `totalRecords` 500000, `processedRecords` 500000,
   `skippedRecords` 0.

5. Verify the row count and idempotency:

   ```bash
   docker compose exec -T postgres psql -U modaco -d modaco \
     -c "SELECT count(*), count(DISTINCT sku) FROM products;"
   ```

   Re-upload the same file. The count must not change. The upsert uses
   `ON CONFLICT ("sku") DO UPDATE`.

### Local pipeline runner

The script below runs the pipeline from the command line. It does not use the
HTTP API:

```bash
npm run ingest -- --file data/fixtures/products.csv
```

## Scenario B: flash sale on a large category

1. Make sure the fixture data is loaded (Scenario A).

2. Create the flash sale:

   ```bash
   curl -s -X POST http://localhost:3000/promotions \
     -H "Content-Type: application/json" \
     -d '{"name":"Flash 50% Accessories","discountType":"PERCENTAGE","value":50,"startAt":"2026-07-01T00:00:00.000Z","endAt":"2026-12-31T23:59:59.000Z","scope":"CATEGORY","category":"Accessories"}'
   ```

   The API recomputes the effective price of every product in the category
   (about 9 seconds for 100,000 products).

3. Verify the discounted rows:

   ```bash
   docker compose exec -T postgres psql -U modaco -d modaco \
     -c "SELECT count(*) FROM products WHERE category = 'Accessories' AND \"effectivePrice\" = round(\"basePrice\" * 0.5, 2);"
   ```

4. Read the catalog. The reads are fast and cached:

   ```bash
   curl -s "http://localhost:3000/products?category=Accessories&sort=price_desc&limit=20"
   ```

5. Create a product during the sale. It must get the discounted price:

   ```bash
   curl -s -X POST http://localhost:3000/products \
     -H "Content-Type: application/json" \
     -d '{"sku":"NEW-ACC-1","name":"New Cap","category":"Accessories","basePrice":40,"stockQuantity":5}'
   ```

   Expected `effectivePrice`: 20.

6. Cancel the sale. Prices must be restored:

   ```bash
   curl -s -X POST http://localhost:3000/promotions/<promoId>/cancel
   ```

   `NEW-ACC-1` must return to `effectivePrice` 40.

## Architecture

- Modular monolith: `src/modules/products`, `src/modules/promotions`,
  `src/ingest`, `src/shared`.
- Denormalized `effectivePrice` on the product row. Reads never join promotions.
- Redis cache-aside with a generation counter (`src/cache/index.ts`).
- Ingestion: chunked fan-out through a message queue (`src/ingest/orchestrator.ts`).
  The production variant uses S3 + SQS + Lambda
  (`lambdas/orchestrator.ts`, `lambdas/pricing-worker.ts`).
- The pricing engine is a small pipeline of rules (`src/shared/pricing`).
  It computes prices in integer cents to avoid floating-point rounding errors.

See `ADR.md` for the full architecture decisions and trade-offs.

## AWS deployment (SAM)

`template.yaml` describes the serverless ingestion path:

- An S3 bucket receives vendor files.
- An orchestrator Lambda streams and chunks the file, then enqueues the chunks.
- An SQS queue feeds a worker Lambda that upserts the chunks.

Build the Lambda bundles:

```bash
npm run lambda:build
```

Prisma on Lambda needs the query engine. Add the engine binaries to the bundle
(or use a Prisma Lambda layer) before production deployment.

## Configuration

See `.env.example`. The important variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://modaco:modaco@localhost:5432/modaco` | Postgres connection |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `CACHE_DRIVER` | `redis` | `redis` or `memory` |
| `STORAGE_DRIVER` | `local` | `local` or `s3` |
| `INGEST_CHUNK_SIZE` | `1000` | Rows per chunk |
| `INGEST_MAX_CONCURRENCY` | `4` | Parallel workers (local pipeline) |

## Project structure

```
src/
  cache/                  Redis cache-aside with generation counter
  config/                 Env validation
  db/                     Prisma client
  ingest/                 Chunker, orchestrator, processor, queue, jobs
  modules/products/       Product API (repository/service/controller)
  modules/promotions/     Promotion API
  services/               Price recompute (bulk updates)
  shared/pricing/         Pricing engine and rules
lambdas/                  Lambda handlers (orchestrator, worker)
prisma/                   Schema and seed
scripts/                  Fixture generator, local ingest runner
tests/                    Unit and integration tests
```
