# Quem gasta a quota — atribuição ao minuto (30/10/2026)

**Data:** 30 de outubro de 2026, 13:25 UTC · **Conta:** `016a8f9ed58a5cd10e9be697944905f0` · **BD:** só a de produção `fab720b7…`
**Método:** GraphQL Analytics da conta, **por minuto** (`d1AnalyticsAdaptiveGroups` + `workersInvocationsAdaptive`), cruzada com os 3 relatórios de código (cliente / D1 / Durable Objects).
**Legenda:** **MEDIDO** = número da Analytics ou `meta.rows_read` · **ESTIMADO** = conta feita a partir do código, ainda não medida.

---

## 0. Resposta em três linhas

1. **Hoje, 98,5 % das leituras da D1 vieram de 45 minutos** (424 545 de 430 840 linhas). Os outros 759 minutos somam 6 295 linhas.
2. **Cada pico é um múltiplo inteiro de 23 332 linhas — o tamanho exacto da tabela `places`.** Eram varreduras completas de `places` feitas pelo 3.º passo de `localPlaces()` (`norm LIKE '%termo%'`, sem índice), **removido às 08:21 UTC de hoje** (commit `c515d18`, "cortes P0", já em produção).
3. **Depois do corte, o consumo real da app é ~10 000 linhas/dia (0,2 % do tecto de 5 M).** O que resta não são leituras — são **pedidos por viagem** (~300 Worker+DO), que a 50 000 viagens/dia continuam a ser o muro.

---

## 1. Hoje, minuto a minuto (MEDIDO 00:00Z → 13:25Z)

| Recurso | Gasto | Tecto | % |
|---|---|---|---|
| D1 linhas lidas | **430 840** | 5 000 000 | **8,6 %** |
| D1 queries de leitura | 3 792 | — | — |
| D1 linhas escritas | 375 | 100 000 | 0,4 % |
| Pedidos Worker | **4 770** (4 519 `ladiesgo-api` + 251 `-staging`) | 100 000 | 4,8 % |
| Pedidos Durable Objects | 647 (13:16Z) | 100 000 | 0,6 % |
| Duração DO | 0,64 GB-s / 26 h | 13 000 GB-s | 0,005 % |

### A distribuição que explica tudo

| Grupo de minutos | Minutos | Linhas lidas | % das leituras |
|---|---|---|---|
| **≤ 200 linhas** (repouso) | 759 | **6 295** | **1,5 %** |
| **> 200 linhas** (picos) | **45** | **424 545** | **98,5 %** |

### Por hora (UTC)

| Hora | D1 lidas | D1 esc. | Worker req | Leitura |
|---|---|---|---|---|
| 00:00–03:00 | 120 · 120 · 120 · 124 | 0 | 1144 · 118 · 120 · 119 | piso de repouso |
| **04:00** | **346 162** | 243 | 1278 | **80 % do dia** |
| 05:00 | 25 467 | 112 | 355 | picos |
| 06:00 | 32 100 | 0 | 317 | picos |
| 07:00 | 741 | 0 | 177 | piso (cron) |
| 08:00 | 429 | 0 | 121 | piso (cron) — **corte entra às 08:21** |
| 09:00 | 11 582 | 3 | 225 | verificação do deploy + medições |
| 10:00 | 12 616 | 8 | 335 | idem |
| 11:00 | **502** | 9 | 286 | já só app |
| 12:00 | **126** | 0 | 100 | já só app |
| 13:00 | **631** | 0 | 75 | já só app |

**Piso de repouso medido (sem ninguém, sem viagens): 120–741 linhas/hora e ~100–120 pedidos/hora.**
Projectado: **3 000–18 000 linhas/dia (0,06–0,36 %)** e **2 400–2 900 pedidos/dia (2,4–2,9 %)**. O cron por minuto não é problema.

---

## 2. A prova de que eram varreduras de `places`

`places` tem **23 332 linhas**. Todos os picos são múltiplos inteiros desse valor, a menos de outras queries pequenas no mesmo minuto:

| Minuto | Linhas lidas | Queries | Média | ÷ 23 332 | Pedidos Worker |
|---|---|---|---|---|---|
| 04:32 | 186 908 | 77 | 2 427 | **8,01** | 90 |
| 04:31 | 44 281 | 40 | 1 107 | 1,90 | 51 |
| 06:37 | 25 572 | 7 | 3 653 | **1,10** | 7 |
| 04:35 | 26 304 | 7 | 3 758 | 1,13 | 23 |
| 04:51 | 23 375 | 7 | 3 339 | **1,00** | 6 |
| 05:00 | 23 358 | 9 | 2 595 | **1,00** | 7 |
| 04:18 | 10 327 | 7 | 1 475 | 0,44 | 8 |
| 04:19 | 10 278 | 21 | 489 | 0,44 | 27 |

Nenhuma outra tabela chega perto: `trips` 121, `notifications` 315, `ratings` 24, `users` 26, `trip_points` 1 290. **Só `places` tem 23 k linhas** — é a assinatura de uma varredura completa.

### O multiplicador perverso (código como estava até 08:21Z)

`localPlaces()` tinha três passos, e o 3.º (`norm LIKE '%termo%'`) **disparava sempre que o FTS devolvia menos de 8 linhas** — ou seja, nas pesquisas precisas. E o cliente dispara **1 pedido por tecla** (debounce 250–300 ms) em quatro caixas de pesquisa:

- `#qs` (`linha 113`), `sharedPlaceInput` (`961`), `sharedPickSearch` (`971`), `prmPick` (`1499`) — todas com `fetch` cru;
- só `#q`/`#oq` usam `lgPlaceFetch` (`82`, cache 10 min).

Logo: **escrever "kilamba" = 7 teclas = 7 pedidos = 7×23 332 = 163 324 linhas = 3,3 % do tecto diário.**
O bloco das 04:31–04:32 (8 varreduras em 90 pedidos) tem exactamente essa forma: uma pessoa a escrever um destino.

**214 pesquisas dessas = os 5 M do dia.** Foi o que aconteceu a 29/10 (3,56 M).

### O que o corte de 08:21Z mudou (MEDIDO, `meta.rows_read` do SQL já em produção)

| Pesquisa | Linhas lidas |
|---|---|
| `isptec` | **3** |
| `bloco d27` | **3** |
| `patricio` | 9 |
| `momo` | 18 |
| `shoprite` | 39 |
| `banco bic` | 183 |
| `agostinho neto` | 237 |
| `kilamba` | **2 399** |

Antes: 23 332 em **todas**. O pior caso caiu 10× e o caso típico caiu ~1 000×. O tecto deixou de ser "214 pesquisas/dia" para "≥2 000/dia só no pior caso".

---

## 3. O que gasta agora (ranking real, depois do corte)

### 3.1 Por pedidos ao Worker (100 k/dia) — MEDIDO + modelo do código

Piso medido: **~100–120 pedidos/h** com a app fechada (cron 60/h + um cliente).

| # | Origem | Pedidos/h | Corte |
|---|---|---|---|
| 1 | `GET /drivers/nearby` — `softResync` a cada 32 s **sem** `liveSkipPoll` | **112** | **FEITO 30/10:** respeita o WS `nearby-live` (1×/60 s) → **0** |
| 2 | `GET /trips/incoming` — `pollInc` 4 s → 60 s com WS | 60 (900 sem WS) | fallback ≥30 s |
| 3 | `GET /trips/:id?view=web` — `pollTrip` 8 s → 60 s com WS | 60 (450 sem WS) | manter |
| 4 | `GET /route` — 2 pernas com gate de 10 s | até 720 | gate 30–60 s / só com desvio >50 m |
| 5 | `GET /notifications/unread-count` (WS notif em baixo) | 60 | 300 s |

Cenários modelados: **passageira parada no `/home` ≈ 119 pedidos/h** · **à espera de motorista ≈ 296/h** (357 com posição) · **motorista online sem viagem ≈ 82/h**.
O piso noturno medido (118–120/h) **bate certo** com o cenário "parada" + cron — o modelo está validado.

### 3.2 Por linhas lidas da D1 (5 M/dia)

| # | Sítio | Linhas/chamada | Nota |
|---|---|---|---|
| 1 | `/api/places/search` | 3 → **2 399** | único endpoint que lê milhares; cache 7 dias por datacenter |
| 2 | `GET /trips/history` | **153** (30 itens) | `JOIN` duplo desnecessário |
| 3 | `webDriverInfo` `AVG(score)` | **97** | cache isolado de 120 s |
| 4 | `GET /ratings/pending` | **83** | `OR` mata os índices; cresce com o histórico |
| 5 | `GET /trips/active` | **5–6** | era 78/65 antes do `INDEXED BY` |
| — | cron por minuto | 120–741/h | 4 queries/min (2 880/dia) |

### 3.3 Por pedidos às Durable Objects (100 k/dia)

| Objeto | 26 h | Storage lido | Nota |
|---|---|---|---|
| `geo:global` | 938 req | **7 776** | `load()` faz `storage.list({prefix:'p:'})` — **O(nº de motoristas) por hibernação**, e as chaves nunca são apagadas. **Corrigido a 30/10 (P7): snapshot numa só chave, 11 → 1 leitura por acordar** |
| `notif:<userId>` | ~194 | 0 | 1 objeto por utilizador, WS hibernável |
| `trip:<id>` / `requests:global` | 46 / 28 | 0 / 0 | — |

A ponte `/gps` (DriverGeo → TripPush) continua a valer ~400 pedidos de DO/hora por viagem ativa (emissor 9 s, receptor descarta <10 s).

### 3.4 Escritas (100 k/dia) e duração

45–55 linhas por viagem ≈ **2 000 viagens/dia** só pelas escritas. Hoje: 375 (0,4 %). **Não é o muro.**
Duração: 0,07 GB-s por viagem (Hibernation API a funcionar) — 26 h deram 0,64 GB-s.

---

## 4. Correção de duas ideias antigas (para não repetir a análise)

- **"O cron por minuto é um piso de 65 linhas/min ⇒ 93,6 k/dia (1,9 %)".** Falso. Medido hoje nas horas sem ninguém: **741 (07:00), 429 (08:00), 126 (12:00)**, ou seja **2–18 k/dia**. As 65 linhas/min vinham de uma janela com trabalho de teste a decorrer.
- **"3,56 M/dia é a pesquisa de lugares em uso real".** A cascata era mesmo a causa (provado pelos múltiplos de 23 332), mas **o volume incluía a auditoria/correção de coordenadas do próprio assistente** (29/10, 15:00–20:00Z: 2,64 M em 6 h, com 3 000 pedidos/hora). O uso real medido hoje, pós-corte, é ~10 k/dia.

---

## 5. Propostas ordenadas por ganho/risco (nada aplicado — à espera de decisão)

| # | Correção | Ganho estimado | Risco |
|---|---|---|---|
| **P1** | `localPlaces`: subquery `LIMIT 800→120`, exterior `400→60`; subir a chave `places:v14→v15` | `kilamba` 2 399 → ~350 (**−85 %** no pior caso) | relevância de prefixos largos (a app mostra 5–6; o `ORDER BY` por distância continua dentro dos 120 melhores por bm25) |
| **P2** | 4 caixas de pesquisa passarem a `lgPlaceFetch` (cache 10 min) | menos **pedidos** em teclas repetidas (a D1 já é poupada pelo cache de 7 dias) | nenhum |
| **P3** | `webDriverInfo`: TTL 120 s → 600 s **+ tirar o `JOIN`** (ver nota abaixo) | 97 → **18** linhas e 30/h → 6/h | nota da motorista até 10 min desactualizada (o `POST /ratings` invalida a cache) |
| **P4** | `/ratings/pending`: `INDEXED BY trips_passenger_idx`/`_driver_idx` por papel | 83 → 0–1 | nenhum (mesma resposta) |
| **P5** | `/trips/history`: um só `JOIN` | 153 → ~60 | nenhum |
| **P6** | `softResync` respeitar `liveSkipPoll('nearby')` | −112 pedidos/h por app de passageira aberta | mapa de carros actualiza pelo WS (já existe) — **FEITO 30/10** |
| **P7** | `DriverGeo.load`: chave única `snapshot` em vez de `list({prefix:'p:'})`, e apagar chaves com `ts` > 18 min | **FEITO 30/10: 11 → 1 leitura por acordar** (medido) | 1 migração de storage no DO (inócuo; o `pos` repovoa no 1.º ping) |

**Ordem recomendada:** P1 (o único sítio que ainda lê milhares) → P3+P4+P5 (uma tarde, tudo de resposta idêntica) → P6 (pedidos) → P7 (só quando houver mais de ~20 motoristas).

> **Estado a 30/10:** **P3 FEITO** (em produção, API `c9780c53`) — e melhor do que o estimado:
> a média deixou de fazer `JOIN` com `trips` e passou a ler `ratings."ratedId"` (índice
> `ratings_rated_idx`), **97 → 18 linhas**; TTL 600 s. `GET /ratings/mine` passou à mesma fonte
> (**131 → 35 linhas**). Detalhe e provas em `AGENTS.md` → "8. Quinta vaga".
> **P4/P5 FEITOS** na migração `0023`. **P1 medido e recusado** (perde qualidade nas pesquisas mais
> usadas de Luanda por ~0,3 % de quota). **P7 FEITO a 30/10** (decisão do dono, sem esperar pelos
> ~20 motoristas): o `DriverGeo` passou a guardar **todas** as posições numa **única chave**
> (`snapshot:v1`) e a apagar de vez as chaves `p:<userId>` antigas (eram elas que faziam o
> `storage.list({prefix:'p:'})` custar **11 leituras por acordar** em produção com **1** motorista).
> Medido com a GraphQL por objeto (`6f8141fd…`): **11 → 1 leitura/pedido**, e a migração correu
> uma só vez (16:34Z: 22 leituras + 12 escritas, o `delete` das 11 chaves velhas). Provado em
> staging: `mode:"legacy-list"` na 1.ª hibernação e `mode:"snapshot"` na seguinte, posição nova
> (-8.9111, 13.3111) recuperada do snapshot, offline → `drivers:0`/snapshot 2 bytes. Ver
> `AGENTS.md` → "10. Sétima vaga".
>
> **P6 FEITO a 30/10** — e com ele a **9.ª vaga** de cortes, que ataca o recurso mais perto do tecto
> em uso real: os **pedidos ao Worker**.
> - `GET /api/v1/boot` (novo) junta perfil + bloqueio da carteira + categorias + não lidas + banner
>   + viagem ativa: **5–7 pedidos → 1**, por +5 linhas lidas na D1 (18 no total, medido em produção).
> - `Cache-Control: public, max-age=300` em `/categories` e `private, max-age=300` em `/turn/ice`
>   (provado no browser: 1517 ms com cache-bust vs **2 ms** sem — a 2.ª não chega ao Worker).
> - Cliente: 60 s de tréguas no banner e nas não lidas depois do `/boot`, e `__adoptActive` aceita a
>   viagem ativa do próprio `/boot`. Com o `/boot` abortado cai tudo nos endpoints antigos (provado).
> - O `softResync` deixou de repetir o `/drivers/nearby` com o WS de carros aberto (era o P6).
> - Medido no browser (414×896, 15 s de `/home`): **7 pedidos `/api/*`** com `/boot` vs **11** sem.
>   Detalhe e provas em `AGENTS.md` → "9. Sexta vaga".


---

## 6. Como repetir esta medição

```bash
cd cloudflare/api-worker && node scripts/quota-watch.mjs          # total da conta
node "$TEMP/opencode/cf-today.mjs"                                # hoje, minuto a minuto (D1 prod + Worker)
```
Scripts usados: `%TEMP%\opencode\cf-today.mjs` (hoje) e `cf-hourly.mjs` (26 h, por minuto e por classe de DO).
