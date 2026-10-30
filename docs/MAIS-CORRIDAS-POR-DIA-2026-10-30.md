# Mais corridas por dia no plano Free — consolidação (2026-10-30)

Objectivo do dono: **mais viagens/dia sem sair do Free**. Este documento junta três investigações
paralelas (custo no backend, limites oficiais Cloudflare 2026, tempo-real/GPS barato) + inspecção do
cliente, e responde a uma pergunta só: *o que corta custo por viagem, por quanto, e o que falta medir
antes de mexer*.

Nada aqui foi aplicado. É investigação read-only (só `SELECT`, sem deploy, sem testes de carga).

---

## 1. Onde estamos (medido, AGENTS.md "12. Nona vaga")

| Recurso | Por viagem (15 min) | Tecto Free/dia | Viagens/dia |
|---|---|---|---|
| Pedidos às Durable Objects | ≈49 | 100 000 | **≈2 040** ← trava |
| Escritas D1 | ≈48 | 100 000 | ≈2 080 ← quase empata |
| Pedidos ao Worker | ≈20–30 | 100 000 | ≈4 000 |

Os dois primeiros estão **empatados**: cortar só um dá **+0 a 2 %**. Qualquer plano tem de cortar os
dois em simultâneo.

---

## 2. As três correcções ao modelo actual (encontradas nesta investigação)

### 2.1 O ciclo da viagem gasta ≈44 escritas, não 48 — mas por outras razões
O AGENTS.md conta "8 (2 avisos)" no ciclo. **Esses 8 não existem no código** (o pedido de viagem não
escreve em `notifications`). Em compensação existem duas escritas que não estavam contadas:
`wallet_tx` (**+3**) e `UPDATE drivers` (**+1**). O ciclo real fica **≈44**, e os 48 do total
continuam a bater certo com os pontos do GPS.

### 2.2 O `geoSet` espelhado dentro do `TripPush.onGps` pode ser o maior gasto escondido
`cloudflare/api-worker/src/index.ts:4089`:

```ts
// dentro do DO da viagem, a cada fix do motorista (máx. 1/10 s)
geoSet(this.env, { userId: att.uid, lat: la, lng: lo, h: hh, noTripPush: true })
```

`geoSet` → `geoFetch` → `fetch()` ao DO **`geo:global`** (`index.ts:1236-1241`). Ou seja: **cada fix
do motorista que entra pelo WebSocket da viagem custa 1 pedido ao DO global**, além do fix que já
tinha entrado pelo WebSocket `drivers/live-geo`.

E o cliente manda esse fix de propósito: `webapp/ladiesgo-home.html:796` tem um `setInterval(…,15000)`
que chama `liveSendGps(la,lo)` com a posição actual — **mesmo parada** — e o `postPos` foi
embrulhado para *saltar* o REST quando o WS da viagem aceitou o envio. Resultado: numa viagem de
15 min, **≈60 pedidos extra ao DO `geo:global`** (1/15 s), que o modelo dos 49/viagem **não conta**
(foi medido num ensaio em que o motorista pingava por REST, caminho que não passa por aqui).

- **Se os pedidos forem contados 1:1**, a viagem real custa ≈**109** pedidos de DO, não 49 ⇒ a
  capacidade real de hoje seria ≈**900 viagens/dia**, não 2 040.
- **Se as mensagens de WS forem 20:1**, o espelho continua a ser um `fetch` explícito (conta 1) e o
  custo é ≈**109** na mesma. Só o custo das *mensagens* é que muda.

Não dá para decidir isto por leitura de código — **tem de se medir** (ver §5).

### 2.3 As mensagens de WebSocket podem contar 1:1 no Free
A documentação de preços diz que as mensagens de entrada num DO são facturadas a **20:1** ("100
mensagens = 5 pedidos"), mas classifica a regra como **de facturação**. No Free o tecto é "pedidos",
não dólares. Há indicação de que, no Free, cada mensagem conta como **1 pedido**. Se for verdade,
`heading` (1/0,9 s) e `gps` (1/15 s) e `ping` (1/3 s durante chamadas) somam **centenas** de pedidos
por viagem, e o modelo dos 49 está muito optimista.

**Consequência prática:** qualquer optimização de mensagens (heartbeat, heading, batching) só vale a
pena depois de saber isto. É o item nº 1 da lista de medição.

---

## 3. Cortes propostos, por ordem de ganho

### A. Espelhar a posição no `geo:global` no máximo 1×/60 s (novo, maior ganho)
- Onde: `TripPush.onGps`, `index.ts:4089` (guardar `att.lastMirrorAt`, igual ao `lastFixAt`).
- Porque 60 s chega: com o WS aberto o polling da passageira está a **120 s** (`liveSkipPoll(...,120000)`);
  o link público recebe a posição pelo próprio `TripPush` (`broadcastTag('pub')`), não pelo `DriverGeo`;
  e o `geoPushToTrip` (REST) já cobre o caminho de fundo.
- Ganho: **≈60 → ≈15 pedidos/viagem ao DO global** (−45). Baixo risco: só se perde frescura do
  fallback de polling, que já é lento por desenho.

### B. `trip_points` 180 s → 900 s
- Onde: `index.ts:4158` (`if (now - this.lastPointAt < 180000) return;`).
- Cada `INSERT` em `trip_points` = **4 linhas escritas** (linha + 3 índices). 15 min a 180 s = 5 pontos
  = 20 escritas; a 900 s = 1 ponto = 4.
- Ganho: **−12 a −16 escritas D1/viagem** (48 → 32–36). O rasto é histórico, não desenha mapa ao vivo.

### C. `GEO_PUSH_MIN_MS` 20 s → 30 s
- Onde: `index.ts:1084`.
- 30 s é exactamente o intervalo de redesenho do recetor (`PUSH_STATUS_TTL_MS`/`onGpsPush`), por isso
  **nenhum frame é descartado**.
- Ganho: **45 → 30 pedidos/viagem** no caminho REST (−15).

### D. `PUSH_GPS_MIN_MS` 10 s → 15 s (só depois de saber §2.3)
- Onde: `index.ts:3780`. Alinha o servidor com o cliente (que já só envia 1/15 s) e corta as
  mensagens a metade quando a app nativa manda mais depressa.
- Ganho: 0 pedidos se as mensagens forem 20:1; até **−30/viagem** se forem 1:1.

### E. (Estrutural) Mover `trip_points` para o SQLite do próprio DO da viagem
- O DO `trip:<id>` já tem storage próprio, com **orçamento separado** (5 M leituras / 100 k escritas/dia).
- Ganho: D1 36 → **32** escritas (−4) e **+1 escrita** no orçamento do DO. Só compensa depois de A–C,
  e só se as escritas da D1 voltarem a ser o gargalo.

### Contas com A + B + C

| Recurso | Hoje | Depois | Viagens/dia |
|---|---|---|---|
| Pedidos DO (modelo antigo, sem espelho) | 49 | **34** | 2 941 |
| Pedidos DO (com espelho medido) | ≈109 | **≈49** | 2 040 |
| Escritas D1 | 48 | **36** | 2 778 |
| Pedidos Worker | ≈25 | ≈20 | ≈5 000 |

⇒ **≈2 780 viagens/dia (+36 %)** no cenário conservador; **≈2 000** se o espelho existir e nada for
feito quanto a ele. O ganho de A é o que decide entre "mais 36 %" e "estamos a desperdiçar metade da
quota em pedidos redundantes".

---

## 4. O que foi avaliado e RECUSADO (para não se repetir)

| Ideia | Porque não |
|---|---|
| **SSE em vez de WebSocket** | Uma resposta longa mantém o DO **acordado** a facturar duração: ≈115 GB-s por viagem de 15 min ⇒ ≈**112 viagens/dia**. Catastrófico. |
| **KV para "última posição"** | 1 000 escritas/dia, mesma chave no máximo 1×/s, consistência até 60 s. Não serve para 1 escrita/10 s por motorista. |
| **Alarms do DO para heartbeat** | Cada alarme = 1 pedido + 1 escrita **e impede a hibernação**. O `TripPush` hibernado é o que mantém o custo baixo. |
| **Long-polling** | Pior caso absoluto: 1 pedido por ciclo (90 por viagem a 10 s). |
| **Abrir contas novas para multiplicar quota** | Viola os ToS (§2.2.1(c)/(e)). |
| **Pool do FTS `LIMIT 800 → 120`** | Já medido e recusado a 30/10: degrada `kilamba`, `viana`, `talatona` por 0,3 % de quota. |
| **Índices parciais `trips_active_*`** | +6 escritas/viagem por −73 leituras; ao câmbio 50:1 não paga. |
| **Cron `* * * * *` → `*/5`** | 1 440 pedidos/dia = 1,4 %; a precisão ao minuto é necessária às notificações agendadas. |

---

## 5. O que falta medir antes de mexer (2 itens)

1. **Rácio das mensagens de WebSocket no Free** (1:1 ou 20:1). Decide se D vale −30/viagem e se o
   modelo dos 49 é realista. Método: uma viagem em staging com a webapp real, medida por objeto na
   GraphQL (`durableObjectsInvocationsAdaptiveGroups`, `%TEMP%\opencode\do-window.mjs`) e comparação
   com o número de mensagens enviadas pelo cliente (contadores `__hdgSentN` já existem no código).
2. **O espelho `geoSet` do §2.2 dispara em produção?** Medir pedidos ao objeto `geo:global` durante
   uma viagem real (ou de staging com a webapp a conduzir) e ver se aparecem ~60 pedidos extra. Se
   sim, A é o corte nº 1 e a capacidade real de hoje é ≈900/dia, não 2 040.

Sem estas duas medições, qualquer número deste documento é um limite superior optimista.

---

## 6. Fora do plano Free: quanto custaria 50 000 viagens/dia

Ordem de grandeza (preços públicos 2026, dominado pela **duração de DO**):

- **≈$7–75/mês** para o conjunto dos recursos, sendo a duração dos DOs o termo que manda.
- Com DOs a dormir (hibernação) e WebSocket batching, o tecto real do Free deixa de ser os 100 k
  pedidos e passa a ser os **13 000 GB-s/dia** de duração — é aí que se parte primeiro.
- Não foi tomada nenhuma decisão de mudança de plano; o dono quer ficar no Free.

---

## 7. Resumo executivo

1. **A** (espelho `geoSet` a 60 s) — maior ganho, risco baixo, precisa de 1 medição para confirmar.
2. **B** (`trip_points` 900 s) — −12/−16 escritas, zero risco de UX.
3. **C** (`GEO_PUSH_MIN_MS` 30 s) — −15 pedidos, zero frames perdidos.
4. **D** (`PUSH_GPS_MIN_MS` 15 s) — só depois de saber o rácio das mensagens.
5. **E** (`trip_points` no SQLite do DO) — estrutural, para quando a D1 voltar a ser o gargalo.

Com A+B+C: **≈2 000 → ≈2 780 viagens/dia (+36 %)**, sem sair do Free e sem perder funcionalidade.
