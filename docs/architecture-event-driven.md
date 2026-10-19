# LADIESGO — Arquitetura Event-Driven (Migração do Worker Monolítico)

**Estado:** proposta de design · **Data:** 2026-10-17 · **Escopo:** migração progressiva (sem downtime) do Worker monolítico `cloudflare/api-worker` para microserviços orientados a eventos sobre Cloudflare.

**Referências estudadas:**
- `SaiKrishnaMulukutla/uber` — Go + **Kafka** + **Redis GEO** + PostgreSQL (matching por `GEORADIUS`, `EventEnvelope`, tópicos `ride.requested`, `ride.offered`, `driver.assigned`, `trip.completed`, `ridego.events`).
- `Sparsh1501/Ride-Sharing-Service` — Java/Spring + **Kafka** + **Redis GEO** + **event sourcing/CQRS** + **STOMP** (log `trip_events`, idempotência `SET event:processed NX`, consistent hashing, scoring ponderado).

> **Nota de realidade da stack:** a produção atual **já não usa Neon Postgres** — usa **D1 (SQLite)** + **Durable Objects** (ver `AGENTS.md`, `cloudflare/api-worker/src/db.ts`). Este documento parte da stack real (Workers + D1 + DO + Queues), não da stack de investigação anterior (`docs/research/01`, que assume Neon).

---

## 1. Análise da arquitetura atual (Worker monolítico)

### 1.1 O que existe hoje

| Camada | Onde | Factos |
|---|---|---|
| **Worker HTTP** | `cloudflare/api-worker/src/index.ts` (~2 869 linhas) + `src/db.ts` | Hono, ~185 call-sites `sql\`...\``, JWT HS256 (WebCrypto), PBKDF2 (10 000 iterações), autenticação por `Authorization: Bearer`. |
| **Rotas** | mesmo ficheiro | `auth/*`, `users/*`, `drivers/*`, `trips/*` (estimate, request, request-web, incoming, active, history, status, accept, skip, arrived, start, complete, cancel, live, public), `ratings/*`, `notifications/*` (stubs), `payments/*` (stubs), `turn/*`, `trips/:id/call/*`, `trips/:id/chat/*`, `places/search`, `zone`, `route`, `admin/*`. |
| **Durable Objects** | mesmo ficheiro (`export class ...`) | `TripRinger` (global, alarmes + push Expo), `TripPush` (1 por viagem, WS hibernável), `RequestsHub` (global, feed de pedidos da motorista), `DriverGeo` (global, mapa GPS em memória). |
| **Dados** | D1 `ladiesgo` | `users`, `drivers`, `trips`, `ratings`, `ride_categories`, `call_logs`, `call_signals`, `chat_messages`, `notifications`, `reports`, `wallet_tx`, `places` + `places_fts`. Adaptador `db.ts` traduz SQL "estilo Postgres" para SQLite. |
| **Externos** | chamadas `fetch` | Expo Push, Telegram (fotos admin), Nominatim, Photon, OSRM/Valhalla (routing), Facebook scrape. |
| **Tempo real** | WebSocket hibernável | `TripPush` (passageira↔motorista), `RequestsHub` (feed), `DriverGeo` (GPS). |

### 1.2 Como o "dispatch" funciona hoje (dentro do monolito)

1. `POST /api/v1/trips/request` → `buildOfferQueue()` filtra candidatas em memória (`geoAll()` do `DriverGeo`) por distância ≤ raio e depois lê só essas na D1; constrói `offerQueue` ordenada por distância.
2. A oferta é **sequencial** (30 s cada, raio expansivo 5 → 8 → 12 km) via `advanceOfferIfNeeded()`; ao esgotar a fila, `offerBroadcast = true` (abre a todas).
3. `TripRinger` (DO global com alarme a 4 s/8 s/15 s) avança a oferta em silêncio e dispara push Expo dirigido (`pushTripToDriver`) à motorista ofertada.
4. A motorista aceita via `PUT /trips/:id/accept`; o estado muda na D1; `pushStatus()` notifica o `TripPush` da viagem.
5. `PUT /trips/:id/start` valida `pinForTrip(id)` (OTP) e só então `IN_PROGRESS`.
6. `PUT /trips/:id/complete` aplica comissão (14 %), atualiza `wallet_tx`, `totalEarnings` e notifica.

### 1.3 Pontos fortes (manter)

- **WS hibernável por viagem** (`TripPush`) — faturação de duração ≈ 0 quando ocioso. Correto e deve manter-se.
- **GPS fora da D1** (`DriverGeo` em memória, 0 escritas por ping). Correto.
- **Contratos 1:1 com `mobile/src/services/api.ts`** — estável; a migração não pode quebrar o mobile sem novo build.
- **Adaptador `db.ts`** — isolar a tradução SQL, permitindo mudar o motor sem reescrever 185 call-sites.

### 1.4 Débitos e riscos (motivação da migração)

| # | Problema | Impacto |
|---|---|---|
| R1 | **Um só Worker** com rotas de viagem + auth + places + admin. | Um `places/search` lento (8 s de timeout externo) compete por CPU/isolate com o dispatch; não há deploy independente nem escala isolada. |
| R2 | **`TripRinger` e `RequestsHub` e `DriverGeo` são DOs globais** (`idFromName('global')`). | DO single-threaded, teto suave ~1 000 req/s, **ponto único de falha** preso a um datacenter. (O `docs/research/01` já assinala isto como P0.) |
| R3 | **Não existe barramento de eventos**: "eventos" são chamadas de função + `waitUntil`. | Sem schema, sem versionamento, sem replay, sem auditoria, sem idempotência; impossível adicionar consumidores. |
| R4 | **OTP determinístico** (`pinForTrip` = hash do id da viagem). | Previsível; qualquer pessoa que conheça o id consegue iniciar a viagem. |
| R5 | **Sem idempotência**: retries podem duplicar comissão, avaliações, contadores. | Perda de dinheiro / inconsistência sobretry de rede. |
| R6 | **Lógica de negócio espalhada**: matching, carteira/comissão, push, places, admin no mesmo ficheiro. | Acoplamento; testes difíceis; risco de regressão. |
| R7 | **D1 single-threaded** e quota de escrita 100 000 linhas/dia **por conta** (já esgotada a 2026-10-17, erro 7500). | Escrever tudo numa D1 é frágil; a quota é por conta, não por BD. |
| R8 | **Notificações e pagamentos são stubs.** | Não há produto completo; o evento-driven dá o backbone para os construir. |
| R9 | **Consumidores externos síncronos** (Nominatim/Photon/OSRM) dentro do caminho de resposta. | Latência variável; sem circuit breaker. |

---

## 2. Arquitetura alvo (microserviços orientados a eventos)

### 2.1 Princípios

1. **Contratos primeiro**: o barramento carrega eventos versionados; os serviços comunicam por eventos, não por consultas cruzadas de BD.
2. **Cloudflare-native, mas portátil**: o *envelope* de evento é idêntico ao usado com Kafka (`eventId/eventType/timestamp/correlationId/sourceService`), para que uma ponte para Kafka/Redis seja possível sem reescrever produtores.
3. **Estado quente em DO, estado autoritativo em D1**: posições GPS e ofertas em DO; viagens/utilizadores em D1 (com CQRS: comandos escrevem eventos, leituras usam read models).
4. **Idempotência em todos os consumidores** (`eventId` + `aggregateId`).
5. **Degradação graciosa**: se um consumidor cair, o monólito continua a servir o caminho síncrono (fase de transição).
6. **Zero downtime**: *feature flags* + *dual-run* + *canary*; cada fase é revertível.

### 2.2 Opção escolhida (e porquê)

| Opinião | Descrição | Veredito |
|---|---|---|
| **A — Cloudflare puro** | Múltiplos Workers + **Queues** como barramento + DOs para matching/geo + D1 por domínio. | ✅ **Recomendado** — custo mínimo, sem egress, nativo, consistente com a stack atual. |
| **B — Híbrido Kafka** | Adicionar Kafka gerido (Aiven/Confluent) + Redis gerido (Upstash). | ⚠️ Só para analytics/integração externa futura. **Trabalhadores Cloudflare não abrem TCP**, por isso Kafka exigiria um proxy HTTP (custo + latência + outro SPOF). |
| **C — Redis Streams** | Upstash Redis Streams. | ⚠️ Viável (Upstash tem API HTTP/REST), mas por-mensagem HTTP é caro no hot path; sem vantagem sobre Queues. |
| **D — Manter monolito** | Só corrigir os DOs globais. | ❌ Não resolve R1/R3/R6. |

> **Regra prática:** o *hot path* (matching, GPS, ofertas, estado da viagem) fica em **Queues + DOs**; Kafka entra mais tarde apenas como **sink de analytics/auditoria**.

### 2.3 Diagrama de alto nível

```
                          ┌────────────────────────────────────────────────────────┐
   Mobile (Expo/RN)        │                 Cloudflare Edge                          │
   passageira/motorista ──▶│  api-gateway Worker (Hono): auth, rate-limit, WAF,       │
        ▲                  │  roteamento, feature flags, request.cf geolocation       │
        │ HTTPS/WSS        └───────────────┬───────────────────────────┬─────────────┘
        │                                  │ comandos                   │ consultas
        │                                  ▼                            ▼
        │                     ┌────────────────────────┐      ┌──────────────────────┐
        │                     │  trip-service Worker    │      │  query/read models    │
        │                     │  comandos + state machine│      │  (D1 por domínio)     │
        │                     └───────────┬────────────┘      └────────▲─────────────┘
        │                                 │ eventos                     │ projeções
        │                                 ▼                             │
        │                     ┌──────────────────────────────────────────────────────┐
        │                     │        Cloudflare Queues (barramento de eventos)       │
        │                     │  ride-requests · offers · trip-events · locations ·   │
        │                     │  notifications · earnings                             │
        │                     └───┬───────────┬────────────┬───────────┬──────────────┘
        │                         ▼           ▼            ▼           ▼
        │              ┌──────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────┐
        │              │ matching-svc │ │ location-  │ │ notif-svc  │ │ earnings-svc │
        │              │ (DO sharded) │ │ svc (DO)   │ │            │ │              │
        │              └──────┬───────┘ └─────┬──────┘ └─────┬──────┘ └──────┬───────┘
        │                     │               │              │               │
        │                     ▼               ▼              ▼               ▼
        │              DriverGeo DO     D1 locations    Expo/Telegram    D1 wallet_tx
        │              (GEO em memória)                  in-app           comissão
        │
        └── WSS (hibernável) ◀── TripPush DO (1 por viagem) · RequestsHub DO · DriverGeo WS
```

### 2.4 Mapeamento dos padrões de referência para Cloudflare

| Padrão | `uber` (Kafka+Redis) | `Ride-Sharing-Service` (CQRS+STOMP) | Implementação LADIESGO |
|---|---|---|---|
| Barramento | Kafka 5 tópicos | Kafka 7 tópicos + `EventEnvelope` | **Cloudflare Queues** (1 fila por tipo de evento) |
| Dedupe/idempotência | — | `SET event:processed:{eventId} NX` | `eventId` + `processed_events` (DO/D1) com TTL |
| Matching geográfico | Redis `GEORADIUS` | Redis `GEORADIUS` + consistent hashing | **`DriverGeo` DO** (já existe) + *sharding por cidade/H3* |
| Event sourcing | — | `trip_events` append-only + fold | `trip_events` em D1/R2; fold em DO |
| CQRS | — | `trip-service` (cmd) / `query-service` (read) | comandos no `trip-service`; leituras em read models D1 |
| Tempo real | WebSocket | STOMP over SockJS | **WS hibernável** (`TripPush`/`RequestsHub`) |
| OTP | Redis | — | **OTP aleatório** no `TripPush` DO (storage), TTL |
| Sharding | — | ConsistentHashRing (MurmurHash3, Redis ZSET) | **1 DO por cidade** (`idFromName(city)`), depois por célula H3 |

---

## 3. Definições de schema de eventos

### 3.1 Envelope canónico (todos os eventos)

```json
{
  "eventId": "01JX...",                 // ULID — chave de idempotência/dedupe
  "eventType": "ride.requested",
  "version": "1",
  "occurredAt": "2026-10-17T20:13:44.123Z",
  "sourceService": "trip-service",
  "correlationId": "01J...",            // id do agregado (ex.: tripId)
  "causationId": "01J...",              // eventId que originou este (para tracing)
  "actor": { "type": "PASSENGER", "id": "usr_..." },
  "payload": { /* específico do eventType */ }
}
```

**Regras:**
- `eventId` é imutável e global; consumidores deduplicam por `(eventId)`.
- `correlationId` = id do agregado raiz (viagem) — garante ordenação por partição.
- `version` permite coexistir v1/v2 durante migração (consumidores aceitam ambas).
- Todos os timestamps em ISO-8601 UTC (evita o caos de `NOW()`/strftime da D1).
- Payload ≤ 100 KB (limite da Queue: 128 KB).

### 3.2 Catálogo de eventos

| Evento | Produtor | Consumidores | Desencadeia |
|---|---|---|---|
| `ride.requested` | trip-service | matching-svc, surge-svc, notif-svc | início do ciclo de ofertas |
| `ride.estimated` | trip-service | — (cache) | fare/surge |
| `driver.location.updated` | location-svc | matching-svc, notif-svc, trip-svc | atualizar GEO + ETA |
| `driver.availability.changed` | location-svc | matching-svc, notif-svc | entrar/sair do pool |
| `ride.offer.created` | matching-svc | notif-svc, trip-svc | push à motorista |
| `ride.offer.expired` | matching-svc | matching-svc, trip-svc | avançar fila |
| `ride.offer.skipped` | matching-svc | matching-svc | avançar fila |
| `ride.offer.accepted` | matching-svc | trip-svc, notif-svc | `driver.assigned` |
| `ride.offer.rejected` | matching-svc | matching-svc | avançar fila |
| `driver.assigned` | trip-svc | notif-svc, earnings-svc | push a ambos; gerar OTP |
| `driver.arrived` | trip-svc | notif-svc | push "chegou" |
| `ride.started` | trip-svc | notif-svc, location-svc | validar OTP; tracking |
| `ride.completed` | trip-svc | earnings-svc, notif-svc | comissão; push |
| `ride.cancelled` | trip-svc | matching-svc, notif-svc | libertar motorista |
| `ride.rated` | trip-svc | notif-svc, earnings-svc | atualizar rating |
| `payment.completed` | payment-svc | notif-svc, earnings-svc | recibo |
| `payment.failed` | payment-svc | notif-svc | retry/alerta |
| `driver.earnings.updated` | earnings-svc | — | extrato |
| `trip.eta.updated` | trip-svc | notif-svc | push ETA |
| `notification.delivered` / `.failed` | notif-svc | — (métricas) | DLQ se falhar |

### 3.3 Schemas (JSON Schema) dos eventos críticos

**`ride.requested`**
```json
{
  "$id": "https://ladiesgo.ao/schemas/ride.requested.v1.json",
  "type": "object",
  "required": ["passengerId","pickup","dropoff","rideType","fareEstimate","distanceKm","paymentMethod"],
  "properties": {
    "tripId":      { "type": "string" },
    "passengerId": { "type": "string" },
    "pickup":      { "type": "object", "required": ["lat","lng"],
                     "properties": { "lat": {"type":"number"}, "lng": {"type":"number"}, "address": {"type":"string"} } },
    "dropoff":     { "type": "object", "required": ["lat","lng"],
                     "properties": { "lat": {"type":"number"}, "lng": {"type":"number"}, "address": {"type":"string"} } },
    "stops":       { "type": "array", "maxItems": 3, "items": { "type":"object" } },
    "rideType":    { "type": "string", "enum": ["ECONOMY","COMFORT","PREMIUM"] },
    "fareEstimate":{ "type": "number" },
    "distanceKm":  { "type": "number" },
    "paymentMethod":{ "type": "string", "enum": ["CASH","CARD"] },
    "idempotencyKey": { "type": "string" }
  }
}
```

**`ride.offer.created`**
```json
{
  "type": "object",
  "required": ["tripId","driverId","offerId","seq","expiresAt"],
  "properties": {
    "tripId":   { "type": "string" },
    "driverId": { "type": "string" },
    "offerId":  { "type": "string" },
    "seq":      { "type": "integer", "minimum": 0 },
    "expiresAt":{ "type": "string", "format": "date-time" },
    "distanceKm":{ "type": "number" }
  }
}
```

**`driver.assigned`** (inclui OTP temporário)
```json
{
  "type": "object",
  "required": ["tripId","driverId","passengerId","otp","otpExpiresAt"],
  "properties": {
    "tripId":      { "type": "string" },
    "driverId":    { "type": "string" },
    "passengerId": { "type": "string" },
    "otp":         { "type": "string", "pattern": "^[0-9]{4}$" },
    "otpExpiresAt":{ "type": "string", "format": "date-time" },
    "pickup":      { "type": "object" },
    "driver":      { "type": "object" }
  }
}
```

**`driver.location.updated`**
```json
{
  "type": "object",
  "required": ["driverId","userId","lat","lng","ts"],
  "properties": {
    "driverId":{ "type": "string" },
    "userId":  { "type": "string" },
    "lat":     { "type": "number" }, "lng": { "type": "number" },
    "cats":    { "type": "array", "items": { "type": "string" } },
    "online":  { "type": "boolean" },
    "ts":      { "type": "string", "format": "date-time" }
  }
}
```

**`ride.completed`**
```json
{
  "type": "object",
  "required": ["tripId","finalFare","distanceKm"],
  "properties": {
    "tripId":     { "type": "string" },
    "finalFare":  { "type": "number" },
    "distanceKm": { "type": "number" },
    "completedAt":{ "type": "string", "format": "date-time" },
    "ratingDue":  { "type": "boolean" }
  }
}
```

### 3.4 Tópicos/filas (mapeamento Kafka → Queues)

| Fila Cloudflare | Equivalente Kafka (uber) | Partição/ordenação |
|---|---|---|
| `ride-requests` | `ride.requested` | por `pickup` H3 (ou cidade) |
| `driver-locations` | `driver.location.updated` | por `driverId` |
| `ride-offers` | `ride.offered` / `driver.match.found` | por `tripId` |
| `trip-events` | `trip.events` | por `tripId` |
| `driver-responses` | `driver.response` | por `tripId` |
| `notifications` | `ridego.events` (subconjunto) | por `userId` |
| `earnings` | `payment.completed` | por `driverId` |

> A ordenação estrita é **por partição** (não global). Consumidores tratam eventos de um mesmo `tripId`/`driverId` em ordem; eventos de agregados distintos podem chegar fora de ordem — daí a necessidade de **versionamento de estado** (secção 8).

---

## 4. Kafka vs Redis Streams vs Cloudflare Queues

### 4.1 Tabela comparativa

| Critério | **Cloudflare Queues** | **Kafka (gerido, ex.: Aiven/Confluent)** | **Redis Streams (Upstash)** |
|---|---|---|---|
| Acesso a partir de Workers | ✅ Nativo (binding) | ❌ **Sem TCP nos Workers** — exige proxy HTTP (REST proxy / ponte) | ⚠️ Só via REST HTTP (Upstash) |
| Modelo | push/pull por lote (até 100 msgs) | pull contínuo por consumer group | pull por consumer group |
| Ordenação | por partição (não garantida entre partições) | estrita por partição | estrita por stream |
| Retenção | 24 h (Free) → **14 dias** (Pago) | configurável (dias–semanas) | por `MAXLEN`/tempo |
| Replay | limitado (retention) | ✅ total | ✅ total |
| Entrega | **at-least-once** + retries + DLQ | at-least-once / exactly-once (idempotente) | at-least-once |
| Throughput | 5 000 msg/s por fila; 250 consumidores | muito alto | alto |
| Lote | ✅ nativo | ✅ | ✅ |
| Custo (Pago) | 1M ops/mês incluídas → **$0,40/M ops** (3 ops/msg) | $15–50+/mês (Aiven) + egress | $0,20/100k comandos (Upstash) + HTTP |
| Free tier | 10 000 ops/dia | — | — |
| Ops burden | **zero** (managed CF) | alto (brokers, TLS, schema registry, SASL) | médio (Upstash gerido) |
| Geo/distribuição | edge global | clusters regionais | regional |
| Adequação ao hot path | ✅ | ❌ (proxy adiciona latência e custo) | ⚠️ |

### 4.2 Veredito para LADIESGO

- **Barramento principal = Cloudflare Queues.** Nativo, sem egress, custo desprezível, DLQ/retries integrados, e o *envelope* mantém compatibilidade futura com Kafka.
- **Redis (Upstash) apenas para GEO e locks** *se* for necessário estado geográfico partilhado fora do DO — mas o `DriverGeo` DO já cobre o caso de uso; **não introduzir Redis no hot path** nesta fase.
- **Kafka só mais tarde** para: (a) sink de analytics/BI, (b) integração com parceiros/auditoria, (c) reprodução histórica de eventos. Mesmo assim, os produtores em Cloudflare publicam via **proxy HTTP** — o que reforça a recomendação de manter o barramento em Queues e exportar para Kafka por um consumidor dedicado.

> **Custo de Kafka via proxy:** um proxy HTTP que aceita `POST /produce` e reencaminha ao Kafka gerido adiciona ~1 salto de rede, TLS e um componente a operar. Para uma operação em crescimento com quota apertada, é custo e risco evitáveis.

---

## 5. Roteiro de migração (fases, sem downtime)

Estratégia: **Strangler Fig + Outbox**. O monolito continua a servir o caminho síncrono enquanto os novos serviços são ligados progressivamente atrás de *feature flags*. Nenhuma fase exige janela de manutenção.

### Fase 0 — Fundamentos (1–2 dw) · risco baixo
- Criar biblioteca partilhada `packages/events`: `EventEnvelope`, `eventId` (ULID), schemas, serializadores, `publish()` e `consume()` tipados.
- Adicionar **idempotency keys** nos endpoints mutáveis (`trips/request`, `accept`, `complete`, `ratings`, `wallet/credit`).
- Adicionar **observabilidade**: contadores por evento, latência de consumidores, alertas de backlog/DLQ.
- Configurar filas e bindings (staging primeiro). **Sem mudança de comportamento.**

### Fase 1 — Outbox no monolito (2–3 dw) · risco baixo
- Cada transição de estado passa a escrever numa tabela `outbox` (D1) na **mesma transação** (D1 é single-threaded; usar `batch`).
- Um consumidor (`outbox-relay` Worker) lê o `outbox` e publica nas Queues; apaga após ACK.
- **Dual-run:** consumidores novos só gravam em tabelas *shadow*; nenhuma leitura de produção muda.
- Resultado: barramento vivo, zero impacto no mobile.

### Fase 2 — Extrair o Location Service (3–4 dw) · risco médio
- Criar `location-service` Worker + DO `DriverGeo` **sharded por cidade** (`idFromName(city)`), com *location hint*.
- O monolito passa a ingerir GPS enviando para o `location-service` (ou o cliente liga-se diretamente ao WS do DO).
- Publicar `driver.location.updated` e `driver.availability.changed`.
- **Reverter:** flag `USE_LOCATION_SERVICE=false` devolve o `PUT /drivers/location` ao comportamento atual.
- Valida: consistência do mapa, TTL 18 min, escrita na D1 só na transição offline→online.

### Fase 3 — Extrair o Notification Service (2–3 dw) · risco baixo/médio
- `notif-svc` consome `ride.*` → Expo Push + Telegram + in-app.
- Remover o fan-out de push do `TripRinger` (que passa a tratar só de *ring*/alarme).
- **Degradação:** se a fila de notificações estiver em backlog, o monólito reenvia push crítico (ex.: "motorista chegou") de forma best-effort.
- Resolver R8 (notificações eram stubs) com produto real.

### Fase 4 — Extrair o Matching Service (5–7 dw) · risco alto
- **A fase mais delicada** (estado partilhado + concorrência + SLA de oferta).
- `matching-svc` consome `ride.requested` + `driver.location.updated`; possui a fila de ofertas e os alarmes de 30 s; produz `ride.offer.*` e `ride.offer.accepted`.
- **Dark-launch:** correr o matching em *shadow* (sem efeitos) durante 1–2 semanas; comparar oferta escolhida, tempo até aceite e taxa de sucesso com o monolito.
- **Canary:** 5 % → 25 % → 100 % dos pedidos por flag + dimensão (cidade/categoria).
- **Reverter:** flag devolve o `buildOfferQueue`/`advanceOfferIfNeeded` ao monolito (código mantido até ao fim da Fase 7).
- Corrigir R2 (DOs globais) e R4 (OTP determinístico) aqui.

### Fase 5 — Extrair o Trip Service (CQRS/event-sourced) (5–8 dw) · risco alto
- Comandos (`assign/arrive/start/complete/cancel`) passam a **append-only** em `trip_events` (JSON) e o estado é derivado por *fold*.
- Read models (D1) alimentam as consultas; `query-service` separado para histórico/admin/analytics.
- OTP passa a ser **aleatório**, gerado no `trip-service`, guardado no DO da viagem (storage) com TTL; consumido uma vez.
- **Reverter:** as rotas REST antigas permanecem como *adapter* de compatibilidade (contratos 1:1 com o mobile).

### Fase 6 — Extrair Auth e Admin (3–4 dw) · risco médio
- `auth-svc`: guest/login/register/refresh/change-password/OTP de registo; possui `users`.
- `admin-svc`: painel, carteiras, categorias, aprovação de motoristas.
- Manter o mesmo `JWT_SECRET` para não invalidar sessões.

### Fase 7 — Desmantelar (2–3 dw) · risco baixo
- Desligar rotas do monolito uma a uma (flags), começar pelas menos críticas (`places`, `zone`, `route` → `geo-svc`).
- Aposentar `TripRinger`/`RequestsHub` globais (substituídos por DOs sharded + Queues).
- Migrar D1 única → D1 por domínio (ou manter uma, com schema por serviço) conforme volume.

### 5.1 Regras de ouro (todas as fases)

1. **Nunca quebrar o contrato do mobile** sem build novo.
2. **Feature flag por fase** + kill-switch instantâneo.
3. **Dual-run + shadow** antes de qualquer cutover.
4. **Backfill** de dados históricos antes de desligar o antigo.
5. **Métricas de comparação** (shadow): latência, taxa de aceite, receita/viagem, erros.
6. **Reversibilidade** garantida em cada passo.

---

## 6. Decomposição de serviços

### 6.1 Auth Service

| Item | Detalhe |
|---|---|
| Responsabilidades | `guest`, `login`, `register`, `refresh-token`, `change-password`, reset de senha, OTP de registo/recuperação, emissão/validação JWT (HS256, 7 d). |
| Dados | D1 `auth_db`: `users` (+ `otp_challenges`). |
| Produz | `user.registered`, `user.login`, `user.password.changed`. |
| Consome | — |
| Endpoints | `POST /auth/guest`, `/login`, `/register`, `/verify-register`, `/refresh-token`, `/change-password`. |
| Estado | stateless (JWT) + desafios OTP com TTL no DO/D1. |
| Notas | Manter o **mesmo `JWT_SECRET`** para não invalidar sessões; OTP de registo em 2 passos (padrão `uber`). |

### 6.2 Matching Service (Redis GEO)

| Item | Detalhe |
|---|---|
| Responsabilidades | Descobrir candidatas, ordenar, gerir a **fila de ofertas sequenciais**, raio expansivo 5→8→12 km, *broadcast* de fallback, alarmes de 30 s. |
| Dados | DO `DriverGeo` (sharded por cidade) + D1 `matching_db` (cache de elegibilidade). |
| Produz | `ride.offer.created`, `.expired`, `.skipped`, `.accepted`, `.rejected`. |
| Consome | `ride.requested`, `driver.location.updated`, `driver.availability.changed`. |
| Algoritmo | Filtro geográfico → scoring ponderado (`0.40·dist + 0.25·rating + 0.20·aceitação + 0.15·veículo`, padrão `Ride-Sharing-Service`) → oferta. |
| Concorrência | **Lock por motorista** (`SET NX EX 20` no DO) e **lock por viagem** para evitar aceites duplos. |
| Estado | DO com alarmes (TTL da oferta); fila persistida em storage do DO. |
| Notas | É o substituto direto do Redis GEO + Kafka consumer do `uber`. |

### 6.3 Trip Service (máquina de estados + OTP)

| Item | Detalhe |
|---|---|
| Responsabilidades | Comandos de ciclo de vida; máquina de estados; geração/validação de OTP; cálculo de fare/comissão; ETA. |
| Dados | D1 `trip_db`: `trips`, `trip_events` (append-only), `wallet_tx`; DO `TripPush` (1 por viagem). |
| Produz | `driver.assigned`, `driver.arrived`, `ride.started`, `ride.completed`, `ride.cancelled`, `ride.rated`, `trip.eta.updated`, `driver.earnings.updated`. |
| Consome | `ride.requested`, `driver.location.updated`, `driver-responses`, `ride.offer.accepted`. |
| Máquina de estados | `REQUESTED → ACCEPTED → DRIVER_ARRIVED → IN_PROGRESS → COMPLETED` / `CANCELLED` (em qualquer estado ativo); transições inválidas → 409. |
| OTP | 4 dígitos **aleatórios**, gerados no `driver.assigned`, guardados no storage do DO da viagem, TTL 10 min, **consumidos uma vez**. |
| CQRS | Escrita = append em `trip_events` + fold; leitura = read models. |

### 6.4 Notification Service

| Item | Detalhe |
|---|---|
| Responsabilidades | Traduzir eventos em canais: **Expo Push**, Telegram (fotos admin), in-app. |
| Dados | D1 `notif_db`: `notifications`, `delivery_log`. |
| Produz | `notification.delivered`, `notification.failed`. |
| Consome | `ride.*`, `driver.*`, `payment.*`, `trip.eta.updated`. |
| Confiabilidade | Retry com backoff; **DLQ** para falhas permanentes; dedupe por `eventId`; idempotência de envio. |
| Notas | Remover o fan-out do `TripRinger`; o "motorista chegou" tem fallback no monólito. |

### 6.5 Location Service (ingestão GPS)

| Item | Detalhe |
|---|---|
| Responsabilidades | Ingestão de GPS por WS, heartbeat, *batch/deadband*, publicar localizações. |
| Dados | DO `DriverGeo` (sharded); D1 só para transições online/offline. |
| Produz | `driver.location.updated`, `driver.availability.changed`. |
| Consome | — (recebe WS diretamente). |
| Otimizações | 1 fix/10 s por motorista; deadband ≥ 150 m ou 30 s (já existe no `TripPush`); amostragem adaptativa (5 s em viagem / 10 s idle). |
| Notas | 0 escritas D1 por ping (regra já cumprida). |

### 6.6 (Futuro) Earnings / Payment Service

| Item | Detalhe |
|---|---|
| Responsabilidades | Comissão 14 %, `wallet_tx`, bloqueio por saldo negativo, pagamentos (stub hoje). |
| Produz | `driver.earnings.updated`, `payment.completed/failed`. |
| Notas | Extrair de `applyCommission()` (hoje inline) para um consumidor dedicado com idempotência. |

---

## 7. Diagramas de fluxo de dados

### 7.1 Fluxo feliz — pedido → conclusão

```
Passageira                api-gateway        trip-service       matching-svc      location-svc      notif-svc
    │  POST /trips/request      │                  │                  │                │               │
    │──────────────────────────▶│                  │                  │                │               │
    │                           │  ride.requested  │                  │                │               │
    │                           │─────────────────▶│                  │                │               │
    │                           │                  │  enqueue          │                │               │
    │                           │                  │─────────────────▶│                │               │
    │                           │                  │                  │ GEORADIUS (DO) │               │
    │                           │                  │                  │◀──drivers──────│               │
    │                           │                  │  ride.offer.created               │               │
    │                           │                  │                  │───────────────▶│  push motorista│
    │                           │                  │                  │                │──────────────▶│
    │                           │                  │                  │                │  (Expo)       │
    │                           │  ride.offer.accepted                │                │               │
    │                           │◀─────────────────────────────────────│                │               │
    │                           │  driver.assigned (OTP)              │                │               │
    │                           │─────────────────▶│ (OTP no DO)      │                │               │
    │  PUT /trips/:id/start      │                  │                  │                │               │
    │──────────────────────────▶│  OTP válido?     │                  │                │               │
    │                           │─────────────────▶│  ride.started    │                │               │
    │                           │                  │──────────────────────────────────────────────────▶│ push
    │                           │                  │                  │                │               │
    │  PUT /trips/:id/complete   │                  │                  │                │               │
    │──────────────────────────▶│  ride.completed  │                  │                │               │
    │                           │─────────────────▶│  append event    │                │               │
    │                           │                  │  earnings-svc (comissão 14%)     │               │
```

### 7.2 Ciclo de ofertas sequenciais (Matching Service)

```
ride.requested ─▶ [fila ordenada por distância] ─▶ offer.created(seq=0, TTL 30s)
                                                   │
                          ┌────── aceita ◀────────┤
                          ▼                        │ expira/skip
                   driver.assigned           offer.expired / offer.skipped
                                                  │
                                                  ▼
                                    offer.created(seq=1, TTL 30s)
                                                  │
                          ... até esgotar a fila ...
                                                  ▼
                              offerBroadcast = true ─▶ push a todas as online
                                                  │
                              (alarme DO: 4s/8s/15s; máx. 4 toques por motorista)
```

### 7.3 Ingestão de GPS (Location Service)

```
motorista ──WSS──▶ DriverGeo DO (sharded por cidade)
                      │  setPos() em memória (0 escritas D1)
                      │  1 fix/10s · deadband 150m/30s
                      ▼
              driver.location.updated ──▶ Queues ──┬─▶ matching-svc (pool)
                                                   ├─▶ trip-svc (ETA)
                                                   └─▶ notif-svc (se relevante)
              transição offline→online ──▶ 1 escrita D1 (drivers.isOnline)
```

### 7.4 Outbox (transição sem downtime, Fase 1)

```
Monolito (D1, single-threaded)
  BEGIN batch:
     UPDATE trips ...            (mudança de estado)
     INSERT outbox(event)        (mesma transação)
  COMMIT
        │
        ▼
outbox-relay Worker ──▶ Queues ──▶ consumidores novos (shadow)
        │ ACK
        ▼
  DELETE outbox
```

### 7.5 Falha / degradação

```
Queue em backlog ──▶ consumidor lento ──▶ alarme ──▶ shed de eventos de baixa prioridade
DO sobrecarregado ──▶ 503 + retry com jitter ──▶ fallback: monólito serve caminho síncrono
D1 quota esgotada ──▶ writes falham ──▶ buffer em Queue/R2 ──▶ retry até reset 00:00 UTC
Provider de push em baixo ──▶ DLQ ──▶ retry ──▶ alerta
```

---

## 8. Modos de falha e recuperação

| # | Falha | Efeito | Deteção | Recuperação |
|---|---|---|---|---|
| F1 | **Evento duplicado** (at-least-once) | Oferta/comissão duplicada | `eventId` já em `processed_events` | **Dedupe** por `eventId`; consumidor é idempotente |
| F2 | **Eventos fora de ordem** | `ride.completed` antes de `started` | `stateVersion` / `causationId` | Reordenar por `aggregateId`; rejeitar transição inválida (409) |
| F3 | **Backlog de Queue** | Ofertas atrasadas, SLA falha | métrica de backlog + alarme | Escalar consumidores; *shed* de baixa prioridade; aumentar lote |
| F4 | **DO sobrecarregado** (~1 000 req/s/obj) | 503, ofertas perdidas | contadores por DO | **Shard por cidade/H3**; retry com jitter; 503 ao cliente |
| F5 | **OTP incorreto/expirado** | Viagem não arranca | validação no DO | OTP aleatório + TTL; regenerar no reassign |
| F6 | **Comissão duplicada** | Perda de dinheiro | `wallet_tx` único por `tripId`+tipo | Idempotência + `ON CONFLICT DO NOTHING` |
| F7 | **Timeout de externos** (Nominatim/OSRM/Photon) | `places`/`route` lentos | timeout 4–8 s + circuit breaker | Fallback offline (`offlineZone`, cache 604800 s); fila dedicada |
| F8 | **Push Expo em baixo** | Motorista não é avisada | DLQ + contador de falhas | Retry backoff; DLQ; fallback SMS/WhatsApp futuro |
| F9 | **Quota D1 esgotada (erro 7500)** | Toda a escrita → 500 | alerta de quota | Buffer em Queue/R2; retry; ler continua OK |
| F10 | **Perda parcial de eventos** | Estado divergente | reconciliação | **Cron de reconciliação** (comparar `trips` vs `trip_events`); backfill |
| F11 | **Poison message** | Consumidor em loop | retries excedidos | Mover para **DLQ**; alerta; corrigir schema |
| F12 | **Retry storm** | Sobrecarga | métrica de retries | Backoff exponencial + jitter; *circuit breaker* |
| F13 | **Clock skew** | TTL/ordenação erradas | timestamps ISO UTC | Usar `occurredAt` do produtor + `serverNow`; nunca relógio local |
| F14 | **Falha do consumidor** | Eventos acumulam | backlog alarm | Redeploy; replay a partir da retention (14 dias) |
| F15 | **Corrupção/bug de schema** | Consumidor falha | validação de schema na entrada | Rejeitar + DLQ; versionar eventos (`version`) |

### 8.1 Padrões obrigatórios

- **Idempotência**: todo o consumidor grava `eventId` antes de aplicar; `INSERT OR IGNORE`.
- **DLQ**: cada fila tem dead-letter; alerta imediato.
- **Reconciliação**: Cron (≤15 min) compara estado autoritativo vs projeções; reprocessa.
- **Circuit breaker**: para externos; degradar para valor cacheado/default.
- **Feature flags**: kill-switch por serviço/fase.
- **Observabilidade**: métricas por evento (produzido/consumido/latência/DLQ), traces por `correlationId`.

---

## 9. Análise de custos (Cloudflare Workers + D1 + Redis/Queues)

### 9.1 Premissas (de `docs/research/02`)

| Métrica | 1k | 10k | 50k | 200k viagens/dia |
|---|---|---|---|---|
| Motoristas online (N≈0,02·T) | 20 | 200 | 1 000 | 4 000 |
| Pings GPS/dia | 432k | 4,32M | 21,6M | 86,4M |
| Pedidos Worker/mês | 1,5M | 15M | 75M | 300M |
| Eventos/viagem (estimado) | 25 | 25 | 25 | 25 |
| Eventos/mês | 0,75M | 7,5M | 37,5M | 150M |

> Estimativa de ~25 eventos/viagem: 1 `requested` + 1 `estimated` + ~10–15 ofertas + 1 `accepted` + 1 `assigned` + 1 `arrived` + 1 `started` + 1 `completed` + 1–3 `eta.updated` + 2–3 notificações.

### 9.2 Custo incremental do event-driven (Queues + DO)

| Componente | Fórmula | 10k/dia | 50k/dia | 200k/dia |
|---|---|---|---|---|
| **Queues** | 3 ops/msg × eventos/mês × $0,40/M | $9,0 | $45,0 | $180,0 |
| **DO requests** | mensagens consumidas × $0,15/M | ~$1,7 | ~$8,5 | ~$34 |
| **D1 writes** | escritas/mês × $1/M | ~$0,1 | ~$0,5 | ~$2 |
| **Total incremental** | — | **~$11** | **~$54** | **~$216** |

> As Queues incluem 1M ops/mês; acima disso o custo é residual ($0,40/M). O custo incremental por viagem é **<$0,001**.

### 9.3 Comparação de stack (50k viagens/dia, Neon Launch)

| Cenário | Custo/mês estimado | Comentário |
|---|---|---|
| **Monolito atual** (Workers + DO + D1 + externos) | ~$40–70 | Sem barramento; quota D1 frágil; DOs globais |
| **Event-driven Cloudflare puro** | **~$565–620** | Queues + DO sharded + D1 por domínio; sem egress |
| **Event-driven + Kafka gerido** | **~$620–700** | +$15–50 Kafka + proxy HTTP + egress |
| **Event-driven + Redis (Upstash)** | **~$570–640** | só se GEO fora do DO |

> **Nota:** a maior parte do custo vem do **cómputo da BD** (Neon Launch/Scale), não do barramento. Por isso a otimização decisiva mantém-se: **GPS e estado quente em DO, nunca na BD**, e **Hibernation em todos os WS**.

### 9.4 Alavancas de custo (ROI por ordem)

1. **Hibernation WS** em `TripPush`/`RequestsHub`/`DriverGeo` — elimina duração ociosa.
2. **Batching de GPS** (3–5 s) + **deadband** (20–50 m) — corta mensagens DO em 60–80 %.
3. **Queues em vez de polling** — elimina pedidos HTTP por ping.
4. **Cache de places/route/ETA** (já parcialmente feito) — reduz externas.
5. **D1 por domínio** — evita hotspot single-threaded e quota concentrada.
6. **Amostragem de logs** (5–10 %) antes da mudança de pricing de Observability (Dec 2026).
7. **Arquivo frio em R2** — viagens antigas fora da D1 quente.

---

## 10. Decisões arquiteturais (ADR resumido)

| ADR | Decisão | Alternativa rejeitada | Razão |
|---|---|---|---|
| ADR-1 | Barramento = **Cloudflare Queues** | Kafka/Redis Streams | Nativo, sem TCP/egress, custo residual, DLQ integrado |
| ADR-2 | Envelope **compatível com Kafka** | formato proprietário | Portabilidade futura sem reescrever produtores |
| ADR-3 | Estado quente em **DO**, autoritativo em **D1** | tudo na BD | Limite DO/BD e quota; Hibernation |
| ADR-4 | Matching **sharded por cidade → H3** | DO global | Remove SPOF ~1 000 req/s |
| ADR-5 | OTP **aleatório no DO** | OTP determinístico (`pinForTrip`) | Segurança (R4) |
| ADR-6 | Migração **Strangler Fig + Outbox** | big-bang | Zero downtime, reversível |
| ADR-7 | Contratos **1:1 com o mobile** durante a migração | quebrar e rebuild | Evita buildsforçados e downtime |
| ADR-8 | Kafka só para **analytics/auditoria** | no hot path | Proxy HTTP adiciona latência/custo/SPOF |

---

## 11. Riscos e mitigações (resumo)

| Risco | Impacto | Mitigação |
|---|---|---|
| Matching mal migrado (Fase 4) | Viagens perdidas | Dark-launch + canary + rollback por flag |
| DOs globais (R2) | Outage | Shard por cidade (Fase 4) |
| Eventos duplicados/fora de ordem | Inconsistência financeira | Idempotência + versionamento + reconciliação |
| Quota D1 (R7) | Escrita 500 | D1 por domínio + buffer em Queue |
| Queues sem TCP para Kafka | — | Manter Queues; Kafka via consumidor dedicado |
| Custo de cómputo BD | $ | Hibernation, batching, cache, arquivo frio |
| Equipa pequena | Execução lenta | Fases pequenas e independentes; parar na Fase 5 se necessário |

---

## 12. Conclusão

A migração do Worker monolítico para uma arquitetura event-driven **não exige trocar de cloud**. O essencial é introduzir um **barramento de eventos versionados e idempotentes** (Cloudflare Queues) e extrair, em fases reversíveis, os cinco serviços críticos:

1. **Auth Service** (identidade e JWT);
2. **Matching Service** (Redis GEO → `DriverGeo` DO sharded);
3. **Trip Service** (máquina de estados + OTP + event sourcing/CQRS);
4. **Notification Service** (Expo/Telegram/in-app);
5. **Location Service** (ingestão GPS).

Os padrões dos repositórios de referência são diretamente aplicáveis — Kafka → Queues, Redis GEO → DO, STOMP → WS hibernável, event sourcing/CQRS → `trip_events` + read models — mantendo o envelope de evento compatível com Kafka para uma ponte futura.

O maior ganho não é só técnico: é **operacional** — deploys independentes, escala isolada, replay/auditoria e um caminho claro para pagamentos e notificações reais (hoje stubs). O roteiro proposto garante **zero downtime** e reversibilidade em cada fase, respeitando a realidade da quota D1 e da stack Cloudflare atual.
