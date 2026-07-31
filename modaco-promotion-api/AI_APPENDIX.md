# AI Appendix (Form 5) - ModaCo Promotion Management API

> Draft for review. This document fills the Form 5 "AI Appendix" structure.
> The team member names the tools and the model. Review the text and adjust
> the numbers in the Reflection section before submission.

## 1. Tool manifest

The table lists the AI tools and the supporting tools.

| Tool | Type | Model / version | Purpose | Effectiveness |
| --- | --- | --- | --- | --- |
| opencode | Coding assistant (CLI) | deepseek-v4-flash-free | Wrote the code, ran commands, ran tests, made the architecture decisions | High. Wrote the full working implementation and proof runs |
| skills.sh - software-architecture-design | Skill (prompt package) | n/a | Gave the ADR template, the scenario-building workflow, and the build-then-debug loop | High. Kept the work structured and defensible |
| Prisma CLI | Database tool | 6.19.3 | Schema-as-code, db push, client generation | High |
| vitest | Test runner | 3.x | Unit and integration tests | High. Caught a money-rounding bug (see Section 3) |
| Docker Compose | Local infrastructure | Postgres 16, Redis 7, MinIO | Postgres, Redis, and S3-compatible object store | High |
| psql / curl | Verification tools | n/a | Direct SQL checks and API calls | High. Proved 500K ingest and 100K recompute |

## 2. My approach to using the AI tool

### 2.1 Phase 1: Learn the method first

I loaded the software-architecture-design skill before writing code. The skill
gave a workflow: plan first, record decisions, build one scenario, debug it,
then build the second scenario.

I used the AI tool as a "steering partner", not as an autopilot. I stated the
constraints, the scale numbers, and the required proof at the start of the
conversation. I asked for an architecture plan and options before any code.

### 2.2 Phase 2: Decide with the AI, not by the AI

I made the key decisions with the AI, then I approved them:

- PostgreSQL + Prisma instead of a NoSQL store.
- Denormalized `effectivePrice` instead of read-time joins.
- Redis cache-aside with a generation counter.
- S3 + SQS + Lambda fan-out for ingestion.
- Product promotion wins over category promotion.

I gave each decision a reason. The ADR file (ADR-001 to ADR-006) records these
reasons.

### 2.3 Phase 3: Two critical prompts

The two most critical prompts were:

**Prompt 1 - the architecture plan.**

"Design the full architecture for the ModaCo case study. The API is an internal
Express/TypeScript REST API. Scenario A: ingest a 500K-row vendor CSV without
loss, apply active promotions. Scenario B: apply a 50% flash sale to 100K products
in one category from 500K rows without blocking reads. Give me options and
trade-offs for the database, the caching, and the ingestion path. Do not write
code yet."

This prompt produced the options list. It led to ADR-001 to ADR-006.

**Prompt 2 - the flash-sale optimization.**

"The flash-sale recompute over 100K products takes 77 seconds. That is too slow.
Find the bottleneck in the recompute path and propose a change that keeps
correctness and stays below 10 seconds. Show the SQL you would use."

This prompt led to the bulk `UPDATE ... FROM (VALUES ...)` statement. The
recompute dropped from about 77 seconds to about 9.1 seconds.

### 2.4 Phase 4: Prove with numbers

I did not stop at "the tests pass". I ran the real scenarios:

- Ingested a 500,000-row file and checked `count(*)` and distinct `sku`.
- Re-ran the same file to prove idempotency.
- Created a flash sale over 100,000 products and counted the discounted rows.
- Cancelled the sale and counted the restored rows.
- Measured cached read time (about 2.5 ms) and cold read time (about 51 ms).

## 3. The biggest mistake the AI made, and how I fixed it

The AI first proposed a read-time pricing design. It computed the effective price
by joining the `products` table to the `promotions` table on every read. It also
proposed a one-shot ingestion: read the whole file into memory and write all rows
in one function.

Both designs fail the constraints:

- A read-time join over 100,000 promoted products would create a database hotspot
  during a flash sale. The sort and filter would repeat on every request.
- A one-shot ingestion of 500,000 rows would exhaust memory and time out the
  request.

I corrected the design:

- The system stores `effectivePrice` on the product row. It recomputes at write
  time with a bulk statement.
- The system ingests in chunks of 1,000 rows through a message queue. The memory
  use is bounded and the process resumes on retry.

A second mistake appeared during verification, and the tests caught it. The AI
computed prices with JavaScript floating-point math. For 4,041 of 100,000 products,
the JavaScript rounding differed from PostgreSQL decimal rounding by one cent
(for example, 272.65 at 50% gave 136.32 instead of 136.33). I fixed the engine to
compute in integer cents. The unit test suite now covers this exact case. After
the fix, all 100,001 products matched the decimal expectation.

A third issue was a Windows-specific race in the local queue. The AI used a
rename-based claim. On Windows a rename is not exclusive. I switched the claim to
a lock file created with the `wx` flag. A smoke test proved the fix.

## 4. Overall reflection

### 4.1 What I would do differently

- I would capture the measured numbers in a single run script earlier. The ADR
  would then quote one reproducible result.
- I would add a golden-file test for the CSV parse path. It would catch encoding
  edge cases.

### 4.2 The ratio of my input to the AI input

The AI wrote most of the code. It produced about 70% of the solution. My input
was about 30%.

My 30% mattered most in these areas:

- The architecture decisions (denormalized price, fan-out ingestion).
- The verification and the fixes for the mistakes in Section 3.
- The performance targets and the acceptance criteria.

The AI is a force multiplier. It is not a replacement for judgment. The biggest
value of the AI was speed: a complete, tested implementation plus a 500K-row proof
in a short time. The biggest risk of the AI was silent bugs in edge cases (money
rounding, Windows file semantics). The tests and the end-to-end proofs caught them.
