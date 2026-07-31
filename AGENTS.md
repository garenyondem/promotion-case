# AGENTS.md

## Layout

- All code lives in `modaco-promotion-api/` (Express 4 + TypeScript + Prisma 6 + Postgres 16 + Redis 7). Run every command from that directory.
- The repo root `package.json` / `package-lock.json` / `node_modules/` are a stray trimmed copy — ignore them, never `npm install` at the root.
- `modaco-promotion-api/opencode.json` is gitignored (local-only MCP/permission config). It references `AGENTS.md` and `DEPLOYMENT.md`; `DEPLOYMENT.md` does not exist.
- `README.md` (setup + scenarios), `ADR.md` (architecture decisions ADR-001..006), `AI_APPENDIX.md` (Form 5) are the canonical docs.

## Setup

```
npm install
docker compose up -d          # Postgres 16, Redis 7, MinIO
cp .env.example .env
npm run prisma:generate       # required before app AND tests
npm run db:push
npm run db:seed
npm run dev                   # tsx watch, http://localhost:3000
```

`.env` is gitignored. `DATABASE_URL` is required; `CACHE_DRIVER`=`redis`|`memory`, `STORAGE_DRIVER`=`local`|`s3`.

## Verify

- `npm test` — vitest, needs Docker Postgres up and Prisma client generated.
- `npm run lint` then `npm run format` (prettier `--check`).
- `npm run build` (tsc) is the typecheck (no separate typecheck script). `npm start` runs `dist/src/server.js` — build emits under `dist/src` because tsconfig `rootDir` is `.`.

## Test quirks

- Integration tests (16) use a **separate** `modaco_test` database, not `modaco`. Override with `TEST_DATABASE_URL`. `tests/setup.ts` forces `CACHE_DRIVER=memory` and runs `prisma db push --accept-data-loss` (destructive, test DB only) on every run.
- vitest config: `fileParallelism: false`, 60s test timeout. Pricing engine has 10 unit tests.
- The suite only runs against the local Postgres — it is not hermetic.

## Money and pricing (do not "simplify")

- Prices are computed in **integer cents** (`src/shared/pricing/rules.ts`). JS float math diverges from Postgres decimal rounding by a cent (e.g. 272.65 at 50% → 136.32 vs 136.33). `tests/unit/pricing-engine.test.ts` covers this; keep it.
- Precedence (ADR-006): a PRODUCT-scope promotion beats a CATEGORY-scope one.
- `effectivePrice` is denormalized onto `products`; reads never join promotions. Promotion create/cancel/assign triggers a bulk recompute (`src/services/recompute.service.ts`) using raw SQL with explicit casts `$n::uuid`, `$n::numeric` (columns are UUID/Decimal).

## Ingest quirks

- Local queue (`src/ingest/queue.ts`) claims messages with a lock file created via `wx` flag. Rename-based claiming is NOT exclusive on Windows — do not "fix" this.
- Upsert is `INSERT ... ON CONFLICT ("sku") DO UPDATE`, idempotent. CSV header: `sku,name,category,basePrice,stockQuantity`.
- Local pipeline: `npm run fixture` writes `data/fixtures/products.csv` (500k rows); `npm run ingest -- --file data/fixtures/products.csv` runs it without the HTTP API.
