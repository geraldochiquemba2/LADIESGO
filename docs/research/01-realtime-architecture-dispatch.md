# LADIESGO — Realtime Architecture & Dispatch at National Scale

**Track:** Realtime + dispatch/matching · Stack: Expo/RN · Cloudflare Workers (Hono) + Durable Objects · Neon Postgres
**Scope:** Angola nationwide · 2026

---

## 1. Key findings (the short version)

1. **Your free-tier ceiling is a plan problem, not an architecture problem.** Workers Free = **100,000 requests/day** (hard `1027` error, resets midnight UTC) and **10 ms CPU** per request. At ~10 requests/trip, that's your observed ~10k trips/day ceiling. National scale needs the **Workers Paid plan from day one** ($5/mo base) — everything below assumes Paid.
2. **A single global "TripRinger" DO is the #1 architectural risk.** Cloudflare explicitly warns: *"Do not create a single global Durable Object that handles all requests."* A single DO is single-threaded with a **soft ~1,000 req/s** ceiling, never relocates, and is a single point of failure pinned to one datacenter. **Shard it (by city first, then geohash cell).** This is P0.
3. **Your per-trip DO + hibernation design is correct and is the path to national scale.** Hibernation lets WS clients stay connected while the DO is billed **zero duration**. Keep it, but add **location hints** so objects spawn near Angola, and never let a DO accumulate trip history (10 GB/object cap; spill to Postgres/R2).
4. **Production dispatch is "candidate filter → ETA rank → batched optimization → offer", not nearest-driver.** Uber (DISCO) batches every ~2–5 s and solves a bipartite matching; Lyft/DiDi/Grab use LP/RL variants. Grab uses **geohash + 40+ factors + batching**; inDrive uses a **bid/auction** model; Bolt leans on ETA accuracy + dynamic pricing.
5. **Neon is fine, but connection discipline + geo indexing are mandatory.** Enable **PostGIS + H3**, use the **pooler (`-pooler` host)** or the **serverless driver**, add **GiST indexes**, and **partition the trips table**. Read replicas are compute-only and scale to zero — cheap wins.
6. **Hyperdrive is the right tool if/when you need TCP Postgres from Workers**, but its pooling is regional to the DB — pair it with Smart Placement. Neon's HTTP serverless driver avoids raw TCP entirely and is usually simpler for Hono.
7. **ETA is your biggest *quality* lever and hardest to buy.** No native Cloudflare routing exists. Plan on OSM-derived self-hosted routing or a third party (TomTom/Mapbox); cache ETAs in KV/D1.

---

## 2. How production ride-hailing platforms do dispatch & matching

### 2.1 Geospatial indexing

| System | Grid | Notes |
|---|---|---|
| **Uber** | **H3** (hexagonal, hierarchical) | 6 equidistant neighbors → good circle approximation for candidate queries & surge heatmaps. Used across marketplace for pricing & dispatch. |
| **Google/others** | **S2** (square, hierarchical) | Strong for geofencing, containment, hierarchical sharding. |
| **Grab** | **Geohash** | "Divides areas into many smaller zones following lat/long lines" for candidate generation. |
| **inDrive** | (bid-based) | Geography still used to show offers to nearby drivers, but price is negotiated. |

**Takeaway:** Use **H3** (available as JS in Workers via `h3-js`, and server-side in Neon via the `h3` / `h3_postgis` extension). Suggested resolutions:
- **res 6 (~36 km²)** → coarse city/region shards
- **res 7 (~5.2 km²)** → city sub-zones
- **res 8 (~0.74 km²)** → supply buckets / driver presence
- **res 9 (~0.11 km²)** → hyper-local pickup matching

Index driver presence and trips by H3 cell; query the origin cell + its **k-ring neighbors** instead of a SQL `ORDER BY distance LIMIT`.

### 2.2 Matching algorithms (in rough order of sophistication)
1. **First-dispatch / greedy nearest** — assign each request immediately to the closest open driver. Cheap, robust, but myopic.
2. **Batched bipartite matching** — collect requests for a 2–5 s window, build rider×driver cost matrix (ETA-based), solve **Hungarian / ILP / max-flow**. This is **Uber DISCO** and **Lyft's** core.
3. **Auction / bid models** — inDrive: passenger offers a fare, drivers accept or counter-offer; no surge. Great for emerging markets where price sensitivity is high.
4. **RL / forward-looking** — Lyft, DiDi, Grab DispatchGym, DoorDash. High complexity; **not for a small team at launch.**

**Practical recommendation:** start with **greedy + batched (2 s) bipartite** per city; add RL/ML only after you have data volume.

### 2.3 Offer / dispatch mechanics
- **Sequential offer with timeout:** offer to best driver, wait N seconds, escalate to next ring. Encode expiry as a **DO alarm**.
- **Broadcast offer:** fan-out to k nearby drivers, first to accept wins (best for thin supply — relevant to Angola's early markets).
- **Queue/dispatch loop:** a matcher consumes a request queue, ranks candidates, emits offers, and re-queues unmatched requests on timeout.
- **Surge/dynamic pricing:** computed per H3 cell from demand/supply imbalance; Bolt/Grab adjust prices to rebalance.

### 2.4 ETA
- Routing distance ≠ physical distance; production uses **road-network ETA** + ML correction (Uber **DeepETA**).
- Cheap path: precompute OSM road-graph travel times (OSRM/Valhalla) + a learned correction. Cache origin-cell→destination-cell ETAs (H3 pair keys) in **KV/D1**.

---

## 3. Cloudflare-native building blocks and their limits

### 3.1 Limits that matter (verified 2026)

| Product | Key limits |
|---|---|
| **Workers Free** | **100,000 req/day**, **10 ms CPU**, 50 subrequests, 128 MB mem, 100 Workers, 5 cron triggers |
| **Workers Paid** | No request cap; CPU default 30 s (max 5 min); 10,000 subrequests; 500 Workers; 250 cron |
| **Durable Objects** | **Single-threaded per object**, soft **~1,000 req/s** per object; **unlimited objects**; SQLite storage **10 GB/object** (Paid), 5 GB/account (Free); SQLite value/row ≤ 2 MB; **location hints are best-effort and objects never relocate** |
| **DO billing** | Paid: 1 M req/mo included + $0.15/M; 400k GB-s/mo + $12.50/M GB-s. **Hibernation = no duration charges.** Incoming WS messages billed at **20:1** ratio |
| **DO wall time** | HTTP/RPC unlimited while connected; **alarm handlers 15 min** |
| **Queues** | 128 KB messages, **5,000 msg/s per queue**, 25 GB backlog, 250 push consumers, retention 24 h free / up to 14 days |
| **D1** | 10 GB max/DB, **single-threaded**, 50,000 DBs (Paid), 30 s max query |
| **Hyperdrive** | Pool **min 5**, ~20 (Free) / ~100 (Paid) origin connections/config; 25 configs; 60 s max query; 50 MB cache |
| **KV** | Eventually consistent (up to ~60 s), learnable/persistent — **not for hot supply state** |

### 3.2 Durable Objects: when they become the bottleneck and how to shard

A DO becomes a bottleneck when:
- **Request rate to one object** approaches ~1,000/s.
- **Duration billing accrues** because the object is never idle (hibernation only applies when the DO is a **WebSocket server**).
- **All writes funnel to one location** (latency + single point of failure).
- **In-memory state** grows unbounded (128 MB isolate; 10 GB storage).

**Sharding strategy (recommended):**
- **P0 — shard by city.** `idFromName("luanda")`, `idFromName("benguela")`, etc. Replace the global TripRinger with one per active city/region. Add `{ locationHint }` on first `get()`.
- **P1 — shard by H3 cell within megacities.** One "supply cell" DO per res-7/8 cell holding idle-driver state + neighbors; a "city matcher" DO consumes cell summaries.
- **P2 — shard offer fan-out.** Use **Queues** for broadcast offers / notifications rather than one DO doing everything.
- **Never** create objects ahead of real traffic and **never** relocate decisions: hints must be set on the **first** `get()`.

**Location hints:** supported hints include `wnam`, `enam`, `weur`, `eeur`, `apac` (and others). Note `sam` objects **spawn in Eastern North America**; DOs are **not in every datacenter**. Verify live coverage at `where.durableobjects.live` and pick the nearest viable region to Angola. Hints are **suggestions, not guarantees**.

### 3.3 Other Cloudflare pieces mapped to LADIESGO
- **Hibernation WS** — keep per-trip DOs as **WS servers**; `serializeAttachment()` to survive hibernation; batch messages (50–100 ms).
- **Alarms** — offer timeouts, re-dispatch, batched matching windows, heartbeat reconciliation (≤15 min handler wall).
- **Queues** — offer fan-out, push notifications, ETA/surge precompute, async writes to Neon.
- **Cron Triggers** — periodic surge recompute, driver rebalancing, reconciliation sweeps.
- **KV** — geocell→city/shard map, feature flags, surge multipliers.
- **D1** — optional per-city analytics/ledger (single-threaded, treat as shard).
- **R2** — trip event logs, audit, exports (no egress fees); archive old trip partitions here.
- **Hyperdrive** — pooled TCP path; combine with **Smart Placement**.
- **Workflows** — durable multi-step trip lifecycle (P2).
- **Geolocation** — `request.cf` (lat/long/city/region) is free at the edge for coarse city routing.

---

## 4. Postgres / Neon patterns at scale

### 4.1 Connections (serverless correctness)
- Use the **pooled endpoint** (`-pooler` suffix) or the **`@neondatabase/serverless`** HTTP/WebSocket driver from Workers. PgBouncer accepts up to 10,000 client connections, but concurrency is capped by `default_pool_size = 0.9 × max_connections`.
- `max_connections` scales with compute: **~104 (0.25 CU), 419 (1 CU), 1,678 (4 CU), 4,000 (9+ CU)**.
- **Anti-pattern:** creating a new pool per request. Keep client pools at **1–2 connections per instance**.
- Use **direct (non-pooled)** connections only for migrations/`pg_dump`.

### 4.2 Read scaling
- **Read replicas are compute-only, attach to the same storage, provision in ms, and scale to zero.** Route read-heavy dashboards/analytics/history to replicas.

### 4.3 Geo indexing & schema
- Enable **PostGIS** and ideally **`h3`/`h3_postgis`**.
- Add a **GiST index** on geometry columns; use `ST_DWithin` and `ST_Distance`. Without GiST, spatial predicates degrade to seq scans.
- Store both **lat/long geometry** and the **H3 cell id** so the hot matching path can bucket by cell.

### 4.4 Write hotspots & partitioning
- Partition **trips by RANGE on `created_at`** (monthly/weekly) so you can **DROP** old partitions instantly.
- Avoid a single hot partition; consider **hash sub-partitioning** or per-region databases.
- Move closed trips to cold/archive (or R2) via Cron; read replicas serve history.
- **Keep driver-location state in DOs, not Postgres** — persist only meaningful transitions to Neon.

---

## 5. Target architecture (text)

```
                                 ┌───────────────────────────────────────────┐
   Expo / RN clients             │            Cloudflare Global Edge          │
   (driver + rider)  ──HTTPS/WSS─▶  Worker API (Hono) + WS gateway (per region) │
                                 │   • request.cf geolocation → pick city      │
                                 │   • KV: geocell→city/shard map, flags       │
                                 │   • auth (access JWT), rate-limit, WAF       │
                                 └───────┬───────────────────────┬─────────────┘
                                         │ service bindings      │ writes (async)
                     ┌───────────────────▼───────────┐   ┌───────▼─────────────┐
                     │   Dispatch / Matching tier    │   │   Cloudflare Queues  │
                     │  (Durable Objects, sharded)   │   │  offers, notif, ETA, │
                     │                               │   │  surge, DB writes    │
                     │  CityMatcher DO  (per city)    │◀──┤                      │
                     │   • 2s batching window (alarm) │   └───────┬─────────────┘
                     │   • greedy → bipartite match   │           │
                     │                               │   ┌───────▼─────────────┐
                     │  SupplyCell DO (per H3 r7/8)   │   │  Cron Triggers       │
                     │  TripRinger DO  (per region)   │   │  surge, rebalance,   │
                     │  TripSession DO (per trip)     │   │  partition upkeep    │
                     └───────┬───────────────────────┘   └─────────────────────┘
                             │ pooled / HTTP (Hyperdrive or Neon serverless driver)
                     ┌───────▼───────────────────────────────────────────────┐
                     │              Neon Postgres (primary region)            │
                     │  users, vehicles, trips(partitioned by time),          │
                     │  payments, PostGIS + GiST, h3 cell column              │
                     └───────┬───────────────────────────┬───────────────────┘
                             │                           │
                   ┌─────────▼─────────┐        ┌────────▼─────────┐
                   │ Read replica(s)    │        │  R2 archive/logs  │
                   └────────────────────┘        └──────────────────┘

   Graceful degradation:
     • Matcher unavailable → Worker falls back to DO-local greedy nearest-driver.
     • Queue backlog → shed offers above cap, extend batching window.
     • Neon write failures → buffer in Queue/R2, retry; serve reads from DO state.
     • DO overloaded → 503 + client retry with jitter; shed lowest-priority work.
```

---

## 6. Phased roadmap (P0 / P1 / P2)

### P0 — Do now (correctness + unblock scale) — ~3–5 dw
| # | Action | Why | Effort | Risk |
|---|---|---|---|---|
| P0.1 | **Move to Workers Paid**; set budget alerts | Removes 100k/day + 10 ms caps | 0.2 dw | Cost creep |
| P0.2 | **Shard the global TripRinger** by `idFromName(city)` | Removes single-threaded SPOF | 1–2 dw | Keying bugs; idempotency |
| P0.3 | Add **location hints** on first `get()` | Pin objects near Angola | 0.5 dw | Hints best-effort |
| P0.4 | Add **H3 cell column** to trips + driver presence; index it | Cell-based candidate queries | 1 dw | Backfill cost |
| P0.5 | **PostGIS + GiST** on Neon; partitioned `trips` table (monthly) | Fast geo reads; cheap retention | 1 dw | Migration window |
| P0.6 | **Offer timeout via DO alarms** | Prevents stuck offers | 0.5 dw | Alarm cost |
| P0.7 | Route all matching **through Queues** (bounded) | Smooths spikes; backpressure | 1 dw | At-least-once → idempotent |

### P1 — Scale to provinces (2–6 months) — ~8–14 dw
| # | Action | Why |
|---|---|---|
| P1.1 | **Per-H3-cell SupplyCell DOs** (r7/r8) + city matcher | City DO bottleneck past ~1k req/s |
| P1.2 | **Batched bipartite matching** (2 s window) per city | Better global wait time |
| P1.3 | **Neon read replicas** for dashboards/history | Offload primary |
| P1.4 | **ETA service**: OSM routing (OSRM/Valhalla) + cell-pair cache | Biggest quality lever |
| P1.5 | **Driver rebalancing + surge** via Cron + per-cell multiplier | Balance supply/demand |
| P1.6 | **R2 archive** for closed trips; detach old partitions | Keep hot tables small |

### P2 — National maturity (6–18 months)
| # | Action |
|---|---|
| P2.1 | **Split into per-region databases** via KV routing |
| P2.2 | **Multi-region DO hints** aligned per province |
| P2.3 | **Hyperdrive + Smart Placement** (if moving to TCP `pg`) |
| P2.4 | **ML/RL matching** after data volume |
| P2.5 | **Multi-step Workflows** for trip lifecycle / disputes / payouts |

**Free-tier reality check:** National scale will exceed 100k req/day by definition. Treat Paid Workers + Neon paid compute + Queues as **baseline infrastructure**, not optimizations.

---

## 7. Risk register (top items)

| Risk | Impact | Mitigation |
|---|---|---|
| Single global DO | Outage / hard ~1k req/s ceiling | Shard by city (P0), then cell (P1) |
| DO duration billing (always-on) | Cost blow-up | Hibernation; avoid constant alarms |
| Neon connection exhaustion | Failed queries | Pooled endpoint; small client pools; replicas |
| Cross-region latency | Slow writes | Location hints; Smart Placement; regional DB |
| ETA inaccuracy | Bad matching, cancellations | OSRM + correction; cache |
| Angola connectivity / mobile churn | Dropped WS | Heartbeats; idempotent rejoin; rehydrate |
| At-least-once queues | Duplicate offers/payments | Idempotency keys |
| Hot Postgres partition | Slow writes | Time partitioning + hash sub-partitioning |

---

## 8. Sources

**Dispatch & matching**
- Uber H3: https://www.uber.com/blog/h3/ · https://github.com/uber/h3 · https://h3geo.org
- Uber city cores/H3: https://www.uber.com/blog/visualizing-city-cores-with-h3/
- Uber DISCO / Grab DispatchGym explainer (2026): https://dev.to/vesviet/system-design-ride-hailing-dispatch-algorithm-how-uber-disco-grab-dispatchgym-match-drivers-pp4
- Lyft — Solving Dispatch: https://eng.lyft.com/solving-dispatch-in-a-ridesharing-problem-space-821d9606c3ff
- Lyft — RL matching (arXiv 2310.13810): https://arxiv.org/pdf/2310.13810
- DiDi — RL order dispatching (INFORMS): https://pubsonline.informs.org/doi/abs/10.1287/inte.2020.1047
- Matching/dynamic pricing survey (NRL 2020): https://onlinelibrary.wiley.com/doi/10.1002/nav.21872
- Grab — how matching works: https://www.grab.com/sg/inside-grab/stories/matching-driver-partners-and-riders-allocation/
- Grab — DispatchGym (2025): https://engineering.grab.com/techblog_-dispatchgym
- Grab — real-time data ingestion: https://engineering.grab.com/real-time-data-ingestion
- Bolt — marketplace/dispatch/orchestration: https://bolt.eu/en/careers/teams/engineering/delivery/
- Bolt — TomTom traffic/ETA: https://www.tomtom.com/newsroom/press-releases/general/517622259/
- inDrive — bid model: https://indrive.com/en-np/help/about-indrive/how-does-indrive-work
- Yango — ML order distribution: https://yango.com/about
- DoorDash — RL objective-weight dispatch (2026): https://arxiv.org/html/2606.13604v1

**Cloudflare**
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Durable Objects limits: https://developers.cloudflare.com/durable-objects/platform/limits/
- Rules of Durable Objects (sharding, ~1k req/s): https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- DO data location / location hints: https://developers.cloudflare.com/durable-objects/reference/data-location/
- DO WebSockets & hibernation: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- DO pricing (hibernation, WS 20:1): https://developers.cloudflare.com/durable-objects/platform/pricing/
- Queues limits: https://developers.cloudflare.com/queues/platform/limits/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- Hyperdrive limits: https://developers.cloudflare.com/hyperdrive/platform/limits/
- Smart Placement: https://developers.cloudflare.com/workers/configuration/placement/

**Postgres / Neon**
- Connection pooling: https://neon.com/docs/connect/connection-pooling
- Read replicas: https://neon.com/blog/the-problem-with-postgres-replicas
- PostGIS on Neon: https://neon.com/docs/extensions/postgis
- Geospatial search guide / GiST: https://neon.com/guides/geospatial-search
- Postgres table partitioning: https://www.postgresql.org/docs/17/ddl-partitioning.html
