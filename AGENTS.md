# AGENTS.md — LADIESGO

Instruções para agentes que trabalham neste repositório.

## Git
- Fazer **sempre `git push`** depois de cada commit (decisão do dono, 2026-10-17).

## Cloudflare — conta única do projeto (2026-10-28)
**CONTA OFICIAL: `rererererererere670@gmail.com`** (Account ID `016a8f9ed58a5cd10e9be697944905f0`).
**TUDO vive nesta conta: Pages + Worker estático + Worker/API + base de dados D1.**
**NUNCA usar `fddsfds45@gmail.com` nem `isabelcanjamba62@gmail.com` para publicar.** Verificar sempre com `npx wrangler@4.151.1 whoami`.

| O que | Nome / projeto | URL |
|---|---|---|
| **Pages (site)** | `ladiesgo` | `https://ladiesgo.pages.dev` |
| **Worker estático** | `ladiesgo` | `https://ladiesgo.rererererererere670.workers.dev` |
| **Worker/API** | `ladiesgo-api` | `https://ladiesgo-api.rererererererere670.workers.dev` |
| **Base de dados D1** | `ladiesgo` | id `fab720b7-d96e-423f-8454-bcc9942f6d50` |

- O webapp fala com a API pelo host `ladiesgo-api.rererererererere670.workers.dev` (constante `A=` no topo de cada HTML + WebSockets `wss://…`).
- **Não publicar** nas contas `fddsfds45@gmail.com` nem `isabelcanjamba62@gmail.com`.
- O login do wrangler deve ficar na conta `rerere…` (`~/.wrangler/config/default.rerere670account.toml`).
- **Nunca** correr `wrangler logout` — revoga o token e obriga a novo login.
- **Nunca** correr testes de carga contra produção.

### Deploy
- **Pages**: a partir de `webapp/`, `wrangler pages deploy . --project-name=ladiesgo --branch=main --commit-dirty=true`.
- **Worker estático**: a partir de `webapp/`, `wrangler deploy --name ladiesgo`.
- **Worker/API**: a partir de `cloudflare/api-worker/`, primeiro `npm install` (uma vez) e depois `wrangler deploy`. O `wrangler.toml` aponta à D1 `ladiesgo` da rerere (`fab720b7…`); bindings incluem as 5 Durable Objects (`RINGER`, `TRIPPUSH`, `REQUESTSHUB`, `DRIVERGEO`, `NOTIFHUB`).
- Depois de mexer no `wrangler.toml` ou nas migrações: confirmar `wrangler whoami` e o `database_id` antes de aplicar.

### Esquema da BD (migrations)
- As migrações vivem em `cloudflare/api-worker/migrations/` e aplicam-se com
  `wrangler d1 migrations apply ladiesgo --remote` (a partir de `cloudflare/api-worker`).
- A migração **`0010b_shared_departures.sql`** cria as tabelas `shared_departures`/`shared_reservations`
  (existiam na BD antiga mas nunca tinham migração; sem elas a `0011` falha). Não renomear para antes de `0011`.
- A D1 **não aceita** `BEGIN TRANSACTION` nem statements > ~100 KB num ficheiro de importação
  (fotos base64 grandes têm de ir em ficheiros separados ou a `NULL`).

## `places` — coordenadas corrigidas contra a Yango (2026-10-29)
**A tabela `places` NÃO é uma base da Yango** — o comentário da migração `0006_places.sql` está errado.
É um extracto OSM mal convertido: 0 linhas têm os tipos `organization`/`address` da Yango. Não substituir
a tabela por uma extracção da Yango (licença/ToS e todas as categorias ficariam "Organization", porque
`placeCat()` só sabe mapear os `type` do OSM).

- **Bug corrigido:** o ISPTEC (id 5683) apontava para o INSUTEC, em Samba, **5 128 m** ao lado. Causa:
  `localPlaces()` devolve a linha local e `if (local.length >= 1)` **curto-circuita** o Photon/Nominatim,
  portanto uma linha local errada bloqueia o geocoder externo que acertaria.
- **Auditoria** (`scripts/audit-places.mjs`, 9 877 POIs, autocomplete público da Yango a 2,4 req/s):
  `ok` 2 892 (≤150 m) · `corrigir` **139** (aplicadas) · `sinalizar` 6 403 · `ausente` 443. 13 duplicados apagados.
- **Três guardas** (sem elas seriam 346 correções, muitas erradas):
  - **irmãos** — o mesmo nome noutra linha nossa a >1 km é filial/cadeia: não se corrige
    (`Banco BIC Angola` ×27, `Recauchutagem` ×26, `Zumba` ×13). A guarda de cadeia *da resposta* não apanha
    isto porque a Yango só devolve a filial mais próxima (máx. 7). 346 → 184.
  - **corroboração** — desvio >2 km (`--safe`) só passa se outro sítio nosso estiver a ≤250 m (`--proof`) do
    destino com nome parecido ≥0,6. Trava `seven`, `Lavanderia`, `Viana`; deixa passar o ISPTEC (a linha
    `ISPTC` já está a 61 m do sítio certo). 184 → 139. **Só o ISPTEC tem desvio >2 km.**
  - **duplicados** — só se apaga com nome exatamente igual **e** coordenadas a **4 casas** (~11 m).
    Com 3 casas (~110 m) apagavam-se entradas distintas do mesmo sítio.
- **Cache:** a pesquisa guarda a resposta **7 dias** em `caches.default` por datacenter
  (`places:v12:<q>:<lat>,<lng>`). Corrigir a D1 **não chega** — é preciso subir a chave e fazer deploy.
  Passou a `places:v13` (commit `7b95f75`) e depois a **`places:v14`** (2026-10-30, com a pesquisa FTS-only —
  ver "Cortes de custo no plano Free"). **Ao mexer em `places`, subir sempre esta chave.**
- **Aplicado em produção (2026-10-29):** 139 UPDATEs + 13 DELETEs = **721 linhas escritas**; `places` e
  `places_fts` 23 345 → **23 332**; `integrity-check` do FTS passa. Verificação: 131/139 na coordenada certa
  e as 8 restantes são os duplicados que o próprio lote apagou. `/api/places/search?q=isptec` devolve
  **Talatona**; amostra de 25 correções, todas a **0 m**. Time Travel de rollback:
  `0000000a-00000064-00005113-e4fb9ec0f269c6029fa7d3d8f781e772`.
- **`--report`** regenera `.sql`/`.csv` a partir do `.jsonl` sem rede. O `.jsonl` passou também a ser
  reescrito com as decisões **já filtradas** — antes guardava a decisão bruta e quem o lesse via correções
  (ex.: id 8, `Viana`, `seven`) que nunca foram escritas.
- **Fase 2 (por fazer):** as 6 403 `sinalizar` precisam de revisão humana; adições devem vir de
  **OSM/Overpass** (ODbL), não da Yango.

## Migração de conta (2026-10-28) — estado
- A API e a base de dados foram **migradas da conta legada `fddsfds45` para a `rerere…`**.
- **Base de dados:** D1 `ladiesgo` na rerere (`fab720b7…`), já com os dados migrados da BD antiga
  (29 utilizadores — 1 ADMIN, 2 motoristas, 26 passageiras —, 108 viagens, 24 avaliações,
  23.345 lugares, histórico completo). As senhas (`pbkdf2$100000$…`) são lidas do próprio hash, por isso
  o login por senha continua a funcionar. As 3 fotos de perfil em base64 (~120 KB) ficaram a `NULL`
  (limite por statement da D1; as fotos são reenviáveis na app).
- **Conta legada `fddsfds45`:** fica **intacta mas sem clientes** — ainda aloja o Worker antigo
  (`ladiesgo-api.ladiesgo-ao.workers.dev`) e a D1 antiga (`84893b8b-5661-4fbc-a6aa-810ffbc1ab38`).
  **Não publicar lá** e não reutilizar os URLs antigos.
- **`JWT_SECRET`:** definido com `wrangler secret put JWT_SECRET` no Worker/API da rerere (valor novo,
  gerado para a migração). Não usar o valor de `.dev.vars` em produção.

## Verificações HTTPS
- PowerShell 5.1 / `curl` têm TLS quebrado para `*.workers.dev` (schannel). Usar `node`, ex.:
  `node -e "fetch('https://ladiesgo-api.rererererererere670.workers.dev/api/v1/health').then(r=>r.text()).then(console.log)"`

## Fotos de perfil (2026-10-29) — Telegram
- A D1 guarda **só o `file_id`** do Telegram em `users."profilePhoto"` (letras/números); nunca base64.
- `PUT /api/v1/users/profile` e `PUT /api/v1/admin/users/:id/photo` recebem a data URL, enviam a
  imagem ao canal Telegram (`TG_BOT_TOKEN` + `TG_CHAT_ID`) e gravam o `file_id` devolvido.
- `GET /api/v1/users/photo/:fileId` serve a imagem a partir do Telegram (`getFile` + streaming;
  cache de 30 min do `file_path` por isolate). É público porque é usado em `<img src>`.
- Resposta de sucesso leva `Cache-Control: public, max-age=86400, immutable` (24 h); erros (404/502)
  vão com `no-store`. O URL tem o `file_id`, por isso uma foto nova (novo `file_id`) gera um URL novo —
  cachear 24 h é seguro e poupa pedidos ao Worker.
- A API devolve sempre `profilePhoto` como **URL absoluto** pronto para `<img src>`.
- Se o Telegram falhar, o upload devolve **502** e **não** escreve na D1 (não voltar a guardar base64).
- Migração de fotos base64 antigas: `npm run migrate:photos` (a partir de `cloudflare/api-worker`;
  segredos em `.dev.vars.telegram`, que está no `.gitignore`).

## Tempo real (quem manda a posição do carro)
- `DriverGeo` (DO global, id `geo:global`) é a **fonte de toda a posição viva**: recebe o GPS por REST (`PUT /api/v1/drivers/location`, `POST /api/v1/drivers/position`) e por WebSocket global (`/api/v1/drivers/live-geo`).
- `TripPush` (DO por viagem, id `trip:<tripId>`) é o que serve o WebSocket da viagem (`GET /api/v1/trips/:id/live`) → é o que a passageira vê.
- **Ponte obrigatória:** o `DriverGeo` empurra cada fix para o `TripPush` da viagem ativa (rota interna `POST /gps`), senão o carro fica **parado no mapa** quando a app da motorista está em segundo plano (o GPS em background nunca passa pelo WS da viagem).
  - Viagem ativa resolvida por `activeTripForDriver()` (cache de 20 s no isolate) → 1 leitura **D1** por ~20 s e por motorista.
  - O `TripPush` só difunde se a viagem estiver `ACCEPTED`/`DRIVER_ARRIVED`/`IN_PROGRESS`, com o mesmo throttle do WS (1 fix/10 s; redesenho se o carro andou ≥150 m ou a cada 30 s).
  - Pontos da viagem (`trip_points`) gravam-se a cada **60 s** (antes 30 s) — poupança de escritas na D1, sem perda visível no rasto.
- **Cancelamento de corrida:** o aviso às motoristas é um `await hubBroadcast(c.env)` **imediato** nos endpoints de cancelamento (não em `waitUntil`), para a oferta sumir rápido. Ver também o ping/pong do WS de pedidos no webapp.

### WebSockets de leitura (2026-10-29) — mapa, chamadas, notificações, link público
Todos são `GET` com header `Upgrade: websocket`; sem upgrade devolvem **426**. O token vai por `?token=<JWT>` (ou `Authorization: Bearer`).

| Rota | Auth | DO / id | Frames |
|---|---|---|---|
| `/api/v1/drivers/nearby-live?token=<JWT>&lat=<n>&lng=<n>&radius=<m>` | qualquer autenticado | `DRIVERGEO` → `geo:global` (viewer `pax`, tag `pax`) | `{t:'nearby', drivers:[{id,lat,lng,h}], ts}` ao ligar e no máx. 1×/5 s (hash das posições). Só `id`/posição/rumo; lista vazia é enviada na mesma (`drivers: []`). **Nunca** nome, telefone nem categorias. |
| `/api/v1/trips/:id/call/live` | só participante (`assertParticipant`, senão **403**) | `TRIPPUSH` → `calls:<tripId>` (tag `call`) | `{t:'ready'}` ao ligar; depois `{t:'signal', signal:{from,type,payload,ts}}`. Aceita `{t:'ping'}` → `{t:'pong'}` (heartbeat) e `{t:'signal',type:'end'\|'reject'\|'cancel'}` do cliente, que difunde logo (atalho do "desligar"). |
| `/api/v1/notifications/live` | qualquer autenticado | `NOTIFHUB` → `notif:<userId>` (tag `u:<userId>`) | `{t:'hello'}` ao ligar; `{t:'notif', n:1}` quando entra notificação nova |
| `/api/v1/trips/public/:id/live` | **nenhuma** (link público; **404** se a viagem não existir) | `TRIPPUSH` → `trip:<id>` (tag `pub`) | `{t:'hello', status, driver:{lat,lng,h}\|null}`; depois só `status`/`driver`/`eta` sanitizados |

- **`nearby-live` — raio (2026-10-29):** `radius` em metros, opcional: default **5000**, mínimo **200**, máximo **50000**; valor inválido → default. Sem `lat`/`lng` válidos mantém-se o comportamento antigo (devolve a frota toda). O filtro de raio já é feito **no servidor**; o cliente pode continuar a filtrar (apresentação), mas já não é obrigatório.
- **`NotifHub`** é a 5.ª DO (binding `NOTIFHUB`, migration `v5`, também em `[env.staging]`): 1 DO por utilizador, WS hibernável, auto-resposta `ping`/`pong`, rota interna `POST /poke`.
- **Pokes internos** (Worker → DO, sempre em `waitUntil`/try-catch, para não bloquear a resposta):
  - `chatPoke()` no `POST /trips/:id/chat` → `{t:'unread', n:1}` a todos os sockets da viagem. O WS **não** leva `{t:'chat'}`: o texto vem por `GET /trips/:id/chat` (o app usa `unread` + REST).
  - `callSignalPoke()` no `POST /trips/:id/call/signal` → difunde o sinal ao DO `calls:<tripId>`.
  - `notifPoke()`/`notifPokeMany()` em **todos** os `INSERT INTO notifications` (admin manual, agendadas/cron, alerta de partilha, confirmação Premium). O pedido de viagem **não** cria linha em `notifications` — usa só o `hubPoke` da `RequestsHub`.
- **Isolamento (crítico):** `broadcast()`/`broadcastExcept()` **excluem** sockets laterais (`pub`/`call`); o público só recebe `broadcastTag('pub', …)` com `status`/`driver`/`eta`. Sockets `pub`/`call` não podem injetar `gps`/`chat`/`heading`, e o `state` de um socket `pub` é respondido em versão sanitizada.

## Staging — testar notificações/cron (2026-10-29)
Os três pokes de notificação **não se testam em produção**: `POST /admin/notifications/send` e as agendadas escolhem
destinatários por **role** (`ALL`/`PASSENGERS`/`DRIVERS`), nunca por utilizador — testar em produção escreveria uma
linha em `notifications` para todas as contas reais e dispararia push Expo para telemóveis verdadeiros.

Ambiente isolado (`[env.staging]` no `wrangler.toml`):
- Worker **`ladiesgo-api-staging`** + D1 **`ladiesgo-staging`** (`7e0cf0fd-527f-4e51-8e30-c93a55abddea`) + as 5 DOs.
- `ENVIRONMENT="staging"`, rate limit 1000/min. **Sem cron** (`[env.staging.triggers] crons = []`).
- Segredos próprios: `JWT_SECRET` e `DEBUG_KEY` (nunca os de produção).
- O logar como `999999999`/`1234567890` **cria** o admin na D1 de staging (backdoor), não é preciso seed manual.

Disparar o cron à mão (só existe com `KEY` certa **e** `ENVIRONMENT === 'staging'`; fora disso devolve **404**):
```bash
curl -X POST "https://ladiesgo-api-staging.<sub>.workers.dev/api/v1/debug/cron/notifications?key=$DEBUG_KEY"
```
Chama `runNotificationSchedules(env)`; o claim de `lastRunKey` garante que uma 2.ª chamada no mesmo slot **não** repete.

Resultado do teste de fogo (28/28, D1 de staging a zero no fim): admin `PASSENGERS` → frame nas 2 passageiras e
**nenhum** no motorista (715/711 ms); Premium confirm → só na passageira dona da reserva (602 ms); cron `DRIVERS` →
só no motorista (895 ms); 2.ª chamada do cron → sem frame novo.

Limpeza: `DELETE`s por ordem (filhos → pais); **`POST /debug/d1/reset` só repõe os contadores**, não apaga linhas.

## TURN / chamadas (2026-10-29) — Metered
`GET /api/v1/turn/ice` (autenticado) devolve `{ iceServers, demo }`. **`demo:true` só existe quando não há TURN configurado**
— nesse caso usa `turn:openrelay.metered.ca` (`openrelay`/`openrelay`), que funciona em Wi-Fi mas falha em rede móvel/CGNAT.

Ordem de resolução (em `src/index.ts`):
1. **Rotativa:** `METERED_DOMAIN` + `METERED_SECRET_KEY` → cria credencial com `expiryInSeconds=172800` (48 h),
   guarda-a em D1 (`turn_credentials`) e serve o `apiKey` dela (`source:'rotating'`). Renova quando a mais recente
   tem **mais de 24 h**; a anterior fica válida até expirar (sobreposição de 24 h).
2. Estática via `METERED_TURN_APIKEY` (credential-scoped) → `https://<domínio>/api/v1/turn/credentials`.
3. `METERED_ICE_JSON` → array JSON estático `[{urls, username, credential}]` (`source:'static'`).
4. `FALLBACK_ICE` (OpenRelay público) → `demo:true`.

**Configuração atual (2026-10-29):** workspace Metered `ladiesgo-taxi` → `METERED_DOMAIN=ladiesgo-taxi.metered.live`.
Em produção e staging: `METERED_SECRET_KEY` + `METERED_DOMAIN` (rotação), `METERED_TURN_APIKEY` (legado, 2.º),
`METERED_ICE_JSON` (último recurso).
- **A credencial muda de dia para dia.** A que está no telemóvel expira em 48 h; uma nova é criada ~24 h antes.
  Se vazar, deixa de servir no dia seguinte.
- **Cron:** o horário diário `17 3 * * *` chama `rotateTurnCredential(env)` (a par do purge de `trip_points`).
  O `/turn/ice` também roda sozinho se a credencial estiver velha (útil se o cron falhar).
- **Tabela:** migração `0015_turn_credentials.sql` (`username` PK, `apiKey`, `label`, `createdAtMs`, `expiresAtMs`);
  label `ladiesgo-prod` / `ladiesgo-staging`. Rodagem = **1 INSERT por dia** e limpeza de expirados > 1 dia.
- **Secret Key ≠ API key:** a `995a…` só lê a credencial fixa; a Secret Key (`hbB-…`) é a chave-mestra da conta,
  fica **só** no Worker e nunca vai para o browser. A Metered valida-a contra o subdomínio exato (outro domínio → 401).
- Prova (2026-10-29): `source:'rotating'`, credencial `8dda…` (≠ estática `4c63…`), **6 candidatos `typ relay`** no
  browser; em staging, credencial envelhecida 25 h → nova criada e a antiga mantida (2 linhas).
- Rodar/chave nova: `"<valor>" | npx wrangler@4.151.1 secret put METERED_SECRET_KEY --env=""` (idem `--env staging`).
  Sem `METERED_SECRET_KEY` o `/turn/ice` volta à credencial estática (funciona, mas não expira).

## Chamada — fechar rápido e voz com menos atraso (2026-10-29)
Sintomas reportados: ao desligar num lado, o outro demorava a fechar; e a voz tinha atraso.

- **Desligar por WebSocket (atalho):** `__sigPost('end'|'reject'|'cancel')` envia **também** `{t:'signal',type:...}` pelo
  WS `call/live`; o DO `calls:<tripId>` difunde logo com `ts=Date.now()`. O `POST /call/signal` continua a ser feito
  (persistência + fallback) e leva `keepalive:true`.
- **`POST /call/signal` deixou de esperar pela D1:** faz o poke ao DO em paralelo e grava a linha em `waitUntil`
  com `"createdAt" = to_timestamp(ts/1000)` (o `ts` devolvido é o mesmo do frame). Antes o INSERT (D1 em WEUR)
  atrasava ~0,5–0,8 s a entrega ao outro lado.
- **Fallback de polling:** o salto de 30 s com WS aberto passa a **3 s enquanto há chamada** (30 s em `idle`).
- **Heartbeat:** durante a chamada o cliente envia `{t:"ping"}` a cada 3 s; o DO responde `{t:"pong"}`. Sem pong
  durante 12 s → fecha/reabre o WS e faz `__callLoop(true)` (caem as ligações meio-abertas típicas de rede móvel).
- **Voz:** `pc.ontrack` define `receiver.jitterBufferTarget = 0` (e `playoutDelayHint = 0` como fallback) — corta
  a espera do jitter buffer (~200 ms no Chrome/WebView).
- **Queda abrupta:** `iceConnectionState === 'disconnected'` durante 6 s (ou `failed`/`closed`) → termina a chamada
  e mostra "A chamada caiu." (antes ficava "Em chamada" com áudio morto).
- **Duplicados/ordem:** os sinais são deduplicados por `trip|ts|type|fim-do-payload` (antes só `trip|ts`, e como o
  `offer` e o 1.º `ice` saem no **mesmo milissegundo**, o `offer` era descartado como duplicado → ficava "A ligar…"
  para sempre). `__call.seen` guarda **ts do servidor** (antes `Date.now()` local podia saltar sinais e impedir a
  chamada seguinte de tocar).
- **ICE antes do offer:** os candidatos que chegam antes de existir `remoteDescription` ficam em `__call.pend`
  (máx. 120) e são aplicados por `__flushIce()` depois do `setRemoteDescription` (no `answer` e no `accept`).
  O `offer` **não** limpa o `pend`. No `__callAccept` o estado passa a `calling` **antes** dos `await` e, no fim,
  se o ICE já estiver `connected`, o handler é chamado à mão para promover a `active` (senão ficava "A ligar…"
  com áudio já a passar).
- Prova (2026-10-29, browser real, 2 origens diferentes, áudio sintético): offer entregue em ~1 s, `pend`=9,
  `accept` → `active` nos dois lados, `iceConnectionState/connectionState = connected`, `inbound-rtp` a subir
  (bytes 48 KB → 62 KB em 3 s, `audioLevel 1`), 6 candidatos `relay`. Desligar: outro lado `idle` no 1.º poll.
- **Confirmado em telemóvel real pelo dono (2026-10-29):** motorista→passageira a ligar e a falar nos dois sentidos.
- Prova (2026-10-29, produção, browser real em `/home`): `end` pelo WS chegou ao outro socket em **249 ms**,
  ou seja **240 ms antes** de o POST terminar (489 ms); 5/5 entregas 194–267 ms; `ping→pong` ~200 ms.
  Staging: 188–507 ms. Dados de teste apagados da D1 no fim (prod 25 users / 116 trips).

## Cancelamento — aviso imediato ao outro lado (2026-10-29)
Sintoma: quem cancelava via a viagem terminar, mas o outro lado só descobria 10–30 s depois (polling).

- **Bug de raiz:** em `POST /api/v1/trips/:id/status` os `UPDATE` de `DRIVER_ARRIVED`, `IN_PROGRESS` e `CANCELLED`
  não tinham `RETURNING`. A D1 devolve `[]` quando não há `RETURNING`, logo o `if (!r.length) return 400`
  disparava **sempre**: a linha era gravada mas a resposta era `400 {"message":"Transição inválida."}` e o
  `pushStatus` **nunca corria**. Passou a ter `RETURNING id` nos 3 ramos (afetava também `arrived`/`in_progress`/
  `completed` no fluxo web, não só o cancelamento).
- **Ordem:** o push ao DO sai **depois** do `UPDATE`; se saísse antes o outro lado lia o estado antigo na D1 e
  voltava a mostrar a viagem.
- **O frame leva quem cancelou e o motivo:** `notifyTripPush`/`pushStatus` aceitam `extra`, o DO `TripPush /notify`
  difunde `{t:'status',status,by,reason}`. `PUT /trips/:id/cancel` manda o `role` do token; `/status` manda o `by`
  do corpo (a home já o enviava, era ignorado).
- **Cliente não espera pelo polling:** no handler do WS, em `cancelled`, se o `by` **não** for o meu papel, limpa
  `myTripId`/`tripId` + `lg_mtrip`/`lg_trip`/`lg_org`/`lg_orgm`, remove marcadores, volta a `home`, mostra
  `showCancelBanner` com o texto por papel ("Corrida cancelada pela motorista/passageira" + "Motivo: …"), fecha o
  WS e faz `return` (não chama `pollTrip`/`pollMine`). Quem cancelou continua a ver "Cancelaste a corrida".
- Prova (2026-10-29, produção, Node com WS global + browser real em 2 origens):
  passageira→motorista 200/748 ms com frame em 770 ms; motorista→passageira 200/736 ms com frame em 737 ms.
  No browser: frame com `by`/`reason` em 484 ms (A) e 519 ms (B), banner correto no recetor e
  "Cancelaste a corrida" no ator. `arrived`/`in_progress`/`completed` passaram de 400 falso para 200
  (frames 275–636 ms).
- **Banner antigo:** `pollTrip`/`pollMine` chamam `closeCancel()` quando recebem uma viagem ativa — o aviso
  "Corrida cancelada…" de uma viagem anterior deixa de ficar por cima da viagem nova (prova no browser: banner
  ligado por `showCancelBanner` desaparece no `poll*` seguinte, nos dois papéis e nos dois domínios).
- Nota: `wrangler d1 execute --remote` continua a funcionar; a **API REST** da D1 com o token OAuth guardado
  devolve `7403` (o token não tem scope de D1). Para escritas por script usar **wrangler**.
  *(Depois de renovar o login do wrangler a API REST volta a funcionar; em 2026-10-29 o `delete`/`insert` por
  REST passou a devolver 200 — ver a nota de tokens.)*

## Push — um só ponto de envio e eventos completos (2026-10-29)
**Sintoma:** a app não mandava notificações. Havia 3 problemas independentes.

1. **Sem push nos eventos principais.** Só existia push em: novo pedido (`pushTripToDriver(s)`), chegou
   (`pushPaxArrived`), chat e toca-toca do `TripRinger`. Aceitar, cancelar e concluir **não** avisavam nada.
2. **Tokens mortos nunca eram apagados.** Os envios iam direitos ao Expo e a resposta (que diz
   `DeviceNotRegistered`) era ignorada; o token velho ficava na BD para sempre a falhar em silêncio.
3. **Causa nativa (a que impede mesmo o token de existir):** `mobile/app.json` nunca teve o plugin
   `expo-notifications`. Desde o **SDK 53** o plugin é obrigatório: sem ele o iOS não ganha o entitlement
   `aps-environment` e o `getExpoPushTokenAsync()` falha dentro de um `catch {}` (silêncio total). No Android
   falta o `google-services.json` (nunca existiu no repo) → também não há token. Ver "Pendente" abaixo.

**Servidor (feito, deployado e provado):**
- `expoSend(sql, msgs)` é o **único** sítio que fala com `https://exp.host/--/api/v2/push/send`. Lê os
  *tickets* da resposta e, para cada `error` com `details.error === 'DeviceNotRegistered'`, faz
  `UPDATE users SET "fcmToken" = NULL` — o token morto sai da BD e o próximo login regista um novo.
- `pushToUser(sql, userId, title, body, data)` e `tripOtherUserId(sql, tripId, meId)` (o outro lado da viagem).
- Passaram a usar `expoSend`: `pushPaxArrived`, o push de chat, `pushTripToDriver`, `pushTripToDrivers` e o
  alarme do `TripRinger`. **Não há mais `fetch(...push/send)` espalhados** — ao acrescentar pushes usar estes
  helpers (senão volta a não haver poda de tokens).
- Eventos novos, todos com `data.tripId` e `type`:
  | Onde | Para quem | Título |
  |---|---|---|
  | `PUT /trips/:id/accept` | passageira | 🦋 Motorista a caminho! (com o 1.º nome da motorista) |
  | `POST /trips/:id/status` `accepted` | passageira | 🦋 Motorista a caminho! |
  | `PUT /trips/:id/cancel` | o outro lado | Corrida cancelada pela motorista/passageira (+ `Motivo: …`) |
  | `POST /trips/:id/status` `cancelled` | o outro lado | idem, com o motivo do corpo |
  | `PUT /trips/:id/complete` | passageira | 🦋 Viagem concluída (convite a avaliar) |
  | `POST /trips/:id/status` `completed` | passageira | 🦋 Viagem concluída |
  - Os pushes de estado vão em `c.executionCtx.waitUntil(...)`: não atrasam a resposta HTTP.
  - `arrived` continua a sair de `pushPaxArrived` (chamado no ramo `DRIVER_ARRIVED`) — não duplicar.
  - `in_progress` **não** manda push de propósito (a passageira está no carro com a app aberta).

**Como testar sem tocar em telemóveis reais:** pôr `fcmToken = 'ExponentPushToken[FAKEtest000000000000]'`
no utilizador de teste, provocar o evento e confirmar que o token fica `NULL`. O Expo responde sempre
`{"status":"error","details":{"error":"DeviceNotRegistered"}}` a tokens falsos (prova de que o envio saiu e a
poda correu). Script pronto: `%TEMP%\opencode\t-push.mjs` (regista motorista+passageira, exercita aceite/
cancelamento nos dois sentidos/chegou/iniciou/concluiu e limpa no fim).
- **Atenção no `POST /trips/:id/status` `accepted`:** o corpo leva `driverId` = **userId** da motorista
  (`driverIdFor()` procura `drivers."userId"`), não o id da linha `drivers`. Com o id da linha devolve
  `403 {"message":"Só motoristas."}`.
- **Nunca** limpar dados de teste com `DELETE ... WHERE "passengerId" NOT IN (SELECT id FROM users)`:
  isso apaga viagens históricas de contas já eliminadas. Apagar só por `name LIKE 'ZZ%'` / `id LIKE 'drvtest-%'`.
  (Aconteceu em 2026-10-29: 15 viagens apagadas e repostas com
  `wrangler d1 time-travel restore ladiesgo --timestamp=…` — o Time Travel da D1 funciona como rede de segurança.)

**Prova (2026-10-29, produção, token falso, dados de teste apagados no fim):** aceite por `/status` 200 e por
`PUT /accept` 200 com token → `NULL`; cancelamento motorista→passageira e passageira→motorista com token →
`NULL` dos dois lados; `arrived` → `NULL`; `completed` → `NULL`; `in_progress` sem push (token fica, correto).
Base no fim: 25 users / 119 trips / 1 motorista, 0 vestígios `ZZ%`/`drvtest-%`.

### Causa raiz provada (2026-10-29) — build instalado fala com a API antiga
O último build iOS instalado é o **#11 (19/10, commit `7ca72d5`)**, que tem dentro dele
`API_URL = https://ladiesgo-api.ladiesgo-ao.workers.dev/api/v1` (conta legada) e
`SITE_URL = https://ladiesgo.pages.dev/ladiesgo?v=20261015`. Desde a migração de 28/10 o **site** é o novo
(as viagens são criadas na D1 nova) mas o **registo do token de push** vai para a API antiga:

- `registerPushToken()` faz `PUT {API_URL}/users/profile` com `{ fcmToken }` e o JWT **da API nova**
  (o login é feito no site novo). A API antiga valida com o `JWT_SECRET` antigo → **401 `Sessão inválida.`**
  (provado a 2026-10-29 com JWT novo contra o Worker antigo) e o erro é engolido pelo `catch {}`.
- Resultado: o token não fica em base nenhuma. **O telefone da motorista real nunca teve token**, nem na
  base antiga (verificado: a D1 antiga `84893b8b…` tem exactamente os mesmos 2 tokens de 16/10 e 18/10 que a
  nova, e `fcmToken` da Maria Gaspar = `NULL` nas duas).
- **Corolário: copiar tokens da D1 antiga para a nova não resolve nada** — o que lá existe já cá está. Escrever
  tokens novos só os pode criar um build que aponte à API nova (`API_URL` da rerere, build ≥ #12).

**Resolvido (2026-10-29, 12:03 Lisboa):** instalado o build **#13** (plugin `expo-notifications` + `API_URL` da
rerere), a Maria Gaspar passou a ter `fcmToken` na D1 nova (`tem_token: 1`, `push_diagnostics` **vazio** — o token
foi obtido à primeira). Base: 25 users / 120 trips / 1 motorista / 3 tokens. A assinatura do build passou com o
plugin, o que confirma que a capability **Push Notifications** está activa na App ID `com.ladiesgo.app`.
A partir daqui **não voltar a apontar `API_URL` para a conta antiga** nem instalar builds anteriores ao #12.

**Pendente (só o dono consegue resolver):**
- **iOS:** juntar `"expo-notifications"` a `plugins` no `mobile/app.json` e **reconstruir** (build nativo novo —
  mudar `App.tsx`/`app.json` não chega com deploy de HTML). A App ID `com.ladiesgo.app` tem de ter a capability
  **Push Notifications** ativa no portal Apple, senão o `sigh(force: true)` do Fastfile falha.
- **Android:** obter o `google-services.json` do projeto Firebase `com.ladiesgo.app`, guardá-lo em
  `mobile/` (fora do git) e apontar `android.googleServicesFile` no `app.json`.
- Só depois de um build com token real é que os pushes acima chegam ao telemóvel. Sem token na BD, o servidor
  não tem para onde enviar (a motorista real não tem `fcmToken`).

## Notificações com imagem + popup no mapa (2026-10-30)
O admin pode anexar uma imagem a um aviso; no `/home` ela aparece **grande, num popup**, com o título
por cima, a imagem ao centro e o texto por baixo (X ou "Fechar" para sair).

- **A imagem nunca fica em base64 na D1.** O admin envia uma data URL, a API manda-a ao canal Telegram
  (`tgSendPhoto`) e grava só o **`file_id`** na coluna `notifications.image` / `notification_schedules.image`
  (migração `0019_notification_images.sql`). O `GET /api/v1/users/photo/:fileId` serve-a — o mesmo
  caminho das fotos de perfil.
- `notifImageStore()` aceita **data URL** (upload), **file_id** existente ou **URL http(s)**.
  `notifImageUrl()`/`notifImageAbs()` devolvem sempre URL absoluto (dentro do pedido, e no cron, onde não há
  `c.req.url` — daí a constante `API_PUBLIC_ORIGIN`).
- Push Expo leva `data.imageUrl` + `richContent.image` (imagem na notificação do telemóvel, quando o SO deixa).
- **`GET /api/v1/notifications/banner`** (autenticado) devolve **só** o aviso admin mais recente **com imagem**.
  É o que o `/home` pede para o popup — 1 pedido pequeno em vez da lista de 50. Sem imagem → `{banner:null}`.
- **Memória do popup:** ids já vistos em `localStorage.lg_bseen` (máx. 80). O popup abre 1,5 s depois de
  carregar, ao voltar a `visible` e quando o WS `/notifications/live` manda `{t:'notif'}`.
  Fechar marca como visto; recarregar não volta a mostrar.
- **Desenho do popup (2026-10-30):** sem cartão branco e **sem botão "Fechar"** — só o **X** no canto
  superior direito (fecha também tocando no fundo escuro). Título, imagem e descrição **centrados**, texto
  branco sobre o fundo escuro. `z-index:100002` para o X não ficar por baixo da barra de permissões
  (`#lgPermBar`, `100001`).
- **Bandeira do destino (2026-10-30):** `destMk` só é desenhada com o fluxo de reserva aberto
  (`ph==='opt'` + `selDone`) ou com viagem ativa; `show('home')` remove-a. Antes, ao voltar do segundo plano
  (ou ao atualizar o GPS) com um rascunho antigo em `lg_ddraft` (`sel:1`), `focusOriginDest()` redesenhava a
  bandeira no `home` sem a passageira ter marcado destino.
- **Programadas editáveis:** `PUT /api/v1/admin/notifications/schedules/:id` (título, mensagem, alvo, dia,
  horários, imagem, `enabled`). Se `times` não mudar, o `lastRunKey` do slot é preservado (não repete o envio);
  se mudar, só os horários novos são inseridos e os removidos apagados. Sem `image` no corpo, a imagem mantém-se;
  `image:''` remove.
- **UI (`webapp/admin.html`):** seletor de imagem no "Enviar agora" e em cada horário programado, lista de
  programadas com **Editar/Cancelar/Guardar** e interruptor "Ativa". Os 3 horários pré-preenchidos (06:00/12:00/18:00)
  **só são programados se tiverem mensagem** — linhas vazias são ignoradas (antes davam erro e obrigavam a apagar).
- Teste ponta-a-ponta em staging: `%TEMP%\opencode\t-notif-images.js` (18/18 — envio com imagem, file_id → URL,
  imagem servida 200, banner, criar/editar/remover imagem/listar/apagar programada, histórico, 401 sem sessão).
- **Nunca** testar envios em produção: escreve em `notifications` de todas as contas reais e dispara push.
  Para o popup, inserir **uma** linha para um utilizador de teste (e apagá-la no fim).

## Reserva Premium — libertar o carro fecha a reserva (2026-10-30)
Quando o admin carrega em **Libertar** (`POST /api/v1/admin/premium/fleet/:id/release`), a reserva passa a
`completed` e **desaparece da lista da passageira** ("As minhas reservas premium").

- **API:** `GET /api/v1/premium/reservations/mine` filtra
  `WHERE pr.passenger_id = … AND pr.status IN ('pending','confirmed')` (antes devolvia tudo, incluindo
  `completed`/`cancelled`, e a lista mostrava reservas já fechadas).
- **Cliente (`webapp/ladiesgo-home.html`, `renderPremiumMine`):** só desenha `pending`/`confirmed`
  (pendentes já expiradas também saem). O detalhe (`renderPremiumDetail`) reencaminha para a lista com
  mensagem em `completed` ("Reserva concluída — o carro foi libertado.") e `cancelled`.
- O selo `dPremiumN` já usava `prmActive()` (ignora `completed`), por isso fica consistente.
- O carro volta a `available` com `reservadoPor: null` no painel do admin.
- Provado em staging (`%TEMP%\opencode\t-premium-release.mjs`): mine 1 `pending` → 1 `confirmed` → **0**
  depois de libertar; detalhe devolve `completed`; carro `available`/`reservadoPor: null`.

## Menus laterais — ordem por papel (2026-10-30)
O drawer é **um só** (`#drawer`); o papel decide o que aparece.

- **Passageira:** Perfil · Partida Compartilhada · Reserva · Segurança · Contactos · Guardar destinos ·
  Histórico · Voltar ao início · Eliminar conta · Sair.
- **Motorista:** Perfil · Minhas viagens compartilhadas · Segurança · **Viatura** · Carteira · Contactos ·
  Histórico · Voltar ao início · Eliminar conta · Sair, e por baixo **As minhas categorias**
  (Económico/Conforto/Kids!, de `/api/v1/categories`).
- **"Viatura" é singular** — no item do menu **e** no título do ecrã (`data-a="cars"`).
- **A motorista não tem "Guardar destinos":** `#dAddPlace` fica `display:none` para `role==='DRIVER'` no
  handler do `#ham` **e** no sync de papel; o `data-a="addplace"` tem guarda de clique (`if(role==='DRIVER')return`).
  (Antes, um `#ham` que não corresse o handler deixava o item visível — testar sempre com
  `document.getElementById('ham').click()` dentro de `evaluate`, porque `#lgPermBar` (`z-index:100001`)
  tapa o botão e o `click('#ham')` do Playwright faz timeout.)
- **"Minhas Partidas" centrado:** `.sheet>.pwbox{margin-left:auto;margin-right:auto}`. Medido no browser:
  sheet 414 / card 380 / folgas 17–17 px, com "+ Anunciar Partida", "Nenhuma partida anunciada." e "Fechar".

## Anunciar Partida — escolha de pontos igual à reserva (2026-10-30)
O formulário "Anunciar Partida" ("Ponto de partida / Onde estás?" e "Destino") usa **o mesmo picker** da
reserva Premium, não o antigo `sharedPickBar`.

- `prmPickOnMap(field, target)` com `_prmTarget = 'prm' | 'shared'`; `sharedPickOnMap(f)` chama
  `prmPickOnMap(f,'shared')`.
- Títulos: `shared` → "Escolher ponto de partida"/"Escolher destino"; `prm` → "Escolher ponto de busca (X)"/"Escolher destino (Y)".
- Nome do sítio por `/api/zone` (ex.: "Cazenga Popular") e sugestões por `/api/places/search` (ex.: ISPTEC).
- `prmPickConfirm()` escreve `_sharedOrigin`/`_sharedDest` e volta ao formulário (`renderSharedCreate`);
  `prmPickCancel()` volta limpo. `prmPickEnd()` repõe `_prmTarget='prm'` (a reserva Premium não muda).
- Provado no browser (`https://ladiesgo.pages.dev`): barra certa nos dois campos, ISPTEC escolhido e gravado
  em `_sharedOrigin` (lat/lng), cancelar devolve o formulário com o campo vazio, picker Premium intacto.

## Marcador não salta ao escolher ponto (2026-10-30)
Ao escolher um ponto, o alfinete saltava ~200–400 m e o nome mudava para a zona (`/api/zone`) em vez do sítio
pesquisado. Quatro causas, todas corrigidas no cliente (`webapp/ladiesgo-home.html`):

- **Geocoder tardio a sobrepor-se:** cada `/api/zone`/`/api/places/search` tem um contador de geração
  (`_prmGeoGen`); respostas de pedidos antigos são descartadas. Antes, a resposta lenta de um arrasto anterior
  escrevia por cima do ponto novo.
- **`orgCenterOn()` animado:** centrar o mapa com animação fazia o `moveend` reescrever o ponto. Passou a
  `orgCenterOn(animate:false)` no confirmar.
- **Ciclo da motorista a perseguir o carro:** o loop de `follow` reposicionava o mapa por baixo do dedo.
  Agora `pickerOpen()` bloqueia o follow enquanto o picker está aberto, e `_prmUserMove` desliga o follow
  em `dragstart`/`zoomstart`.
- **Âncora do alfinete:** usava o topo do ícone; passou a `pr.bottom` (o alfinete aponta ao pixel certo).

Prova (browser real, `https://ladiesgo.pages.dev`, pesquisa "Patricio"): marcador a **0 m / 0 px** de deriva
durante 14,5 s de observação, nome apresentado é o do sítio pesquisado (não o da zona).

## "Ver rota" nas partidas partilhadas (2026-10-30)
- No formulário "Anunciar Partida" e na lista de partidas há **"Ver rota"**; a passageira vê a rota no mapa
  antes de reservar.
- `GET /api/v1/shared/departures/:id/payment` passou a devolver **origem/destino com coordenadas e nomes**
  (antes só o valor), que é o que `sharedViewRoute()` precisa para desenhar a linha.
- A rota desenha-se com `L.polyline` no mesmo mapa do `/home` e fecha com o botão de voltar; não abre o picker.

## Partida Compartilhada — avisos de aprovação e de partida cheia (2026-10-30)
Antes, aprovar um lugar não avisava ninguém: a passageira só descobria por polling, e quem ficava na fila
nunca sabia que a partida tinha enchido.

- **`POST /api/v1/shared/departures/:id/approve`** grava uma linha em `notifications`
  (`type='shared_approved'`, título `🦋 Lugar aprovado!`) para a passageira aprovada e faz `notifPoke()`
  no `NotifHub` dela (frame `{t:'notif'}` no WS `/notifications/live`).
- **Quando a aprovação enche a partida** (`status='full'`), todas as reservas ainda `pending`/na fila recebem
  `type='shared_full'` com o título exato **"Todos os lugares foram preenchidos"**. A passageira que acabou de
  ser aprovada é **excluída** (não lhe faz sentido avisar que encheu).
- Os dois avisos levam `data = departureId`, para o toque abrir a partida certa.
- Prova (produção, contas de teste `ZZ…` apagadas no fim, script `%TEMP%\opencode\t-shared-notifs.mjs`):
  **12/12** — criar partida, A e B na fila, nenhum aviso antes, `/payment` com coordenadas, aprovar A,
  partida `full`, A recebe `shared_approved`, B recebe `shared_full` com o título exato, A não recebe
  `shared_full`.
- **Ordem importa no teste:** `/payment` só responde com reserva **pendente** — chamá-lo depois de aprovar
  devolve 404 `Você não tem reserva nesta partida.` (foi a única falha do 1.º ensaio, 11/12 → 12/12).

## Categorias com preço por pessoa (2026-10-30)
O preço das categorias deixou de ser só um multiplicador de distância: cada categoria tem **preço por pessoa**.

- **Migração `0020_category_prices.sql`** acrescenta `ride_categories."basePrice"` e preenche:
  `ECONOMY 1500`, `COMFORT 2500`, `PREMIUM 3500` (Kz). Aplicada em produção **e** em staging.
- `getCategories()` devolve `basePrice` nos três modos (`app`/`admin`/`all`); `POST`/`PUT` de
  `/api/v1/admin/categories` aceitam e devolvem `basePrice`.
- **`basePrice = 0` significa "preço por distância"** — é o fallback antigo, não apagar.
- **A app só mostra preço depois de haver destino.** Antes disso o cartão diz só `Económico`/`Conforto`/`Família`;
  depois mostra `Económico · 1500 Kz / pessoa`, `Conforto · 2500 Kz`, `Família · 3500 Kz` e, no total,
  `Preço por pessoa (Família): 3500 Kz · total 14 000 Kz` (formato `toLocaleString('pt-PT')`).
- **`Kids!` foi apagada (`deleted=1`)** e **`PREMIUM` voltou como "Família"** (`active=1, sort=3`) — é a
  categoria de 4 lugares; não reintroduzir `Kids!` sem o dono pedir.
- **`webapp/admin.html`** tem a coluna **"Preço/pessoa"** para editar os valores.

## App Store — build e submissão (2026-10-29)
**O build iOS não é EAS.** É GitHub Actions (`.github/workflows/build-ios.yml`): `expo prebuild` + Xcode +
fastlane (`mobile/fastlane/Fastfile`, lane `release`), que faz cert/sigh/build e `upload_to_testflight`.
O fastlane **só envia para o TestFlight** — a submissão para revisão é feita à parte, pela API do ASC.

- **Build number = `github.run_number`** (`BUILD_NUMBER`). A marketing version vem de `mobile/app.json`
  (`expo.version`). **Subir a versão no `app.json` já lança um build** — o workflow dispara em push que toque
  `.github/workflows/build-ios.yml`, `mobile/fastlane/**` ou `mobile/app.json` (ou `workflow_dispatch`).
- **`EXPO_PUBLIC_API_URL` do workflow tem de ser a rerere.** Esteve em
  `ladiesgo-api.ladiesgo-angola.workers.dev` (conta legada) até `f64847d`; um build a partir dali punha o URL
  antigo em `src/services/api.ts` (GPS em fundo). O `App.tsx` já tinha o URL da rerere escrito à mão, mas
  não contar com isso.
- **`concurrency: ios-build` (`ab22452`)** — dois builds em paralelo correm `sigh(force: true)` sobre o mesmo
  App ID e um **revoga o perfil de provisionamento** do outro. Só protege runs futuros: runs que já estavam
  na fila com o ficheiro antigo continuam a correr.
- **Vários builds com a mesma marketing version:** ficam todos `VALID` no ASC. Ligar à versão **o número
  certo** — em 2026-10-29 o run #14 saiu com o URL legado e o #15 com o correcto.
- **`gh` CLI não existe nesta máquina.** Os runs vêem-se pela web ou pela API pública do GitHub
  (`/repos/geraldochiquemba2/LADIESGO/actions/runs`); **cancelar** um run exige token.

Estado das versões iOS:
| Versão | Build | Estado |
|---|---|---|
| 1.0 | #18 | `READY_FOR_SALE` |
| 1.0.1 | #11 | `READY_FOR_SALE` (libertada em 2026-10-29; push ainda quebrado — build sem o plugin) |
| 1.0.2 | #15 | criada `e20b7ec7-3d6d-415b-bfa5-41f0f227c166`, release **MANUAL** |

- **Uma versão aprovada tranca o build**: não se troca o build da 1.0.1 depois de aprovada, é preciso versão
  nova. E **enquanto uma versão está `PENDING_DEVELOPER_RELEASE` não se pode criar outra** — HTTP **409**
  `ENTITY_ERROR.RELATIONSHIP.INVALID` "You cannot create a new version of the App in the current state".
  Liberta-se primeiro com `POST /v1/appStoreVersionReleaseRequests`.
- **Criar versão pela API copia sozinho** as localizações **e** os conjuntos de screenshots da anterior.
  Só falta preencher `whatsNew` e ligar o build.
- Submissão: `POST /v1/reviewSubmissions` → `POST /v1/reviewSubmissionItems` → `PATCH submitted:true`
  (script `%TEMP%\opencode\asc-submit-102.mjs`, que exige o número do build quando há mais de um candidato).
- A chave ASC (`6CQX832WVJ`, issuer `92705617-…`) foi colada no chat a 2026-10-29: **está comprometida**.
  Revogar e criar outra com papel **App Manager**, actualizando `mobile/eas.json` (linhas 42–44).

## Quota / pedidos
- Cada pedido HTTP ao Worker conta 1; cada **ligação** WebSocket conta 1, mas as **mensagens** WebSocket **não** contam como pedidos do Worker (contam no Durable Object a 20:1).
- O webapp usa **WebSocket primeiro** com polling de fallback (`pollTrip` 8s), por isso o uso real fica bem abaixo da quota.

## Limites do plano Free (decorar)
- **Workers:** 100.000 pedidos/dia por **conta** (reset 00:00 UTC). Estourar → **erro 1027 / HTTP 429**; a conta inteira fica fora até reiniciar.
- **D1:** 100.000 linhas **escritas**/dia e 5.000.000 lidas/dia por **conta** (reset 00:00 UTC). Estourar as escritas → **erro 7500**: TODA a escrita devolve **500** (criar utilizador, ficar online, pedidos, chamadas) até reiniciar; a **leitura continua a funcionar**. É por conta, não por base de dados — criar outra D1 **não** contorna.
- **Durable Objects:** 100.000 pedidos/dia, 13.000 GB-s de duração/dia, 5 M leituras e 100.000 escritas de storage/dia.

## Capacidade a 50.000 viagens/dia — auditoria (2026-10-30)
Relatório completo: **`AUDITORIA-50K-VIAGENS.md`**. Veredicto: **no Free o sistema aguenta ≈330 viagens/dia**,
não 50.000 (~150× menos). O que trava primeiro são os **pedidos ao Worker** e os **pedidos às DO** (~300 por
viagem). No plano pago ($5/mês) 50.000/dia é viável: **≈$377/mês** hoje, **≈$126/mês** com as correções.

**Medido (não estimado) com a GraphQL Analytics API:**

| Métrica | 24 h | 48 h |
|---|---|---|
| Pedidos Worker | 38.513 | — |
| D1 lidas / escritas | 3.556.334 (71% do teto) / 5.401 | — |
| DO objetos / pedidos / duração | — | 140 / 6.684 / **9,63 GB-s** |

- **A maior parte das leituras da D1 NÃO vem das viagens — vem da pesquisa de lugares.** Com ~20 viagens/dia
  já se gastam 71% das 5 M leituras. A causa é o **3.º passo de `localPlaces()`**: quando FTS5 e o GLOB de
  prefixo devolvem <8 linhas, cai num `LIKE '%termo%'` **sem índice** que lê as **23.332 linhas de `places`**
  (horas de pico: 546 queries → 1,37 M linhas = 2.513 linhas/query). Cada prefixo de autocomplete é uma chave
  de cache nova (`places:v13:<q>:<lat,lng>`), por isso escrever uma palavra pode gerar várias varreduras.
- **Correção da estimativa inicial:** a duração real é **0,07 GB-s por viagem de teste** (1–3 GB-s modelado
  para 15 min), **não 232 GB-s** — a Hibernation API é usada e o objeto só corre enquanto executa
  (0,76 ms CPU/pedido). O que cresce mal é o **`geo:global`**: 15.200 linhas de storage lidas em 48 h com
  apenas 2 motoristas.
- **`requireAuth` não faz nenhuma query** (`index.ts:243-254`, só valida o JWT) — "remover o SELECT de auth"
  vale **0%**. As leituras vêm dos endpoints.
- **P0 (protege a quota atual):** matar o `LIKE '%…%'` de `places` (−96% leituras), throttle no emissor de
  `geoPushToTrip`, backoff exponencial nos 5 WS (hoje 3 s fixos → 1.200 ligações/hora por socket em falha),
  `trip_points` 60 s → 180 s, `GET /drivers/wallet/status` (61 → 1 linha). **Aplicado em 2026-10-30** (excepto
  o `wallet/status`) — ver "Cortes de custo no plano Free".
- **P1/P2:** tirar o `AVG(score) JOIN` do `webDriverInfo`, `refreshStatus` 15 → 60 s, `/api/v1/boot`
  agregado, shard do `DriverGeo` por geohash, `NotifHub` por shard, `tripId` no payload do GPS.
- Scripts de medição: `%TEMP%\opencode\cf-quota.mjs` (hoje/24 h), `cf-d1-hourly.mjs` (hora a hora),
  `cf-do-real2.mjs` (DO por tipo de objeto). **O token OAuth do GraphQL expira**: se devolver
  `{"code":10000,"message":"Authentication error"}`, correr `npx wrangler@4.151.1 whoami` para o renovar
  (nunca `wrangler logout`). O limitador ("budget depleted") precisa de ~5 min.

## Cortes de custo no plano Free — aplicados (2026-10-30)
Objectivo do dono: **mais viagens/dia sem sair do Free**. Não se muda de plano; corta-se o custo por viagem.
O alvo nº1 era a pesquisa de lugares: **`3.556.334 ÷ 23.332 ≈ 152` varreduras completas de `places` por dia
(≈98% de todas as leituras da D1)**. Tudo abaixo está **em produção** (API `6849d3f6…`, Pages `c33e5506…`,
Worker estático `6bcd9f6f…`).

### 1. `localPlaces()` — FTS5 e mais nada (`cloudflare/api-worker/src/index.ts`)
- O 3.º passo `norm LIKE '%termo%'` (sem índice) foi **apagado**. A cascata é agora:
  **FTS5 (`places_fts MATCH`, `ORDER BY rank`, subquery interna `LIMIT 800`) → GLOB de prefixo (só se o FTS der 0)
  → Photon/Nominatim (só se 1) e 2) derem 0)**.
- O bug de raiz não era o `LIKE` existir: era disparar **sempre que o FTS devolvia menos de 8 linhas** — ou seja
  exactamente nas pesquisas precisas (`isptec`, `momo`, `bloco d27`). O FTS já acertava; o `LIKE` escrevia por cima.
- **Perda aceite:** deixou de haver correspondência a meio da palavra (`sptec` → `isptec`); nesses casos cai no
  Photon/Nominatim, que acerta em Luanda.
- **`rows_read` medido no SQL novo** (D1 de produção, `--json` → `meta.rows_read`): `isptec` **3**, `bloco d27` **3**,
  `patricio` **9**, `momo` **18**, `shoprite` **39**, `banco bic` **183**, `agostinho neto` **237**, `kilamba` **2.399**
  — contra **23.332** em todos antes (**−98%**; só `kilamba` é caro porque devolve 400 blocos).
- **Cache:** a chave subiu **`places:v13` → `places:v14`** (com `fold(q).trim()`). Corrigir a D1 não chega —
  sem subir a chave os datacenters continuam a servir a resposta antiga durante 7 dias. **Ao mexer em `places`,
  subir sempre esta chave.**
- Verificado em produção (8/8, 200, primeiro resultado certo): `isptec` → ISPTEC @ -8.9242,13.1830 (Talatona, 1.799 ms),
  `kilamba` n=15, `momo` n=3, `bloco d27` → Bloco D27, `agostinho neto` n=15, `banco bic` n=7, `patricio` n=2,
  `shoprite` n=4.

### 2. Servidor (`cloudflare/api-worker/src/index.ts`)
- **`persistPoint` 60 s → 180 s** (`trip_points`): o rasto é histórico, não desenha o mapa ao vivo. Uma viagem de
  15 min passa de ~15 para ~5 pontos. Cada `INSERT` escreve também os índices.
- **`geoPushToTrip` com throttle no emissor** (`GEO_PUSH_MIN_MS = 9.000`, `geoPushAt` por isolate, limpo a >2.000
  entradas): antes chamava o DO `trip:<id>` em **cada** fix de GPS (1/2 s) para o recetor os deitar fora a menos de
  10 s. Agora só chama com fix novo (>9 s < 10 s do recetor, por isso nada é descartado a jusante). Corta ~80% dos
  pedidos ao DO e as leituras de `activeTripForDriver()` (D1).
- **`calls:` keep-alive:** o cliente passou a mandar a **string crua `'ping'`** e a aceitar `'pong'` cru, servidos
  pelo `setWebSocketAutoResponse()` do DO — **sem acordar o objeto** (custo 0 de duração). O ramo `{t:'ping'}`
  continua no servidor como fallback. O `setWebSocketAutoResponse` só aceita **um** par, daí a string literal.

### 3. Cliente (`webapp/ladiesgo-home.html`)
- **`lgBk`/`lgBkOk`/`lgBkReady`** — backoff partilhado das 5 reconexões WS (`req`, `nearby`, `notif`, `geo`,
  `calls`): exponencial **1,7×**, jitter ±25%, teto **60 s** (`calls` 20 s), nunca < **15 s** com
  `navigator.onLine === false`; `lgBkOk` no `onopen` e um listener `online` que limpa todas as chaves e reconecta.
  Antes era **3 s fixos**: em falha de rede eram **1.200 ligações/hora por socket**, cada uma 1 pedido ao Worker.
- **`lgPlaceFetch(q, ll)`** — cache de pesquisa no cliente: **10 min** para resultados com linhas, **60 s** para
  vazio; chave `q.toLowerCase()|round(lat*100),round(lng*100)`. Usada pelo `#q` e pelo `#oq`; debounce 250 → **400 ms**.
  Provado no browser: 1.ª chamada 200 ms, 2.ª **0 ms** com o **mesmo objecto** (`same_obj:true`).
- **`refreshProfile(force)`** — TTL **60 s → 900 s** (15 min); o clique no menu chama `refreshProfile(true)`.
- **`walletData()`** — cache de 60 s + dedupe de pedido em curso (`__walletC`/`__walletP`).
- **`paintWBadge`** 120 s → **600 s**; **`sharedNotifPoll`** 30 s → **60 s**.

### 4. Segunda vaga (2026-10-30, por deployar) — leituras por viagem
Relatório: `AUDITORIA-FREE-PLANO-2026-10-30.md`. Tudo abaixo está **editado e validado**
(`wrangler deploy --dry-run` 324,29 KiB; 22/22 blocos `<script>` do `/home` passam `vm.Script`) mas **ainda
não foi publicado** — falta o deploy da API e do Pages/Worker estático.

- **`GET /api/v1/trips/:id` passou a ler tudo numa query.** Antes o `?view=web` fazia 4 idas à D1
  (viagem + `webDriverInfo` + `users` da passageira + `catMaps`) e o polling mobile fazia 2. Agora é 1 query com
  `LEFT JOIN` sobre chaves primárias (1 linha por JOIN), duas variantes escolhidas por `view`:
  **web 4 linhas** (era 2+2+1) e **mobile 3 linhas** (era 2+1). Medido em produção com `meta.rows_read`
  (viagem `f01dbab4…`): web `2+2+1+97 → 4`, mobile `2+1 → 3`. O caminho mobile **não** lê `rating`/carro/`users`
  da motorista — só posição + dados da passageira.
- **`webDriverInfo(c, sql, driverId, pre)`** — com `pre` (a linha do JOIN) já não faz query nenhuma; sem ela
  mantém o comportamento antigo (usado noutros sítios).
- **Nota da motorista em cache de 120 s** (`drvRatingCache`, `DRV_RATING_TTL_MS`): o
  `AVG(ratings.score) JOIN trips` lê **97 linhas** e o valor só muda quando alguém avalia. O `POST /ratings`
  invalida a entrada (`drvRatingCache.delete`), por isso a nota nova aparece já. **Não** se usa `drivers.rating`
  directamente: essa coluna nunca é atualizada pelo `POST /ratings`.
- **`GET /api/v1/drivers/wallet/status`** (novo) devolve só `{blocked}` — **1 linha**. O `loadDrvBlocked` do
  webapp usava `/drivers/wallet` (2 queries, ~31 linhas, a cada 30 s) só para saber o bloqueio; mantém fallback
  para `/drivers/wallet` se vir 404 (builds antigos da app).
- **`PUSH_STATUS_TTL_MS` 15 s → 60 s** e o frame `state` do `TripPush` passou a `refreshStatus(false)` — cada
  `state` forçava uma leitura à D1 mesmo com o estado fresco. O push de transição continua imediato.
- **Cliente — o polling só é rede de segurança quando o WebSocket está aberto:** `liveSkipPoll('pt'|'pm'|'pi', …)`
  passa a levar a janela: **60 s** com o socket aberto, **8 s** (`pt`)/**30 s** (`pm`/`pi`) sem socket. As duas
  ocorrências do antigo `'pt8'` foram unificadas na chave `'pt'` (antes o `tripTimer` e o `pollTrip` de arranque
  usavam chaves diferentes e pollavam em paralelo).
- **`softResync`** usa as mesmas janelas dinâmicas e só chama `pollCars()` com a página visível.
- **`__callLoop` ocioso com viagem: 2 000 → 10 000 ms** (o WS `calls` já cobre o sinal).

### O que foi medido e NÃO se fez (para não repetir a análise)
- **Migração `0021` (índices parciais + `DROP INDEX trips_pending_idx`): abandonada.** Contagens de produção:
  `trips`=**121**, `notifications`=**315**, `drivers`=**1**, `ratings`=**24**, `trip_points`=**1.290**,
  `chat_messages`=**14**, `call_signals`=**425**, `users`=**26**. Só `places` (23.332) é grande. Índices extra
  só acrescentam escritas, sem ganho de leitura.
- **Reescrever o `DriverGeo` para 1 snapshot:** uso medido = **0,16%** do orçamento de leituras de storage. Precipitado.
- **Cron `* * * * *` → `*/5`:** 1.440 pedidos/dia = ~1,4% da quota, e a precisão ao minuto é necessária para as
  notificações agendadas.
- **Sharding do `NotifHub` / correção do `notifPokeMany` (>45 destinatários rebenta o limite de subrequests):**
  é um bug real, mas com 26 utilizadores não acontece. **Documentado, não corrigido.**
- **Workers Cache e Cache Rules para `/api/*`:** o Worker corre **à frente** do cache da zona, logo poupa **0**
  pedidos; `caches.default` com HIT poupa leituras da D1/subrequests, não pedidos. O Workers Cache cobra os HITs
  e os assets estáticos; os assets do Pages/Worker estático são grátis e ilimitados.
- **Contas novas para fugir ao limite:** viola os ToS. **Tabela FTS trigram:** risco de quota de escrita.

## Incidentes de quota (2026-10-17) — NAO REPETIR
Dois limites foram esgotados no mesmo dia, ambos pela via do assistente (nao por uso real).
Prova: os logs em `~/.wrangler/logs` registam `"agent":"opencode"`, e o historico do PowerShell
so tem comandos `opencode`.
- **Conta antiga — 100.000 pedidos/dia (erro 1027):** causado pelos testes de carga
  (`loadtest/firetest.mjs`, `loadtest/ws-storm.mjs`, `loadtest/k6/ladiesgo.js`), ~2000 contas de teste.
- **Outra conta — 100.000 escritas/dia na D1 (erro 7500):** causado por **reimportar a BD
  inteira repetidamente** durante uma migração (cada import completo reinsere os 23.345 registos de `places`).
- **Conta `rerere…` — 100.000 escritas/dia na D1 (erro 7500), 2026-10-28 21:57 UTC:** a própria migração
  da BD para a conta nova. Medição e causa exata em "Custo real de um import completo" abaixo.

Regras para nao repetir:
- **Nunca** correr `loadtest/` contra producao nem contra a conta que serve a API. Usar staging/2a conta.
- **Nunca** reimportar a BD toda em ciclo; importar so o que mudou. **Um import completo custa ~117.000 linhas
  escritas** (medido em 2026-10-28, não 23k) — sozinho estoura o teto diário de 100.000. Ver abaixo.
- Preferir `wrangler d1 migrations apply` (incremental) a reimportar o dump completo.

### Custo real de um import completo (medido 2026-10-28)
`wrangler d1 execute --remote --file=…` usa o endpoint `/import` da D1, e o "rows written" conta
**linhas + entradas de índice** — por isso é ~5× maior do que o número de linhas das tabelas.

| O que correu (hora 21:00Z, a hora da migração) | rows written |
|---|---|
| 13 imports pequenos, tabela a tabela (21:55:30–21:57:12) | ~7.078 |
| **1 import completo — 73 queries, 1,22 s** (21:57:19) | **116.798** |
| tráfego normal da app no resto da hora | ~175 |
| **total da hora** | **124.051 = 124% do teto** |

- O import grande leu 46.835 linhas e deu 71.648 `changes`. `places` tem 23.345 linhas, mas o total escrito
  é ~117k porque cada INSERT também escreve os índices.
- Antes dele houve **5 tentativas falhadas** (21:49–21:53, sem resumo de execução) — as retentativas somam.
- Depois das 21:57 UTC o dia ficou sem escritas: 22:00Z teve 41 linhas e 23:00Z **zero**; as leituras
  continuaram (73k nessa hora). A app ficou ~2 h só de leitura até ao reset das 00:00 UTC.
- **Um import completo = o dia inteiro.** Nunca repetir o import "para ver se passou"; ver a quota antes.

### Ver a quota da conta (antes de qualquer import)
O wrangler não tem comando de quota; usar a GraphQL Analytics API com o token OAuth do wrangler
(`~/.wrangler/config/default.toml` → `oauth_token`) e o `accountTag` `016a8f9ed58a5cd10e9be697944905f0`:
- **Workers:** `workersInvocationsAdaptive { sum { requests errors subrequests } dimensions { scriptName } }`
- **D1:** `d1AnalyticsAdaptiveGroups { sum { rowsRead rowsWritten readQueries writeQueries } dimensions { datetime databaseId } }`

Script pronto: `%TEMP%\opencode\cf-quota.mjs` (hoje/24h por script e por BD) e `cf-d1-hourly.mjs` (hora a hora).
**Nota:** a API de *billing/subscriptions* devolve **403** com este token (sem scope de billing) — não dá para
confirmar o plano por API, só pelo dashboard.

## Tokens de login (cuidado com o use-account.ps1)
**Conta oficial:** `rerere…` — token em `~/.wrangler/config/default.rerere670account.toml`.
`use-account.ps1 old/new` é **legado** (contas antiga/nova); não usar para Pages.
`use-account.ps1` copia `default.<conta>account.toml` -> `default.toml`, mas o wrangler **renova e
RODA** o token dentro de `default.toml` e NAO o escreve de volta no ficheiro da conta. Logo, trocar
de conta depois de um refresh restaura um token antigo e o login passa a dar
`Failed to fetch auth token: 400 Bad Request` / `Not logged in` (aconteceu a 2026-10-17).
Boas praticas: antes de trocar de conta copiar `default.toml` -> `default.<conta>account.toml`;
em caso de duvida voltar a correr `wrangler login` (NAO `wrangler logout`).

## Estado de produção (2026-10-28)
- **Tudo na conta `rerere…`.**
- **Site:** `https://ladiesgo.pages.dev` (Pages) e `https://ladiesgo.rererererererere670.workers.dev` (Worker estático).
- **API:** `https://ladiesgo-api.rererererererere670.workers.dev`.
- **Base de dados:** D1 `ladiesgo` (`fab720b7-d96e-423f-8454-bcc9942f6d50`) na conta `rerere…`, com os dados migrados.
- **Mobile:** carrega `https://ladiesgo.pages.dev/ladiesgo` e usa a API acima.

## Mobile (2026-10-29) — casca WebView
- Entrada `mobile/index.ts` → `mobile/App.tsx` (WebView com `SITE_URL = https://ladiesgo.pages.dev/ladiesgo?v=…`).
- O bundle tem **7 módulos**. Todo o resto de `mobile/src/` é **código órfão**: não é importado, não é compilado, não corre.

| Corre (no bundle) | Órfão (não corre) |
|---|---|
| `mobile/index.ts`, `mobile/App.tsx` | `mobile/src/screens/**`, `mobile/src/navigation/**`, `mobile/src/components/**` |
| `mobile/assets/icon.png` | `mobile/src/store/**`, `mobile/src/services/socket.ts` |
| `mobile/src/services/api.ts`, `bgLocation.ts`, `driverBgLocation.ts`, `driverGeoSocket.ts` | restantes `mobile/src/services/*` |

- Fluxo real: `/ladiesgo` (landing, ~22 KB) → `/app` (login) → `/home` (mapa/chat, ~398 KB). O `SITE_URL` abre **só** o `/ladiesgo`.
- Mudar `App.tsx` (incluindo o `?v=` do `SITE_URL`, que quebra a cache da WebView) exige **build EAS + versão nova na loja**; mudar HTML de `webapp/` não.
- Detalhes da casca nativa: ver `mobile/AGENTS.md`.

## Fase 1 — histórico (2026-10-17; NÃO usar para deploy)
- Notas da conta `isabelcanjamba62` (em espera/desativada). **Não publicar nessa conta.**
- **Rate limiting HTTP:** 100 req/min por IP em `/api/*` (sliding window, em memória por isolate). `/ping`, `/api/v1/health` e `/api/v1/auth/guest` estão isentos.
- **Backdoor admin removido:** `999999999` / `1234567890` não entra mais como ADMIN. Qualquer admin deve existir na BD com `role='ADMIN'` e autenticar normalmente.
  - **CORRECÇÃO (verificado 2026-10-29): isto NÃO é verdade em produção.** `POST /api/v1/auth/login` ainda tem o
    ramo de backdoor (em `src/index.ts`, ~linha 301): com `999999999` + `1234567890` (aceita também `+244…`/`244…`)
    procura/cria o utilizador e força `role = 'ADMIN'`. **Fica assim por decisão do dono (2026-10-29)** — é um
    risco aceite e consciente, para ter acesso de emergência. Não "corrigir" sem ele pedir; quem souber estes dois
    valores tem controlo total da app. O resto desta nota descreve o estado pretendido, não o real.
- **Variáveis:** `RATE_LIMIT_MAX=100`, `RATE_LIMIT_WINDOW_MS=60000` no `wrangler.toml` do Worker/API.
- **Smoke test:** `GET /api/v1/health` deve retornar 200; `POST /api/v1/auth/login` com `999999999` deve retornar 401 (backdoor removido).
