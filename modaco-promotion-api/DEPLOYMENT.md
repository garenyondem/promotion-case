# Deployment Guide

Deployment and migration guide for the ModaCo Promotion Management API.

Two targets are covered:

- **Local development** on a laptop (Docker Desktop + Node.js).
- **Production** as a Docker stack (recommended) or bare Node.js on a Linux VM,
  with the optional AWS SAM serverless ingestion stack.

The API is a modular monolith (see `ADR.md`, ADR-001). The production build is a
single container running `dist/src/server.js`.

## Prerequisites

- Node.js 24 (LTS).
- Docker Desktop with the Compose plugin.
- For production on a VM: a Linux host with Docker and Compose, or a plain
  Node.js 24 runtime.
- Postgres 16 and Redis 7. The Compose files provide both.

## Project layout notes

- The TypeScript build emits under `dist/src` (tsconfig `rootDir` is `.`). The
  container and `npm start` run `node dist/src/server.js`.
- The repo root (one level up) contains a stray trimmed `package.json` /
  `node_modules`. Ignore it. Run every command from `modaco-promotion-api/`.
- Database schema: `prisma/schema.prisma`. Migrations live in
  `prisma/migrations/`.

---

## 1. Local development deployment

Run every command from `modaco-promotion-api/`.

### 1.1 One-time setup

```bash
npm install
docker compose up -d          # Postgres 16, Redis 7, MinIO
cp .env.example .env
npm run prisma:generate
npm run prisma:migrate -- --name init
npm run db:seed
```

- `prisma:migrate` runs `prisma migrate dev`. On a fresh database it creates the
  schema from `prisma/migrations/`. On a database that was previously created with
  `db:push`, Prisma reports drift and offers to reset; instead, adopt the baseline
  without data loss (see section 2.3).
- `db:seed` loads the sample data. It is optional.

### 1.2 Start the API

```bash
npm run dev                   # tsx watch, http://localhost:3000
```

### 1.3 Verify

```bash
curl http://localhost:3000/health
npm test                      # 48 tests, needs Docker Postgres + generated client
npm run lint
npm run format
npm run build                 # tsc typecheck, emits dist/src
```

---

## 2. Prisma migrations

Migrations are the source of truth for the production schema. `db:push` is kept
for throwaway environments only; do not use it to change production.

### 2.1 Development (interactive)

Add or edit models in `prisma/schema.prisma`, then create a migration:

```bash
npm run prisma:migrate -- --name describe_change
```

`prisma migrate dev` generates the migration SQL, applies it locally, and
regenerates the client. Commit `prisma/migrations/` along with the schema change.

### 2.2 Production / CI (non-interactive)

```bash
npm run prisma:deploy         # prisma migrate deploy
```

`migrate deploy` applies pending migrations in order and never prompts. Run it
as a step before starting new API instances.

> Never run `prisma migrate dev` or `prisma migrate reset` against a production
> database. Use only `prisma migrate deploy`.

### 2.3 Adopting migrations on an existing database

If the database was created with `db:push` (no migration history), generate the
baseline migration without touching the data, then mark it applied:

```bash
mkdir -p prisma/migrations/$(date +%Y%m%d%H%M%S)_init
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/<timestamp>_init/migration.sql
npx prisma migrate resolve --applied <timestamp>_init
```

Then `npm run prisma:migrate` works as normal for future changes.

### 2.4 Rollback

Migrations are append-only. To roll back a shipped migration:

1. Revert the schema change in `prisma/schema.prisma`.
2. Create a new migration that reverses the previous one:
   `npm run prisma:migrate -- --name revert_<change>`.
3. Deploy it with `npm run prisma:deploy`.

Do not edit or delete an applied migration. The database history and the
`prisma/migrations/` folder must stay in sync.

---

## 3. Production deployment

### 3.1 Option A: Docker stack (recommended)

`Dockerfile` builds the API, `docker-compose.prod.yml` runs Postgres, Redis, a
one-shot migration job, and the API.

The prod Compose project is named `modaco-promotion-api-prod`. It can run
alongside the local dev stack (`modaco-promotion-api`) on the same host. Tear it
down with `docker compose -f docker-compose.prod.yml down -v`.

1. Create the production environment file (never commit it):

   ```bash
   cp .env.example .env.prod
   # edit .env.prod: real credentials, database host = "postgres", redis host = "redis"
   ```

   For the compose network, `DATABASE_URL` must use host `postgres` and
   `REDIS_URL` must use host `redis`:

   ```
   DATABASE_URL=postgresql://modaco:CHANGE_ME@postgres:5432/modaco
   REDIS_URL=redis://redis:6379
   NODE_ENV=production
   CACHE_DRIVER=redis
   STORAGE_DRIVER=s3
   ```

2. Build and start:

   ```bash
   docker compose -f docker-compose.prod.yml build
   docker compose -f docker-compose.prod.yml up -d
   ```

   `up -d` runs the `migrate` service first (`prisma migrate deploy`). The API
   container waits for it to finish successfully before starting.

3. Verify:

   ```bash
   docker compose -f docker-compose.prod.yml ps
   curl http://localhost:3000/health
   docker compose -f docker-compose.prod.yml logs api
   ```

4. Read logs and restart:

   ```bash
   docker compose -f docker-compose.prod.yml logs -f api
   docker compose -f docker-compose.prod.yml restart api
   ```

Notes:

- The image runs as a non-root `node` user. If `STORAGE_DRIVER=local`, mount a
  writable volume for the upload and queue directories (the default is
  `/app/data`), for example
  `- ./data:/app/data` or a named volume.
- `migrate` runs `prisma migrate deploy`. The Prisma CLI is included in the image
  specifically for this job.
- For the serverless ingestion path, the API itself does not need S3; the Lambda
  stack (section 3.3) does the S3 + SQS work.

### 3.2 Option B: bare Node.js on a Linux VM

1. Install Node.js 24 and Postgres 16 / Redis 7 on the host.
2. Copy the repository (excluding `.git`, `node_modules`, `data`) to `/opt/modaco-promotion-api`.
3. Install and build:

   ```bash
   npm ci
   npm run prisma:generate
   npm run build
   ```

4. Configure the environment:

   ```bash
   cp .env.example .env
   # set NODE_ENV=production and the real DATABASE_URL / REDIS_URL
   ```

5. Apply migrations and seed (seeding optional):

   ```bash
   npm run prisma:deploy
   ```

6. Start with the process manager of your choice. Example systemd unit
   `/etc/systemd/system/modaco-api.service`:

   ```ini
   [Unit]
   Description=ModaCo Promotion API
   After=network.target postgresql.service redis.service

   [Service]
   WorkingDirectory=/opt/modaco-promotion-api
   ExecStart=/usr/bin/node dist/src/server.js
   Restart=always
   Environment=NODE_ENV=production

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now modaco-api
   curl http://localhost:3000/health
   ```

### 3.3 Serverless ingestion (AWS SAM)

`template.yaml` describes the S3 + SQS + Lambda ingestion path
(`lambdas/orchestrator.ts`, `lambdas/pricing-worker.ts`).

1. Build the Lambda bundles:

   ```bash
   npm run lambda:build
   ```

2. Deploy with the SAM CLI:

   ```bash
   sam build
   sam deploy --guided
   ```

   Provide the database connection string for the worker Lambda (`DatabaseUrl`
   parameter). The Lambda runtime is `nodejs20.x`.

3. Prisma on Lambda needs the query engine binary. Add the engine binaries to the
   bundle or use a Prisma Lambda layer before production traffic.

4. The worker Lambda must reach the production Postgres. Configure the
   `VpcConfig` in `template.yaml` (`SubnetIds` / `SecurityGroupIds`) when the
   database is in a VPC.

---

## 4. Environment variables

See `.env.example` for defaults. Production overrides:

| Variable | Local default | Production | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | `production` | Runtime mode |
| `PORT` | `3000` | `3000` | HTTP port |
| `DATABASE_URL` | `postgresql://modaco:modaco@localhost:5432/modaco` | real credentials, host `postgres` (compose) | Postgres connection |
| `REDIS_URL` | `redis://localhost:6379` | host `redis` (compose) | Redis connection |
| `CACHE_DRIVER` | `redis` | `redis` | `redis` or `memory` |
| `CACHE_TTL_PRODUCT` | `60` | keep | Product cache TTL (s) |
| `CACHE_TTL_LISTING` | `30` | keep | Listing cache TTL (s) |
| `STORAGE_DRIVER` | `local` | `s3` | `local` or `s3` |
| `UPLOAD_DIR` | `./data/uploads` | volume mount if local | Local upload path |
| `QUEUE_DIR` | `./data/queue` | volume mount if local | Local queue path |
| `INGEST_CHUNK_SIZE` | `1000` | `1000` | Rows per chunk |
| `INGEST_MAX_CONCURRENCY` | `4` | tune to instance size | Local pipeline workers |
| `AWS_REGION` | `us-east-1` | your region | AWS region |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | empty | IAM credentials | S3 access (if applicable) |
| `INGEST_BUCKET` | `modaco-vendor-files` | bucket name | S3 vendor bucket |
| `INGEST_QUEUE_URL` | empty | SQS queue URL | SQS ingestion queue |

Secrets (database password, AWS keys) must come from a secrets manager or a
private env file. Never commit `.env*` files.

---

## 5. Rollout and verification checklist

1. Run `npm run prisma:deploy` (or the compose `migrate` job) before starting new
   instances.
2. Smoke test `/health`.
3. Exercise the core flows from `README.md` (Scenario A and Scenario B).
4. Check logs for `api listening` and for cache / database connection errors.
5. After a schema change, regenerate the Prisma client and re-deploy the whole
   stack; the client and the database schema must be in sync.
