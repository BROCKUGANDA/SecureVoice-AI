# `DialJob` — what must be added to `prisma/schema.prisma`

**Status: NOT YET APPLIED. Both remaining steps are yours; WP-19 was scoped to
leave `prisma/schema.prisma` untouched and to run no `db push`.**

| # | What | Where | Consequence if skipped |
|---|---|---|---|
| 1 | `DialJob` model block (below) | `prisma/schema.prisma` | `db.dialJob` never exists; the queue keeps working via raw SQL, and CI's **migration drift gate fails** (a migration that creates a table the schema does not declare is drift) |
| 2 | Apply the migration | your database | every `dial_job` read/write fails with `relation "dial_job" does not exist`; `src/lib/scale/queue.ts` rethrows that as a message pointing here |

---

## 1. The exact block to paste

Append at the top level of `prisma/schema.prisma` — order does not matter to
Prisma. It is the Prisma equivalent of
`prisma/migrations/2_dial_job/migration.sql`, column for column and index for
index.

```prisma
/// Durable dial queue (WP-19). One row per (case, dial attempt): enqueued
/// before the call is placed, settled after. This is what makes "we shed load"
/// answerable — every case either has a row that was dialled or a row that was
/// dead-lettered, and a case with neither is a bug this table makes visible.
///
/// Raw SQL note: claiming uses FOR UPDATE SKIP LOCKED, which has no Prisma
/// equivalent, so src/lib/scale/queue.ts talks to this table with $queryRaw
/// (see §4).
model DialJob {
  id             String    @id @default(cuid())
  caseId         String    @map("case_id")
  caseRef        String    @map("case_ref")
  orgId          String?   @map("org_id")
  attemptNo      Int       @default(1) @map("attempt_no")
  retries        Int       @default(0)
  state          String    @default("PENDING")
  priority       Int       @default(0)
  payload        String
  availableAt    DateTime  @default(now()) @map("available_at")
  leaseExpiresAt DateTime? @map("lease_expires_at")
  claimedBy      String?   @map("claimed_by")
  lastError      String?   @map("last_error")
  completedAt    DateTime? @map("completed_at")
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")

  @@unique([caseId, attemptNo], map: "dial_job_case_id_attempt_no_key")
  @@index([state, availableAt, priority], map: "dial_job_state_available_at_priority_idx")
  @@index([state, leaseExpiresAt], map: "dial_job_state_lease_expires_at_idx")
  @@index([caseId], map: "dial_job_case_id_idx")
  @@index([state, createdAt], map: "dial_job_state_created_at_idx")
  @@map("dial_job")
}
```

Two things in that block are load-bearing and easy to get wrong:

- **Every camelCase field needs its `@map`.** The migration created `snake_case`
  columns. Without `@map`, Prisma generates `caseId`, `availableAt`, … and the
  drift gate fails with a wall of renames.
- **The primary key is the `@id` field attribute, not a table-level `@@id`.**
  Prisma has no table-level `@@id`, and a `@default(cuid())` field cannot carry a
  constraint name. The migration's `dial_job_pkey` is created by the SQL, which
  is how every other table in this repo does it too.

### Verify after pasting

```bash
bunx prisma generate          # must succeed
bunx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script
# must print NOTHING — that empty output is the CI "Migration drift gate" step
```

---

## 2. Applying the migration

```bash
bunx prisma migrate deploy                                  # dev / staging / prod
psql "$DATABASE_URL" -f prisma/migrations/2_dial_job/migration.sql   # scratch DB
```

The migration is written **without** `IF NOT EXISTS`, matching `2_outbox` and
`3_postcall` in this repo, so it fails loudly on a database where the table
already exists rather than pretending to succeed. One situation needs care:

> `tests/load/load.test.ts` creates `dial_job` itself when the table is missing —
> it applies this same migration file, guarded by a `to_regclass` check — so the
> gate is runnable with no manual step. If you then run `prisma migrate deploy`
> against **that same** database it will fail with "relation already exists".
> Record the migration as applied instead of re-running it:
>
> ```bash
> bunx prisma migrate resolve --applied 2_dial_job
> ```

Set `DIAL_JOB_SKIP_BOOTSTRAP=1` to make the load gate refuse to create the table,
if you would rather it only ever ran against a properly migrated database.

---

## 3. Why the shape is what it is

**No foreign key to `Case`.** An FK would cascade a customer's dial job away the
moment the case row was purged — PDPL erasure, an operator purge, a retention
sweep — and that row is the proof we tried to reach them. Referential integrity
is enforced by the worker instead: a job whose case cannot be resolved is
dead-lettered with reason `case_missing`, never silently dropped. A constraint
that can delete the evidence is not one this table can afford.

**`attempt_no` and `retries` are two different counters, on purpose.**
`attempt_no` is the job's identity and is unique per case — that uniqueness is
what makes enqueue idempotent (`ON CONFLICT ("case_id","attempt_no") DO
NOTHING`). `retries` is how many times *this row* has failed, and it is what the
bounded-attempts ladder walks. Collapsing them would mean a retry changed the
row's unique key, and a retried signal could then insert a second row for the
same case: the exact double-dial the unique index exists to prevent.

**`DEAD` is a state, not a table.** The existing `DeadLetter` model is keyed to
`OutboxEvent.id` and exists to replay a bank *webhook delivery*. Replaying a dial
job means "try to reach this customer again", which is `replayDeadDialJob`:
reset to `PENDING`, retry ladder untouched. A second table would have meant a
second lifecycle to keep consistent. If a bank later wants dead-lettered dials in
one operator queue, a view over `state = 'DEAD'` is the change — far smaller than
a second write path.

---

## 4. Why the module uses raw SQL at all

`src/lib/scale/queue.ts` was written against a table that is not in the Prisma
schema, so every statement is raw SQL with quoted, explicitly named columns.
That is a temporary state, not a house style, and you should be able to overturn
the reasons:

1. **`FOR UPDATE SKIP LOCKED` has no Prisma equivalent.** The claim pattern needs
   `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n) RETURNING …`.
   That stays `$queryRaw` after the model lands. Only the non-claiming reads
   (`queueDepth`, `dialJobById`) could move to the model layer.
2. **The load gate asserts the columns.** `tests/load/load.test.ts` compares the
   table's real columns against the module's `COLUMNS` list and fails on any
   divergence, so a migration that does not match the code fails the gate rather
   than production. **Delete that assertion once the typed model is in place** —
   it exists only because the schema is behind the code.

Nothing else in the repo reads `dial_job`. The only importer of
`src/lib/scale/queue.ts` is `src/lib/scale/admission.ts`, for the `queue_depth`
metric.