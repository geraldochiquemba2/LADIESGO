# Comparacao: LADIESGO vs Repositorios de Taxi Open-Source

Data: 2026-10-17

---

## 1. Repositorios Analisados

| Repositorio | Stack | Destaques |
|---|---|---|
| [ayu-haker/ride-hailing-platform](https://github.com/ayu-haker/ride-hailing-platform) | NestJS microservices, Flutter, React, Docker/K8s | Microservicos, Redis throttling, circuit breakers |
| [rashid-mamun/ride-hailing-microservices](https://github.com/rashid-mamun/ride-hailing-microservices) | NestJS monorepo, Turborepo, Redis, TypeORM | API Gateway, Redis throttling, idempotency keys, Outbox |
| [vivenn/ridematch](https://github.com/vivenn/ridematch) | NestJS, Redis GEO, Socket.IO, Lua scripts | Redis GEO search, batched offers, atomic Lua assignment |
| [SaiKrishnaMulukutla/uber](https://github.com/SaiKrishnaMulukutla/uber) | Go, Kafka, Redis GEO, PostgreSQL | Event-driven, Kafka, Redis GEO, OTP verification |
| [Sparsh1501/Ride-Sharing-Service](https://github.com/Sparsh1501/Ride-Sharing-Service) | Java 17, Spring Boot, Redis GEO, Kafka, STOMP | CQRS, event sourcing, consistent hashing, surge pricing |
| [emmaoluga-sketch/Rider](https://github.com/emmaoluga-sketch/Rider) | Go, Redis GEO, WebSocket, PostgreSQL/PostGIS | Redis GEOSEARCH, distributed locks, race-free assignment |
| [majidkhazaei/redis-taxi-system](https://github.com/majidkhazaei/redis-taxi-system) | Redis, Python, Lua, Pub/Sub | Atomic Lua assignment, Redis Streams, Pub/Sub |
| [toufiq-dev/RideShare-API-v2](https://github.com/toufiq-dev/RideShare-API-v2) | NestJS, modular | Auth, real-time, payments, geofencing |
| [yohhannees/Ride-Hailing-Distributed-Microservice](https://github.com/yohhannees/Ride-Hailing-Distributed-Microservice) | Node.js, NestJS, Django, FastAPI | Multi-language microservices, notifications |

---

## 2. Padroes de Comunicacao em Tempo Real

### 2.1 WebSocket (Socket.io) — Usado por: LADIESGO, ridematch, Rider, RideShare-API-v2

**Como funcao:**
- Conexao persistente bidirecional
- Sala por viagem (`ride:{id}`) para isolar comunicacao
- Driver envia GPS a cada 4-5s, servidor faz broadcast para passageiro

**Otimizacoes encontradas:**
| Tecnica | Descricao | Beneficio |
|---|---|---|
| **Redis Adapter** | Pub/Sub entre multiplos servidores Socket.io | Horizontal scaling |
| **Sticky Sessions** | Load balancer roteia mesmo cliente ao mesmo servidor | Evita "Session ID unknown" |
| **Connection Pooling** | Limite de conexoes por servidor (ex: 5000) | Previne thrashing |
| **Heartbeat/Ping-Pong** | Detecta conexoes mortas em 30s | Liberta recursos |
| **Per-connection Rate Limit** | Token bucket: 100 msgs capacity, 10 msgs/sec refill | Previne flood/DoS |
| **Idle Timeout** | Fecha conexoes sem dados em 60-100s | Recupera memoria |
| **Message Size Cap** | Rejeita payloads > 64KB | Previne abuso |
| **Exponential Backoff + Jitter** | Cliente reconecta com delay crescente aleatorio | Evita thundering herd |

### 2.2 Redis GEO — Usado por: ridematch, Rider, uber, Ride-Sharing-Service

**Como funcao:**
- `GEOADD drivers:geo <lng> <lat> <driverId>` — indexa localizacao
- `GEORADIUS drivers:geo <lng> <lat> 5 km` — busca drivers proximos em O(log N)
- TTL de 30s: driver que nao pinga e removido automaticamente

**Vantagem sobre PostgreSQL/PostGIS:**
- Redis: ~2ms por query GEORADIUS
- PostGIS: ~50-200ms (re-indexa a cada update)
- Redis: 100K+ writes/sec por node
- Gojek: 600K writes/min + 200K searches/min com Redis cluster

### 2.3 Kafka (Event-Driven) — Usado por: uber, Ride-Sharing-Service

**Como funcao:**
- `ride.requested` → matching-service consome, encontra driver
- `ride.offered` → notification-service push ao driver
- `driver.assigned` → trip-service gera OTP, persiste
- `driver.location.updated` → dispatch, notification, surge consomem

**Beneficios:**
- Desacoplamento: cada servico escala independentemente
- Resiliencia: se matching-service cai, requests ficam na fila
- Replay: eventos persistidos por 7 dias permitem replay

### 2.4 Polling com Fallback — Usado por: LADIESGO

**Como funcao:**
- WebSocket primeiro, polling de fallback (8s)
- Reduz uso real de quota (conta Cloudflare)

---

## 3. Padroes de Otimizacao de Servidor

### 3.1 Arquitetura de Microservicos

```
                    ┌─────────────────────┐
  Client  ────────► │   API Gateway       │
                    │  (Auth, Rate Limit) │
                    └─────────┬───────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
    ┌─────▼─────┐      ┌─────▼─────┐      ┌─────▼─────┐
    │  Auth     │      │  Matching │      │  Trip     │
    │  Service  │      │  Service  │      │  Service  │
    └───────────┘      └───────────┘      └───────────┘
                              │                   │
                       ┌──────▼──────┐     ┌──────▼──────┐
                       │  Redis GEO  │     │  PostgreSQL │
                       └─────────────┘     └─────────────┘
```

**Beneficios:**
- Matching-service escala por GPS throughput
- Trip-service escala por ride volume
- Auth-service escala independentemente
- Se um servico cai, os outros continuam

### 3.2 Rate Limiting e Throttling

| Camada | Tecnica | Valor tipico |
|---|---|---|
| API Gateway | Requests/sec por IP | 100-300 RPS |
| WebSocket | Mensagens/sec por conexao | 10-20 msgs/sec |
| WebSocket | Max conexoes por IP | 10 |
| WebSocket | Max conexoes por user | 5 |
| Location Service | GPS updates/sec | 250K (cluster) |
| D1/DB | Writes/dia | 100K (Cloudflare free) |

### 3.3 Cache Strategy

| Dados | Cache | TTL | Razao |
|---|---|---|---|
| Driver locations | Redis GEO | 30s | Real-time, descartavel |
| User sessions | Redis | 7d | Evita DB lookup |
| Trip status | Redis Hash | 5min | Leitura frequente |
| Places/FTS | D1 (Cloudflare) | Permanente | 23K registos, leitura intensiva |
| Fare estimates | Redis | 60s | Evita recalculo |

### 3.4 Connection Management

```
Server Capacity Planning:
- 1 WebSocket connection = ~2-10 KB RAM
- 10K connections = ~20-100 MB RAM
- 100K connections = ~200 MB - 1 GB RAM
- File descriptors: ulimit -n 1048576
- Single server tuned: 500K+ idle connections
```

### 3.5 Load Shedding (Rejeicao graciosa)

- Quando servidor atinge 80% capacidade: rejeita novas conexoes com code 1013
- Prioriza conexoes ativas sobre novas
- Health check endpoint para load balancer remover servidor do pool

---

## 4. Comparacao: LADIESGO vs Melhores Praticas

### 4.1 O que o LADIESGO ja faz bem

| Aspecto | LADIESGO | Status |
|---|---|---|
| WebSocket com fallback polling | Sim (8s poll) | Bom |
| D1 para dados estaticos (places) | Sim (23K registos) | Bom |
| Duas contas Cloudflare (separacao API/Pages) | Sim | Bom |
| WebSocket primeiro, polling fallback | Sim | Bom |
| D1 FTS (Full-Text Search) | Sim (migration 0008) | Bom |

### 4.2 O que falta ou pode melhorar

| Aspecto | LADIESGO atual | Melhores praticas | Prioridade |
|---|---|---|---|
| **Redis GEO para drivers** | Nao usa (D1 SQL) | Redis GEOADD/GEORADIUS (~2ms) | ALTA |
| **Redis Adapter (Socket.io)** | Nao usa (single server) | Redis Pub/Sub para multi-server | ALTA |
| **Rate limiting WebSocket** | Nao implementado | Token bucket per connection | ALTA |
| **Connection pooling** | Nao implementado | Max 5000/servidor, heartbeat 30s | MEDIA |
| **Sticky sessions** | N/A (single server) | Necessario se escalar para multi-server | MEDIA |
| **Event-driven (Kafka/Streams)** | Nao usa | Desacoplamento de servicos | BAIXA |
| **Microservicos** | Monolito (Cloudflare Worker) | Separar matching/trip/auth | BAIXA |
| **Idle timeout** | Nao implementado | 60-100s sem dados = disconnect | MEDIA |
| **Message size cap** | Nao implementado | Max 64KB por mensagem | BAIXA |
| **Load shedding** | Nao implementado | Rejeitar a 80% capacidade | BAIXA |
| **OTP de viagem** | Nao implementado | Codigo 4-digit anti "ghost rides" | MEDIA |
| **Consistent hashing** | Nao usa | 150 virtual nodes, <10% remap | BAIXA |

### 4.3 Problemas criticos do LADIESGO (baseado no AGENTS.md)

| Problema | Causa raiz | Solucao |
|---|---|---|
| **Erro 1027 (429)** — Workers quota | Testes de carga (2000 contas) | Nunca testar contra producao |
| **Erro 7500** — D1 writes quota | Reimportar BD inteira (23K writes) | Usar migrations incrementais |
| **Token refresh quebrado** | use-account.ps1 nao preserva token | Copiar default.toml antes de trocar |
| **Single point of failure** | Um Worker, um servidor | Redis Adapter + multi-server |

---

## 5. Recomendacoes Prioritarias para LADIESGO

### Fase 1 — Imediata (evitar exceder servidores)

1. **Rate limiting no Worker**
   - Max 100 requests/min por IP
   - Max 20 WebSocket msgs/sec por conexao
   - Max 10 conexoes WebSocket por IP

2. **Idle timeout no WebSocket**
   - Fechar conexoes sem dados em 60s
   - Heartbeat ping a cada 30s

3. **Connection cap**
   - Max 1000 conexoes WebSocket por Worker (Cloudflare free: 1000/Worker)
   - Rejeitar com code 1013 se atingir limite

4. **Nunca reimportar BD inteira**
   - Usar `wrangler d1 migrations apply` (incremental)
   - Um import completo = ~23K writes (23% do limite diario)

### Fase 2 — Curto prazo (1-2 semanas)

5. **Redis GEO para driver locations**
   - Substituir D1 SQL por Redis GEOADD/GEORADIUS
   - TTL 30s: driver que nao pinga e removido
   - Busca de drivers proximos: ~2ms vs ~50ms SQL

6. **Redis Adapter para Socket.io**
   - Permite multi-server horizontal
   - Sticky sessions no load balancer
   - Pub/Sub entre instancias

7. **OTP de viagem (4-digit)**
   - Anti "ghost rides" (motorista inicia sem passageiro)
   - Gerado quando driver aceita, passageiro lê codigo

### Fase 3 — Medio prazo (1-2 meses)

8. **Separar servicos**
   - Matching-service (GPS ingestion, Redis GEO)
   - Trip-service (estado, OTP, tracking)
   - Auth-service (login, tokens)

9. **Event-driven architecture**
   - Kafka ou Redis Streams para eventos
   - Desacoplamento: matching nao depende de trip
   - Replay de eventos para debugging

10. **Monitoring e alertas**
    - Prometheus + Grafana
    - Alertas em p99 latency, error rate, connection count
    - Dashboard em tempo real

---

## 6. Resumo: Como os grandes repositorios evitam exceder servidores

| Tecnica | Uber/Gojek | LADIESGO pode adotar? |
|---|---|---|
| Redis GEO para localizacao | Sim (600K writes/min) | Sim — substituir D1 SQL |
| Redis Adapter (multi-server) | Sim | Sim — permite escalar |
| Rate limiting por conexao | Sim | Sim — token bucket |
| Connection pooling | Sim (5000/servidor) | Sim — limite 1000/Worker |
| Heartbeat + idle timeout | Sim (30s) | Sim — ping 30s, timeout 60s |
| Event-driven (Kafka) | Sim | Medio prazo — Redis Streams |
| Microservicos | Sim | Medio prazo — separar matching/trip |
| Load shedding | Sim | Sim — rejeitar a 80% |
| Sticky sessions | Sim | Sim — se multi-server |
| Message size cap | Sim (64KB) | Sim — validar no Worker |

---

## 7. Conclusao

O LADIESGO tem uma base solida (WebSocket + D1 + Cloudflare), mas esta vulneravel a quotas porque:

1. **Nao tem rate limiting** — qualquer cliente pode fazer requests ilimitados
2. **Nao tem Redis GEO** — D1 SQL e lento para localizacao em tempo real
3. **Nao tem connection management** — sem limite de conexoes, sem heartbeat
4. **Reimporta BD inteira** — consome 23% do limite diario de writes

**As 3 acoes mais importantes para NAO exceder servidores:**
1. Implementar rate limiting (requests + WebSocket msgs)
2. Adicionar Redis GEO para driver locations
3. Nunca reimportar BD — usar migrations incrementais
