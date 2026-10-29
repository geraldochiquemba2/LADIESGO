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

**Pendente (só o dono consegue resolver):**
- **iOS:** juntar `"expo-notifications"` a `plugins` no `mobile/app.json` e **reconstruir** (build nativo novo —
  mudar `App.tsx`/`app.json` não chega com deploy de HTML). A App ID `com.ladiesgo.app` tem de ter a capability
  **Push Notifications** ativa no portal Apple, senão o `sigh(force: true)` do Fastfile falha.
- **Android:** obter o `google-services.json` do projeto Firebase `com.ladiesgo.app`, guardá-lo em
  `mobile/` (fora do git) e apontar `android.googleServicesFile` no `app.json`.
- Só depois de um build com token real é que os pushes acima chegam ao telemóvel. Sem token na BD, o servidor
  não tem para onde enviar (a motorista real não tem `fcmToken`).

## Quota / pedidos
- Cada pedido HTTP ao Worker conta 1; cada **ligação** WebSocket conta 1, mas as **mensagens** WebSocket **não** contam como pedidos do Worker (contam no Durable Object a 20:1).
- O webapp usa **WebSocket primeiro** com polling de fallback (`pollTrip` 8s), por isso o uso real fica bem abaixo da quota.

## Limites do plano Free (decorar)
- **Workers:** 100.000 pedidos/dia por **conta** (reset 00:00 UTC). Estourar → **erro 1027 / HTTP 429**; a conta inteira fica fora até reiniciar.
- **D1:** 100.000 linhas **escritas**/dia e 5.000.000 lidas/dia por **conta** (reset 00:00 UTC). Estourar as escritas → **erro 7500**: TODA a escrita devolve **500** (criar utilizador, ficar online, pedidos, chamadas) até reiniciar; a **leitura continua a funcionar**. É por conta, não por base de dados — criar outra D1 **não** contorna.

## Incidentes de quota (2026-10-17) — NAO REPETIR
Dois limites foram esgotados no mesmo dia, ambos pela via do assistente (nao por uso real).
Prova: os logs em `~/.wrangler/logs` registam `"agent":"opencode"`, e o historico do PowerShell
so tem comandos `opencode`.
- **Conta antiga — 100.000 pedidos/dia (erro 1027):** causado pelos testes de carga
  (`loadtest/firetest.mjs`, `loadtest/ws-storm.mjs`, `loadtest/k6/ladiesgo.js`), ~2000 contas de teste.
- **Outra conta — 100.000 escritas/dia na D1 (erro 7500):** causado por **reimportar a BD
  inteira repetidamente** durante uma migração (cada import completo reinsere os 23.345 registos de `places`).

Regras para nao repetir:
- **Nunca** correr `loadtest/` contra producao nem contra a conta que serve a API. Usar staging/2a conta.
- **Nunca** reimportar a BD toda em ciclo; importar so o que mudou. Um import completo ~23k escritas e o teto diario e 100k.
- Preferir `wrangler d1 migrations apply` (incremental) a reimportar o dump completo.

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
- **Variáveis:** `RATE_LIMIT_MAX=100`, `RATE_LIMIT_WINDOW_MS=60000` no `wrangler.toml` do Worker/API.
- **Smoke test:** `GET /api/v1/health` deve retornar 200; `POST /api/v1/auth/login` com `999999999` deve retornar 401 (backdoor removido).
