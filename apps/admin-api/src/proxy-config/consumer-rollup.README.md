# Consumer rollup storage and reads

This implements storage/backfill and bounded count/latency/path readers for
implementation.md section 4.5. The public usage API keeps exact interpolated
statistics and path groups for windows of at most 100,000 retained raw records.
Larger windows automatically use consumer rollups with global method/path groups.
Broader workload/cardinality/replica acceptance remains required.

Admin migration/provisioning installs tenant-owned count and path rollup tables,
independent state rows and indexed nullable markers on request_logs, with
statement-level ingestion hooks. The authenticated reader and dashboard expose
path groups with independent materialization coverage.
The collector creates no schema and continues its existing bounded INSERT with
ON CONFLICT (id) DO NOTHING. The AFTER INSERT transition table contains only new
records. Marking those records and updating grouped counts commit together. A
failed aggregate write rolls back the source insert, so it cannot be acknowledged
as complete. Replayed IDs preserve their receipt and cannot increment counts.

Each cell identifies a consumer, UTC request minute and UTC receipt minute. Receipt
is database-owned; request time can arrive late. Store request/error/sample counts,
first/last receipts and a fixed 33-bin latency histogram. Missing or negative
durations are not histogram samples. Stored cells contain no paths, request IDs,
service names, IPs, agents, trace IDs or credentials. An arrival at least 15 seconds
after the end of its request minute increments the late-record counter. This
counts persisted late observations, not missing traffic.

Histograms use version 1 upper bounds: zero, powers of two through 2^30 and the
maximum PostgreSQL INTEGER. Merge integer counts and compute nearest ranks with
BigInt. Estimates must be labelled as bucket upper bounds; they cannot be presented
as the current API's exact interpolated observed percentiles. Bounds or minute
semantics require a deliberate version migration.

The 250,000-cell tenant cap applies under the canonical receipt lock. Existing cells
can continue merging; new cells beyond capacity leave source rows unmarked for
backfill. No log is discarded because the aggregate table is full. Operator bulk
imports materialize at most 1,000 inserted records synchronously and leave the
remainder pending. Imports with naive timestamps or missing receipt/policy schema
remain pending until the admin's UTC and receipt migrations run.

The background worker owns one non-overlapping sweep with at most eight tenant
transactions, 500 source records and 500 expired cells per store per transaction. Fair tenant
selection uses a persisted checked time and SKIP LOCKED. Every transaction has
three-second statements and one-second lock waits; retain the receipt lock through
commit. Competing replicas, ingestion, privacy and retention therefore cannot
double-materialize a row. Retry failures and capacity pressure after a minute;
reconstruction reads existing markers and counts. Shutdown clears discovery and
awaits actual admitted work.
Bulk imports and capacity-limited inserts commit a durable wake-up whenever new
source records remain unmarked. public.consumer_rollup_backlog holds at most one
UUID per tenant and cascades on tenant removal. It stores no source IDs or payloads.
Discovery reads that notification without locking it before the receipt fence;
after materialization, acknowledgement and the public pending flag commit together
under that fence. This wakes a recently idle tenant immediately without reversing
the public-row/receipt lock order. Actual failures retain their cooldown; capacity
pressure returns to the existing idle retry rather than a hot discovery loop.
Admin startup recovers notifications from indexed pending markers. Pre-startup
provisioning tolerates missing public discovery DDL. A failed notification write
rolls back source ingestion and both aggregates.
Discovery first skips locked tenants. If every eligible tenant is busy, it waits
under the same one-second lock budget and PostgreSQL rechecks eligibility after
acquisition. Brief locks from other periodic work cannot silently discard the
whole sweep; healthy free tenants and replica receipt/marker fencing retain priority.
A PostgreSQL lock-timeout (55P03) retains pending discovery and delays that tenant
for two seconds. Actual materialization failures retain the one-minute cooldown.
The persisted checked time fences that short retry across replicas; it may be
up to two seconds in the future. Every transaction keeps its original SQL budgets.
State/cleanup mutations return their rows through a final SELECT: TypeORM's UPDATE
result is a [rows, affected] tuple. Completed tenants must leave pending discovery,
and cleanup must return the actual bounded deletion count before callers decide
whether historical erasure is complete.

Retention deletes cells only when their last receipt expires. The raw-log retention
worker and idle rollup worker both prune bounded pages and update the cell count
atomically. Privacy omission immediately stops consumer materialization. Historical
privacy cleanup erases consumer cells before permitting the omitted attribution to
be retained again. Processed/attributed lifetime counters retain no identity and
are not current retained counts or guaranteed traffic coverage.
Malformed explicit legacy metadata selections fail closed, matching the shared
privacy reader. Valid selections and legacy policies without a selection retain
their existing attribution behavior. Backfill reads only the required scalar fields.

The reader uses the same repeatable snapshot and admission/SQL budgets as the
existing usage service. It sums only whole request and receipt minutes, then
reconciles four disjoint raw sets: unmarked records, the first partial request
minute, the last partial request minute and the partial receipt-floor minute within
whole request minutes. Each branch and the combined raw page are bounded. Separate
request-edge ranges preserve index access. An exact microsecond receipt cutoff is
passed unchanged to PostgreSQL; a mixed cell is never added wholesale, even after
expired raw records have been deleted. Privacy/retention revisions are rechecked
before either raw or rollup responses are published. Consumer omission bypasses
all attribution immediately, before historical cleanup.

Queries admit at most 20,000 cells, 100,000 pending/boundary raw records and 169 UTC
series buckets. Hour/day/week intervals use minute/15-minute/hour buckets. A window
that starts between bucket boundaries includes two partial edges; observedSeconds
and rates use each edge's actual duration. Excess work returns actionable 503
recovery without publishing partial totals. PostgreSQL sums and serializes decimal
integers; JavaScript parses BigInt, checks request/error/sample/late/histogram
coherence and rejects counts beyond safe JSON numeric precision.

Rollup responses expose source, version, exact retained-observation counts,
complete/backfilling/capacity-limited materialization, pending and late counts,
query limits and the histogram upper-bound method. The dashboard labels estimated
percentiles, partial UTC intervals and materialization state. Filtered REST metric
history retains numeric-zero missing latencies and adds consumerUsage metadata,
including sample count, observedSeconds and the same rollup coverage. Gateway
metric reports and unfiltered history retain their established contracts.

Coverage describes available persisted records; it cannot prove gateway traffic
was fully recorded or recover logs deleted before installation. Successful rollup
windows declare paths complete for retained records. Legacy unavailable responses
remain explicit in the dashboard and are never described as recorded zero.

The path storage foundation has its own version-1 marker, state and 250,000-cell
cap, independent of count capacity. Keys include consumer, UTC request/receipt
minutes, method (16 characters) and query-free path prefix (512 characters), with
deterministic C collation. Store only request/error/sample counts, receipts and
the same 33-bin latency histogram. Count and path aggregates share the source
transaction and receipt lock; any failed write rolls back ingestion. Existing
count-only installations backfill the retained source without replaying count
markers. New path keys over capacity leave only their path marker pending while
count materialization continues. The two stores can contain at most 500,000 cells
combined; synchronous materialization admits at most 1,000 source IDs per store.

Policy omission projects fresh paths to `[redacted]` before aggregation. Historical
cleanup deletes at most 500 private path cells, merges their counts/histograms into
redacted groups and changes capacity atomically. It preserves source markers and
counts; the metadata cannot return after cleanup and re-enabling retention.
Consumer omission erases all attributed path groups. Cleanup completion accounts
for raw logs and both stores before permitting omitted fields to be retained again.
Privacy discovery prefers unlocked pending tenants, then waits under the existing
one-second lock budget if all are busy. PostgreSQL rechecks the current cursor and
revision after acquisition. Periodic replicas therefore retain progress through
brief locks without skipping raw rows, increasing page sizes or weakening policy
ownership. An actual two-worker, 600-path regression verifies this behavior.
Receipt retention and idle worker cleanup prune paths with the same irreversible
floor as counts. Both internal markers are excluded from public logs and archives.

The path reader reconciles its own marker and the same four disjoint raw-edge sets
inside the count reader's repeatable snapshot. Its independent limits are 20,000
cells and 100,000 pending/boundary raw records. Exceeding either refuses the entire
usage response; no partial path groups or totals are published. Full grouped
request/error/sample counts and all 33 merged bins must equal the count reader.
The global top ten are selected only after summing every normalized group, with
deterministic C-collated method/path ties; cell-local truncation is forbidden.
Current path privacy is projected before grouping cells and raw records, including
historical data not yet erased. The existing final policy-revision guard remains.
Private histograms are used only for validation and integer percentile calculation.
Public pathAggregation reports all normalized groups, admitted cell/raw/pending
counts, independent complete/backfilling/capacity-limited status and query limits.
Filtered metrics preserve that coverage. The dashboard shows the returned/total
group count, labels histogram upper estimates and retains data on refresh failure.

Real PostgreSQL checks cover replay, rollback, all histogram bounds, UTC upgrade,
bounded bulk imports, 100,001-record legacy backfill, reconstruction/replicas, actual
250,000-cell capacity recovery, lock deadlines, privacy and receipt expiry.
Authenticated PostgreSQL reader checks include 200,001 actual records, mixed
microsecond receipt cells, both request edges, pending/capacity bounds, unsafe
integer refusal, histogram coherence, policy revision races and immediate privacy
suppression. The packaged runtime verifier checks real gateway/collector materialization and
privacy erasure, and excludes the internal marker from log reads and private
archives. Its separate bulk-import fixture exercises 200,001 persisted observations
through production provisioning, real background timers and authenticated REST.
These finite checks do not establish comparative throughput or formal phase acceptance.

Run `NX_DAEMON=false NX_NO_CLOUD=true npm exec -- nx run admin-api:consumer-rollup-smoke`
against the locally built `novagate-admin:verification` image for the isolated
production-timer check. It creates disposable PostgreSQL/Redis resources, preserves
the 150-second materialization deadline, checks authenticated reads and privacy,
then verifies non-root execution and exit-0 shutdown. Evidence is written to
`.local-work/issue99/consumer-rollup-runtime-evidence.json`. The broader
`admin-api:runtime-smoke` target also retains gateway, collector, metrics, alerts,
archives and export-destination checks.

`admin-api:consumer-rollup-replicas-smoke` uses two non-root production admin
containers and real timers against disposable PostgreSQL/Redis. Its finite workload
has 400,001 persisted observations, 19,995 normalized groups and exactly 20,000
path cells. It checks another workspace's progress under a 20-second bound,
concurrent replay, restart while backfill is active, a 180-second materialization
deadline, independent reference counts/histograms/global ranking, simultaneous
admission/recovery, tenant isolation, the 20,001st-cell refusal, shorter-window and
receipt-retention recovery, privacy projection and automatic non-resurrection.
No worker ticks or aggregate/marker writes are manufactured. It preserves a
180-second privacy-cleanup bound and writes consumer-rollup-replicas-evidence.json
under .local-work/issue99 only after both exit-0 shutdowns. Failure diagnostics
retain database state and both stdout/stderr container logs before removing all
owned resources. This is a finite persisted-log check, not a live-traffic or
comparative Kong throughput benchmark.
