# Auditoria ao plano Free — D1, Worker e Durable Objects

**Data:** 30 de outubro de 2026 (medição às 08:06 UTC) · **Conta:** `016a8f9ed58a5cd10e9be697944905f0`
**Método:** 4 agentes em paralelo — 3 auditorias de código (só leitura) + 1 medição real pela GraphQL Analytics API.
**Pergunta do dono:** *"tenho medo que a base de dados estoure o limite do Free com muitas viagens. E se aplicarmos connection pool?"*

---

## 0. Resposta directa sobre *connection pool*

**Não se aplica. Ganho: 0.**

- O D1 **não tem ligações**. Cada `sql\`\`` é um pedido HTTP independente ao serviço D1; não há socket, pool, `max_connections` nem handshake para reutilizar. Não existe nada para agrupar.
- O D1 **não cobra ligações**. Cobra `rows_read` e `rows_written` (documentado em `developers.cloudflare.com/d1/platform/pricing`): uma query que varre uma tabela de 5 000 linhas conta 5 000, mesmo que devolva 1. Pool não muda linhas lidas.
- **Read replication / Sessions API** (`withSession()`) é o que existe mais parecido — reduz **latência** em regiões longe do primário e escala throughput. A própria documentação diz: *"You incur the exact same D1 usage billing with or without replicas, based on `rows_read` and `rows_written`"*. **Quota: zero de ganho.**
- **Hyperdrive** é o *pooler* real da Cloudflare — mas só para **PostgreSQL/MySQL**. Com D1 não se usa.
- **O análogo útil é `db.batch([...])`**: 1 round-trip para N statements. Poupas **pedidos ao Worker e subrequests** (e latência de 0,5–0,8 s por round-trip em WEUR), **não** poupas linhas lidas. O adaptador em `cloudflare/api-worker/src/db.ts:69-102` **não tem `batch()`** — todos os `sql\`\`` são `prepare().all()` isolados.

> Conclusão: procurar uma solução de *pooling* é procurar no sítio errado. O que estoura é **linhas lidas** e **pedidos ao Worker**, e isso só baixa com **menos queries por viagem, menos polling e cache**.

---

## 1. Onde estamos, ao minuto (números reais)

### Hoje (00:00 UTC → 08:06 UTC, 8,11 h decorridas)

| Recurso | Gasto | Tecto Free/dia | % |
|---|---|---|---|
| Pedidos Worker | **3 629** | 100 000 | **3,6 %** |
| D1 linhas lidas | **405 180** | 5 000 000 | **8,1 %** |
| D1 linhas escritas | **400** | 100 000 | **0,4 %** |
| Pedidos Durable Objects | **488** (36 objectos) | 100 000 | **0,5 %** |
| Duração DO | **0,30 GB-s** | 13 000 GB-s | **0,002 %** |
| Storage DO (R/W) | 3 047 / 0 | 5 M / 100 k | 0,06 % / 0 % |

### Últimas 24 h

| Recurso | 24 h | % do tecto diário |
|---|---|---|
| Pedidos Worker | **38 202** | **38,2 %** |
| D1 linhas lidas | **3 495 200** | **69,9 %** |
| D1 linhas escritas | **5 290** | **5,3 %** |
| Pedidos DO | **5 398** | **5,4 %** |
| Duração DO | **7,02 GB-s** | **0,054 %** |

*48 h: 40 790 pedidos Worker · 3 709 076 lidas · 129 854 escritas (das quais **124 051** são o import de 28/10 — sem ele, ~6 500) · DO 6 706 pedidos, 9,64 GB-s.*

### Hora a hora (o que importa ver)

| hora (UTC) | pedidos | readQ | rowsRead | **linhas por leitura** |
|---|---|---|---|---|
| 29/10 22:00 | 1 354 | 600 | 20 456 | 34,1 |
| 29/10 23:00 | 1 211 | 594 | 23 057 | 38,8 |
| 30/10 00–03:00 | ~170/h | 180/h | 120/h | **0,7** (só cron) |
| 30/10 **04:00** | 558 | 1 054 | **346 162** | **328,4** |
| 30/10 05:00 | 157 | 376 | 25 467 | 67,7 |
| 30/10 06:00 | 142 | 289 | 32 100 | 111,1 |
| 30/10 07:00 | 94 | 198 | 741 | 3,7 |
| 30/10 08:00 (parcial) | 6 | 13 | 31 | 2,4 |

**Leitura:** o padrão antigo (2 513 linhas/query, `29/10 17:00` = 1,37 M numa hora) **já não existe** — o corte do `LIKE '%…%'` pegou. Mas **04:00 de hoje** ainda fez **346 162 linhas em 1 hora = 7 % do tecto diário num único relógio**, com 328 linhas por query. Não é a varredura de 23 332; é busca de lugares com muitos resultados (`kilamba` = 2 399) e ausência de cache para prefixos novos.

> **Duas horas de testes de autocomplete hoje esgotam as leituras de amanhã.** Foi assim que a conta caiu em 2026-10-17 e 2026-10-28.

---

## 2. Estado real das correções documentadas no `AGENTS.md`

| Correção | Estado | Prova |
|---|---|---|
| `localPlaces()` sem `norm LIKE '%…%'` (FTS5 → GLOB → Photon) | **Feito** | `index.ts:1899-1923` |
| Chave de cache `places:v14` | **Feito** | `index.ts:1975` |
| `persistPoint` 180 s | **Feito** | `index.ts:3962` |
| `geoPushToTrip` com `GEO_PUSH_MIN_MS` | **Feito** (9 000 ms) | `index.ts:1009-1022` |
| Backoff exponencial nos 5 WS (`lgBk`) | **Feito** | `ladiesgo-home.html:795-820` |
| `lgPlaceFetch` (cache cliente 10 min/60 s) no `#q` | **Feito** | `:82`, `:112` |
| `refreshProfile` 900 s · `walletData` 60 s · `paintWBadge` 600 s · `sharedNotifPoll` 60 s | **Feito** | `:47`, `:76`, `:78`, `:874` |
| `GET /drivers/wallet/status` (61 → 1 linha) | **NÃO existe** | só `GET /drivers/wallet` (`:523`, 31 linhas) |
| `webDriverInfo` sem `AVG(score) JOIN` | **Por fazer** | `index.ts:3034` |
| `refreshStatus` 15 s → 60 s | **Por fazer** (`PUSH_STATUS_TTL_MS=15_000`, e `:3850` força) | `index.ts:3588`, `:3850` |
| `pollInc` parar com `requests-live` aberto | **Por fazer** | `home:61` |
| `/api/v1/boot` agregado | **Por fazer** | — |
| Backoff do WS da viagem (`_liveSchedule`) | **Parcial** (1,6×, 3–30 s, **sem jitter**, sem floor offline) | `home:784` |
| `lgPlaceFetch` no `#oq`/`#qs`/picker partilhado/picker Premium | **Parcial/por fazer** (fetch directo) | `:113`, `:959`, `:969`, `:1497` |
| `batch()` no adaptador D1 | **Não existe** | `src/db.ts:69-102` |

---

## 3. Para onde vão as leituras da D1 (top 10)

Estimativas derivadas de `LIMIT`, JOINs e índices — não há dimensão de rota na Analytics API.

| # | Endpoint | Queries seq. | Linhas/chamada | Frequência | Custo/viagem 15 min |
|---|---|---|---|---|---|
| 1 | `GET /trips/:id?view=web` | **4** | ~28 (4 a 127) | 8 s / 30 s com WS | **~840–3 100** |
| 2 | `GET /trips/incoming` | 3–4 | ~82 | 8 s durante a procura | ~1 230 por pedido |
| 3 | `GET /trips/active` | 2 | ~2 | 8 s | ~224 |
| 4 | `GET /places/search` | 1–2 | **3 a 2 399** (medido) | cache 7 dias + 10 min cliente | só no *miss* |
| 5 | `GET /admin/stats` | 4 (paralelas) | ~269 | raro (admin) | — |
| 6 | `GET /trips/history` | 1–2 | ~35 | por abertura | ordena em memória |
| 7 | `GET /notifications` | 1 | 50 | abertura + poke | 50 |
| 8 | `GET /drivers/wallet` | 2 | ~31 | abertura, **×3 no arranque da motorista** | 93 |
| 9 | `GET /notifications/banner` | 1 | ≤12 | 1,5 s após `/home` + cada poke | 12 |
| 10 | `GET /drivers/nearby` | 1 | 1 | 3 s de cache cliente | ~1 |

**O campeão absoluto é o `/trips/:id?view=web`**: 4 round-trips sequenciais, dos quais o pior é um agregado **sem cache**:

```
index.ts:3034  SELECT COALESCE(AVG(rt.score),0), COUNT(*) FROM ratings rt
               JOIN trips t ON t.id = rt."tripId" WHERE t."driverId" = ?
```

Devolve **um número** que já está em `drivers.rating`. Hoje são 24–121 linhas por chamada; a 1 000 viagens são 1 000+.

---

## 4. Escritas: não é o problema (5,3 % do tecto)

| Operação | Escritas (linha + índices) |
|---|---|
| `INSERT trips` | 4 |
| aceite | 3–4 |
| `arrived` / `in_progress` | 2–3 cada |
| `complete` + `applyCommission` | 7–8 |
| `trip_points` (5 pontos × 3) | ~15 |
| avaliação | 4 |
| chat (~5 msgs) | ~5 |
| **Total** | **≈ 35–45** |

A 120 escritas/viagem estimadas antes, estava pessimista. Com 40: **100 000 ÷ 40 = 2 500 viagens/dia** só pelas escritas.

---

## 5. Pedidos ao Worker: a segunda parede (e a primeira na prática)

| Cenário | Pedidos/h por utilizador |
|---|---|
| Passageira, 1.º plano, WS bom, sem viagem | **≈ 4** |
| Motorista online, sem viagem | **≈ 154** (até **484** com pedidos na lista) |
| Passageira, 1.º plano, viagem ativa | **≈ 604** (120 são escritas) |
| Motorista, viagem ativa | **≈ 394** |
| Qualquer, durante chamada | **+1 080/h** |
| Passageira, background, sem WS | ≈ 124–184 |
| Passageira, background + viagem com WS caído | **≈ 870–2 550** |

Os três desperdícios maiores:

1. **`pollInc` a 8 s/30 s com o `requests-live` aberto** (`home:61`) — o frame `{t:'refresh'}` já chama `pollInc` (`:803`). **−110 a −440 pedidos/h por motorista online.**
2. **`call/signal` a 2 s quando o WS de chamadas está fechado** (`:671`, `:619`) — **1 800/h**. O `ping`/`pong` do WS já detecta queda em 12 s.
3. **Arranque disperso**: passageira **9 REST + 2 WS**, motorista **13 REST + 3 WS**. Um `/api/v1/boot` faria **1 + 2** e **1 + 3**. Inclui `GET /drivers/wallet` **três vezes** (`:76`, `:164`, `:193`).

---

## 6. Durable Objects: não é o constrangimento

| DO | Hibernation | Storage writes/evento | Pedidos/viagem |
|---|---|---|---|
| `TripPush trip:<id>` | Sim | 1 por ligação + 1 por estado | **~102** |
| `TripPush calls:<id>` | Sim | 0 | 1 + sinais |
| `RequestsHub requests:global` | Sim | 0 | 2–3 + tick |
| `NotifHub notif:<uid>` | Sim | **0** | 0 |
| `DriverGeo geo:global` | Sim | 1 por >120 s | 0 (faz a ponte) |
| `TripRinger global` | Não (sem WS) | 4 no `/kick` | 4–8 |

**Uso real: 5,4 % dos pedidos e 0,05 % das GB-s.** O tecto de duração só morderia às ~185 000 viagens/dia.

Duas notas:
- O modelo de **"~300 pedidos DO/viagem" do `AGENTS.md` não se reproduz**: dá **≈110–115** limpo e **≈155–190** realista. Dos quais **95 são a ponte `geoPushToTrip` (86 %)**.
- **Bug real, não de quota:** `notifPokeMany` (`index.ts:1136-1144`) faz **1 subrequest por destinatário** e o Worker Free permite **50 por invocação**. A partir de **~45 destinatários** o push Expo falha **em silêncio** (os erros são engolidos em `try{}catch{}`). Com 26 utilizadores não acontece — mas é a primeira coisa a partir quando a base crescer. Há também **dois pokes flutuantes** (`:4761`, `:4832`) sem `await` nem `waitUntil`, que podem **nunca chegar**.

---

## 7. Tecto real hoje — e depois das correções

| Restrição | Conta | Viagens/dia |
|---|---|---|
| Pedidos ao Worker | 100 000 ÷ 300 | **~330** |
| Pedidos a DO | 100 000 ÷ 150 | ~660 |
| Linhas lidas D1 | (5 M − 1,2 M base) ÷ 3 000 | ~1 270 |
| Linhas escritas D1 | 100 000 ÷ 40 | 2 500 |
| Duração DO | 13 000 ÷ 2 | 6 500 |

**Hoje: ~330 viagens/dia** — limitado por pedidos ao Worker, com as leituras a 70 % já sem viagens nenhumas.

Depois das correções da §8 (≈120 pedidos e ≈700 linhas por viagem, base de leitura ≈1,2 M):

| Restrição | Viagens/dia |
|---|---|
| Pedidos ao Worker | (100 000 − 38 000) ÷ 120 ≈ **515** |
| Linhas lidas D1 | (5 M − 1,2 M) ÷ 700 ≈ **5 400** |

**Com as correções, quem manda passa a ser o Worker: ~500 viagens/dia.** Para 50 000/dia nunca há solução no Free — é o plano pago ($5/mês), como já diz o `AUDITORIA-50K-VIAGENS.md`.

---

## 8. Plano por ordem de ganho (nada aplicado — só auditoria)

### P0 — dias, não semanas (protege a quota de hoje)

1. **`webDriverInfo` sem o `AVG(score) JOIN`** (`index.ts:3034`) → usar `drivers.rating` (já atualizado em `POST /ratings`) ou cache `(avg,n)` 120 s por isolate. **−25 a −121 linhas × 112 chamadas/viagem.** Risco: nota até 2 min atrasada.
2. **`refreshStatus` 15 s → 60 s** e tirar o `force=true` do `state` (`:3588`, `:3850`). **−45 leituras/viagem.** O push continua imediato.
3. **`pollInc`: sem polling com `requests-live` aberto** (`home:61`), rede de segurança 60 s. **−110 a −440 pedidos/h por motorista.** Risco: um frame perdido atrasa ≤60 s.
4. **`call/signal` 2 s → 10 s** fora de chamada (`:671`, `:619`). **−1 700/h em rede má.**

### P1 — a seguir

5. **`/api/v1/boot`** + dedupe do arranque (`wallet` ×3 → ×1). **−8 pedidos/abertura (passageira), −12 (motorista).**
6. **`batch()` no `src/db.ts`** para as leituras independentes do `/trips/:id?view=web` (3 delas) e `/trips/incoming` (2). **−2 a −3 round-trips por chamada** (pedidos, não linhas).
7. **`pollTrip` 8 s → 20 s e uma só chave** (`'pt'`/`'pt8'` hoje duplicam). **−300/h por viagem em rede má.**
8. **Background**: `pollCars` do `softResync` e `unread-count` só com `visibilityState==='visible'`. **−120/h por utilizador em background.**
9. **Índices compostos** `trips_passenger_idx("passengerId","createdAt")` e `trips_driver_idx("driverId","createdAt")` (a `0002` apagou-os). Não dói hoje (121 viagens) mas **cresce linear**. Custo: +1 escrita por INSERT.
10. **`GET /drivers/wallet/status` → `{blocked}`** (1 linha) e `loadDrvBlocked` a reutilizar `walletData()`.

### P2 — quando a base crescer

11. **`notifPokeMany` com tecto** (fan-out por shard ou fila `pending`) e **push Expo antes dos pokes**. Corrige a falha silenciosa a partir de ~45 destinatários.
12. **`tripId` no payload do GPS** → elimina o `activeTripForDriver()` (1 leitura D1 a cada 20 s por motorista).
13. **`broadcastNearby` uma vez por centro** (O(V×S) → O(V×C)). Só conta GB-s.
14. **Rate limit no `webSocketMessage` do `TripPush`** (o `DriverGeo` já tem `newBucket`/`tryConsume` — copiar 10 linhas) e **`from` do chat do attachment**, não do payload (spoofing).

### Não fazer (já medido e recusado)

- **Connection pool** — não existe para D1.
- **Read replication / Sessions API para quota** — mesmo preço, só latência.
- **Migração `0021`** (índices extra) — só `places` é grande; abandonada.
- **Reescrever o `DriverGeo` para snapshot** — 0,16 % do orçamento de storage.
- **Cron `* * * * *` → `*/5`** — 1,4 % da quota, e a precisão ao minuto é necessária.
- **Contas novas para fugir ao limite** — viola os ToS.

---

## 9. Resumo em 5 linhas

1. **Connection pool: não existe no D1 e não muda nada.** O que conta são linhas lidas/escritas — não ligações.
2. Hoje estás a **8 % das leituras** e **3,6 % dos pedidos**, mas nas últimas 24 h as leituras foram **70 %** com ~20 viagens: o problema é a **pesquisa de lugares e o polling**, não as viagens.
3. O que trava primeiro é o **pedido ao Worker (~330 viagens/dia)**, não a base de dados.
4. Com as 4 correções P0 sobes para **~500 viagens/dia** e as leituras caem para ~15 % do tecto.
5. **50 000 viagens/dia no Free é impossível** (150× acima) — é plano pago de $5/mês + as correções P0/P1.
