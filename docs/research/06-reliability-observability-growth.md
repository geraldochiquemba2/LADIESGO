# LADIESGO — Reliability, Observability, Analytics & Growth at National Scale (2026)

## 0. Executive summary

National scale for LADIESGO is **not** a traffic problem — it is a **dispatch-determinism, data-integrity and cost-control** problem. The platform is Cloudflare Workers + Durable Objects + Neon Postgres with mobile clients. The differentiators are: (1) **epsilon-accurate SLOs tied to realtime dispatch**, (2) an **observability stack that is cheap and DO-native**, (3) **event-driven unit economics analytics** (trips, GMV, ETAs, fraud), and (4) a **growth engine built on women-safety trust**.

**Top findings:**
1. **The #1 architectural reliability risk is the single global `TripRinger` Durable Object** — a hot spot and single point of failure. **Shard it by city/region.**
2. **The bottleneck at scale is Neon Postgres, not Cloudflare.** Realtime and GPS must stay in Durable Objects; Postgres handles durable/transactional state only.
3. **Observability must be Durable-Objects-aware** (Workers Logs/Traces + Analytics Engine + Tail Workers), sampled to control cost ahead of the **Dec 2026 Observability pricing change**.
4. **SLOs must be defined driver-first** (dispatch ETA, acceptance, payment success) because driver trust is the growth engine.
5. **Growth is trust-led**: women-first safety + reliable payouts + referral loops; analytics must measure safety and driver earnings, not only trips.

---

## 1. Architecture reliability review

### 1.1 Known topology
- **Workers (Hono)** = stateless API + WS upgrade.
- **`TripPush` (DO per trip)** = realtime channel per trip; **Hibernation API** in use.
- **`TripRinger` (single global DO)** = broadcasts incoming trip offers to online drivers.
- **Neon Postgres** = durable state (users, trips, wallets).

### 1.2 Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **Single `TripRinger` DO** (hot object, SPOF, throughput cap ~1k req/s/object) | Critical | **Shard by city/region** (`RINGER:luanda`, `RINGER:benguela`…); consistent hashing by driver home city |
| `TripPush` per-trip socket leak if not hibernated | High | Enforce Hibernation API + `setWebSocketAutoResponse` heartbeat + idle eviction |
| Neon as realtime store | High | Keep GPS/presence in DO memory/KV with TTL; Postgres only for durable writes |
| Duplicate routes in `index.ts` | Medium | Deduplicate; single route registry; add tests |
| No request rate limiting | High | Cloudflare Rate Limiting + DO token buckets |
| WS upgrade not authenticated | High | Validate JWT before `acceptWebSocket`; authorize per trip |
| Fan-out to all online drivers nationally | High | Geo-shard offers: only drivers within radius/city receive the offer |

### 1.3 Redundancy & failover
- **DO placement:** use location hints; keep city data near users (Frankfurt for Angola if no local region).
- **Neon:** enable **read replicas** for read scaling; automated backups + PITR.
- **Graceful degradation:** if realtime down, fall back to REST polling on mobile; queue events.
- **Queue-based async** for non-critical work (analytics, notifications) to absorb spikes.

---

## 2. SLOs / SLIs / error budgets

Define SLOs per **critical user journey**, not per endpoint.

| Journey | SLI | SLO target | Error budget |
|---|---|---|---|
| **Trip request → offers dispatched** | % requests with ≥1 offer in X s | 99% < 3 s | 1% |
| **Rider books → driver accepts** | % with acceptance < 60 s | 95% | 5% |
| **Realtime channel availability** | WS success rate | 99.9% | 0.1% |
| **GPS update freshness** | % driver positions < 15 s old | 99% | 1% |
| **Auth API** | p99 latency | 99.9% < 300 ms | 0.1% |
| **Payment/PSP callback success** | % confirmed | 99.5% | 0.5% |
| **Crash-free driver app sessions** | % | 99.8% | 0.2% |
| **Trip completion integrity** | % completed without dispute | 99% | 1% |

**Latency targets:** API p50 < 100 ms, p95 < 300 ms, p99 < 800 ms. Realtime dispatch p95 < 3 s.

**Error-budget policy:** freeze risky deploys when budget exhausted; prioritize reliability work.

---

## 3. Observability stack (Cloudflare-native, cost-aware)

### 3.1 Layers
- **Logs → Workers Logs** (structured JSON), with **Tail Workers** for aggregation/redaction. *Note the Dec 2026 move to Observability pricing — enable sampling (5–10%).*
- **Traces → Workers Traces / OpenTelemetry**; propagate `traceId` across Worker → DO → Neon.
- **Metrics/dashboards → Analytics Engine** (cheap, high-cardinality, SQL over time series).
- **Real-time alerting →** Grafana/Prometheus or Cloudflare notifications + PagerDuty/Opsgenie.
- **Error tracking → Sentry** (mobile) + Workers logs (backend). Correlate by `tripId`/`traceId`.

### 3.2 What to instrument
- Request rate, error rate, latency **(RED)** per route and per DO.
- DO metrics: active objects, duration GB-s, hibernation efficiency, message throughput.
- WS: connect/disconnect rate, message rate, half-open detection.
- Dispatch: offers sent, acceptance latency, no-driver-found rate (by city).
- Payments: PSP callback success/failure, reconciliation gaps.
- Neon: CU usage, connection count, slow queries (`pg_stat_statements`), replication lag.
- Cost: daily Workers/DO/Neon spend vs budget.

### 3.3 Dashboards (minimum set)
1. **Ops health** (RED + SLO burn rates).
2. **Realtime/dispatch** (socket health, offer funnel, ETA).
3. **Money** (GMV, payouts, PSP success).
4. **Cost** (CF + Neon usage vs forecast).
5. **Safety/incidents**.

### 3.4 Alerting rules (examples)
- Dispatch success < 95% for 5 min → page.
- WS success < 99.5% for 10 min → page.
- No-driver-found rate > 15% in a city → alert (supply gap).
- API 5xx > 1% for 5 min → page.
- Neon CU > 80% of cap or egress > 80% → alert.
- PSP callback failure > 2% → page.

### 3.5 Observability guardrails
- **Never log PII** (phones, exact location, payment tokens). Redact in Tail Workers.
- Sample high-volume logs; keep all **error/security** events.
- Tag everything with `city`, `tripId`, `userId`(hashed), `build`, `region`.

---

## 4. Analytics & metrics

### 4.1 Event pipeline
- Emit structured **domain events** (trip_requested, offer_sent, offer_accepted, arrived, started, completed, cancelled, paid, rated, sos_triggered).
- Ingest via **Analytics Engine** (fast, cheap) → export to a warehouse (R2/Parquet or Neon read replica) for deeper analysis.
- **Idempotent event IDs** to avoid double counting.
- Business-critical state remains in Postgres; analytics derived from events.

### 4.2 Core metric definitions (single source of truth)

| Metric | Definition |
|---|---|
| **Completed trips** | status = COMPLETED (atomic count) |
| **GMV** | Σ net fare of completed trips |
| **Net take rate** | platform revenue ÷ GMV |
| **Fulfillment rate** | completed ÷ requested |
| **Median/p95 ETA** | book→pickup duration |
| **Acceptance rate** | accepted ÷ offered |
| **Cancellation rate** | cancelled ÷ requested (rider vs driver) |
| **Driver utilization** | paid time ÷ online time |
| **Rider D1/D7/D30** | cohort retention |
| **Driver 90-day churn** | left ÷ avg active |
| **Rider/Driver CAC** | spend ÷ activated |
| **Contribution per trip** | net fare − payout − fees − incentives |
| **Digital share** | digital ÷ total payments |
| **Women share** | % women riders/drivers |
| **Safety incident rate** | incidents ÷ trips |

### 4.3 Guardrails
- One canonical definition per metric, versioned.
- Distinguish **event-time** vs **processing-time**.
- Backfill/repair procedures; anomaly detection on metric drops.
- Cohort + city + acquisition-channel dimensioning from day one.

---

## 5. Incident management

- **Severity levels** (SEV1 outage/SSafety … SEV4 minor).
- **On-call rotation** with clear runbooks in Portuguese for support.
- **Status page + user comms** (WhatsApp, in-app banner).
- **Blameless postmortems** within 72 h; track action items.
- **Deploy safety:** canary/staged rollouts (EAS Update `--rollout-percentage`), feature flags, instant rollback.
- **Game days / chaos drills** for DO and dispatch failures.

---

## 6. Growth engine (trust-led)

### 6.1 Growth loops
1. **Safety referral loop** — riders/drivers invite trusted contacts; both get credit.
2. **Driver earnings loop** — reliable, fast payouts + transparent earnings → word-of-mouth recruiting.
3. **Corporate/B2B loop** — hotels, malls, hospitals, universities, NGOs → recurring GMV.
4. **Delivery adjacency loop** — parcels/food on the same fleet + wallet.

### 6.2 Acquisition channels (ranked for Angola)
- Referrals; community ambassadors; WhatsApp marketing; local radio/influencers (provincial); corporate direct sales; offline driver recruitment hubs.

### 6.3 Retention mechanics
- Rider subscription/pass; loyalty points; priority for women-driver preference.
- Driver loyalty tiers; bonus predictability; payout reliability; training/financing.

### 6.4 Experimentation
- A/B framework for pricing, dispatch, promos; guardrail metrics (safety, cancellations).
- North star: **completed trips/month** × **women share** × **safety score**.

---

## 7. 90-day reliability & observability plan

### Days 1–30 — Instrument & stabilize
- **Shard `TripRinger` by city** (P0).
- Deduplicate routes; add rate limiting; authenticate WS; add schema validation.
- Stand up **Analytics Engine** + structured logs with PII redaction.
- Define SLOs; build the **ops health** dashboard; wire paging.
- Harden `TripPush` hibernation + heartbeat; half-open detection.

### Days 31–60 — Protect money & supply
- Payment reconciliation + PSP callback monitoring; alerting.
- Dispatch funnel analytics (offers, acceptance, no-driver-found by city).
- Neon guardrails (CU cap, egress alerts, slow-query review).
- Canary deploys + rollback drill; first game day.
- Driver utilization & churn instrumentation.

### Days 61–90 — Scale & optimize
- Read replica(s) for analytics; move heavy reads off primary.
- Cost dashboard vs budget; sampling tuned ahead of Dec 2026 pricing.
- Experimentation framework live; first growth experiments.
- Postmortem culture established; error-budget policy enforced.
- Multi-city dispatch sharding validated.

---

## 8. Cost-aware reliability notes
- Realtime in DO with **hibernation** (idle = cheap); Postgres never in the realtime path.
- **Analytics Engine** instead of expensive log storage for metrics.
- **Sample** logs 5–10% before the Dec 2026 Observability pricing change.
- Cap Neon autoscale; alert before egress/CU cliffs (see annex 02).

---

## Sources
- Cloudflare Workers observability: https://developers.cloudflare.com/workers/observability/
- Workers Logs & Tail Workers: https://developers.cloudflare.com/workers/observability/logs/workers-logs/ , https://developers.cloudflare.com/workers/observability/logs/tail-workers/
- Workers Traces / OpenTelemetry: https://developers.cloudflare.com/workers/observability/traces/
- Analytics Engine: https://developers.cloudflare.com/analytics/analytics-engine/
- Durable Objects best practices / hibernation: https://developers.cloudflare.com/durable-objects/best-practices/ , https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Cloudflare Rate Limiting: https://developers.cloudflare.com/waf/rate-limiting-rules/
- Google SRE (SLOs, error budgets, postmortems): https://sre.google/workbook/implementing-slos/ , https://sre.google/sre-book/postmortem-culture/
- Neon monitoring/scale: https://neon.com/docs/introduction/monitoring , https://neon.com/docs/introduction/read-replicas
- Sentry RN: https://docs.sentry.io/platforms/react-native/
