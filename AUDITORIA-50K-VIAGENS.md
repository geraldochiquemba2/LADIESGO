# Vistoria de capacidade — LADIESGO a 50 000 viagens/dia

**Data:** 30 de outubro de 2026 · **Conta:** `rererererererere670@gmail.com` (`016a8f9ed58a5cd10e9be697944905f0`)
**Âmbito:** site (`webapp/*.html`), Worker/API (`cloudflare/api-worker`), D1 `ladiesgo`, as 5 Durable Objects.
**Pergunta:** o site inteiro, com todas as alterações recentes, aguenta **50 000 viagens/dia** nas quotas **Free**?

---

## 1. Veredicto (uma linha)

> **Não.** Nas quotas Free o sistema aguenta **≈ 330 viagens/dia** (não 50 000 — é ~150× menos). O que trava primeiro são os **pedidos ao Worker** e os **pedidos às Durable Objects**, ambos a ~300 por viagem. A 50 000 viagens/dia o plano Free rebentaria logo nas primeiras horas do primeiro dia.
> **No plano pago** (Workers Paid, $5/mês) 50 000 viagens/dia **é viável** — custa **≈ $360/mês** como está hoje e **≈ $120/mês** com as 5 correções do §8.

| Cenário | Pedidos Worker/dia | D1 lidas/dia | D1 escritas/dia | Pedidos DO/dia | Duração DO/dia | Free aguenta? |
|---|---|---|---|---|---|---|
| **Hoje** (~20 viagens/dia) | 38 500 (medido) | 3,56 M (medido) | 5 401 (medido) | ~6 700/48 h (medido) | 9,6 GB-s/48 h (medido) | ✅ mas as leituras já a **71%** |
| **5 000 viagens/dia** | 1,5 M | 15 M | 600 k | 1,5 M | 10 k GB-s | ❌ 15× / 3× / 6× / 15× / 0,8× |
| **10 000 viagens/dia** | 3,0 M | 30 M | 1,2 M | 3,0 M | 20 k GB-s | ❌ 30× / 6× / 12× / 30× / 1,5× |
| **50 000 viagens/dia** | **15 M** | **150 M** | **6 M** | **15 M** | **100 k GB-s** | ❌ **150× / 30× / 60× / 150× / 7,7×** |

*(Tectos Free por conta/dia: Worker 100 000 pedidos · D1 5 000 000 linhas lidas e 100 000 escritas · DO 100 000 pedidos e 13 000 GB-s. Modelo por viagem em §4.)*

---

## 2. Como foi medido (não é estimativa)

Tudo o que está marcado **medido** vem da GraphQL Analytics API da Cloudflare com o token OAuth do wrangler, não de contas de papel:

| Fonte | Script | O que devolve |
|---|---|---|
| Quota por script/BD (hoje e 24 h) | `%TEMP%\opencode\cf-quota.mjs` | pedidos, subrequests, `rowsRead`, `rowsWritten` |
| D1 hora a hora (48 h) | `cf-d1-hourly.mjs` | leituras/escritas por hora e por BD |
| Durable Objects reais (48 h) | `cf-do-real2.mjs` | objetos, pedidos, **duração GB-s**, CPU, msgs WS, storage |

Estado da base (medido): **26 utilizadores** (1 admin, 2 motoristas, 23 passageiras), **121 viagens**, **23 332 lugares**, **7,85 MB**, `places_fts` íntegro.

> **Nota sobre o token:** o `oauth_token` do `default.toml` expira e o GraphQL passa a devolver `{"code":10000,"message":"Authentication error"}`. Correr `npx wrangler@4.151.1 whoami` renova-o e grava-o de volta. **Nunca** `wrangler logout`.

---

## 3. O que os números reais dizem hoje

### 3.1 As leituras da D1 não vêm do polling — vêm da pesquisa de lugares

Últimas 48 h, D1 de produção, por hora (extrato):

| Hora (UTC) | Pedidos Worker | Queries de leitura | Linhas lidas | **Linhas por query** |
|---|---|---|---|---|
| 29/10 01:00 | 28 | 60 | 0 | 0 |
| 29/10 13:00 | 383 | 554 | 24 986 | 45 |
| 29/10 17:00 | 1 132 | 546 | **1 371 992** | **2 513** |
| 29/10 18:00 | 1 485 | 1 194 | 311 002 | 209 |
| 29/10 22:00 | 1 380 | 600 | 20 456 | **34** |
| 30/10 04:00 | 562 | 1 054 | 346 162 | 616 |
| 30/10 05:00 | 67 | 181 | 24 353 | 363 |

**Leitura:** nas horas de uso normal o custo é **~15–45 linhas por pedido**. Os picos de 200 k–1,4 M numa hora são **varreduras completas da tabela `places`** — 23 332 linhas cada. A hora das 17:00Z fez **~57 varreduras** (1,37 M ÷ 23,3 k).

**Porquê:** `localPlaces()` (`index.ts:1848-1911`) tenta três caminhos em cascata: FTS5 → GLOB de prefixo → **`LIKE '%termo%'` sem índice**. O terceiro só corre quando os dois primeiros devolvem **menos de 8** linhas — e quando corre, lê a tabela **toda** (linhas 1899-1909, com o próprio comentário a admitir "lia as ~23k linhas TODAS"). Cada prefixo de autocomplete é uma chave de cache nova (`places:v13:<q>:<lat,lng>`), por isso escrever uma palavra com 6 letras pode gerar 6 varreduras se os prefixos não tiverem resultados.

**Consequência:** hoje, com **~20 viagens/dia**, a conta já gastou **3,56 M das 5 M leituras diárias (71%)** e **5 401 das 100 000 escritas**. Não é o negócio a consumir a quota — é a pesquisa de lugares.

### 3.2 Durable Objects: a hibernação funciona (correção importante)

48 h reais, por tipo de objeto:

| Tipo | Objetos | Pedidos | Duração GB-s | CPU | Storage lido | Storage escrito | Por objeto |
|---|---|---|---|---|---|---|---|
| `geo:global` | 2 | 3 410 | 4,87 | 2,89 s | **15 200** | 307 | 1 705 pedidos · 2,43 GB-s |
| `trip:<viagem>` | 39 | 1 372 | 2,81 | 1,00 s | 189 | 146 | **35 pedidos · 0,07 GB-s** |
| `global` (Ringer) | 1 | 69 | 1,16 | 0,23 s | 200 | 72 | 69 pedidos · 1,16 GB-s |
| `notif:<user>` | 65 | 829 | 0,61 | 0,48 s | 0 | 0 | 12,8 pedidos · 0,01 GB-s |
| `calls:<viagem>` | 31 | 857 | 0,12 | 0,44 s | 0 | 0 | 27,6 pedidos · 0,003 GB-s |
| `requests:global` | 2 | 147 | 0,07 | 0,07 s | 0 | 0 | 73,5 pedidos · 0,03 GB-s |
| **Total** | **140** | **6 684** | **9,63** | **5,11 s** | **15 589** | **525** | 0,0014 GB-s/pedido |

**Duas conclusões que corrigem a estimativa inicial do batalhão:**

1. **A duração é 0,07 GB-s por viagem, não 232 GB-s.** A hipótese "o DO da viagem nunca hiberna e cobra 30 min de wall-clock" está **errada** — a Hibernation API está a ser usada e o objeto só corre enquanto executa (0,76 ms de CPU por pedido). Uma viagem real de 15 min, com mais fixes, deve ficar em **1–3 GB-s**, não em 232.
2. **O que cresce mal não é a duração — é o `geo:global`:** **15 200 linhas de storage lidas em 48 h** com apenas 2 motoristas. Isso vem do `load()` que faz `storage.list({prefix:'p:'})` (uma linha por motorista) em cada arranque a frio e de gravar a posição a cada ~2 min. Com 2 000 motoristas, um único cold start lê 2 000 linhas e o `setPos` escreve 720 linhas/dia/motorista → estoura as **100 000 escritas de storage de DO** com ~139 motoristas.

### 3.3 Onde o tráfego do cliente está (e onde está a bomba)

Intervalos confirmados no código (`webapp/ladiesgo-home.html`):

| Atividade | Intervalo | Com WS aberto |
|---|---|---|
| `pollTrip` / `pollMine` | 8 s | **1×/30 s** (`liveSkipPoll`) |
| `__chatTick` | 30 s | 1×/30 s |
| `__callLoop` (REST) | 2 s (visível) / 10 s | **30 s idle · 3 s em chamada** |
| `refreshProfile` | 60 s (throttle interno) | 60 s |
| `pollInc` (motorista) | 4 s | 30 s (8 s se há ofertas) |
| `pollCars`/`nearby` | 15 s | 30 s |
| `paintWBadge` (carteira) | 120 s | 120 s |
| `geoPresence` (GPS) | 10 m em viagem / 20 m parada, heartbeat 30 s | — |

**A bomba:** 5 dos 6 WebSockets reconectam com **backoff fixo de 3 s** (`geoWsRetry`, `reqLiveConnect`, `nearby`, `notif`, `calls`). Com o servidor em baixo, cada socket faz **1 200 ligações/hora**; 4 sockets = **4 800 pedidos/hora por utilizador** — 21 utilizadores presos em reconexão esgotam os 100 000 pedidos diários. Só o WS da viagem tem backoff exponencial (3→30 s).

---

## 4. Modelo por viagem (viagem de 15 min, apps abertas, WS saudável)

| Componente | Pedidos Worker | Linhas D1 lidas | Linhas D1 escritas | Pedidos DO |
|---|---|---|---|---|
| Passageira (poll 30 s, posição, chat, chamada, perfil) | ~140 | — | — | — |
| Motorista (pollMine, chat, chamada, perfil, carteira) | ~115 | — | — | — |
| Eventos (pedido, aceite, chegou, iniciou, concluiu, avaliar, boot, rota) | ~25 | — | — | — |
| Ligações WebSocket | ~9 | — | — | — |
| Leituras D1 (15–45 por pedido medido) | — | **~3 000** | — | — |
| Escritas D1 (chat 40 + `trip_points` 45 + estados/avaliação/carteira) | — | — | **~120** | — |
| DO da viagem (WS + ponte GPS 1 fix/10 s) | — | — | — | **~300** |
| **Total por viagem** | **≈ 300** | **≈ 3 000** | **≈ 120** | **≈ 300** |

*Sem WS (rede má, DO em baixo) o mesmo ciclo passa de ~300 para **~5 800 pedidos** e as leituras D1 para **~30 000** — 10× pior. É por isso que o backoff fixo de 3 s é perigoso.*

### Tecto do plano Free, por restrição

| Restrição | Conta | Viagens/dia possíveis |
|---|---|---|
| Pedidos ao Worker | 100 000 ÷ 300 | **333** |
| Pedidos a DO | 100 000 ÷ 300 | **333** |
| Duração de DO | 13 000 ÷ 2 GB-s | 6 500 |
| Linhas D1 escritas | 100 000 ÷ 120 | 833 |
| Linhas D1 lidas | (5 000 000 − 370 000) ÷ 3 000 | 1 543 |

> **Tecto real hoje: ≈ 330 viagens/dia.** As duas primeiras restrições empatam; as leituras da D1 parecem folgadas mas **não estão**, porque hoje já se gastam 71% delas sem viagens nenhumas (§3.1).

---

## 5. O que quebra primeiro (ordem real)

| # | Parede | Quebra a | Sintoma |
|---|---|---|---|
| 1 | Pedidos ao Worker (100 k/dia) | **~330 viagens/dia** | erro **1027 / HTTP 429** — a conta inteira fora até 00:00 UTC |
| 2 | Pedidos a DO (100 k/dia) | ~330 viagens/dia | pedidos a DO falham; mapa/estado param |
| 3 | Linhas lidas D1 (5 M/dia) | **já a 71%** com ~20 viagens | leituras falham; a app fica "cega" |
| 4 | Linhas escritas D1 (100 k/dia) | ~830 viagens/dia | erro **7500** — **todas** as escritas devolvem 500 |
| 5 | Escritas de storage DO (100 k/dia) | ~139 motoristas | posições deixam de gravar |
| 6 | Duração DO (13 k GB-s/dia) | ~6 500 viagens/dia | só aparece depois das outras |
| 7 | Throughput do `geo:global` | ~1 500–2 000 motoristas | CPU do objeto saturado; mapa atrasa (não é quota, é desenho) |

---

## 6. Preços reais (verificados na documentação a 30/10/2026)

| Produto | Free / dia | Pago |
|---|---|---|
| Workers | 100 000 pedidos · 10 ms CPU/invocação | **$5/mês** · 10 M pedidos/mês · depois **$0,30/M** · 30 M CPU-ms incluídos · $0,02/M ms |
| D1 | 5 M lidas · 100 k escritas · 5 GB | 25 000 M lidas/mês · 50 M escritas/mês · 5 GB · depois $0,001/M lidas e **$1,00/M escritas** |
| Durable Objects | 100 k pedidos · 13 000 GB-s · 5 M lidas/100 k escritas de storage | 1 M pedidos/mês · 400 000 GB-s/mês · depois **$0,15/M pedidos** e **$12,50/M GB-s** |
| Pages (site) | ilimitado | ilimitado |

Fontes: `developers.cloudflare.com/workers/platform/pricing`, `/d1/platform/pricing`, `/durable-objects/platform/pricing` (outubro de 2026).

### Custo a 50 000 viagens/dia (mês de 30 dias)

| Item | Como está hoje | Com as correções do §8 |
|---|---|---|
| Subscrição Workers Paid | $5 | $5 |
| Pedidos Worker (15 M/dia → 450 M/mês) | 440 M × $0,30 = **$132** | 6 M/dia → 170 M × $0,30 = **$51** |
| D1 lidas (150 M/dia → 4,5 mM/mês) | dentro dos 25 mM → **$0** | **$0** |
| D1 escritas (6 M/dia → 180 M/mês) | 130 M × $1,00 = **$130** | 45 M/mês → dentro dos 50 M → **$0** |
| Pedidos DO (15 M/dia → 450 M/mês) | 449 M × $0,15 = **$67** | 300 M → **$45** |
| Duração DO (100 k GB-s/dia → 3 M/mês) | 2,6 M × $12,50 = **$33** | 1,5 M → **$19** |
| CPU dos Workers | ~$10 | ~$6 |
| **Total** | **≈ $377/mês** | **≈ $126/mês** |

*Custo por viagem: **$0,25** hoje → **$0,084** corrigido. A 5 000 viagens/dia os totais são ~$42/mês (hoje) e ~$18/mês (corrigido).*

---

## 7. Riscos que não são de quota (mas partem a app)

| Risco | Onde | Efeito |
|---|---|---|
| **`geo:global` num só objeto** | `DriverGeo`, id `geo:global` | `broadcastNearby` recalcula o enquadramento **por socket** (O(V×S) a cada 5 s). Satura a ~1 500–2 000 motoristas. Já há o comentário "Futuro: shard por cidade". |
| **Ponte GPS sem throttle no emissor** | `geoPushToTrip` (`:1002`) | 1 pedido a DO por cada fix, mesmo quando o recetor o descarta (`PUSH_GPS_MIN_MS` 10 s). ~600 pedidos/viagem só aqui. |
| **`trip_points` a cada 60 s** | `persistPoint` (`:3941`) | 1 escrita/min por viagem; é o maior consumidor de escritas D1 (45 das 120). |
| **`refreshStatus` a cada 15 s** | `:3958` | 60 leituras/viagem redundantes com `pushStatus()` (que já empurra em todas as transições). |
| **`AVG(score)` com JOIN em cada poll** | `webDriverInfo` (`:3016`) | ~85 linhas por `GET /trips/:id?view=web` para devolver um número que já está em `drivers.rating`. |
| **`GET /drivers/wallet` devolve 30 movimentos** | `:523` | ~61 linhas por chamada para responder `blocked` (1 linha bastava). |
| **`webSocketMessage` do `TripPush` sem rate limit** | `:3792` | um cliente pode inundar o DO; e o `from` do chat vem do payload (**spoofing**). |
| **Backoff fixo de 3 s em 5 WS** | cliente | esgota a quota em cascata quando o servidor falha. |
| **`/notifications/live` com 1 DO por utilizador** | `notifPoke`/`notifPokeMany` | um aviso do admin a 50 000 contas = 50 000 objetos e 50 000 pedidos num só gesto. |
| **Cron a cada minuto** | `wrangler.toml:12` | 1 440 pedidos/dia (1,4% do Free) só para verificar se há trabalho. |

---

## 8. Plano de correção, por ordem de ganho

### P0 — fazer antes de qualquer campanha (protege a quota atual)

1. **Matar o `LIKE '%…%'` de `places`** (`index.ts:1899-1909`).
   Remover o 3.º passo e deixar cair ao Photon/Nominatim (que já corre em paralelo e tem cache de 7 dias). **Ganho: 3,56 M → ~150 k leituras/dia (−96%).** É a diferença entre 71% e 3% da quota. Alternativa melhor: FTS5 sobre a coluna `norm` (o `places_fts` atual indexa tokens de `name`, não `norm`).
2. **Throttle no emissor da ponte GPS** (`geoPushToTrip`): só empurrar se passaram ≥10 s desde o último fix do mesmo motorista (espelhar `PUSH_GPS_MIN_MS`). **Ganho: −58% pedidos a DO por viagem** (600 → ~180) e menos acordares do objeto.
3. **Backoff exponencial com jitter nos 5 WS** (3→60 s) e só reconectar com `navigator.onLine` e `visibilitychange`. **Ganho: evita 1 200 pedidos/hora por socket em falha.**
4. **`trip_points` 60 s → 180 s** (`:3941`). **Ganho: −30 escritas D1 por viagem (−25%)** e o tecto de escritas sobe de 833 para ~1 100 viagens/dia.
5. **`GET /drivers/wallet/status`** devolvendo só `{blocked}`. **Ganho: 61 → 1 linha por chamada.**

### P1 — para escalar a sério

6. **Remover o `AVG(score) JOIN` do `webDriverInfo`** e usar `drivers.rating` (atualizado no `POST /ratings`, que já faz `UPDATE drivers`). **Ganho: 85 → 4 linhas por poll** (no cenário sem WS, 9 520 → 450 por viagem).
7. **`refreshStatus` 15 s → 60 s** (é rede de segurança de `pushStatus`). **Ganho: −45 leituras/viagem.**
8. **`refreshProfile` 60 s → 600 s** ou juntar ao `/api/v1/boot`. **Ganho: −54 pedidos/hora por utilizador aberto** (é a maior fonte em idle).
9. **`/api/v1/boot` agregado** (categorias + perfil + viagem ativa + não lidas + banner + zona): −8 a −12 pedidos por abertura.
10. **Índices/agregações do admin**: `notifications(type, createdAt)`, `SUM(finalFare)` com índice parcial, `admin/driver-stats` a ler `drivers.totalTrips/totalEarnings`; e **apagar os índices duplicados em `trips`** (`trips_passenger_idx` ×2, `trips_status_idx` ×2) — cada `UPDATE trips` escreve 2–4 entradas a menos.

### P2 — desenho para 50 000

11. **Shard do `DriverGeo`** por geohash/cidade (`geo:<célula>`) e **calcular o enquadramento uma vez por ciclo** (não por socket): O(V×S) → O(V + S).
12. **`NotifHub` por shard** (1 objeto por 1 000 utilizadores com tags) em vez de 1 por utilizador.
13. **Passar o `tripId` no payload do GPS** e acabar com o `activeTripForDriver()` (1 leitura D1 a cada 20 s por motorista, mesmo sem viagem).
14. **Snapshot único no `DriverGeo`** (`storage.put('snapshot', …)`) em vez de `p:<user>` por motorista + `load()` O(V).
15. **Rate limit no `webSocketMessage`** do `TripPush` e derivar o `from` do chat do attachment do socket (spoofing).
16. **Cron de 1 min → 5 min** com `lastRunKey`.

---

## 9. Correções às estimativas iniciais (para não repetir o erro)

| Estimativa inicial | Realidade medida | Porquê |
|---|---|---|
| "232 GB-s por viagem; o DO nunca hiberna" | **0,07 GB-s por viagem de teste; 1–3 GB-s modelado para 15 min** | a Hibernation API é usada; o objeto só corre enquanto executa (0,76 ms CPU/pedido). |
| "remover o SELECT de autenticação por pedido" | **0%** — `requireAuth` só valida o JWT (HMAC), não toca na D1 | `index.ts:243-254` |
| "as 3,5 M leituras/dia vêm das viagens" | vêm da **pesquisa de lugares** (varredura de 23 332 linhas por prefixo sem resultados) | §3.1 |
| "o teto Free é ~1 000 viagens/dia" | **≈ 330**, limitado pelos pedidos ao Worker e às DO | §4 |
| "arranjar as leituras aumenta o número de viagens" | **não aumenta** — as leituras são um problema de custo/risco; o número de viagens é limitado por pedidos e escritas | §4 |

---

## 10. Resposta curta

- **50 000 viagens/dia no Free: impossível** — está ~150× acima do teto. Nem 500/dia passa com folga.
- **O que fazer para chegar lá:** plano **Workers Paid** ($5/mês) + as correções P0/P1. Sem correções, ~$377/mês; com elas, **~$126/mês**.
- **Antes de tudo:** corrigir a varredura de `places` — hoje, com 20 viagens/dia, já se gastam 71% das leituras diárias e um dia de testes de autocomplete esgota a conta (erro 1027/7500, que já aconteceu duas vezes neste projeto).
- **O que continua verdade no AGENTS.md:** nunca correr `loadtest/` contra produção, nunca reimportar a base toda, e subir a chave `places:vN` sempre que se mexer em `places`.
