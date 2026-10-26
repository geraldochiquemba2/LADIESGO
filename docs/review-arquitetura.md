# Revisão Arquitetural Profunda — LADIESGO vs Sistemas de Ride-Hailing de Produção

> **Nota (2026-10-26):** a conta Cloudflare oficial é `rererererererere670@gmail.com`. Referências a "conta nova" / `ladiesgo-angola` / isabel neste documento são históricas; ver `AGENTS.md`.

**Data:** 2026-10-17
**Revisor:** Subagente de Análise Arquitetural
**Âmbito:** `C:\Users\Geraldo\LADIESGO` — monorepo contendo `backend/` (NestJS), `cloudflare/api-worker/` (Cloudflare Worker + D1), `webapp/` (HTML estático + `server.js` Node), `mobile/` (Expo WebView), `docs/`, `selfhost/`.

---

## 1. Executive Summary (5 Pontos)

- **Sistema de produção NÃO é o `backend/` NestJS — é um `server.js` Node de 553 linhas sem framework, sem autenticação real, sem Redis GEO e com estado apenas em memória**, que só corre em dev local. O `server.js` é explicitamente marcado como "demo em memória" mas implementa a lógica de negócio real (ofertas, chat, geolocalização). O backend NestJS de 15+ módulos é código morto/vivo-parcialmente desconectado do deployment real.
- **Sem Redis GEO, sem Redis Adapter, sem rate limiting, sem connection pooling, sem heartbeat/idle timeout** — o sistema faz matching por Haversine O(N) em memória via polling HTTP, enquanto `vivenn/ridematch` usa Redis GEO com scripts Lua atómicos (~2ms/busca) e `SaiKrishnaMulukutla/uber` usa Redis GEO + Kafka + OTP.
- **Sessões JWT incompatíveis entre ambientes**: o `cloudflare/README.md` admite que o `JWT_SECRET` da conta nova é o de dev (`.dev.vars`), quebrando todas as sessões existentes. Não existe rotação de segredos, refresh tokens, nem blacklist — qualquer token emitido é válido indefinidamente.
- **O `AGENTS.md` documenta 3 incidentes de quota no mesmo dia (2026-10-17)** — erro 1027 (Workers 100K req/dia), erro 7500 (D1 100K escritas/dia), token refresh quebrado. A causa raiz é falta de rate limiting, testes de carga contra produção, e reimportação da BD inteira. O sistema não sobreviveria a um único pico de tráfego real.
- **Webapp é um "monolito estático"**: 7+ ficheiros HTML com JS inline de ~250KB cada, sem build, sem bundler, sem TypeScript, com constantes de API duplicadas em cada ficheiro, e patch manual de `fetch` por cima de `/api/*`. O `mobile/` é uma WebView que carrega este site — não há app nativa real com lógica offline.

---

## 2. Questões Críticas (Corrigir Imediatamente)

### 2.1 — Ausência total de Rate Limiting
**Impacto:** Qualquer cliente pode fazer requests ilimitados. O sistema já esgotou 2 quotas num dia por causa de testes — sem rate limiting, um único utilizador malicioso ou um bug no cliente pode derrubar a API inteira.
**Evidência:** Zero ocorrências de rate limiting/throttling no `cloudflare/api-worker/src/index.ts` ou no `server.js`. O `docs/comparacao-repositorios-taxi.md` §4.2 marca isto como "ALTA" prioridade mas não foi implementado.
**Correção:**
- Adicionar middleware de rate limiting no Worker: 100 req/min por IP (REST), 20 msgs/sec por conexão WS, 10 conexões WS por IP.
- Usar `Cache API` do Cloudflare ou contadores em Durable Objects para estado distribuído.
- Headers `Retry-After` em respostas 429.

### 2.2 — Sem Redis GEO para localização de motoristas
**Impacto:** O `server.js` faz `[...drivers.values()].filter(...).sort(...)` — O(N) Haversine em memória. Com 10.000 motoristas online, cada pedido de viagem itera todos eles. `vivenn/ridematch` e `SaiKrishnaMulukutla/uber` usam Redis GEOADD/GEORADIUS (~2ms, O(log N)).
**Evidência:** `server.js` linha 155: `const cands = [...drivers.values()].filter(d => Date.now() - d.ts < 45000 && !busy.has(d.id)).map(d => ({ id: d.id, km: havKm(...) })).filter(...).sort(...).slice(0, 15)`
**Correção:**
- Migrar para `GEOADD drivers:geo <lng> <lat> <driverId>` + `GEORADIUS`.
- TTL de 30s por entrada (motorista que não pinga é removido automaticamente).
- Cloudflare: usar D1 para persistência, mas o Redis GEO pode ser substituído por D1 com índice espacial se a quota de escrita permitir — ou mover matching para um serviço externo.

### 2.3 — Estado apenas em memória (Maps do Node.js)
**Impacto:** Todo o estado (drivers, trips, busy, chats, callSignals) vive em `Map`s do processo Node. Se o processo reinicia, **tudo é perdido**: motoristas ficam offline, viagens desaparecem, chats somem. Não há persistência real além de `trips.json` (últimas 300 viagens) e chats (últimas 50 entradas).
**Evidência:** `server.js` linhas 6-10: `const drivers = new Map(); const trips = new Map(); const busy = new Set(); const chats = new Map(); const callSignals = new Map();`
**Correção:**
- Persistir estado em D1 (Cloudflare) com TTL para sessões.
- Usar Durable Objects para estado em tempo real por viagem.
- Implementar graceful shutdown com checkpoint.

### 2.4 — Autenticação falsa no `server.js` (demo)
**Impacto:** O `server.js` emite tokens JWT falsos (`'demo.' + base64 + '.demo'`) sem assinatura, sem verificação, sem expiração. Qualquer pessoa pode criar um token admin. O backend NestJS tem JWT real mas não é o que corre em produção.
**Evidência:** `server.js` linhas 435-475 — login mock com token `'demo.' + Buffer.from(JSON.stringify(user)).toString('base64') + '.demo'`.
**Correção:**
- Se o `server.js` é apenas dev, NÃO deve ter rotas de produção.
- Se é produção, implementar JWT real com assinatura HMAC-SHA256, expiração, e verificação no Worker.

### 2.5 — JWT_SECRET de dev em produção
**Impacto:** O `cloudflare/README.md` admite que o `JWT_SECRET` da conta nova é o de dev. Sessões antigas caem, e o segredo é publicamente conhecido (está no `.dev.vars`).
**Evidência:** `cloudflare/README.md` linha 56: "Nota: o JWT_SECRET da conta nova é o de dev (.dev.vars) -> as sessões antigas caem"
**Correção:**
- Gerar novo `JWT_SECRET` aleatório de 256 bits.
- Fazer `wrangler secret put JWT_SECRET` na conta nova.
- Implementar rotação de segredos com período de graça.

---

## 3. Questões de Alta Prioridade (Corrigir em 1-2 Semanas)

### 3.1 — Sem Heartbeat / Idle Timeout no WebSocket
**Impacto:** Conexões WebSocket nunca fecham se o cliente morrer silenciosamente. Com limite de 1000 conexões/Worker (Cloudflare free), 1000 clientes "zombies" derrubam o sistema. `docs/comparacao-repositorios-taxi.md` §2.1 recomenda heartbeat 30s + idle timeout 60-100s.
**Correção:** Ping a cada 30s, disconnect após 60s sem pong, code 1013 ao atingir limite.

### 3.2 — Sem Connection Cap / Load Shedding
**Impacto:** Cloudflare free limita a 1000 conexões WebSocket por Worker. Sem cap, o Worker pode atingir o limite e começar a rejeitar conexões aleatórias. Sem load shedding, o Worker pode entrar em thrashing.
**Correção:** Contador de conexões em Durable Object, rejeitar com code 1013 ao atingir 80% (800 conexões).

### 3.3 — Sem Redis Adapter para Socket.io (multi-server)
**Impacto:** O sistema é single-server por design (Cloudflare Worker). Se escalar para múltiplos Workers, cada um terá estado diferente. O `server.js` usa polling HTTP para fallback, mas não há broadcast entre instâncias. `vivenn/ridematch` e `SaiKrishnaMulukutla/uber` usam Redis Adapter para Socket.io.
**Correção:** Usar Redis Pub/Sub (ou Durable Objects) para broadcast entre instâncias. No Cloudflare, Durable Objects já fazem isto nativamente.

### 3.4 — Oferta sequencial O(N) sem consistência
**Impacto:** O sistema faz oferta sequencial: 15s por motorista, mais próxima primeiro. Se 15 motoristas falham, a viagem fica 225s (quase 4 min) sem ser aceita. Não há timeout global, não há escalação para broadcast após N tentativas.
**Evidência:** `server.js` linha 13: `const OFFER_TTL_MS = 15000;`
**Correção:** Timeout global de 60s para oferta sequencial, depois broadcast para todos os motoristas próximos. `vivenn/ridematch` usa "batched offers" com Lua atômico.

### 3.5 — Sem OTP de viagem
**Impacto:** O `server.js` gera um `pin` aleatório de 4 dígitos na linha 305 (`t.pin = String(1000 + Math.floor(Math.random() * 9000))`) mas nunca é verificado. Motoristas podem iniciar viagens sem o passageiro estar no carro ("ghost rides"). `SaiKrishnaMulukutla/uber` e `Sparsh1501/Ride-Sharing-Service` têm OTP de viagem.
**Correção:** Passageiro lê o PIN em voz alta ao motorista, motorista insere no app para iniciar viagem.

### 3.6 — Sem Message Size Cap
**Impacto:** Clientes podem enviar mensagens WebSocket/HTTP de tamanho ilimitado, causando OOM. `docs/comparacao-repositorios-taxi.md` §2.1 recomenda 64KB max.
**Correção:** Validar `Content-Length` e rejeitar payloads > 64KB.

### 3.7 — `server.js` em produção sem TypeScript, sem testes, sem CI/CD
**Impacto:** O ficheiro crítico de produção é JavaScript puro de 553 linhas, sem type safety, sem testes unitários, sem testes de integração, sem pipeline de deploy automatizado. O `package.json` do webapp não tem scripts de teste.
**Correção:** Migrar para TypeScript, adicionar testes, criar pipeline GitHub Actions.

---

## 4. Questões de Média Prioridade (Corrigir em 1-2 Meses)

### 4.1 — `server.js` como monolito não modular
**Impacto:** Um único ficheiro de 553 linhas lida com: routing, autenticação, viagens, chat, sinalização WebRTC, geolocalização, proxy OSRM, proxy Nominatim, TURN, admin. Impossível testar, impossível escalar, impossível manter.
**Correção:** Separar em módulos: `auth.ts`, `trips.ts`, `geo.ts`, `chat.ts`, `webrtc.ts`, `proxy.ts`, `admin.ts`.

### 4.2 — Backend NestJS desconectado da produção
**Impacto:** O `backend/src/` tem 15+ módulos (auth, users, drivers, trips, payments, ratings, admin, promos, turn) mas o `server.js` implementa a lógica de negócio de forma completamente diferente. O NestJS é código morto ou não está a ser usado.
**Correção:** Decidir: ou o NestJS é o backend e o `server.js` é removido, ou o `server.js` é o backend e o NestJS é arquivado. Não ter dois backends divergentes.

### 4.3 — Webapp sem build, sem bundler, sem TypeScript
**Impacto:** HTML com JS inline de ~250KB, sem minificação, sem tree-shaking, sem type checking. Cada página carrega o mesmo código duplicado. O `mobile/` é uma WebView que carrega este site — sem offline, sem push notifications nativas.
**Correção:** Migrar para React (ou Svelte) com Vite, TypeScript, component library. Usar React Native em vez de WebView.

### 4.4 — Sem Event-Driven Architecture
**Impacto:** O sistema é request-response puro. Não há filas de eventos, não há desacoplamento entre matching e trip management. `SaiKrishnaMulukutla/uber` usa Kafka com topics `ride.requested`, `ride.offered`, `driver.assigned`, `driver.location.updated`. `Sparsh1501/Ride-Sharing-Service` usa Kafka + event sourcing.
**Correção:** Usar Redis Streams ou Cloudflare Queues para eventos de viagem.

### 4.5 — Sem Monitoring / Observabilidade
**Impacto:** Não há métricas, não há tracing, não há alertas. Os únicos "logs" são `page.log`, `zone.log`, `route.log` — ficheiros de texto sem estrutura. `docs/comparacao-repositorios-taxi.md` §5 recomenda Prometheus + Grafana.
**Correção:** Adicionar OpenTelemetry, exportar métricas para Cloudflare Analytics ou Datadog.

### 4.6 — Geolocalização por polling HTTP em vez de WebSocket para GPS
**Impacto:** O `server.js` atualiza posição via `POST /api/v1/drivers/position` (polling). O `webapp/AGENTS.md` diz que usa 3 WebSockets (`liveConnect`, `geoWsConnect`, `reqLiveConnect`) mas o `server.js` não tem código WebSocket — tem polling. Há uma desconexão entre a documentação e a implementação.
**Correção:** Implementar WebSocket real no Worker com Durable Objects para broadcast de GPS.

### 4.7 — `trips.json` como persistência
**Impacto:** `saveTrips()` escreve JSON para ficheiro a cada mutação. Não é transacional, não é concorrente, não escala. Com 100 viagens ativas, cada escrita serializa todas.
**Correção:** Usar D1 com inserts incrementais, ou Durable Objects por viagem.

---

## 5. Questões de Baixa Prioridade (Nice to Have)

### 5.1 — Consistent hashing para sharding
**Impacto:** Não há sharding. `Sparsh1501/Ride-Sharing-Service` usa consistent hashing com 150 virtual nodes. Com uma cidade (Luanda) isto é menos relevante, mas se expandir para múltiplas cidades, será necessário.

### 5.2 — Surge pricing
**Impacto:** O `server.js` tem `fare` fixo pedido pelo cliente. Não há cálculo dinâmico de preço. `Sparsh1501/Ride-Sharing-Service` implementa surge pricing.
**Correção:** Motorista envia estimativa, servidor calcula com base na oferta/demanda.

### 5.3 — Multi-stop trips
**Impacto:** O `server.js` suporta `stops` (até 3) mas não os usa para routing. Apenas guarda os dados.
**Correção:** Integrar com OSRM para calcular rota com múltiplos waypoints.

### 5.4 — Scheduled rides
**Impacto:** O `server.js` tem `scheduledAt` mas não há scheduler que dispare a viagem na hora certa. A lógica `Date.now() > t.scheduledAt - 900000` apenas filtra.
**Correção:** Usar Cloudflare Cron Triggers ou Durable Objects com alarme.

### 5.5 — In-app chat persistente
**Impacto:** Chats guardados em memória, perdidos após restart, limitados a 50 mensagens.
**Correção:** Persistir em D1 com TTL de 30 dias.

### 5.6 — Proxy OSRM/Nominatim sem cache
**Impacto:** Cada pedido de rota faz fetch ao OSRM público. Sem cache, sem rate limiting no servidor externo.
**Correção:** Cache de rotas em Cache API (Cloudflare) com TTL 1h.

---

## 6. Comparação Arquitetural com os 3 Repositórios de Referência

### 6.1 — LADIESGO vs `vivenn/ridematch`

| Aspecto | LADIESGO | vivenn/ridematch | Gap |
|---|---|---|---|
| Localização motoristas | Haversine O(N) em memória (`server.js:155`) | Redis GEOADD/GEORADIUS ~2ms | **CRÍTICO** |
| Matching | Sequencial 15s/motorista, sem atomicidade | Batched offers + Lua atómico | **CRÍTICO** |
| Escala | Single Worker, estado em memória | Multi-server + Redis Adapter | **ALTO** |
| Estado | `Map` Node (volátil) | Redis (com TTL) + PostgreSQL | **ALTO** |
| CI/CD | Desconhecido/nãoexistente | GitHub Actions | MÉDIO |
| Testes | Nenhum | Jest + integration tests | MÉDIO |
| TypeScript | Apenas no backend NestJS (não usado) | Sim | ALTO |

### 6.2 — LADIESGO vs `SaiKrishnaMulukutla/uber`

| Aspecto | LADIESGO | SaiKrishnaMulukutla/uber | Gap |
|---|---|---|---|
| Autenticação | JWT falsos (`demo.base64.demo`) | OTP verification + JWT real | **CRÍTICO** |
| Arquitetura | Monólito request-response | Event-driven com Kafka | **ALTO** |
| OTP viagem | PIN gerado mas nunca verificado | OTP 4-digit verificado antes de iniciar | **ALTO** |
| Localização | Polling HTTP em memória | Redis GEO + Kafka `driver.location.updated` | **CRÍTICO** |
| Persistência | `trips.json` (ficheiro) | PostgreSQL + Kafka replay | **ALTO** |
| Linguagem | JavaScript (server.js) + TypeScript (backend morto) | Go (backend real) | MÉDIO |
| Escalabilidade | Single server | Multi-service, Kafka consumers | **ALTO** |

### 6.3 — LADIESGO vs `Sparsh1501/Ride-Sharing-Service`

| Aspecto | LADIESGO | Sparsh1501/Ride-Sharing-Service | Gap |
|---|---|---|---|
| Padrão arquitetural | Monólito ad-hoc | CQRS + Event Sourcing | **ALTO** |
| Consistência | Nenhuma (sem transações, sem locks) | Event sourcing + consistent hashing | **ALTO** |
| Sharding | Nenhum | Consistent hashing 150 virtual nodes | MÉDIO |
| Surge pricing | Nenhum (fare fixo) | Implementado | BAIXO |
| CQRS | Reads e writes no mesmo caminho | Command/Query separation | **ALTO** |
| Stack | JavaScript/Node (server.js) | Java 17 + Spring Boot + Kafka + Redis GEO | MÉDIO |
| Produção-ready | Demo em memória | Docker + Kubernetes | **ALTO** |

### 6.4 — Síntese Comparativa

O LADIESGO está **2-3 gerações atrás** dos repositórios de referência:
- **Geração 1 (LADIESGO atual):** `server.js` Node em memória, polling HTTP, estado volátil.
- **Geração 2 (LADIESGO potencial):** Cloudflare Worker + D1 + Durable Objects + WebSocket real + Redis GEO (ou equivalente).
- **Geração 3 (referências):** Microserviços + Kafka + Redis GEO + CQRS + Event Sourcing + Kubernetes.

Para atingir nível de produção, o LADIESGO precisa no mínimo da Geração 2. A Geração 3 é desejável para escalar para múltiplas cidades.

---

## 7. Achados ao Nível de Código

### 7.1 — `server.js` linha 305: PIN gerado mas nunca verificado
```javascript
t.pin = String(1000 + Math.floor(Math.random() * 9000));
```
O PIN é gerado mas não há endpoint que o valide. Motoristas podem aceitar viagens sem o passageiro confirmar o PIN.

### 7.2 — `server.js` linha 302: Race condition na atribuição
```javascript
for (const o of trips.values()) { if (o.id !== t.id && o.driverId === drv && ['accepted', 'arrived', 'in_progress'].indexOf(o.status) >= 0) { send(400, ...); return; } }
```
Isto não é atómico. Dois pedidos simultâneos podem passar esta verificação e atribuir a mesma motorista a duas viagens. `vivenn/ridematch` resolve isto com Lua atómico no Redis.

### 7.3 — `server.js` linha 55: Perda de dados no arranque
```javascript
try{ const saved = JSON.parse(fs.readFileSync(TRIPS_FILE, 'utf8')); ... }catch(e){}
```
Se o ficheiro estiver corrompido, todo o estado é perdido silenciosamente. Sem backup, sem replicação.

### 7.4 — `server.js` linha 83: Log de rota em ficheiro
```javascript
fs.appendFile('route.log', new Date().toISOString() + ' ' + req.url + ' pts=' + g.length + '\n', () => {});
```
Logs em ficheiro de texto sem estrutura, sem rotação, sem nível de severidade.

### 7.5 — `server.js` linha 203: Base64 decode sem validação
```javascript
if (tok.startsWith('demo.')) from = (JSON.parse(Buffer.from(tok.split('.')[1], 'base64').toString()).id) || '';
```
Qualquer pessoa pode forjar um token `demo.` com qualquer ID. Não há assinatura, não há expiração, não há verificação.

### 7.6 — `server.js` linha 168: Query complexa em uma linha
```javascript
const fresh = [...trips.values()].filter(t => { if (t.status !== 'pending') return false; if (t.scheduledAt) return Date.now() > t.scheduledAt - 900000 && Date.now() < t.scheduledAt + 3600000; return Date.now() - t.ts < 600000; });const byPax = new Map();for (const t of fresh) { const c = byPax.get(t.passengerId); if (!c || t.ts > c.ts) byPax.set(t.passengerId, t); }const list = [...byPax.values()].sort((a, b) => a.ts - b.ts).slice(-20);
```
Lógica de negócio inline, impossível de testar, impossível de reutilizar.

### 7.7 — Duplicação de lógica de oferta
A lógica de `advanceOffer`, `offerOut`, `skip`, `status` está espalhada por múltiplos blocos com callbacks aninhados. Não há separação de concerns.

### 7.8 — `webapp/ladiesgo-home.html` (~250KB)
Um único ficheiro HTML com todo o JS inline. Sem módulos, sem componentes, sem estado gerido. Qualquer mudança exige editar 250KB de código minificado.

### 7.9 — Constantes de API duplicadas
O `webapp/AGENTS.md` nota: "Se o host da API mudar de novo, há que trocar essa constante em todos os HTML de webapp/ e em mobile/". Isto é um código smell grave — a constante deveria estar num único ficheiro de configuração.

### 7.10 — Backend NestJS com 15+ módulos mas sem endpoint de health check
O `backend/src/` tem módulos para auth, users, drivers, trips, payments, ratings, admin, promos, turn mas não há health check endpoint visível. Sem health check, não há como fazer load balancing ou auto-scaling.

---

## 8. Roadmap de Recomendação

### Fase 1 — Estabilização Imediata (0-1 semana)
1. **Adicionar rate limiting** no Worker (100 req/min IP, 20 msgs/sec WS).
2. **Gerar novo JWT_SECRET** e fazer `wrangler secret put`.
3. **Remover tokens `demo.`** do `server.js` ou bloquear essa rota em produção.
4. **Adicionar health check endpoint** (`/health`) no Worker.
5. **Parar de reimportar a BD inteira** — usar migrations incrementais.

### Fase 2 — Localização e Matching (1-2 semanas)
6. **Implementar Redis GEO** (ou D1 com índice espacial) para localização de motoristas.
7. **Substituir Haversine O(N)** por GEOSEARCH.
8. **Adicionar timeout global** de 60s para oferta sequencial antes de broadcast.
9. **Verificar OTP/PIN** antes de iniciar viagem.
10. **Adicionar connection cap** (1000/Worker) com code 1013.

### Fase 3 — Persistência e Real-time (1-2 meses)
11. **Migrar estado em memória** para D1 + Durable Objects.
12. **Implementar WebSocket real** no Worker (substituir polling).
13. **Adicionar Redis Adapter** (ou Durable Objects pub/sub) para multi-server.
14. **Persistir chats** em D1 com TTL.
15. **Adicionar heartbeat + idle timeout** (30s/60s).

### Fase 4 — Arquitetura e Escala (3-6 meses)
16. **Decidir backend único** (NestJS ou server.js) — não manter dois.
17. **Event-driven architecture** com Cloudflare Queues ou Redis Streams.
18. **Monitoring** com OpenTelemetry + Cloudflare Analytics.
19. **CI/CD** com GitHub Actions (testes + deploy).
20. **Surge pricing** e matching inteligente.

### Fase 5 — Produção Enterprise (6+ meses)
21. **Microserviços** separados: matching-service, trip-service, auth-service.
22. **CQRS + Event Sourcing** para auditoria e replay.
23. **Multi-cidade** com sharding geográfico.
24. **Kubernetes** ou similar para orchestration.
25. **Load testing** automático em staging.

---

## Conclusão Final

O LADIESGO tem uma **ideia de produto válida** (ride-hailing para Luanda, Angola, com foco em passageiras) e uma **base de código com potencial** (o backend NestJS tem estrutura modular correta), mas a **implementação de produção atual (`server.js`) é um protótipo de demo** que não sobreviveria a tráfego real.

Os **3 repositórios de referência** demonstram claramente o padrão mínimo para um sistema de ride-hailing de produção:
1. **Redis GEO** para localização (~2ms vs O(N) Haversine)
2. **Event-driven architecture** para desacoplamento (Kafka/Queues)
3. **OTP/verificação** para prevenção de fraudes
4. **Persistência real** (PostgreSQL/Redis) em vez de memória volátil
5. **Rate limiting + connection management** para proteção contra abuso

O LADIESGO precisa de **pelo menos 6 meses de trabalho focado** para atingir o nível dos repositórios de referência. A prioridade máxima é **parar de usar o `server.js` como produção** e implementar o backend NestJS com Redis GEO, ou reescrever o `server.js` como um sistema TypeScript modular com persistência real.
