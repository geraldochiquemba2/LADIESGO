# Plano de Testes — LADIESGO

## 1. Visão Geral

| Tipo | Ficheiro | Descrição |
|------|----------|-----------|
| Unitários | `e2e/tests/websocket-limits.mjs` | Limites de conexão WS, heartbeat, tamanho de mensagem |
| Unitários | `e2e/tests/rate-limiting.mjs` | Rate limiting HTTP e WebSocket |
| Unitários | `e2e/tests/d1-write-quota.mjs` | Monitorização da quota de escrita D1 |
| Integração | `cloudflare/api-worker/loadtest/full-journey-e2e.mjs` | Ciclo de vida completo da viagem |
| Carga | `cloudflare/api-worker/loadtest/firetest.mjs` | Testes de carga HTTP |
| Carga | `cloudflare/api-worker/loadtest/ws-storm.mjs` | Testes de carga WebSocket |
| Segurança | `e2e/tests/rate-limiting.mjs` | Bypass de rate limit, JWT inválido |
| Performance | `cloudflare/api-worker/loadtest/k6/ladiesgo.js` | Comparação Redis GEO vs D1 SQL |

## 2. Testes Unitários

### 2.1 Autenticação (`auth`)

| ID | Teste | Método | Esperado |
|----|-------|--------|----------|
| AUTH-01 | Login admin mestre | `POST /api/v1/auth/login` | 200 + JWT |
| AUTH-02 | Login com credenciais erradas | `POST /api/v1/auth/login` | 401 |
| AUTH-03 | Registo com número duplicado | `POST /api/v1/auth/register` | 409 |
| AUTH-04 | Registo com senha curta | `POST /api/v1/auth/register` | 400 |
| AUTH-05 | Token expirado | `GET /api/v1/users/profile` | 401 |
| AUTH-06 | Token mal formado | `GET /api/v1/users/profile` | 401 |
| AUTH-07 | Refresh token válido | `POST /api/v1/auth/refresh-token` | 200 + novo JWT |
| AUTH-08 | Guest login | `POST /api/v1/auth/guest` | 200 + JWT |

### 2.2 Viagens (`trips`)

| ID | Teste | Método | Esperado |
|----|-------|--------|----------|
| TRIP-01 | Pedir viagem | `POST /api/v1/trips/request` | 200 + tripId |
| TRIP-02 | Aceitar viagem | `PUT /api/v1/trips/:id/accept` | 200 |
| TRIP-03 | Aceitar viagem já aceita | `PUT /api/v1/trips/:id/accept` | 400 |
| TRIP-04 | Iniciar viagem sem PIN | `PUT /api/v1/trips/:id/start` | 400 |
| TRIP-05 | Iniciar viagem com PIN correto | `PUT /api/v1/trips/:id/start` | 200 |
| TRIP-06 | Completar viagem | `PUT /api/v1/trips/:id/complete` | 200 |
| TRIP-07 | Cancelar viagem ativa | `PUT /api/v1/trips/:id/cancel` | 200 |
| TRIP-08 | Transição inválida | `PUT /api/v1/trips/:id/accept` (já completada) | 400 |

### 2.3 Motoristas (`drivers`)

| ID | Teste | Método | Esperado |
|----|-------|--------|----------|
| DRV-01 | Toggle online | `PUT /api/v1/drivers/toggle-online` | 200 |
| DRV-02 | Toggle online com carteira bloqueada | `PUT /api/v1/drivers/toggle-online` | 403 |
| DRV-03 | Atualizar localização | `PUT /api/v1/drivers/location` | 200 |
| DRV-04 | Localização inválida (NaN) | `PUT /api/v1/drivers/location` | 400 |
| DRV-05 | Listar motoristas próximos | `GET /api/v1/drivers/nearby` | 200 + array |
| DRV-06 | Registo de motorista bloqueado | `POST /api/v1/drivers/register` | 400 |

### 2.4 Localizações (`locations`)

| ID | Teste | Método | Esperado |
|----|-------|--------|----------|
| LOC-01 | Pesquisa de locais | `GET /api/places/search?q=...` | 200 + places |
| LOC-02 | Pesquisa com query curta | `GET /api/places/search?q=a` | 200 + vazio |
| LOC-03 | Zona por coordenadas | `GET /api/zone?lat=...&lng=...` | 200 + zone |
| LOC-04 | Rota entre pontos | `GET /api/route?from=...&to=...` | 200 + points |
| LOC-05 | Motoristas próximos com TTL | `GET /api/v1/drivers/nearby` | Posições < 18min |

## 3. Testes de Integração

### 3.1 Ciclo de Vida Completo da Viagem

```
request → accept → arrived → start (PIN) → complete → rating
```

| ID | Passo | Validação |
|----|-------|-----------|
| E2E-01 | Passageira pede viagem | 200 + tripId + fare |
| E2E-02 | Motorista recebe pedido | hubPoke + fetch /trips/incoming |
| E2E-03 | Motorista aceita | 200 + status ACCEPTED |
| E2E-04 | Motorista chega | 200 + status DRIVER_ARRIVED |
| E2E-05 | Passageira vê PIN | GET /trips/:id → pin |
| E2E-06 | Motorista inicia com PIN | 200 + status IN_PROGRESS |
| E2E-07 | GPS transmitido via WS | driver → pax (150m+) |
| E2E-08 | Viagem completada | 200 + status COMPLETED + finalFare |
| E2E-09 | Avaliação registada | POST /api/v1/ratings → 200 |

### 3.2 WebSocket Tempo Real

| ID | Teste | Esperado |
|----|-------|----------|
| WS-01 | Passageira liga a /trips/:id/live | 101 + hello |
| WS-02 | Motorista liga a /trips/:id/live | 101 + hello |
| WS-03 | Ping → Pong | < 1s |
| WS-04 | GPS driver → passageira | frame em < 2s |
| WS-05 | Chat bidirecional | entrega garantida |
| WS-06 | Status da viagem broadcast | todos os sockets |

## 4. Testes de Carga

### 4.1 Limites de Conexão WebSocket

| ID | Teste | Valor | Comportamento Esperado |
|----|-------|-------|------------------------|
| LOAD-01 | Máx. conexões por Worker | 5000 | Rejeição acima do limite |
| LOAD-02 | Idle timeout | 60s | Desconexão automática |
| LOAD-03 | Heartbeat (ping/pong) | 15s intervalo | Conexão mantida |
| LOAD-04 | Tamanho máx. mensagem | 64KB | Rejeição se exceder |
| LOAD-05 | Rate limiting WS | 10 msgs/s | Drop de mensagens |

### 4.2 Rate Limiting HTTP

| ID | Teste | Limite | Esperado |
|----|-------|--------|----------|
| RATE-01 | Requests por IP | 100/min | 429 ao exceder |
| RATE-02 | Conexões WS por IP | 10 | Rejeição acima |
| RATE-03 | Load shedding | 80% capacidade | 503 temporário |

## 5. Testes de Segurança

### 5.1 JWT

| ID | Teste | Ataque | Defesa |
|----|-------|--------|--------|
| SEC-01 | Token expirado | Reutilização | 401 |
| SEC-02 | Token mal formado | String aleatória | 401 |
| SEC-03 | Token sem assinada | Header none | 401 |
| SEC-04 | Token com segredo errado | Brute force | 401 |
| SEC-05 | Token de outro utilizador | Substituição | 401 |

### 5.2 Rate Limit Bypass

| ID | Teste | Método |
|----|-------|--------|
| SEC-06 | Rotação de IPs | X-Forwarded-For |
| SEC-07 | Rotação de tokens | Múltiplos JWTs |
| SEC-08 | Path traversal | `/api/v1/../admin/stats` |

### 5.3 Tamanho de Mensagem

| ID | Teste | Tamanho | Esperado |
|----|-------|---------|----------|
| SEC-09 | Mensagem WS grande | 128KB | Rejeição |
| SEC-10 | HTTP body grande | 10MB | 413 |
| SEC-11 | SQL injection | Query maliciosa | Sanitizada |

## 6. Testes de Performance

### 6.1 Redis GEO vs D1 SQL

| Métrica | Redis GEO | D1 SQL (atual) |
|---------|-----------|----------------|
| Latência escrita GPS | ~1ms | ~15ms |
| Latência leitura nearby | ~2ms | ~10ms |
| Custo por 1000 ops | $0.20 | $0.00 (incluso) |
| Escala horizontal | Cluster | Shard |

### 6.2 Benchmarks Alvo

| Endpoint | P50 | P95 | P99 |
|----------|-----|-----|-----|
| POST /auth/login | 50ms | 150ms | 300ms |
| POST /trips/request | 100ms | 300ms | 500ms |
| GET /drivers/nearby | 50ms | 150ms | 250ms |
| WS GPS round-trip | 50ms | 200ms | 400ms |

## 7. Configuração do Ambiente de Teste

### 7.1 Staging

```bash
# Deploy staging
npx wrangler@4.151.1 deploy --env staging

# Segredos
npx wrangler@4.151.1 secret put JWT_SECRET --env staging
npx wrangler@4.151.1 secret put DEBUG_KEY --env staging
```

### 7.2 Executar Testes

```bash
# Testes unitários
node e2e/tests/websocket-limits.mjs
node e2e/tests/rate-limiting.mjs
node e2e/tests/d1-write-quota.mjs

# Teste de integração
node cloudflare/api-worker/loadtest/full-journey-e2e.mjs

# Teste de carga (NUNCA em produção)
node cloudflare/api-worker/loadtest/firetest.mjs --max=100

# k6 distribuído
k6 run --out json=results.json cloudflare/api-worker/loadtest/k6/ladiesgo.js
```

## 8. Critérios de Aceitação

- [ ] Todos os testes unitários passam
- [ ] Taxa de sucesso E2E > 99.9%
- [ ] P95 HTTP < 500ms sob carga
- [ ] WS round-trip P95 < 400ms
- [ ] Quota D1 nunca excede 80% em operação normal
- [ ] Rate limiting eficaz contra abuso
