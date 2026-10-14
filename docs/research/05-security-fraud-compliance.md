# LADIESGO — Security, Fraud & Compliance (Angola ride-hailing, 2026)

## 0. Executive summary — top risks ranked

| # | Risk | Likelihood | Impact | Priority |
|---|---|---|---|---|
| 1 | **Account takeover (ATO) / SIM-swap** of drivers → payout theft & trip hijack | High | Critical | **P0** |
| 2 | **Storefront/phone-token fraud** (multi-account bonus farming, GPS spoofing) | High | High | **P0** |
| 3 | **Payout fraud** (fake trips → cash-out, mule accounts) | High | Critical | **P0** |
| 4 | **Trip/ride fraud on the women-safety promise** (harassment, unverified substitute driver) | Medium | Critical (brand-killing) | **P0** |
| 5 | **Payment fraud** (chargebacks, fake Multicaixa Express proofs, referral abuse) | High | High | **P0** |
| 6 | **Law 22/11 data-protection non-compliance** (APD registration, international transfer) | High | High | **P0** |
| 7 | **Realtime/WebSocket abuse** (unjuried sockets, message flooding, cost DoS) | Medium | Medium | **P1** |
| 8 | **No rate-limiting / duplicate routes** in worker → enumeration & cost abuse | High | Medium | **P1** |
| 9 | **Insider/API-key leakage**, weak JWT (HS256 shared secret) | Medium | High | **P1** |
| 10 | **Physical security incidents** (assault) with poor evidence chain | Medium | Critical | **P1** |

**Thesis:** in Angola the dominant attack is not fancy crypto-breaking — it is **identity and payout fraud made easy by phone-number-based accounts, SIM-swap, and cash/semi-digital rails.** Defenses must be **device-bound, behaviorally-scored, and money-flow-aware**, layered on top of Law 22/11 compliance.

---

## 1. Threat model

### 1.1 Actors
- **Foreign/organized fraud rings** — fake accounts, bonus farming, mule cashing.
- **Opportunistic users** — GPS spoofing to fake trips, referral self-abuse.
- **Malicious riders** — targeting women passengers/drivers for harassment/fee evasion.
- **Insiders** — support/ops staff abusing data or refunds.
- **Compromised devices** — malware, rooted phones, credential-stealing apps.

### 1.2 Assets to protect
- Driver identity + **payout destination** (highest value).
- Rider PII + **live location** (privacy + physical safety).
- **Money flows** (fares, bonuses, wallet balances).
- Platform integrity metrics (dispatch, pricing, ratings).
- Safety/incident evidence.

### 1.3 Attack surfaces
- Phone-number + OTP auth (SIM-swap).
- Device registration & session tokens.
- GPS/telemetry (spoofable).
- Payment callbacks/webhooks (forgeable proofs).
- Referral & promo engines.
- Realtime WebSocket/DO endpoints.
- Support tooling & admin shortcuts (a **master admin shortcut on phone `999999999` exists** — must be disabled/gated in prod).
- Cloud (Workers/Neon) credentials.

---

## 2. Account takeover & SIM-swap defense

### 2.1 The Angola SIM-swap reality
- Telco OTP is **not a strong authenticator** in Angola (SIM-swap, insider telco abuse, number recycling — Angolan numbers are recycled after inactivity).
- **Never** make phone number the sole recovery/session factor.

### 2.2 Controls
- **Device binding:** on first login, bind the session to a **device ID + hardware attestation** (Play Integrity). New device → step-up challenge + cooldown before payouts.
- **Recovery locks:** after SIM/phone change, **freeze payouts for 48–72 h**, notify old device.
- **Multi-signal login risk scoring:** new device + new geo + new SIM + odd hour → require extra factor (selfie/liveness, PIN, email).
- **Push-based approvals** for payout-destination changes (confirm on an already-trusted device).
- **Sessions:** short-lived access + rotating refresh tokens; server-side revocation; bind to device.
- **Payout-destination change** is the #1 red flag — treat as a **high-risk event** with wait period + human review over a threshold.
- **Notify the user** (SMS + push + in-app) on: new device, login from new city, bank/wallet change.

### 2.3 Auth architecture recommendation
- Move JWT from **HS256 shared secret → asymmetric (EdDSA/RS256)**; keep keys in Workers secrets, rotate.
- Add **device-bound refresh tokens** + short access TTL.
- Remove/disable **admin master shortcuts** (hard-coded phone/password) in production; replace with MFA + role scoping.

---

## 3. GPS spoofing / telemetry integrity

### 3.1 Controls
- **Server-side plausibility:** impossible-speed checks (e.g., >120 km/h sustained), teleport detection, route polyline conformance.
- **Device integrity:** Play Integrity API to flag rooted/emulated devices; degrade trust, require review for payouts.
- **Cross-signal correlation:** mock-location detection (Android `isFromMockProvider`), accelerometer/gyro consistency, cell/Wi-Fi fingerprint vs GPS.
- **Trip randomness challenge:** occasional "prove you're moving" (camera/QR at pickup, randomized checkpoints).
- **Pickup proof:** rider PIN + optional **driver selfie / vehicle photo at pickup** for high-value or flagged trips.

### 3.2 Scoring
- Maintain a **trust score** per driver/device combining integrity, behavior, ratings, dispute rate. Feed into dispatch priority + payout review.

---

## 4. Payout & money-flow fraud

### 4.1 Patterns
- **Fake completed trips** (self-dealing driver+rider collusion) → bonus + surge harvesting.
- **Mule payout accounts** (many drivers → one wallet/bank).
- **Refund/chargeback abuse**.
- **Referral self-farming** (same device/identity, VPN).

### 4.2 Controls
- **Velocity + graph analysis:** detect shared payout destinations, shared devices, shared IPs, duplicated trip geographies.
- **Delay & batch payouts** (e.g., T+1) with **risk hold** for new accounts (first N trips).
- **Bonus design:** cap per device/identity; require genuine unique riders; de-weight same-pair trips.
- **KYC tiering:** raise limits only after verified identity + history.
- **Manual review queue** for anomalies; keep evidence.
- **Reconcile** fares↔payouts↔PSP settlement daily.

---

## 5. Payment fraud (Angola rails)

### 5.1 Multicaixa Express / mobile money
- **Verify via PSP callback only** — never trust client-side "I paid" screenshots.
- Use **webhook signature verification (HMAC)** + idempotency keys (ProxyPay/PayPay/DCSC support this).
- **Pre-authorization** for no-show/cancellation fees; capture on completion.
- Watch **currency/amount mismatches** and replay attempts.

### 5.2 Cash
- Cash trips: **commission captured from driver wallet**; negative-balance thresholds trigger payout holds.

### 5.3 Chargebacks & disputes
- Evidence pack per trip (GPS polyline, timestamps, PIN, photos). Automate retrieval.

---

## 6. Realtime/API hardening

### 6.1 Current weaknesses observed
- **No rate limiting** in the Worker.
- **Duplicate route registrations** in `index.ts` (only the first is served) — confusing and a maintenance risk.
- **Per-trip WebSocket** without documented auth/abuse limits.

### 6.2 Controls
- **Rate limit** per IP + per user + per device (Cloudflare Rate Limiting / DO token buckets).
- **Authenticate the WebSocket upgrade** (JWT in subprotocol/query, validated before `acceptWebSocket`).
- **Authorize per trip:** only the matched rider & driver may subscribe to a trip channel.
- **Message caps:** max frames/sec, max payload size, idle timeout.
- **Cost-DoS guard:** limit concurrent sockets per user/device/IP; cap DO message throughput.
- **Input validation:** strict schema (zod) on all frames and REST bodies.
- **CORS + CSRF**: lock down web `/status` origin; CSRF tokens where cookies are used.
- **Disable/route-audit** duplicate endpoints; single source of truth.

---

## 7. Privacy, safety & incident handling

### 7.1 PII minimization
- Encrypt **live location** and store minimally; keep GPS out of long-term Postgres.
- **Mask phone numbers** in chat (in-app comms only); no direct number exposure.
- **Data retention:** define retention/consent; delete on account closure.

### 7.2 Women-safety specific
- **Verify identity of riders and drivers**; **enforce that the registered driver is the one driving** (selfie/vehicle verification at pickup for flags).
- **In-app SOS** → 24/7 human + trusted contacts + live location share.
- **Route deviation + long-stop alerts**.
- **Rider PIN** + **vehicle/plate confirmation**.
- **Right-to-refuse** and one-tap re-match.
- **Incident evidence chain** (immutable log) for police/legal.

### 7.3 Incident response
- On-call runbook; severity levels; 24/7 support in Portuguese.
- Preserve evidence; cooperate with authorities; notify affected users; regulator notification if data breach.

---

## 8. Compliance — Angola & international

### 8.1 Law 22/11 (Data Protection)
- **Register with the APD** and obtain **prior authorization** for sensitive processing before launch.
- **International transfers to non-adequate countries require authorization** — cloud hosting abroad is in scope.
- **Fines up to ~USD 505,000**; a revision was in public consultation (2025).
- Appoint a **data-protection contact/DPO**; publish privacy policy in Portuguese; obtain **explicit consent** for location.

### 8.2 Transport regulation
- Operate under **occasional passenger transport** rules; partner with **licensed fleet operators**; ensure **vehicle licenses + insurance**.

### 8.3 Financial/AML
- Payout flows may trigger **AML/KYC** expectations (BNA rules on payments). Tiered KYC; sanctions/PEP screening for payouts above thresholds.
- **AGT invoicing** (Factura/Recibo) per transaction.

### 8.4 Security standards
- Align to **OWASP ASVS / MASVS** for the mobile + API; **OWASP Top 10** for the API.
- Consider **ISO 27001** posture as you scale for enterprise/B2B trust.

---

## 9. Security roadmap (P0 → P2)

**P0 (before scaling)**
1. Disable admin master shortcut; enforce MFA + RBAC.
2. Device binding + Play Integrity + payout-change freeze/step-up.
3. Payout risk engine (velocity, shared-destination graph, T+1 hold on new accounts).
4. PSP webhook HMAC verification + idempotency; pre-auth.
5. WS upgrade auth + per-trip authorization + rate limits + frame caps.
6. APD registration + privacy policy + encryption of location + retention policy.
7. Server-side GPS plausibility + mock-location detection.
8. JWT → asymmetric keys; split secrets; rotate.

**P1**
9. Referral/bonus anti-abuse; graph fraud analytics.
10. Incident evidence store + SOPs + support tooling hardening.
11. Anomaly alerting (login, payout, dispute) to on-call.
12. Route dedup/cleanup + schema validation everywhere.

**P2**
13. Trust-score-driven dispatch & payout automation; ML fraud models.
14. Bug bounty / pen-test cycle; ISO 27001 readiness.
15. Advanced liveness/selfie verification for drivers and high-value riders.

---

## 10. Angola-specific notes
- **Phone recycling + SIM-swap make telco OTP weak** → device binding is essential.
- **Cash-dominant** → protect the driver-wallet/commission netting flow (fraud hides in cash reconciliation).
- **Multicaixa Express** is the digital default but **proof must come from PSP callbacks**, not clients.
- **Cloud localization** (Law 22/11) forces a decision: Angola/EU-region hosting or formal transfer authorization.
- **Brand risk is existential:** one high-profile women-safety failure can end the business — invest in verification and incident response early.

---

## Sources
- Angola Data Protection Law 22/11 + APD and CMS guide: https://cms.law/en/int/expert-guides/cms-expert-guide-to-data-protection-and-cyber-security-laws/angola , https://lex.ao/docs/assembleia-nacional/2011/lei-n-o-22-11-de-17-de-junho/
- Angola transport (occasional passenger transport; DP 128/10; DP 123/22): https://lex.ao/docs/presidente-da-republica/2022/decreto-presidencial-n-o-123-22-de-30-de-maio/
- Payment rails: https://developer.proxypay.co.ao/opg/v1/ , https://multicaixa.ao/pt/oferta/canais/comerciantes/gateway-de-pagamentos-online/ , https://docs.paybyrd.com/accept-payments/bank-transfers/multicaixa-express , https://dcsc.ao/produtos/payment-orchestrator
- Cloudflare security/limits: https://developers.cloudflare.com/durable-objects/ , https://developers.cloudflare.com/workers/platform/limits/
- OWASP ASVS/MASVS, OWASP API Top 10: https://owasp.org/www-project-application-security-verification-standard/ , https://owasp.org/www-project-mobile-security-testing-guide/ , https://owasp.org/API-Security/
- Play Integrity API: https://developer.android.com/google/play/integrity/overview
- SIM-swap / ATO guidance: https://www.cisa.gov/sites/default/files/publications/MFA_Recommendations_Fact_Sheet.pdf
