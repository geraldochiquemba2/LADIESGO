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
**Conclusão que inverte a intuição:** no Free, **as viagens/dia têm um muro rígido (~3 700) e as horas
não** — porque as escritas da D1 são ~**fixas por viagem** e os pedidos às DO são **por minuto**.

### 11.1 Os dois muros, em função da duração da viagem

Modelo (ancorado nos valores medidos de §9.4 e §14 do `AGENTS.md`):
`DO(d) = 14 + 1,4d` e `D1(d) = 27 + 0,4d`, com `d` em minutos.

| Duração | Pedidos DO | Escritas D1 | **Viagens/dia** | **Horas/dia** | Trava |
|---|---|---|---|---|---|
| 10 min | 28 | 31 | 3 226 | 538 | D1 |
| **15 min (hoje)** | **35** | **33** | **2 857** | **714** | DO |
| 20 min | 42 | 35 | 2 381 | 794 | DO |
| 30 min | 56 | 39 | 1 786 | 893 | DO |
| 60 min | 98 | 51 | 1 020 | 1 020 | DO |

Duas leituras que não são óbvias:

- **Encurtar as viagens aumenta as viagens/dia mas reduz as horas.** A 10 min o muro passa a ser a D1
  (3 226 viagens, só 538 h).
- **Alongar as viagens aumenta as horas mas reduz as viagens.** A 60 min são 1 020 h mas só 1 020
  viagens — porque o DO cobra **por minuto** e a D1 cobra **por viagem**.

### 11.2 Os 35 pedidos às DO, item a item (dedução aritmética, a confirmar com medição)

Somando o que o código faz numa viagem de 15 min (`webapp/ladiesgo-home.html` + `src/index.ts`):

| Item | Pedidos facturados | Nota |
|---|---|---|
| 5 ligações WebSocket (viagem, `live-geo`, pedidos, notificações, carros próximos) | **5** | 1 por ligação |
| `TripPush /notify` nas 4 transições (aceite, chegou, iniciou, concluiu) | **4** | 1 por transição |
| `hubBroadcast` + `notifPoke` | **5** | |
| `{t:'gps'}` no WS da viagem (1/15 s) | **3** | 60 mensagens ÷ 20 |
| `live-geo` (1/30 s) | **1,5** | 30 mensagens ÷ 20 |
| **`{t:'heading'}`** (`liveSendHdg`: máx. 1/**900 ms** se o rumo mudar **≥2°**) | **≈16,5** | **≈330 mensagens ≈ 22/min** |
| `geoPushToTrip` (ponte) | 0 | cortada pelo flag `noTripPush` (§9) |
| **Total** | **35** | fecha com o medido |

**O `heading` é o maior item isolado e é redundante:** o frame `{t:'gps'}` **já leva o `h`**
(`liveSendGps`, 1/15 s), e o cliente roda o marcador a partir dele
(`drvHdg=carCont(m.h,drvHdg)`, `carRotate`). O `heading` existe só para a rotação ser mais fina que 15 s.
Duas opções, ambas medidas pela mesma aritmética:

| Opção | Mensagens/min | DO/viagem (15 min) |
|---|---|---|
| Hoje (`1/900 ms` + ≥2°) | ≈22 | **35** |
| Baixar para `1/5 s` + ≥10° | ≈12 | **28** |
| Eliminar (rodar no `gps`) | 0 | **19** |

Fica `DO(d) = 14 + 1,4d` hoje, `14 + 0,9d` com `1/5 s` e `14 + 0,3d` sem `heading`.

### 11.3 O muro das escritas — ≈27 é o mínimo de uma viagem

Uma viagem concluída **tem** de escrever, no mínimo:

| O que | Escritas |
|---|---|
| `INSERT` na viagem | 5 |
| `ACCEPTED` / `IN_PROGRESS` / `COMPLETED` | 3 + 2 + 2 = 7 |
| `wallet_tx` (ganho da motorista) | 3 |
| avaliação | 4 |
| **1** notificação (em vez de 2) | 4 |
| **1** ponto de rasto | 4 |
| **Total** | **27** |

⇒ `100 000 ÷ 27 = **3 704 viagens/dia**` é o **tecto absoluto do Free**, mesmo que os pedidos às DO
fossem zero. Contra as **2 857** de hoje é **+30 %**, não 2×.

### 11.4 O que cada corte dá, de facto

| Corte | DO/viagem | D1/viagem | Viagens/dia (15 min) | Horas/dia |
|---|---|---|---|---|
| Hoje | 35 | 34 | 2 857 | 714 |
| **Só `heading` a 1/5 s** | 28 | 34 | 2 941 | 735 |
| **Só eliminar o `heading`** | 19 | 34 | 2 941 | 735 |
| **Só cortar as escritas** (34→27) | 35 | 27 | 2 857 | 714 |
| **Os dois** (sem `heading` + 27 escritas) | 19 | 27 | **3 704** | 926 |

- **Cortar o `heading` sozinho não dá quase nada em viagens** (2 857 → 2 941): mal o DO deixa de ser o
  muro, a D1 toma o lugar (34 escritas ⇒ 2 941). O valor do corte está **noutro lado** — em viagens mais
  longas, porque o DO cobra por minuto e a D1 por viagem.

Com os dois cortes feitos, as horas deixam de ser limitadas pelo DO e passam a crescer com a duração
(a D1 é a única trava, e o seu custo marginal é 0,4 escrita/min):

| Duração | DO | D1 | Viagens/dia | **Horas/dia** |
|---|---|---|---|---|
| 15 min (hoje) | 19 | 27 | 3 704 | 926 |
| 30 min | 23 | 39 | 2 564 | **1 282** |
| 37 min | 25 | 42 | 2 381 | **1 468** ← 2× |
| 45 min | 28 | 45 | 2 222 | 1 667 |
| 60 min | 32 | 51 | 1 961 | 1 961 |

- **"Duplicar as horas" é possível no Free** — com os dois cortes **e** uma viagem média de ~**37 min**
  (hoje 15). Sem os cortes, alongar as viagens só chega a **1 020 h** a 60 min, porque o `heading` e o
  `gps` passam a cobrar por cada minuto a mais.
- **"Duplicar as viagens/dia" NÃO é possível no Free**: exigiria ≤17,5 escritas por viagem e o mínimo
  estrutural é 27 (3 704 é o tecto, +30 % sobre as 2 857 de hoje).

### 11.5 O que fazer, por ordem

1. **Medir o `heading` antes de mexer** (é a única linha do §11.2 que é dedução e não medição). Se
   confirmar ≈16 dos 35, é o corte com melhor retorno de todo o projecto: 1 linha no cliente.
2. **Baixar o `heading`** para `1/5 s` + ≥10° (rotação continua suave; 35 → 28) e, se a rotação
   aguentar, eliminá-lo de vez (→ 19). O `gps` de 15 s já leva o `h`.
3. **Escritas 34 → 27**: uma só notificação por viagem (`completed`) em vez de duas, e um só ponto de
   rasto. As duas são mudanças pequenas e não tiram nada à experiência.
4. **Alongar a viagem média** (o único lever que aumenta horas): com 1–3 feitos, 37 min já duplica as
   horas. Encurtar viagens é o contrário do que se quer.
5. **Não** gastar mais nada em cortes de leitura: com 3 704 viagens o que trava é a escrita, e cortar
   índices troca 1 escrita por ~50 leituras.

### 11.6 A alternativa de uma linha

Com o plano pago (≈**$7–75/mês**, §6), **duplicar é imediato e sem tocar em código** — os tectos
passam de 100 k/dia para ordens de grandeza acima. A decisão é do dono e está fora do âmbito deste
documento; fica registado o número para que a escolha seja informada: **o Free já deu o que tinha a
dar em ~1,3×; o passo seguinte custa ~$7/mês.**
