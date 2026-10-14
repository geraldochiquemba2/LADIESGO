# LADIESGO — Infra Cost & Scaling Model (Cloudflare + Neon, 2026)

## 0. Executive summary

| Stage | Trips/day | Concurrent drivers | Recommended stack | Est. monthly cost |
|---|---|---|---|---|
| Prototype | < ~500 | < 10 | CF Free + Neon Free | $0 |
| Early prod | ~500–2,000 | 10–40 | **CF Workers Paid $5 + Neon Launch** | **$30–80** |
| Growth (≈ now) | 2,000–10,000 | 40–200 | + DO (hibernation) + Hyperdrive + Queues | **$180–260** |
| Scale | 10,000–50,000 | 200–1,000 | + read replica(s), R2 cold storage, Analytics Engine | **$550–800** |
| National | 50,000–200,000 | 1,000–4,000 | Neon Scale or dedicated PG, partitioning, multi-region | **$1,300–2,500** |

**Key finding:** the "~10k trips/day free ceiling" is **too optimistic by ~5×**. The Workers free tier alone tolerates ~2k trips/day, but Neon's **100 CU-hour/month free compute** and **5 GB/project egress** break below ~1,500 trips/day for a 24/7 service (Neon compute cannot scale to zero when trips are continuous). Plan the first paid dollar at **a few hundred sustained trips/day**, not 10k.

**The single biggest cost lever** is Durable Object duration + GPS fan-out. Done right (Hibernation API + WebSocket 20:1 billing + GPS off Postgres), the whole platform stays **under ~$0.0005/trip** at 50k+ trips/day. Done naively (per-trip DO that never hibernates, GPS pinged every 1–2s into Postgres), DO duration alone can hit **$2,000–8,600/month** at 50k–200k trips/day.

---

## 1. Assumptions

**Traffic shape**
- Trip duration = 15 min; average concurrent *on-trip* drivers = `T × 0.25 h / 24 h`.
- Driver utilization = 50% (online : on-trip = 2:1) → **avg concurrent online drivers `N ≈ 0.02 × T`** (20 / 200 / 1,000 / 4,000 at 1k / 10k / 50k / 200k trips-day).
- Peak concurrency ≈ 3× average (autoscaling absorbs it).

**Request generation**
- GPS ping interval = **4 s** → `900 pings/driver-hour` → **`GPS pings/day = 432 × T`**.
- App/API HTTP requests = **50 per trip** → `Worker requests/day = 50 × T`. (GPS runs over a persistent WebSocket, so pings are WS messages — **not** Worker requests.)
- Trip realtime events (status, ETA, accept/arrive, etc.) = **20 per trip**, as DO RPC sessions.
- **WebSocket incoming-message billing ratio = 20:1**, so billable DO requests = `GPS/20 + trip events`.
- Avg CPU per Worker request = 2 ms; avg DO active processing per message = 4 ms.

**Data**
- Writes to Postgres = ~10 rows/trip; reads = ~30 rows/trip. **GPS is never written to Postgres**.
- Result payload ≈ 0.1 MB/trip over the Neon proxy (egress).
- Storage grows to steady-state: 5 / 30 / 120 / 400 GB at 1k / 10k / 50k / 200k.
- Neon compute avg size: **0.5 / 2 / 6 / 12 CU** (1 CU ≈ 4 GB RAM). Compute runs **24/7 (no scale-to-zero)**.

**Billing constants (2026)**
- Cloudflare billing month = calendar month; Neon billing month = **744 h**.

---

## 2. Pricing reference (verified Oct 2026)

### 2.1 Cloudflare (Workers Paid = **$5/mo** flat)

| Product | Free | Paid (included → overage) |
|---|---|---|
| Workers requests | 100k/day | 10M/mo → **$0.30/M** |
| Workers CPU | 10 ms/invocation | 30M CPU-ms/mo → **$0.02/M ms** |
| Workers egress/bandwidth | free | **free (no egress charge)** |
| Durable Objects — requests | 100k/day | 1M/mo → **$0.15/M** |
| Durable Objects — duration | 13,000 GB-s/day | 400,000 GB-s/mo → **$12.50/M GB-s** |
| DO WS incoming message ratio | — | **20:1** (outgoing = free) |
| DO SQLite storage *(billed since Jan 2026)* | 5 GB total | 25B rows read/mo (→$0.001/M); 50M rows written/mo (→$1/M); 5 GB-mo → **$0.20/GB-mo** |
| Queues | 10k ops/day | 1M ops/mo → **$0.40/M** (3 ops/message) |
| R2 | 10 GB-mo, 1M Class A, 10M Class B | **$0.015/GB-mo**; Class A **$4.50/M**; Class B **$0.36/M**; **egress free** |
| Workers KV | 100k reads/day, 1k writes/day | reads 10M → **$0.50/M**; writes/deletes/lists 1M → **$5/M**; 1 GB → $0.50/GB-mo |
| D1 | 5M rows read/day, 100k written/day | 25B read/mo (→$0.001/M); 50M written/mo (→$1/M); 5 GB → **$0.75/GB-mo** |
| Hyperdrive | 100k queries/day | **unlimited, included** |
| Workers Logs | 200k events/day, 3-day | 20M/mo → $0.60/M (7-day) |
| Analytics Engine | 100k pts/day, 10k reads/day | 10M pts/mo → $0.25/M; 1M reads/mo → $1/M |
| Observability *(from Dec 1 2026)* | 0.5 GB/day, 7-day | 50 GB/cycle → **$0.25/GB ingest**; 10 GB-mo → **$0.10/GB-mo** |

**DO lifecycle rule:** billed for duration while actively running or idle-but-not-hibernation-eligible. Use the **WebSocket Hibernation API**. DO soft limit = 1,000 req/s per object.

### 2.2 Neon (per organization)

| | Free | Launch | Scale |
|---|---|---|---|
| Compute | 100 CU-hrs/project | **$0.106/CU-hr** | **$0.222/CU-hr** |
| Autoscale | ≤2 CU (8 GB) | ≤16 CU (64 GB) | ≤16 CU auto, ≤56 CU fixed |
| Scale-to-zero | forced (5 min) | 5 min, can disable | configurable (1 min → always-on) |
| Storage | 1 GB/project, 20 GB total | **$0.35/GB-mo** | $0.35/GB-mo |
| Egress | 5 GB/project/mo | 500 GB/project → **$0.10/GB** | same |
| Instant restore | 6 h, ≤1 GB | **$0.20/GB-mo** | $0.20/GB-mo |
| Snapshots | 1 | $0.09/GB-mo | $0.09/GB-mo |
| Extra branches | — | $1.50/branch-mo | $1.50/branch-mo |
| Read replicas | ≤3 (Free) | billed as **separate compute/CU-hrs** | same |
| Egress caution | exceeding → **compute suspended** | — | — |

Billing month = **744 h**; CU = 1 CPU + 4 GB RAM + SSD. Read replicas add full CU-hours.

### 2.3 Managed-Postgres alternatives

| Provider | Entry | Mid | Notes / caveats |
|---|---|---|---|
| **Neon Launch/Scale** | usage-based | 6 CU ≈ $473 (Launch) | Best for spiky/autoscaling; read replicas cost extra; Africa not a region |
| **Crunchy Bridge** | Hobby-0 $9; Hobby-2 $35; **Standard-8 $140** | Standard-32 $560 | Storage $0.10/GB; **egress included**; HA doubles price |
| **Supabase Pro** | $25 + compute | Micro $10, Large $110, XL $210 | 8 GB disk incl., 250 GB egress, Realtime/Auth included |
| **Fly Managed Postgres** | Basic $38 | Launch $282 | **Africa egress $0.12/GB (10× US)** — bad for Angola traffic |
| **AWS RDS PG** | db.t4g.micro ≈ $12/mo | db.m6g.large ≈ $99 | No true serverless |
| **AWS Aurora Serverless v2** | **$0.12/ACU-hr** | — | Strong at high spiky load |
| **Turso** | Free 500M reads/10M writes | Developer $4.99 / Scaler $24.92 | SQLite/libSQL — **not** Postgres |

---

## 3. Scaling model (the math)

Per month (30 d):

| Metric | 1k | 10k | 50k | 200k |
|---|---|---|---|---|
| Concurrent online drivers `N=0.02T` | 20 | 200 | 1,000 | 4,000 |
| GPS pings/day `432T` | 432k | 4.32M | 21.6M | 86.4M |
| Worker requests/mo `1500T` | 1.5M | 15M | 75M | 300M |
| DO billable requests/mo `(432/20+20)·30T` | 1.25M | 12.5M | 62.4M | 250M |
| DO GB-s/mo | 6.9k | 69k | 347k | 1.39M |
| Neon CU-hrs/mo | 372 | 1,488 | 4,464 | 8,928 |
| Neon storage (GB) | 5 | 30 | 120 | 400 |
| Neon egress (GB/mo) | 3 | 30 | 150 | 600 |

### 3.1 Monthly cost build-up (Neon **Launch**)

| Line item | 1k | 10k | 50k | 200k |
|---|---|---|---|---|
| Workers subscription | $5.00 | $5.00 | $5.00 | $5.00 |
| Workers requests | $0 | $1.50 | $19.50 | $87.00 |
| Workers CPU | $0 | $0 | $2.40 | $11.40 |
| DO requests | $0.04 | $1.72 | $9.21 | $37.29 |
| DO duration | $0 | $0 | $0 | $12.36 |
| **Neon compute** | $39.43 | $157.73 | $473.18 | $946.37 |
| Neon storage | $1.75 | $10.50 | $42.00 | $140.00 |
| Neon instant restore | $0.40 | $2.00 | $8.00 | $24.00 |
| Neon egress overage | $0 | $0 | $0 | $10.00 |
| R2 / Queues / KV / logs (est.) | ~$1 | ~$2 | ~$5 | ~$40 |
| **TOTAL / month** | **~$48** | **~$180** | **~$565** | **~$1,300** |
| **Cost / 1,000 trips** | $1.60 | $0.60 | $0.38 | $0.22 |

### 3.2 Same workload on Neon **Scale**

| | 1k | 10k | 50k | 200k |
|---|---|---|---|---|
| Neon compute at $0.222/CU-hr | $82.57 | $330.34 | $990.77 | $1,981.5 |
| **TOTAL / month** | **~$91** | **~$355** | **~$1,080** | **~$2,350** |

**+ read replicas:** add **$78.90/replica/mo** (Launch) or **$165/replica/mo** (Scale).

---

## 4. Trigger points — when to move to the next tier

| Trigger | Symptom / metric | Action | New cost |
|---|---|---|---|
| **~1,500 trips/day** | Neon free: 100 CU-hrs exhausted; egress hit → **compute suspended** | Upgrade Neon → **Launch** (cap autoscale 1 CU) | ~$40–80/mo |
| **~1,500–2,000 trips/day** | Workers `Error 1027`; DO 100k req/day | Upgrade Cloudflare → **Workers Paid** | +$5 + usage |
| **~3,000–4,000 trips/day** | DO duration/request grows; Neon >2 CU | Add **Hyperdrive**, enable DO **Hibernation**, batch GPS | flat |
| **~10k trips/day** | Read QPS contends with writes; replica lag | Add **1 read replica**; analytics to AE/R2 | +$79–165 |
| **~20k trips/day** | Neon compute >6 CU; egress near 500 GB | Hyperdrive cache, compress payloads, archive cold trips | flat→+small |
| **~50k trips/day** | Need SLA/HIPAA/private networking | Move Neon → **Scale**; evaluate Crunchy/Aurora | +$500–1,000 |
| **~100k+ trips/day** | Steady high load | Benchmark Crunchy / Aurora / self-managed; partition by city/date | case-by-case |
| **Dec 1 2026** | Workers Logs move to Observability pricing | Enable **sampling** (5–10%) | flat if sampled |

---

## 5. Top cost traps (ranked by blast radius)

1. **Non-hibernating per-trip Durable Objects.** 15 min wall-clock = 115.2 GB-s/trip → **~$2,160/mo** at 50k trips/day; **~$8,640/mo** at 200k — vs **$0–12** with Hibernation.
2. **GPS ping fan-out.** 4 s → 1 s multiplies DO requests 4×.
3. **GPS / location in Postgres.** 86M writes/day at 200k → CU-hours + **egress** blow up.
4. **Polling instead of WebSocket.** 2 s passenger poll = +30 Worker reqs/trip + DB reads + egress.
5. **Neon egress from `SELECT *` / wide JSONB / high-frequency reads.** At 0.1 MB/trip, 200k trips/day exceeds 500 GB/project.
6. **Neon compute that can't scale to zero.** 24/7 billing `CU × 744 h` every month.
7. **Billions of Worker requests.** Route GPS over a **persistent WebSocket directly to the DO** (WS billed /20).
8. **Free-tier cliff.** Cloudflare free **fails hard** (Error 1027); Neon **suspends compute**.
9. **R2 as a write-heavy store.** Class A $4.50/M; use R2 for media/docs.
10. **Queues per-message ops.** 3 ops/message.
11. **Log ingestion after Dec 2026.** Sample 5–10%.
12. **`SELECT *` + `pg_stat_statements` blind spots.** Use `pg_stat_statements` to find offenders.

---

## 6. Cost-optimization playbook (highest ROI first)

1. **DO WebSocket Hibernation API** for all realtime (kills duration billing when idle). Use `setWebSocketAutoResponse()` for heartbeat.
2. **GPS batching + debounce:** buffer 3–5 s of pings, send one digest.
3. **Hysteresis / deadband:** only transmit when moved > ~20–50 m.
4. **Adaptive sampling:** 1–2 s moving, 10–30 s idle.
5. **Keep GPS out of Postgres.** Store live positions in DO memory or KV with short TTL.
6. **Cache ETAs and route geometry** (30–60 s TTL).
7. **Enable Hyperdrive** (free on Paid): pooling + query caching.
8. **Add read replica(s)** for analytics/matching reads once >10k trips/day.
9. **Compress + trim payloads:** CBOR/Protobuf, select only needed columns, paginate.
10. **Cap Neon autoscale max** (e.g., 4–8 CU).
11. **Archive cold trip history** to R2 (Parquet).
12. **Use Analytics Engine** for metrics/dashboards.
13. **Batch async work through Queues.**
14. **Region placement:** Neon in closest available AWS region to Angola (likely EU, e.g. Frankfurt).
15. **Sample logs 5–10%** ahead of the Dec 1 2026 Observability switch.

---

## 7. Cheapest viable path to national scale

**Winning configuration (steady state):**
`Cloudflare Workers Paid ($5) + Durable Objects (SQLite backend, Hibernation API) + Hyperdrive + R2 + Queues + Workers KV` on the edge, with `Neon Launch (autoscaling, capped max CU, no scale-to-zero on prod) + 1–2 read replicas`.

- Keeps the platform at **~$0.0004–0.0006/trip** at 10k–50k trips/day.
- As load becomes steady and high (>50k trips/day), bake-off **Crunchy Bridge Standard-32** and **Aurora Serverless v2**.
- The decisive engineering choice: **GPS and realtime state live in Durable Objects, never in Postgres**, and every realtime socket uses Hibernation.

---

## 8. Sources (verified 2026)

Cloudflare:
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/queues/platform/pricing/
- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/kv/platform/pricing/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/hyperdrive/platform/pricing/
- https://developers.cloudflare.com/observability/pricing/
- https://developers.cloudflare.com/analytics/analytics-engine/pricing/

Neon:
- https://neon.com/pricing
- https://neon.com/docs/introduction/plans
- https://neon.com/docs/introduction/usage-calculations
- https://neon.com/docs/introduction/cost-optimization
- https://neon.com/docs/introduction/network-transfer
- https://neon.com/docs/introduction/read-replicas

Alternatives:
- https://supabase.com/pricing
- https://www.crunchydata.com/pricing
- https://fly.io/pricing/
- https://aws.amazon.com/rds/aurora/pricing/
- https://turso.tech/pricing

*All figures are list prices as of October 2026; re-verify before budgeting.*
