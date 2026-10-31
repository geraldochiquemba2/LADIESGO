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

---

## 8. MEDIDO — as duas dúvidas do §5 respondidas, e o corte aplicado (2026-10-30)

### 8.1 Rácio das mensagens de WebSocket: 1:1 na **métrica**, 20:1 na **facturação**

Prova controlada (staging, `%TEMP%\opencode\m-ws-ratio.mjs`): **100 mensagens** enviadas a um WS de
viagem → o minuto somou **102 pedidos** no objeto (2 = a ligação). Ou seja, a métrica
`durableObjectsInvocationsAdaptiveGroups.requests` conta **cada mensagem a 1:1** — é "uso real", como
diz a documentação.

Mas a quota/facturação **não** usa esse número:

> "For compute requests billing-only, a **20:1 ratio is applied to incoming WebSocket messages** […]
> 100 WebSocket incoming messages would be charged as 5 requests for billing purposes. **The 20:1 ratio
> does not affect Durable Object metrics and analytics, which reflect actual usage.**"
> — developers.cloudflare.com/durable-objects/platform/pricing

**Consequência prática:** ao ler a quota de DO, `pedidos facturados = HTTP + mensagens/20`. Sem isto,
uma viagem parece gastar 47 pedidos quando gasta ~18. O "≈49 pedidos/viagem" do modelo do §3 estava
por isso a **somar mensagens como se fossem pedidos HTTP** — a favor da segurança, mas inflacionado.

### 8.2 O espelho `geoSet` dispara em produção? Sim, e era o maior termo

Viagem real em staging com a **cadência do cliente** (trip WS 1 fix/15 s + `live-geo` 1 fix/30 s),
5 min de condução com **90 s parada** no ponto de recolha, ciclo completo
(`%TEMP%\opencode\m-ride-cost.mjs`), medido por objeto na GraphQL:

| Versão | `trip:<id>` | `geo:global` | hubs | **Total métrica** | **Facturado** |
|---|---|---|---|---|---|
| espelho 30 s (1.ª versão) | 30 | 21 | 4 | 55 | **26,5** |
| espelho **60 s + ≥40 m** | 27 | 16 | 4 | 47 | **18,5** |

- No `geo:global` as 16 "requests" são **10 mensagens** do `live-geo` + **5 espelhos** + 1 ligação. A
  30 s eram 10 espelhos. O teto de 60 s com guarda de movimento **reduziu o espelho a metade** numa
  viagem em que 30 % do tempo foi parada — e a zero durante a paragem (um carro parado não tem posição
  nova para escrever).
- No `trip:<id>` as 27 são 20 mensagens + 2 ligações + 4 notificações de estado + ~1 `geoPushToTrip`.

### 8.3 `trip_points`: 1 ponto numa viagem de 5 min, e o gate agora é durável

- **Bug encontrado:** o gate de 180 s (e o de 60 s antes dele) **nunca valeu** — o DO da viagem hiberna
  e é recriado entre fixes, e `this.lastPointAt` voltava a 0 a cada arranque. Provado em staging: 3
  fixes em 35 s → **3 pontos**. Passou a viver no storage do próprio DO (`lastPointAt`, 1 leitura por
  fix, 1 escrita só quando grava um ponto). Mesmo ensaio: **1 ponto**.
- Viagem de 5 min: **1 linha** em `trip_points` (4 escritas). A 60 s seriam 5 linhas (20 escritas).
- Escolheu-se **600 s, não 900 s**: a guarda de viagens esquecidas fecha um `ACCEPTED` sem GPS há
  >20 min usando o último ponto como sinal de vida; a 900 s a margem cairia para 5 min.

### 8.4 Custo final por viagem de 15 min (medido + extrapolado do ensaio)

| Recurso | Antes (espelho 1/fix, geoPush 20 s, pontos 180 s) | Depois (espelho 60 s+40 m, geoPush 30 s, pontos 600 s) | Viagens/dia |
|---|---|---|---|
| Pedidos DO facturados | ≈109 | **≈54** | **≈1 850** |
| Escritas D1 | ≈48 | **≈34** (33–38 medidos, incl. contas de teste) | ≈2 940 |
| Pedidos Worker | ≈25 | ≈20 | ≈5 000 |

⇒ **≈900 → ≈1 850 viagens/dia (2,0×)**, sem sair do Free. O que trava primeiro passou a ser, de novo,
os **pedidos às DO** (o espelho e o `geoPushToTrip` a 30 s valem 45 dos 54).

> **Actualizado em 2026-10-31 (§9):** o `geoPushToTrip` a 30 s era **duplicação** do mesmo fix que já
> ia pelo WS da viagem. Cortado com o flag `noTripPush` do cliente: **6 → 4 pedidos/min** no DO da viagem
> (30 por viagem de 15 min). O total passa a **≈65 → ≈35 pedidos DO facturados/viagem** e a capacidade a
> **≈2 900 viagens/dia**, agora limitada pelas **escritas da D1** (≈34/viagem), não pelos pedidos.

### 8.5 Publicado

- API produção **`28f87bf1-4ae4-4bcf-907e-c992b2201a5c`**; staging `445b439b-4685-459a-b4d8-5ddbb36e3b54`.
- Smoke de produção (só `GET`): **12/12** — `/health` (`shed:0`), `/boot` (6 chaves, 3 categorias,
  410 ms), `/trips/active` `null`, `/drivers/nearby`, `/admin/quota`, `Cache-Control` em
  `/categories` e `/turn/ice`, `/debug/geo/stats` **404** (gate de staging).
- Base de produção intacta: **26 users / 121 trips / 1 motorista / 315 notifications / 0 `ZZ %`**.
  Staging a zero (0 viagens, 0 motoristas, 0 `ZZ %`).

### 8.6 O que sobra (não feito de propósito)

- **`geoPushToTrip` 30 s → 60 s:** pouparia 15 pedidos/viagem (≈2 500 viagens/dia), mas o mapa da
  passageira passaria a saltar ~1 km de cada vez a 50 km/h. **Recusado.**
- **`PUSH_GPS_MIN_MS` 15 s (item D do §7):** as mensagens custam 1/20 do que se pensava; o ganho real
  é ~1 pedido por viagem. **Não vale o risco.**
- **Espelho a 120 s:** +190 viagens/dia, mas a posição no polling sem WS ficaria 2 min velha. **Não.**

## 9. MEDIDO — a ponte `DriverGeo → TripPush` deixou de duplicar o fix (2026-10-31)

O maior termo que sobrava era o **mesmo fix a viajar duas vezes** para o DO da viagem: uma pelo WS da
viagem (`onGps`, mensagem = 1/20 de pedido) e outra pela ponte `DriverGeo → TripPush`
(`POST /gps` → `onGpsPush`, **1 pedido inteiro**). Com a app em primeiro plano as duas vias entregam o
mesmo dado no mesmo instante; a ponte só serve no **segundo plano**.

### 9.1 O que foi feito (duas camadas, ambas a falhar ABERTA)

1. **Cliente → Worker** (a única que poupa o **pedido**): `geoSend()` manda `noTripPush: liveWsOpen()` no
   frame do WS global `drivers/live-geo`; `liveWsOpen()` exige socket aberto **e** ligado à viagem atual.
   O Worker (`DriverGeo.webSocketMessage`) passa o flag a `geoPushToTrip`. Sem flag (builds antigos,
   segundo plano, socket caído) a ponte dispara como antes.
2. **Guarda dentro do `TripPush.onGpsPush`** (rede de segurança, não poupa pedidos): cala a ponte se
   houver um socket de motorista com `lastFixAt` < `WS_FIX_FRESH_MS` (**20 s**). A frescura vive no
   **attachment do socket** — o DO hiberna e é recriado entre fixes.

### 9.2 A camada 2 sozinha vale ZERO

Primeira tentativa, só com a guarda no DO: **22 vs 22** pedidos ao objeto. O pedido já foi feito e
facturado para o DO poder decidir — a guarda só poupa trabalho. Foi aí que se encontrou o bloqueador
real: `DriverGeo.webSocketMessage` tinha `geoPushToTrip(..., false, ...)` **hardcoded**, por isso o flag
do cliente era ignorado (a rota `/set` já o respeitava).

### 9.3 Medido (staging, viagens de 5 min, cadência real do cliente)

| | sem flag | com `noTripPush` |
|---|---|---|
| `trip:<id>` — **regime estável** | **6 pedidos/min** | **4 pedidos/min** |
| `trip:<id>` — total de 5 min (métrica) | 32–37 | 20–28 |
| frames `driver` na passageira | 10 em 300 s | **10 em 300 s** (intervalos 30 s) |
| último fix recebido pela passageira | −9,5600 | **−9,5600** |

- **2 pedidos/min = exatamente 1 por fix de `live-geo`** (30 s) ⇒ **30 pedidos por viagem de 15 min**.
- **Armadilha de medição:** os totais de 5 min são ruído (32 / 28 / 37). Ligações e transições de estado
  caem em minutos diferentes e a janela da analytics corta os últimos ~2 min. O sinal válido é a
  **taxa por minuto em regime estável** — e é preciso voltar a consultar 3–5 min depois.
- **A/B de 150 s com analytics assentada:** **22 vs 18** pedidos (antes da correção do `hardcoded
  false`: 22 vs 22).
- **Regressão do segundo plano (`t-bridge-bg.mjs`, 5/5):** só com o WS global (sem socket de viagem), os
  3 fixes chegaram todos ao `GET /trips/:id` e a passageira recebeu 2 frames — a ponte continua a ser a
  via do segundo plano.
- **`wrangler tail`:** todas as chegadas da ponte saltadas com `age=346 ms / 15 068 ms / 15 131 ms` — o
  cliente a 15 s mantém a janela de 20 s sempre fresca.
- **Prova no browser em produção:** payload real `{"lat":…,"lng":…,"h":null,"cats":[…],"noTripPush":true}`;
  contraprova com `liveWsOpen` forçado a `false` → `"noTripPush":false`. 0 erros de consola.

### 9.4 Conta nova (por viagem de 15 min)

| Recurso | antes (§8) | depois | Viagens/dia (tecto Free) |
|---|---|---|---|
| Pedidos DO **facturados** | ≈65 | **≈35** | **≈2 900** |
| Escritas D1 | ≈34 | ≈34 | ≈2 940 |
| Pedidos Worker | ≈20 | ≈20 | ≈5 000 |

⇒ **≈1 550 → ≈2 900 viagens/dia (1,9×)**, acumulado com os cortes do §8. **O que trava a seguir são as
escritas da D1 (≈34/viagem), não os pedidos às DO** — a partir daqui, qualquer ganho tem de vir de
escritas.

### 9.5 Publicado

- API produção **`442df0de-e53b-4873-a874-5854300fc371`** (`b6ddb05a-4639-413d-b21c-278115470419` foi o
  deploy da lógica; o segundo difere só num comentário); Pages `c5bb4188.ladiesgo.pages.dev`
  (alias `ladiesgo.pages.dev`); Worker estático `5a4167a6-84ab-42cb-806b-57aad4f822ef`.
- `ladiesgo-home.html` (443 645 bytes, sha256 `6aa634f4…`) servido **byte a byte igual** pelo Pages e
  pelo Worker estático.
- Smoke de produção só de `GET`: **12/12**. Base intacta: **26 users / 121 trips / 1 motorista /
  315 notifications / 0 `ZZ %`**. Staging a zero.

## 10. MEDIDO - pesquisa de lugares: todos os inputs na cache de cliente (2026-10-31)

O servidor já estava FTS5-only desde o §1 (3 a 2 400 linhas lidas por pesquisa, contra 23 332), mas o
**cliente** ainda abria um pedido por pausa na escrita em **4 sítios** que não passavam pelo
`lgPlaceFetch` (cache de 10 min). Como cada **prefixo** é uma chave nova na cache do servidor
(`places:v14:<q>:<lat,lng>`), escrever "kilamba" devagar continuava a valer várias pesquisas.

### 10.1 O que mudou (só cliente, 1 linha por sítio)

`fetch('/api/places/search?q=…&lat=…&lng=…&v=3').then(r => r.ok ? r.json() : null)` →
`lgPlaceFetch(q, [lat, lng])`. Ficou **1** ocorrência de `fetch('/api/places/search…')` no ficheiro,
dentro do próprio `lgPlaceFetch`; e o `window.__plC` passou a podar-se acima de 150 chaves.

| Sítio | Estado | Cache antes | Cache agora |
|---|---|---|---|
| `#q` / `#oq` (destino/origem da corrida) | vivo | já tinha | — |
| `#qs` (folha "Adicionar paragem" → `stop`) | **vivo** | não | **sim** |
| `#prmPickSearch` (picker unificado: **Premium e Partida**) | **vivo** | não | **sim** |
| `sharedPlaceInput` (`sharedSugO`/`sharedSugD`) | código morto | não | sim (por coerência) |
| `sharedPickSearch` (`#sharedPickSearch`) | código morto | não | sim (por coerência) |

Os dois últimos são mortos: `renderSharedCreate()` desenha origem/destino como `readonly` com
`onclick="sharedPickOnMap(…)"` e `renderSharedPickBar()` — a única coisa que criaria
`#sharedPickSearch` — nunca é chamado. A Partida usa o **mesmo** bar do Premium (`prmPickBar()`,
`_prmTarget='shared'`), portanto é o `prmPickSearch` que corre.

### 10.2 Medido no browser (produção, API real, 0 escritas)

| Sítio | 1.ª pesquisa | 2.ª (mesma) |
|---|---|---|
| `#qs` ("Adicionar paragem") | **1 pedido**, 784 ms | **0 pedidos** |
| picker unificado (`#prmPickSearch`) | **1 pedido**, 980 ms | **0 pedidos** |

Contagem por `performance.getEntriesByType('resource')` filtrado por `/api/places/search`; sugestões
reais renderizadas (Kilamba, Kilamba Kiaxi - centro, Kilambar, Bloco V) e a escolha continua a ser
guardada (`_prmDraftName:'Kilamba'`, `_prmDraft:[-8.827963,13.271258]`). Com a API stubada
(`page.route`), os 4 sítios deram todos `1 → 0`.

### 10.3 Publicado

Pages **`bad50008.ladiesgo.pages.dev`** (alias `ladiesgo.pages.dev`), Worker estático
**`37f18fc5-d7bc-4fa1-9a6c-b81adb74f2c2`**. `ladiesgo-home.html` com **443 418 bytes**, sha256
**`f19a75031e2cb8a34b0a0fc695071fb6352824153c7c573ff52b449da5c1bae4`**, byte a byte igual no local, no
alias do Pages, no deployment e no Worker estático. Os 22 blocos `<script>` inline compilam. Base
intacta (**26 users / 121 trips / 1 motorista / 315 notifications / 0 `ZZ %`**); as 2 contas guest do
ensaio foram apagadas.

### 10.4 Onde isto entra na conta

Isto não muda o custo **por viagem** (o que trava a seguir continuam a ser as **escritas da D1**,
≈34/viagem, §9.4); muda o custo **por utilizador a pesquisar**. Uma sessão que escreve meia dúzia de
nomes deixa de custar dezenas de pesquisas FTS e passa a custar uma por termo distinto, com o topo
(`kilamba` ≈ 2 000 linhas) pago ~1×/10 min em vez de 1×/pausa.

---

## 11. "Mais viagens por dia" e "duplicar as horas" são duas perguntas diferentes (2026-10-31)

Investigação motivada pela pesquisa das outras plataformas (`docs/PICOS-E-CONCORRENCIA-2026-10-31.md`).
**Conclusão:** no Free, **as escritas da D1 são ~fixas por viagem e os pedidos às DO são por minuto** — e
hoje o que trava primeiro são as DO, **dominadas pelo frame `{t:'heading'}`**.

> **CORRECÇÃO (2026-10-31, medida):** a versão anterior deste §11 dizia **35 DO/viagem** e **2 857
> viagens/dia**. A medição em staging (§11.2) mostra **68–85 DO/viagem** — a estimativa do `heading`
> (16,5) era **metade** do real (33–50). A capacidade real de hoje é **≈1 200–1 470 viagens/dia**, não
> 2 857. A boa notícia inverte o veredicto: **duplicar as viagens/dia passa a ser possível no Free**,
> porque o ponto de partida é metade do que se pensava.

### 11.1 Os dois muros, em função da duração da viagem

Modelos ancorados no medido — `D1(d) = 27 + 0,4d` (§11.3) e quatro variantes de DO (§11.2):

| | `DO(d)` |
|---|---|
| Hoje (`heading` 1/900 ms) | `17 + 3,4d` |
| `heading` a 1/5 s | `17 + 1,8d` |
| Sem `heading` | `17 + 1,2d` |
| Sem `heading` + espelho 1/3 min | `17 + 0,5d` |

| Duração | DO hoje | Escritas D1 | **Viagens/dia (hoje)** | **Horas/dia (hoje)** | Trava |
|---|---|---|---|---|---|
| 10 min | 51 | 31 | 1 960 | 327 | DO |
| **15 min (hoje)** | **68** | **33** | **1 470** | **368** | DO |
| 20 min | 85 | 35 | 1 176 | 392 | DO |
| 30 min | 119 | 39 | 840 | 420 | DO |
| 60 min | 221 | 51 | 452 | 452 | DO |

- **Hoje o muro é sempre as DO** — a D1 só aparece a partir de ~3 000 viagens, que o `heading` nunca
  deixa atingir.
- **Alongar viagens quase não ajuda hoje** (452 h a 60 min contra 368 h a 15): o `heading` cobra
  **2,2 pedidos facturados por minuto** e come a margem toda. É por isso que os cortes de §11.4 valem
  mais em horas do que em viagens.

### 11.2 O `heading` — medido, não deduzido (2026-10-31)

Ensaio em **staging** (`%TEMP%\opencode\hdg-measure.mjs`), viagem `b6fd73dc-82ba-4579-a16b-29f71782d647`,
05:51:34Z–06:00:34Z, 3 fases de 180 s com a **mesma cadência de `gps` do cliente (1/15 s)**:

| Fase | `heading` enviado | Pedidos ao DO da viagem/min | Facturado |
|---|---|---|---|
| 1 — sem `heading` | 0 | **3 · 4 · 4** | base |
| 2 — `1/s` com ruído ±3° (gate 900 ms + ≥2°) | 44/min | **46 · 53 · 49** | +44 msg/min |
| 3 — gate sempre aberto (tecto do throttle) | 58/min | **66 · 52** | +58 msg/min |

- **1 mensagem `heading` = 1 pedido na métrica** (que é 1:1 com as mensagens) e **1/20 na factura**.
  A métrica por minuto sobe exactamente pelo nº de mensagens — confirmado nas 3 fases.
- **A rotação do mapa da passageira NÃO depende do `heading`:** a passageira recebeu **36 frames
  `driver` em 36 envios de `gps`, todos os 36 com `h`**, intervalos de 15 s, 12 valores distintos.
  No servidor o `h` do frame `driver` vem de `normH(m.h)` **do próprio `gps`**
  (`TripPush.onGps`, `index.ts` ~4137), não do `heading`.
- **Rede de segurança no cliente:** `drvHdgAt` só é escrito pelo frame `driverheading`; sem ele o
  `liveUpd` cai em `carBearing(drvHdgFrom, p)` a cada **≥8 m** (`ladiesgo-home.html` ~14575). Ou seja,
  sem `heading` o carro continua a rodar — pelo rumo do movimento.
- **Conta por viagem de 15 min** (decomposição: o que é por minuto escala, o resto não):

| Item | Facturado | Por minuto? |
|---|---|---|
| `heading` (44/min) | **33** | sim |
| espelho para `geo:global` (1/min) | 15 | sim |
| `{t:'gps'}` (60 msg) | 3 | sim |
| ligações + `notify`/`state` + hubs | 17 | não |
| **Total hoje** | **68** | (85 se o `heading` for a 66/min) |

| Opção | `heading`/min | DO/viagem (15 min) | Viagens/dia |
|---|---|---|---|
| Hoje (`1/900 ms` + ≥2°) | 44–66 | **68–85** | **1 176–1 470** |
| **`1/5 s` + ≥10°** | 12 | **44** | **2 272** |
| Eliminar (rodar no `gps`) | 0 | **35** | **2 857** |

### 11.3 O muro das escritas — medido, não estimado (corrigido a 2026-10-31)

> **CORRECÇÃO (2026-10-31).** O "≈27 mínimo" desta secção era uma **estimativa** e tinha dois erros:
> contava **uma linha em `notifications` por viagem** (que **não existe** — todas as
> `INSERT INTO notifications` são de admin/agendadas/partilha/premium) e contava `INSERT` de viagem = 5
> com um índice que não era usado. O valor real foi **medido statement a statement** com
> `meta.rows_written` (§13): **33 antes, 28 depois** dos cortes de índice de 31/10.

Composição real de uma viagem de 15 min (medida, ver §13):

| O que | Antes | Depois (0024) |
|---|---|---|
| `INSERT` da viagem (linha + PK + `pax_created` + `status`) | 5 | **4** |
| `ACCEPTED` (linha + `status` + `drv_created`) | 3 | 3 |
| `DRIVER_ARRIVED` (linha + `status`) | 2 | 2 |
| `IN_PROGRESS` (linha + `status`) | 2 | 2 |
| `COMPLETED` = trips 3 + `drivers` 1 + `users` 2→1 + `wallet_tx` 3 | 9 | **8** |
| avaliação (linha + PK + `rated`) | 4 | **3** |
| **2** pontos de rasto (linha + PK + `trip_ts` + `ts`→só `trip_ts`) | 8 | **6** |
| **Total** | **33** | **28** |

⇒ `100 000 ÷ 28 = **3 571 viagens/dia**` de tecto **pela D1**. Como as DO estão em **34/viagem**
(2 941), **o muro volta a ser as DO** — o corte da D1 comprou folga, não viagens, até o `heading` descer.

### 11.4 O que cada corte dá, de facto

| Corte | DO/viagem | D1/viagem | Viagens/dia (15 min) | Horas/dia |
|---|---|---|---|---|
| Hoje (antes de 31/10) | 68 | 34 | **1 470** | 368 |
| **`heading` a 1/5 s** ✅ feito | 44 | 34 | **2 272** | 568 |
| **+ espelho 1/3 min** ✅ feito | **34** | 34 | **2 941** | 735 |
| **+ escritas 33 → 28** ✅ feito (0024) | 34 | **28** | **2 941** | 735 |
| **+ `heading` a 1/15 s** ✅ feito | **28** | 28 | **3 571** | 893 |
| + `heading` eliminado (daria 25) | 25 | 28 | 3 571 | 893 |
| + escritas 28 → 25 (1 só ponto de rasto) | 25 | 25 | **4 000** | 1 000 |

- **O `heading` a `1/5 s` foi o corte que mais rendeu** (1 470 → 2 272 viagens/dia).
- **O espelho a 1/3 min levou ao empate DO 34 vs D1 34** (§12): as duas travas passam a morder ao mesmo
  tempo, nas mesmas 2 941 viagens.
- **As escritas 33 → 28 (§13) compraram folga, não viagens**: a D1 passou a 3 571 e as DO continuam a
  mandar (2 941). **A partir daí quem manda são as DO outra vez** — e o `heading` voltou a ser o único
  corte que sobe a capacidade, ao contrário do que se tinha concluído antes do corte das escritas.
- **O `heading` a 1/15 s (§14) fecha o empate outra vez, agora em 28/28** ⇒ **3 571 viagens/dia**.
  Eliminar o `heading` por completo **já não sobe nada** (25 DO mas D1 em 28): a partir daqui só se
  passa das 3 571 **mexendo nas duas travas ao mesmo tempo**.

Com o `heading` a 1/15 s (o que ficou) e o espelho a 1/3 min, as DO são `17 + 0,7d` (era `17 + 1,1d`
com o `heading` a 1/5 s) e a D1 é `22 + 3 × pontos` (um ponto de rasto por 600 s); o muro é o **maior**
dos dois:

| Duração | DO (1/15 s) | D1 (0024) | Viagens/dia | **Horas/dia** |
|---|---|---|---|---|
| 15 min (hoje) | **28** | **28** | 3 571 | 893 |
| 30 min | 38 | 34 | 2 632 | 1 316 |
| 37 min | 43 | 34 | 2 326 | 1 435 |
| 40 min | 45 | 37 | 2 222 | **1 481** ← 2× |
| 45 min | 49 | 37 | 2 041 | 1 531 |
| 60 min | 59 | 43 | 1 695 | 1 695 |

- **"Duplicar as horas" é possível no Free** — com os cortes **e** uma viagem média de ~**40 min**
  (hoje 15). Subiu de 30 para 40 min porque o `heading` a 1/15 s custa 0,2 DO facturado por minuto
  (a 30 min as DO já em 38 e a D1 em 34 ⇒ 2 632 viagens ⇒ 1 316 h, abaixo das 1 471).
- **"Duplicar as viagens/dia" também é possível**: o ponto de partida real é ~1 300 e o tecto
  estrutural é **3 571** (2,7×). Passar disso exige **baixar as duas travas**: só o `heading` (25 DO)
  ou só as escritas (25 D1) dão na mesma 3 571.
- *(Estas linhas são **modelo** `DO = 17 + 0,7d` / `D1 = 22 + 3·pontos`, ancorado no medido a 15 min,
  não medição por duração. A linha dos 15 min é a única medida ponta a ponta.)*

### 11.5 O que fazer, por ordem

1. **`heading` a 1/5 s + ≥10°** ✅ **FEITO 31/10** — 1 linha no cliente (`liveSendHdg`: `900` → `5000`,
   `d<2` → `d<10`). Medido: 68 → 44 DO/viagem, **1 470 → 2 272 viagens/dia**. A rotação continua a 5 s.
2. **Espelho `geo:global` de 60 s para 180 s** ✅ **FEITO 31/10** (`MIRROR_MIN_MS`): 15 → 5 por viagem,
   −10 DO, medido (§12). Ficou **34 DO vs 34 D1** ⇒ **2 941 viagens/dia**.
3. **Escritas da D1 33 → 28** ✅ **FEITO 31/10** — migração `0024_write_cut_indexes.sql`: 5 índices que
   nenhuma query usava (provado com `EXPLAIN QUERY PLAN` em produção) foram apagados. Medido statement a
   statement com `meta.rows_written`: **33 → 28** por viagem de 15 min (§13). A D1 passou a **3 571** e
   as DO (34) voltaram a ser o muro ⇒ **viagens/dia não mudou (2 941)**.
4. **`heading` a 1/15 s + ≥20°** ✅ **FEITO 31/10** — 1 linha no cliente (`liveSendHdg`: `<5000` → `<15000`,
   `d<10` → `d<20`). Medido no browser com a função real da página: **13 → 5 mensagens/min** no perfil
   com curvas (o piso é o próprio intervalo) ⇒ **−6 DO facturados/viagem** ⇒ DO 34 → **28** ⇒
   **3 571 viagens/dia (893 h/dia)**. Detalhe e prova em §14.
5. **Escritas 28 → 25** (um só ponto de rasto: gate de 600 s → 1200 s) — **sozinho não muda nada**
   (DO 28 continua a mandar). Com o passo 4 feito, **só sobe a capacidade se as duas travas descerem**:
   25 DO + 25 D1 ⇒ **4 000 viagens/dia**.
6. **Alongar a viagem média** (o único lever que aumenta horas): com 1–5 feitos, ~40 min duplica as
   horas.
7. **Não** gastar mais nada em cortes de leitura: a 3 571 viagens o que trava são as DO e a escrita, e
   cortar índices troca 1 escrita por ~50 leituras.

### 11.6 A alternativa de uma linha

Com o plano pago (≈**$7–75/mês**, §6), **duplicar é imediato e sem tocar em código** — os tectos
passam de 100 k/dia para ordens de grandeza acima. A decisão é do dono e está fora do âmbito deste
documento; fica registado o número para que a escolha seja informada: **o Free aguenta ~2,7× o que faz
hoje (≈1 300 → 3 571 viagens/dia) com os cortes já feitos e um último passo pequeno (o `heading`);
o passo seguinte custa ~$7/mês.**

## 12. MEDIDO — espelho `geo:global` a 1/3 min (2026-10-31)

O espelho dentro do `TripPush.onGps` chamava o DO `geo:global` no máximo 1×/min (`MIRROR_MIN_MS =
60_000`). Passou a **1×/180 s**. É a **3.ª via de escrita na `DriverGeo`**, não a principal:

| Via | Quando escreve na `DriverGeo` | Cadência |
|---|---|---|
| WS global `drivers/live-geo` (`geoPresence`/`geoSend`) | app aberta | carro andou ≥10 m **ou** 30 s |
| REST `POST /drivers/position` | WS global caído / app em fundo | 60 s |
| **Espelho (este)** | o fix chegou pelo WS da viagem | **180 s** + ≥40 m |

(A ponte `DriverGeo → TripPush` vai no sentido contrário — é o `onGpsPush` a 30 s / 150 m — e não
escreve na `DriverGeo`.)

### 12.1 Ensaio (staging, viagem de 420 s, cadência real)

`%TEMP%\opencode\mirror3.mjs` — 28 fixes `gps` a 1/15 s pelo WS da viagem, **sem `heading`** (para isolar
o espelho), passageira com o WS da viagem aberto e polling `?view=web` 1/min. As duas vias principais
foram **desligadas de propósito** para que o espelho fosse o único escritor: é o pior caso, não o normal.

| Métrica | Resultado |
|---|---|
| `geo:global` — pedidos no total | **12** |
| − polling (`geoGet`, 7) − setup (`/drivers/position` 1 + candidatas do pedido 1) | **3 espelhos** |
| Espelhos esperados a 180 s | 3 (t = 0 s, 180 s, 360 s) ✅ |
| Por minuto (buckets) | `06:23=4 · 24=1 · 25=1 · 26=2 · 27=1 · 28=1 · 29=2` — encaixa **exacto** |
| Antes (60 s), mesma viagem | 7 espelhos ⇒ **12 → 3** (−67 %) |
| Frames `driver` na passageira | **28/28 com `h`**, intervalos `15 s` constantes |
| Ciclo `arrived`/`in_progress`/`completed` | 200/200/200 |
| `trip_points` no fim | **1** (gate de 600 s durável a funcionar) |

### 12.2 O atraso do polling no pior caso — e porque não é regressão

Com o espelho como única via, o polling mostrou a posição com atraso igual ao intervalo do espelho:
`0 s · 64 s · 127 s · 190 s` e depois `61 s · 125 s · 188 s` (recomeça a cada espelho). **Isto é
artificial:** o ensaio desligou as duas vias que em produção escrevem sempre que o carro anda —
`geoPresence` (≥10 m ou 30 s) e o REST de 60 s. Com qualquer delas viva, a `DriverGeo` está fresca e o
polling não perde nada. O espelho só serve o caso em que **o WS da viagem é o único canal vivo**, e nesse
caso a passageira está a receber `driver` frames pelo próprio WS a cada 30 s.

### 12.3 Conta nova

| Recurso | Antes (heading 1/5 s) | Depois (+ espelho 1/3 min) | Viagens/dia |
|---|---|---|---|
| Pedidos DO facturados | 44 | **34** | **2 941** |
| Escritas D1 | 34 | 34 | 2 941 |
| Pedidos Worker | ≈20 | ≈20 | ≈5 000 |

⇒ **2 272 → 2 941 viagens/dia (+29 %)**, e as duas travas (DO 34, D1 34) passam a morder **ao mesmo
tempo**. A partir daqui **eliminar o `heading` não comprava capacidade** *enquanto a D1 estivesse em
34* — mas depois do corte das escritas (§13, D1 = 28) o `heading` **voltou a ser o único corte que sobe
a capacidade** (34 → 25 DO ⇒ 3 571 viagens/dia). Ver §11.4 e §11.5.

### 12.4 Publicado

API produção **`ddc37649-d097-460c-bc31-5e6691964a8c`** (`f9132f20-9ff0-48b3-8610-d19b68d322c2` foi o
deploy da lógica; o segundo difere só num comentário), staging **`ded126ec-20b6-433a-9d8b-3e195d6de639`**
(só servidor — o webapp não mudou neste passo). Smoke de produção só de `GET` 8/8 (`/health` 200
`shed:0`, `/boot` 200, `/trips/active` 200 `null` + 401 sem token, `/categories` 200, `/admin/quota`
200 `configured:true`, `/drivers/nearby` 200 com `lat/lng`). Base intacta: **26 users / 121 trips /
1 motorista / 315 notifications / 0 `ZZ %`**; staging a zero (1 admin, 0 viagens, 0 `ZZ %`).

## 13. MEDIDO — escritas da D1: 33 → 28 por viagem (2026-10-31)

Objectivo: **subir as viagens/dia pelo lado que ainda não estava cortado**. Até aqui todos os cortes
foram de **pedidos** (DO/Worker); as escritas da D1 estavam intocadas desde sempre. A D1 do Free dá
**100 000 escritas/dia**, e a regra medida é: **cada entrada de índice É uma linha escrita**, além da
própria linha. Logo, um índice que nenhuma query usa custa escritas em **todas** as linhas da tabela e
não devolve nada.

### 13.1 Método (para poder repetir)

`meta.rows_written` de cada statement, lidos **por statement**, com duas vias independentes:

1. **Directo à D1** (`%TEMP%\opencode\measure-sql2.mjs`): cria um utilizador/motorista `ZZq…` em staging,
   corre o ciclo `INSERT` → `ACCEPTED` → `DRIVER_ARRIVED` → `IN_PROGRESS` → `COMPLETED` + carteira +
   `wallet_tx` + 2 `trip_points` + avaliação, imprime `rows_written` de cada um e **apaga tudo no fim**.
2. **Ponta a ponta pela API** (`%TEMP%\opencode\measure-writes.mjs`): deltas do contador `writes` do
   `/health` entre passos (`POST /trips/request-web`, `PUT /accept`, `POST /status`, `POST /ratings`).

Os dois deram o mesmo (28 depois do corte). Antes de correr o ensaio de API é obrigatório
`clean-stg.mjs`: motoristas `ZZ%` deixados *online* em staging **roubam a oferta** e o `PUT /accept`
devolve **409** em vez de aceitar (foi o que fez o 1.º ensaio medir 0 escritas).

### 13.2 Antes → depois, statement a statement

| Statement | Antes | Depois | Índice que saiu |
|---|---|---|---|
| `INSERT` da viagem | 5 | **4** | `trips_pending_idx` |
| `UPDATE` → `ACCEPTED` | 3 | 3 | — |
| `UPDATE` → `DRIVER_ARRIVED` | 2 | 2 | — |
| `UPDATE` → `IN_PROGRESS` | 2 | 2 | — |
| `UPDATE` → `COMPLETED` (trips) | 3 | 3 | — |
| `UPDATE drivers` (totalTrips/ganhos) | 1 | 1 | — |
| `UPDATE users` (carteira/comissão) | 2 | **1** | `users_driver_wallet_idx` |
| `INSERT wallet_tx` | 3 | 3 | — |
| `INSERT trip_points` ×2 | 4 + 4 | **3 + 3** | `trip_points_ts_idx` |
| `INSERT ratings` | 4 | **3** | `ratings_trip_idx` |
| **Total (viagem de 15 min)** | **33** | **28** | **−15 %** |

(Só o ciclo, sem os pontos de rasto: **25 → 22**. O `INSERT` de utilizador também desceu 1 com a saída
do `users_phone_idx`, mas isso não é por viagem.)

### 13.3 Os 5 índices apagados — e a prova de que não fazem falta

`cloudflare/api-worker/migrations/0024_write_cut_indexes.sql`:

| Índice | Porque saiu | Prova (`EXPLAIN QUERY PLAN`, produção) |
|---|---|---|
| `trips_pending_idx ("createdAt") WHERE status='REQUESTED'` | redundante com `trips_status_idx (status,"createdAt")` | as duas queries de oferta dão `SEARCH ... USING INDEX trips_status_idx (status=? AND createdAt>?)` — `/trips/incoming` **e** o alarme do `RequestsHub` |
| `ratings_trip_idx ("tripId")` | nenhuma query filtra `ratings` por `tripId` | `/ratings/pending` junta por `sqlite_autoindex_ratings_1 (id=?)` (o id é `tripId:userId`); `/ratings/mine` e a nota usam `ratedId` |
| `users_driver_wallet_idx ("walletBalance") WHERE role='DRIVER'` | só servia a lista de carteiras do admin | passa a `SCAN users` (26 linhas) + temp B-tree, 1×/clique |
| `users_phone_idx (phone)` | duplicado do `UNIQUE(phone)` | o login dá `SEARCH users USING INDEX sqlite_autoindex_users_2 (phone=?)` |
| `trip_points_ts_idx (ts)` | só servia o purge de 30 dias, que mudou de forma | ver §13.4 |

**O que NÃO se apagou** (cada um tem um consumidor medido): `trips_status_idx` (é `INDEXED BY` — sem
ele a query falha com *no such index*), `trips_pax_created_idx` (Histórico 319 → 90 linhas),
`trips_drv_created_idx` (Histórico da motorista 315 → 120), `trips_completed_pax_idx`
(`/ratings/pending` 83 → 11), `trip_points_trip_ts_idx` (rota da viagem + purge + guarda de viagens
esquecidas), `wallet_tx_user_idx` (carteira da motorista).

### 13.4 O purge das posições teve de mudar de forma

O purge diário filtrava por `ts` (`DELETE FROM trip_points WHERE ts < …`), o que obrigava a manter o
índice `ts`. Passou a ir **pelas viagens**:

```sql
DELETE FROM trip_points
 WHERE "tripId" IN (SELECT id FROM trips WHERE "createdAt" < NOW() - INTERVAL '30 days')
```

Plano novo: `SEARCH trip_points USING COVERING INDEX trip_points_trip_ts_idx (tripId=?)` +
`LIST SUBQUERY` + `SCAN trips` (121 linhas, **1×/dia**). Medido: **8 linhas lidas, 2 escritas** no
ensaio. Efeito colateral aceite (e desejado): posições **órfãs** (de viagens já apagadas) deixam de ser
limpas por idade — na base de produção há **0** (`SELECT COUNT(*) … LEFT JOIN trips` → 1 290 pontos,
0 órfãos).

### 13.5 Conta nova

| Recurso | Antes | Depois | Tecto Free/dia | Viagens/dia |
|---|---|---|---|---|
| Escritas D1 (15 min) | 34 | **28** | 100 000 | **3 571** |
| Pedidos DO facturados | 34 | 34 | 100 000 | 2 941 |
| Pedidos Worker | ≈20 | ≈20 | 100 000 | ≈5 000 |

⇒ **o muro voltou a ser as DO** (34 vs 28): este corte **não subiu as viagens/dia** — comprou **folga**
(3 571 de tecto contra 2 941 reais) e **descolou** as duas travas. Quem sobe a capacidade a partir daqui
é o **`heading`** (34 → 25 DO ⇒ **3 571 viagens/dia, 893 h/dia**), e só depois as escritas 28 → 25
(1 ponto de rasto) dariam 4 000.

Modelo da D1 actualizado: **`D1(d) = 22 + 3 × (pontos de rasto)`**, com 1 ponto por 600 s. (Antes
`27 + 0,4d`, que vinha da estimativa errada de §11.3.)

### 13.6 Publicado

- Migração `0024_write_cut_indexes.sql` aplicada em **staging** e **produção** (`6 comandos`, ✅).
  Produção: os 5 índices desapareceram e `trips_status_idx` continua lá (confirmado em `sqlite_master`).
- API staging **`490d9c13-c4c3-4e97-91f5-95632924532c`**; **API produção
  `f3831a53-0406-41d8-ba93-c22e1bfac0b1`**.
- Smoke de produção **só de `GET` 10/10**: `/health` 200 `shed:0`, `/trips/active` 401 sem token e 200
  `null` com sessão, `/boot` 200 com as 6 chaves, `/ratings/pending` 200, `/trips/history` 200,
  `/drivers/nearby` 200, `/categories` 200 `public, max-age=300`, `/admin/quota` 200
  `configured:true`.
- Base de produção intacta: **26 users / 121 trips / 1 motorista / 315 notifications / 24 ratings /
  1 290 trip_points / 0 `ZZ %`**. Staging a zero (1 admin, 0 viagens, 0 `ZZ %`).
- O webapp **não mudou** neste passo (só servidor + migração).

## 14. MEDIDO — `heading` a 1/15 s: DO 34 → 28 (2026-10-31)

O último corte que faltava para subir as viagens/dia. O `heading` (rumo do carro) era enviado pelo WS da
viagem com um gate de **1/5 s + ≥10°** — ou seja, **12 mensagens/minuto no máximo**, 180 por viagem de
15 min, **9 DO facturados**. Cada mensagem é **1 pedido na métrica e 1/20 na factura** (§13 da vaga 10).

### 14.1 A alteração — 2 números, 1 linha

`webapp/ladiesgo-home.html`, `liveSendHdg`:

```diff
-var now=Date.now();if(now-_liveHdgAt<5000)return true;if(_liveHdgV!=null){...if(d<10)return true}
+var now=Date.now();if(now-_liveHdgAt<15000)return true;if(_liveHdgV!=null){...if(d<20)return true}
```

Nada mais mudou: o frame `{t:'heading',h}` é o mesmo, o handler do servidor é o mesmo, e o rumo continua a
chegar por **duas outras vias** que já existiam:

- o frame **`{t:'gps'}`** (a cada 15 s) leva `h: drvHeadVal()` e o servidor põe-no no frame `driver`
  (`normH(m.h)`);
- o cliente **deriva o rumo do movimento** (`carBearing`, a cada ≥8 m) para rodar o carro no mapa.

### 14.2 A/B na página real (função real, sem tocar na rede)

Ensaio no browser sobre `https://ladiesgo.pages.dev/home`: lê-se `window.liveSendHdg.toString()`, derivam-se
as duas variantes **por substituição dos dois números do gate** (a única diferença entre elas é o gate),
substituem-se só as pré-condições (`liveWsOpen`, `me`, `drvHeadVal`, `_liveWs.send`) e corre-se **60 s de
viagem a 4 amostras/s** com um relógio controlado.

| Perfil de rumo (60 s) | Antes (1/5 s + 10°) | Depois (1/15 s + 20°) | Redução |
|---|---|---|---|
| recta (ruído ±4°) | 1 msg | 1 msg | — |
| cidade (curva de 35° a cada 3 s) | **13 msg** | **5 msg** | **−62 %** |
| ruído GPS (0–359° aleatório) | **13 msg** | **5 msg** | **−62 %** |

- O perfil "recta" já quase não mandava `heading` (a guarda de 10°/20° corta) — **a poupança vem das
  curvas**, que é o que uma corrida urbana tem.
- Nas curvas o resultado é **exactamente o piso do intervalo**: 5 s → 13 msgs em 60 s (t=0,5,…,60);
  15 s → 5 (t=0,15,30,45,60). Por isso a conta é determinística: **180 → 60 mensagens por viagem de
  15 min** (medido na página já publicada: **61** em 900 s, 4,07/min).
- **6 DO facturados a menos por viagem** (120 mensagens ÷ 20) ⇒ **34 → 28**.

### 14.3 Conta nova (viagem de 15 min)

| Recurso | Antes | Depois | Tecto Free/dia | Viagens/dia |
|---|---|---|---|---|
| Pedidos DO facturados | 34 | **28** | 100 000 | **3 571** |
| Escritas D1 | 28 | 28 | 100 000 | 3 571 |
| Pedidos Worker | ≈20 | ≈20 | 100 000 | ≈5 000 |

⇒ **2 941 → 3 571 viagens/dia (+21 %)** e **735 → 893 h/dia**. As duas travas ficam **empatadas em 28**:
a partir daqui **nenhum corte sozinho sobe a capacidade** — baixar só o `heading` (25 DO) ou só as
escritas (25 D1) dá na mesma 3 571. Para passar disso as duas têm de descer (25/25 ⇒ 4 000).

### 14.4 Publicado

- **Pages** `869a4d0d.ladiesgo.pages.dev` (alias `ladiesgo.pages.dev`) e **Worker estático** `ladiesgo`
  versão `136c6aca-9c93-4159-9689-020c235d7948`.
- `ladiesgo-home.html` **443 421 bytes**, sha256
  **`72aa3e84fd06a5cef3d359cd62f1b6bad567a8db83e7ad0bc41da421e88ef7c0`**, servido **byte a byte igual**
  pelo alias, pelo deployment e pelo Worker estático; `gate15s`/`gate20` presentes nos três.
- Todos os **22** blocos `<script>` inline compilam (`new Function`, sem erros).
- Verificação na página publicada: `gate_novo:true`, `gate_antigo:false`, **61 mensagens em 15 min**
  (4,07/min, 3,05 DO facturados). **0 erros de consola** próprios da alteração.
- Só cliente: **nenhuma** alteração de API, migração ou base de dados.


