# ADR: ModaCo Promotion Management API

| Field | Value |
| --- | --- |
| Document title | Architecture Decision Record |
| Applies to | ModaCo Promotion Management API |
| Document number | MODACO-ADR-000 |
| Revision | 1.0 |
| Status | Accepted |
| Language | ASD-STE100 Simplified Technical English |

## 1. Purpose

This document explains the architecture of the ModaCo Promotion Management API.

It records the important architecture decisions. It defends each decision with technical
and business reasons. It states the trade-offs.

The document has two main audiences:

- The ModaCo engineering team.
- The external reviewer.

## 2. Context

### 2.1 The problem

ModaCo is a fashion retailer. ModaCo needs an internal API to manage its product catalog
and its promotions.

The API must do two tasks at scale.

### 2.2 Scenario A: vendor file ingestion

- The vendor sends a CSV file.
- The file has about 500,000 product rows.
- The API must import all rows without loss.
- The API must apply active promotions to new products.
- The upload must complete in a reasonable time.

### 2.3 Scenario B: flash sale on a large category

- The marketing team starts a flash sale.
- The flash sale gives 50% discount to all products in one category.
- The category has about 100,000 products.
- The catalog has up to 500,000 products total.
- Every product in the catalog must show the correct price to the shopper.
- The price update must not block the catalog reads.
- The shopper must see the new price immediately after the sale starts.
- The API must keep the new price during the sale.
- The API must restore the original price when the sale ends.

### 2.4 Constraints

- The API is internal. It does not serve the public internet.
- The team can use AWS.
- The API must run in a container (Docker) for local development.
- The solution must run on a standard laptop during review.

## 3. The measured results

These numbers come from local runs on a Windows 11 laptop.

| Scenario | Task | Result |
| --- | --- | --- |
| A | Ingest 500,000 rows | About 17.2 seconds |
| A | Duplicate re-run of the same file | Idempotent, no duplicate rows |
| A | Row coverage | 500,000 of 500,000, 0 skipped |
| B | Apply 50% flash sale to 100,000 products | About 9.1 seconds |
| B | Read product list (Redis cache hit) | About 2.5 milliseconds |
| B | Read product list (cold, indexed query) | About 51 milliseconds |
| B | New product price during sale | Correct immediately |

## 4. Architecture decisions

### 4.1 ADR-001: Use a modular monolith, not microservices

**Context**

The API has three bounded parts: products, promotions, and ingestion. A microservice
split would isolate these parts. It would also add network, deployment, and operation
cost.

**Options considered**

1. Microservices (one service per part).
2. One modular monolith (one deployable, clean module boundaries).
3. One simple application (no module boundaries).

**Decision**

Use a modular monolith. The modules are:

- `modules/products` for the product API.
- `modules/promotions` for the promotion API.
- `ingest` for the ingestion pipeline.
- `shared` for the pricing engine and common utilities.

**Consequences**

- The deployment is one container. It is simple to run and to review.
- The module boundaries keep the code testable.
- A future split is possible. The boundaries already exist.
- The team must keep the module boundaries. This is a discipline rule.

### 4.2 ADR-002: Use PostgreSQL and Prisma

**Context**

The catalog needs strong consistency. It needs transactions for price recompute.
The team prefers TypeScript.

**Options considered**

1. PostgreSQL with a raw SQL driver.
2. PostgreSQL with Prisma ORM.
3. MongoDB (document store).
4. DynamoDB (AWS key-value store).

**Decision**

Use PostgreSQL 16 and Prisma ORM.

**Reasons**

- PostgreSQL gives ACID transactions. The recompute needs them.
- PostgreSQL has a mature index engine. It supports the composite index
  `(category, effectivePrice)`.
- Prisma gives typed queries and schema-as-code.
- Prisma maps cleanly to the relational model.
- DynamoDB cannot do a transactional bulk update over 100,000 rows by a filter.
- MongoDB cannot do the same. It also lacks the needed composite index semantics.

**Consequences**

- The team writes raw SQL for the two hot paths. These are the bulk upsert and the
  bulk recompute. Prisma generates the other queries.
- Raw SQL needs explicit type casts in Prisma. For example, `$1::uuid` and
  `$5::numeric`. This is because the columns are `UUID` and `Decimal`.
- The Prisma model names must map to the table names. The code uses `@@map` for this.

### 4.3 ADR-003: Store the effective price on the product row

**Context**

The shopper reads the price on every request. The price depends on the active
promotions. A flash sale changes the price of 100,000 rows at one moment.

The naive design computes the price at read time. It joins the product to the
promotion table on every read. Under a flash sale, this join must filter and sort
over 100,000 promoted rows on every request. It can cause a database hotspot.

**Options considered**

1. Compute the price at read time (join promotions).
2. Store a denormalized `effectivePrice` on the product row.
3. Store the price in a cache only.

**Decision**

Store a denormalized `effectivePrice` column on the `products` table.

**Reasons**

- The reads stay fast. They do not join the promotion table.
- The index `(category, effectivePrice)` gives a fast sorted listing.
- The recompute happens at write time, not at read time.
- The recompute is a single bulk statement. It runs in about 9 seconds for
  100,000 products.
- A cache-only design cannot answer "list all products sorted by price" without
  a full scan.

**Consequences**

- The write path is more complex. It must recompute prices on promotion change.
- The read path is simple and fast.
- The price value is duplicated (base price and effective price). The system must
  keep them consistent. The recompute service owns this.

### 4.4 ADR-004: Use Redis cache-aside with a generation counter

**Context**

The read path must handle high traffic during a flash sale. The database must not
become a hotspot.

**Options considered**

1. No cache.
2. Redis cache-aside with key-per-product and key-per-listing.
3. Redis with distributed invalidation messages.

**Decision**

Use Redis cache-aside. The `CacheService` in `src/cache/index.ts` implements it.

**How it works**

- The service keeps a global `cache:generation` counter.
- A read sets its cache key with the current generation.
- A write (promotion create, cancel, or assign) does three things:
  1. It bumps the generation counter.
  2. It recomputes the affected products.
  3. It deletes the affected product keys.
- A read checks the generation before it uses a cached value. If the generation
  changed, the read treats the value as stale and reloads it.

**Reasons**

- The listing key would be huge to invalidate (many pages, many filters).
- The generation counter invalidates all old entries with one counter bump.
- The pattern is simple and is easy to prove correct.
- The cache has a short TTL (60 seconds for products, 30 seconds for listings).
  The TTL is a safety net.

**Consequences**

- One write can invalidate many cache keys. This is the wanted behavior.
- The first read after a write is slower. It reloads from the database.
- The system tolerates a small stale window if the process fails between the
  counter bump and the recompute. The TTL bounds this window.

### 4.5 ADR-005: Use S3 and SQS for the serverless ingestion pipeline

**Context**

Scenario A needs a durable, scalable ingestion path for files of about 500,000 rows.
The process must resume or retry without losing rows.

**Options considered**

1. One synchronous function that reads the file into memory and writes all rows.
2. A chunked pipeline in the API process only.
3. S3 object store plus SQS queue plus Lambda workers.

**Decision**

Use the S3 + SQS + Lambda fan-out for production (Scenario A).

**How it works**

1. The vendor uploads the file. An S3 bucket receives it.
2. The S3 event triggers the orchestrator Lambda.
3. The orchestrator streams the file. It splits it into chunks.
4. The orchestrator sends each chunk to an SQS queue.
5. The SQS queue triggers the pricing worker Lambda.
6. The worker upserts the chunk with an idempotent `ON CONFLICT` statement.
7. The worker applies the active promotions to each new product.

**Why this design meets the constraint**

- The orchestrator never holds the whole file in memory. It streams chunks of
  1,000 rows. The memory use is bounded.
- SQS gives at-least-once delivery. The upsert is idempotent. A duplicate message
  does not create a duplicate row.
- SQS scales the workers. The queue size controls the concurrency.
- Lambda runs the workers without a server to manage.
- The same chunker, processor, and queue interface run locally. The local pipeline
  proves the logic on a laptop.

**The local variant**

The API runs the same pipeline locally for development and review. It uses:

- `src/ingest/orchestrator.ts` for the pipeline.
- `src/ingest/queue.ts` for the message queue.
- `scripts/local-ingest.ts` to run it.

The local queue uses a lock file (`wx` flag) to claim a message. This works on
Windows. A rename-based claim is not exclusive on Windows.

**Consequences**

- The design adds components (S3, SQS, Lambda). They need configuration.
- The local variant needs a `Storage` interface. It swaps S3 for the local disk.
- The API routes are the same for both. The `STORAGE_DRIVER` env value selects
  the driver.

### 4.6 ADR-006: Promotion precedence rule

**Context**

A product can have a promotion for itself and a promotion for its category at the
same time. The system must decide the price. The case study does not define the rule.

**Options considered**

1. The product promotion wins over the category promotion.
2. The category promotion wins over the product promotion.
3. The two promotions combine (stack).

**Decision**

Use option 1. The product-specific promotion wins. Both promotions can exist at the
same time. The engine applies the product promotion only.

**Reasons**

- It is predictable for the merchant.
- It avoids surprise discounts. A category sale never overrides an explicit
  product deal.
- It is easy to test and to explain.
- The case study did not define a rule. The team chose the safe default.

**Consequences**

- The pricing engine has two scopes. The resolver picks the product scope when it
  exists. See `src/shared/pricing/pricing-engine.ts`.
- A merchant who wants the category price must cancel the product promotion first.
- The precedence rule is a business rule. It lives in one place (the engine).
  It is covered by unit tests.

## 5. Scenario A: design defense

### 5.1 How the design meets the constraints

**Constraint: ingest about 500,000 rows without loss.**

The orchestrator streams the CSV and counts every row. The workers upsert every row.
The job table records `totalRecords` and `processedRecords`. The job status is
`COMPLETED` only when the processed count equals the total count.

**Constraint: apply promotions to new products.**

The worker computes the effective price with the shared pricing engine. The engine
applies the active promotion rules. A new product in a promoted category gets the
discounted price at ingest time.

**Constraint: reasonable time.**

The local run ingested 500,000 rows in about 17.2 seconds. It used 4 concurrent
workers and a chunk size of 1,000 rows. The time scales with the worker count.

**Constraint: duplicate or retry safety.**

The bulk upsert uses `INSERT ... ON CONFLICT ("sku") DO UPDATE`. A duplicate message
updates the existing row. It does not create a duplicate. A re-run of the same file
is idempotent.

### 5.2 Trade-offs

- The pipeline prefers throughput over per-row logging. The job table stores
  counts, not per-row detail.
- The file must be a flat CSV. This is the vendor format. No schema mapping is
  needed.
- A malformed row is counted as skipped and reported. The pipeline does not stop
  for one bad row.

## 6. Scenario B: design defense

### 6.1 How the design meets the constraints

**Constraint: every product shows the correct price.**

The `effectivePrice` column is the single source of truth for reads. The read path
does not compute or join. It selects the stored value.

**Constraint: price update must not block catalog reads.**

The recompute is one bulk `UPDATE ... FROM (VALUES ...)` statement. It runs in about
9.1 seconds for 100,000 products. During the recompute, reads use the previous
values. The API does not lock the read path for the duration of the update.

The cursor-paginated batching keeps the write transaction bounded. Each batch is
2,000 rows.

**Constraint: the shopper sees the new price immediately.**

The promotion create triggers the recompute. After the request returns, every row
has the new effective price. A new product created during the sale gets the
discounted price at creation time. The code proves this end-to-end.

**Constraint: restore the price when the sale ends.**

The promotion cancel triggers the reverse recompute. The engine resets the
effective price to the base price (or to the next active promotion). The code proves
this end-to-end.

**Constraint: reads stay fast under load.**

The Redis generation counter makes the cache correct and simple. The measured read
time is about 2.5 milliseconds on a cache hit.

### 6.2 Trade-offs

- The write path pays the recompute cost. The read path does not. This is the
  correct trade for a read-heavy catalog.
- The `effectivePrice` is denormalized. A bug in the recompute could show wrong
  prices. The tests and the TTL-bound cache reduce this risk.
- The recompute uses server time and promotion time windows. The timezone is
  UTC by convention.

## 7. Known limits and future work

- The Lambda build script produces a bundle. The bundle is not yet deployed.
  The SAM template `template.yaml` describes the deployment.
- The ingestion runs on one database in production. A larger scale would need
  horizontal read replicas. The read path supports this because reads use
  `effectivePrice` only.
- The API has no auth layer. It is internal. Add an API key or IAM auth before
  public exposure.
- The cache is a single Redis instance. It can be a cluster in production.
- The recompute runs in the API process. It can move to a background worker for
  very large categories.

## 8. Related documents

- `README.md` for setup and run instructions.
- `AI_APPENDIX.md` for the AI tool usage appendix (Form 5).
- `prisma/schema.prisma` for the database schema.
