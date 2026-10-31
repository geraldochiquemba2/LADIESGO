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
- **Cancelamento pelo sistema (guarda, 2026-10-30):** o `by` chega como `''` (o DO normaliza `'system'`).
  A condição passou de `if(_cbBy&&!_cbActor)` para `if(!_cbActor)` e o texto é
  `_cbBy ? 'Corrida cancelada pela motorista/passageira' : 'Viagem cancelada'` — antes o `by:''` caía
  fora do bloco e obrigava a um `pollTrip()` para mostrar o banner (1 pedido extra e o socket ficava aberto
  até à resposta). O motivo continua no banner (`Motivo: …`).
  Publicado em 2026-10-30: Pages `9dd37801.ladiesgo.pages.dev` e Worker estático `20430986-24cf-414c-9c07-6b2e2e0f9893`;
  `https://ladiesgo.pages.dev/ladiesgo-home.html` e `https://ladiesgo.rerer…workers.dev/ladiesgo-home.html` servem
  o ficheiro local byte a byte (sha256 `421c3922…`, 439 176 bytes).
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
- Cada pedido HTTP ao Worker conta 1; cada **ligação** WebSocket conta 1, mas as **mensagens** WebSocket **não** contam como pedidos do Worker (contam no Durable Object: **1:1 na métrica e 20:1 na facturação** — medido a 2026-10-30, ver "13. Décima vaga").
- O webapp usa **WebSocket primeiro** com polling de fallback (`pollTrip` 8s), por isso o uso real fica bem abaixo da quota.

## Limites do plano Free (decorar)
- **Workers:** 100.000 pedidos/dia por **conta** (reset 00:00 UTC). Estourar → **erro 1027 / HTTP 429**; a conta inteira fica fora até reiniciar.
- **D1:** 100.000 linhas **escritas**/dia e 5.000.000 lidas/dia por **conta** (reset 00:00 UTC). Estourar as escritas → **erro 7500**: TODA a escrita devolve **500** (criar utilizador, ficar online, pedidos, chamadas) até reiniciar; a **leitura continua a funcionar**. É por conta, não por base de dados — criar outra D1 **não** contorna.
- **Durable Objects:** 100.000 pedidos/dia, 13.000 GB-s de duração/dia, 5 M leituras e 100.000 escritas de storage/dia.

## Capacidade a 50.000 viagens/dia — auditoria (2026-10-30)
Relatório completo: **`AUDITORIA-50K-VIAGENS.md`**. Veredicto original (antes dos cortes): **≈330 viagens/dia**
no Free, não 50.000. O que trava primeiro são os **pedidos ao Worker** e os **pedidos às DO**.
**Depois dos cortes das vagas 1–17 o valor medido é ≈3 571 viagens/dia** (ver "12. Nona vaga",
"14. Décima primeira vaga", "16. Décima terceira vaga" e "17. Décima quarta vaga").
No plano pago ($5/mês) 50.000/dia é viável: **≈$377/mês** hoje, **≈$126/mês** com as correções.

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
  Desde 2026-10-31 é o **único** caminho para `/api/places/search` (ver "Décima segunda vaga"): os 4 sítios que
  ainda chamavam o `fetch` directo passaram a usá-la e o `__plC` poda-se quando passa de 150 chaves.
- **`refreshProfile(force)`** — TTL **60 s → 900 s** (15 min); o clique no menu chama `refreshProfile(true)`.
- **`walletData()`** — cache de 60 s + dedupe de pedido em curso (`__walletC`/`__walletP`).
- **`paintWBadge`** 120 s → **600 s**; **`sharedNotifPoll`** 30 s → **60 s**.

### 4. Custo real por operação — medido (2026-10-30)
Medição em produção com `meta.rows_read` (só `SELECT`) e em **staging** com `meta.rows_written`
(viagem/post/tudo de teste apagado no fim). Serve para responder "o que gasta a D1" sem estimar.

**Leituras por pedido** (`rows_read` real, ID real de produção):
| Operação | Linhas lidas |
|---|---|
| `PUT /drivers/location` (cada fix de GPS) | **1** (`walletBlocked`) — e **0 escritas** |
| `POST /drivers/position` (ping) | 1 (`walletBlocked`) + **1 escrita só na transição offline→online** |
| `GET /trips/incoming` | **3** (gate do motorista 2 + lista 1) |
| `GET /trips/:id` web / mobile | **4** / **3** (+97 do `AVG` só 1×/120 s) |
| `GET /trips/active` passageira / motorista | **5** / **6** — **antes 78 / 65** (lia todas as viagens dela: 76); ver "Terceira vaga" |
| `GET /trips/history` | **153** (30 resultados) |
| `GET /ratings/pending` | **83** |
| `GET /notifications` (lista+banner+unread) | **14** (13+1+**0**) |
| `GET /notifications/unread-count` (60 s) | **0** |
| `GET /drivers/nearby` (15 s) | **0–2** |
| `GET /turn/ice` | **1** (cache 60 s no isolate) |
| `GET /premium/reservations/mine` | **4** (3 + `premiumExpire` 1) |
| `GET /api/places/search` (FTS) | **3** (`isptec`) a **2 399** (`kilamba`) |
| `GET /api/places/search` **antes** (o `LIKE '%…%'`) | **23 332** em cada cache miss |
| `GET /api/zone` | **0** (Nominatim + cache, não toca na D1) |

Baseline de tráfego real (30/10 07:00Z, 98 pedidos): **741 linhas lidas = 7,6 linhas/pedido**. Ou seja,
o uso normal da app gasta **~500–1 200 linhas/hora**; 5 M/dia daria para ~100× mais tráfego.

**Escritas por operação** (`rows_written` real, medido em `ladiesgo-staging`):
| Operação | Linhas escritas |
|---|---|
| `INSERT` viagem | **5** |
| `UPDATE` status → `ACCEPTED` | **3** |
| `UPDATE` status → `IN_PROGRESS` / `COMPLETED` | **2** / **2** |
| `INSERT` `trip_points` (1 ponto, cada **180 s**) | **4** |
| `INSERT` notificação | **4** |
| `UPDATE` `isRead` (marcar lida) | **1** |
| `INSERT` avaliação | **4** |
| `INSERT` mensagem de chat | **3** |
| `INSERT` `wallet_tx` | **3** |
| `INSERT` `turn_credentials` (1/dia) | **3** |
| GPS (position/location) | **0** |

Uma viagem completa ≈ **12** (ciclo) + **20** (5 pontos) + **8** (2 avisos) + **4** (avaliação) + **3** (chat)
≈ **45–55 linhas escritas**. Com o teto de 100 000 → **~2 000 viagens/dia só pelas escritas**, ou seja as
escritas **não** são o gargalo do tráfego real (30/10: 400 linhas = 0,4 %).

**Porque é que um import "não deixa escrever":** cada `INSERT` escreve a linha **mais uma entrada por índice**
(`trips` tem 6 índices → 5–7 entradas por linha). Um import completo das 73 tabelas/queries custou
**116 798 linhas escritas** (medido a 28/10), sozinho acima das 100 000/dia → **erro 7500**: todas as escritas
devolvem 500 até às 00:00 UTC (as leituras continuam). Foi isso, e não a app, que bloqueou as escritas.
`budget.ts` conta o `rows_written` real de cada statement (`db.ts` linha 80) e o `writeGuard()` corta os
endpoints de **escrita opcional** com **503 + `Retry-After`** a partir de **90 000** (`BLOCK_RATIO` 0.9).

### 5. Segunda vaga (2026-10-30) — leituras por viagem
Relatório: `AUDITORIA-FREE-PLANO-2026-10-30.md`. **Em produção** (API `001d7f87`, Pages `09c545c0`,
Worker estático `39c8b901`).

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
- **Provado em produção (2026-10-30, só leituras):** `?view=web` devolve 200 com o contrato intacto
  (`driver.rating` = **4,4**, valor real do `AVG` — antes do cache a query já corria, só custava 97 linhas);
  mobile 200 com `passengerName`/`passengerPhone`/`passengerPhoto` e **zero** alias vazados
  (`dName`/`dRating`/`pName` ausentes); `/drivers/wallet/status` 200 `{"blocked":false}`; `/drivers/wallet`
  continua 200. `ladiesgo-home.html` servido pelo Pages **e** pelo Worker estático com o mesmo sha256 do ficheiro
  local (437 987 bytes), sem vestígios de `'pt8'`.
- **Medição de leituras:** `meta.rows_read` da D1 de produção, por statement e com `--remote` (só `SELECT`).

### 6. Terceira vaga (2026-10-30) — `INDEXED BY trips_status_idx` (78 → 5 linhas)

**O problema.** `GET /api/v1/trips/active` (chamado no arranque de cada sessão) e as duas guardas de
`POST /trips`/`trips/request-web` procuravam a viagem ativa assim:
`WHERE status IN (4 estados) AND "passengerId" = ? ORDER BY "createdAt" DESC LIMIT 1`.
O SQLite escolhe `trips_passenger_idx`/`trips_driver_idx`, **lê todas as viagens históricas da pessoa**
(76 na conta de teste) e ainda faz `USE TEMP B-TREE FOR ORDER BY`. Medido em produção: **78** linhas
(passageira) e **65** (motorista, com o JOIN `drivers`).

**A correção.** `FROM trips t INDEXED BY trips_status_idx` nas **4** queries (2 de `/trips/active`, 1 mobile
em `/trips/request`, 1 web em `/trips/request-web`). O plano passa a `SEARCH t USING INDEX trips_status_idx
(status=?)` e o custo fica dependente **só das viagens em estado ativo**: **5** e **6** linhas medidas em
produção, com resultados idênticos. **Zero escritas extra** e **zero migrações**.

- `INDEXED BY` é uma **restrição dura**: se `trips_status_idx` desaparecer, a query falha com erro
  (`no such index`). O índice é criado em `0001_init.sql` e recriado em `0012_admin_stats_indexes.sql`
  — **não o apagar** num futuro corte de índices.
- O `residual` "USE TEMP B-TREE FOR ORDER BY" mantém-se (o `status IN` obriga a juntar 4 faixas do índice),
  mas agora ordena 0–2 linhas em vez de 76.
- **Porque não se fez um índice parcial novo** (`trips_active_pax_idx`/`_drv_idx`, `WHERE status IN (…)`):
  é usado pelo SQLite e elimina até o temp B-tree, mas custa **+6 linhas escritas por viagem** (ciclo medido
  em `ladiesgo-staging`: 12 → 18: INSERT 5→7, ACCEPTED 3→5, IN_PROGRESS 2→4). Ao câmbio do plano
  (5 M leituras / 100 k escritas = **50:1**), poupar 73 leituras por arranque não paga 6 escritas em cada viagem.
- **Porque não se fez uma janela de tempo** (`createdAt > now-7d`): **não muda o plano** — continua
  `SEARCH ... trips_passenger_idx` + temp B-tree a ler as 76 (provado com `node:sqlite`). E partiria as
  viagens **agendadas**, que nascem `REQUESTED` com `createdAt` de hoje e `scheduledAt` no futuro.
- **Risco assumido:** o custo passa a depender do nº de viagens em estado ativo. Hoje é 0–2 (121 viagens no
  total, todas `CANCELLED`/`COMPLETED`). Se um dia ficarem pedidos `REQUESTED` órfãos a acumular (não há
  expiração automática de `REQUESTED`), esta query e o `/trips/incoming` degradam-se juntas — nesse caso a
  limpeza é apagar/cancelar os `REQUESTED` velhos, não reverter o `INDEXED BY`.
- **Provado em staging** (API `746efef0`, D1 `ladiesgo-staging`; contas `ZZ…` e viagens apagadas no fim):
  sem viagem → 200 `null`; pedido novo → `/trips/active` devolve a viagem com os **43 campos** da tabela
  (`passengerId`/`status`/`pickupAddress`/`rideType` intactos); 2.º pedido substitui o 1.º (guarda);
  motorista aceita → o ramo `JOIN drivers` devolve a viagem `ACCEPTED`; a passageira vê a mesma.
- **Em produção (2026-10-30):** API `88985d51-c305-40a3-bb1d-7cd5b6c02df6`. `GET /trips/active` sem token
  **401**, com sessão **200** (`null`, não há viagem ativa) em 493 ms; `/health` 200. Medição prévia das
  queries exactas com `meta.rows_read`: PAX `78 → 5`, DRV `65 → 6`, guardas `78 → 5`.

### 7. Quarta vaga (2026-10-30) — índices do Histórico e das avaliações (migração `0023`)

**O problema.** As duas queries "normais" mais caras da API (medido com `meta.rows_read` em produção):

| Query | Antes | Causa |
|---|---|---|
| `GET /api/v1/trips/history` (LIMIT 30) | **319** linhas | `ORDER BY "createdAt" DESC` sobre `WHERE "passengerId"=?` → `USE TEMP B-TREE FOR ORDER BY`, a ler **todas** as viagens da pessoa (76) |
| `GET /api/v1/trips/history` (LIMIT 8, **shed nível 2**) | **319** | o corte era **cosmético**: lia exactamente as mesmas 319 |
| `GET /api/v1/trips/history` da motorista | **315** | idem via `"driverId"` |
| `GET /api/v1/ratings/pending` (LIMIT 5) | **83** | `status='COMPLETED'` + `passengerId` + `ORDER BY "completedAt"` |

**A correção — migração `0023_trips_read_indexes.sql`** (só índices; **nenhuma alteração de código/JS**,
o planeador escolhe-os sozinho):

| Índice | Serve | Custo de escrita |
|---|---|---|
| `trips_pax_created_idx ("passengerId","createdAt")` | histórico da passageira | +1 no `INSERT` (todas as viagens têm passageira) |
| `trips_drv_created_idx ("driverId","createdAt") WHERE "driverId" IS NOT NULL` | histórico da motorista | +1 só quando o motorista aceita |
| `trips_completed_pax_idx ("passengerId","completedAt") WHERE status='COMPLETED'` | `/ratings/pending` | +1 só na transição para `COMPLETED` |

Depois de criar os novos, apagam-se os dois antigos que ficaram **redundantes** (são prefixos dos novos):
`DROP INDEX trips_passenger_idx` e `DROP INDEX trips_driver_idx`. Assim o custo líquido é **+1 escrita por
viagem**, não +3.

- **Porque não um índice `(status, "passengerId", …)` completo para as avaliações:** custava **+1 escrita em
  `ACCEPTED` e em `IN_PROGRESS`** (ciclo 12 → 17 medido em staging). A versão **parcial** (`WHERE status='COMPLETED'`)
  custa só no `COMPLETED` → ciclo **12 → 13** (medido com REQUESTED→ACCEPTED→IN_PROGRESS→COMPLETED:
  INSERT 5, ACCEPTED 3, IN_PROGRESS 2, COMPLETED 3).
- **A troca compensa ao câmbio do plano Free** (5 M leituras / 100 k escritas = **50:1**): +1 escrita ≈ 50
  leituras equivalentes, e cada abertura do Histórico poupa **229** (LIMIT 30) a **297** (LIMIT 8).
- **Não apagar `trips_status_idx`** — é usado por `INDEXED BY` em `/trips/active` e `/trips/request`;
  se desaparecer, essas queries falham com `no such index` (ver secção 6).

**Medido em produção (`ladiesgo`, 121 viagens), antes → depois:**

| Query | Antes | Depois | Ganho |
|---|---|---|---|
| history pax LIMIT 30 | 319 | **90** | −72 % |
| history pax LIMIT 8 | 319 | **22** | −93 % |
| history drv LIMIT 30 | 315 | **120** | −62 % |
| ratings/pending (pax) | 83 | **11** | −87 % |
| ratings/pending (drv) | 34 | 34 | — (ramo já usava `INDEXED BY`, não mudou) |
| trips/active (pax) | 5 | 5 | — (continua com `trips_status_idx`) |

- **Plano novo:** `SEARCH t USING INDEX trips_pax_created_idx (passengerId=?)` + `SEARCH u/dd/du USING INDEX
  sqlite_autoindex_*` e **sem** `USE TEMP B-TREE`. Nas avaliações:
  `SEARCH t USING INDEX trips_completed_pax_idx (passengerId=?)` + `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`
  (sobre poucas linhas, porque o índice resolve `status` e `passengerId`).
- **Resultado idêntico (prova de correção):** para as 3 queries, a lista de ids com o índice novo é **igual**
  à da varredura forçada (`NOT INDEXED`) — `IGUAL=true`. Índices de `trips` em produção: 6 → **7**
  (`idx_trips_otp`, `sqlite_autoindex_trips_1`, `trips_pax_created_idx`, `trips_drv_created_idx`,
  `trips_completed_pax_idx`, `trips_pending_idx`, `trips_status_idx`).

**Anel 2 da proteção da quota passou a valer mesmo** (`docs/QUOTA-PROTECAO.md`): com
`system_flags.quota_shed='2'` o `/trips/history` devolve 8 em vez de 30 **e lê 22 em vez de 319**. Provado em
staging por HTTP (D1 de staging com as 121 viagens carregadas de produção): `quota_shed='0'` → **30 viagens**,
`'2'` → **8 viagens**, de volta a `'0'` → **30** (o nível tem TTL de 60 s por isolate, é preciso esperar).
Antes desta migração o nível 2 baixava a resposta mas **não** as leituras.

**Verificação funcional:** staging `6/6` por HTTP (`/health`, login, `POST /trips/request-web`,
`/trips/active`, `/trips/history?passengerId=…` com os campos do contrato `dest`/`fare`/`status`/`other`/`ts`,
`/ratings/pending`, `/trips/:id?view=web`, `/notifications`). Produção (só `GET`s): `/health` 200,
`/trips/history` 200 com **30** viagens, `/ratings/pending` 200, `/trips/active` 200 `null`.
*Atenção:* `/trips/history` **ignora** a sessão e usa o `?passengerId=`/`?driverId=` da query string — sem
esses parâmetros devolve 0 viagens (foi a única falha do 1.º ensaio do teste, 4/6 → 6/6).

**Aplicado em produção em 2026-10-30** (`wrangler d1 migrations apply ladiesgo --remote`, 6 comandos, `✅`).
A migração foi corrida **duas vezes** em staging (a primeira versão tinha um índice `(status,…)` completo);
para a repetir: `DELETE FROM d1_migrations WHERE name='0023_trips_read_indexes.sql'` e voltar a aplicar.
Custo da migração: **0 linhas lidas** (são `CREATE INDEX`), e o staging ficou a zero no fim (176 linhas apagadas).

### 8. Quinta vaga (2026-10-30) — nota da motorista sem `JOIN` (P3)

**O problema.** A nota que a passageira vê a seguir à motorista (`driver.rating` em `GET /api/v1/trips/:id`)
vinha de uma média calculada a cada chamada:

```sql
SELECT AVG(rt.score), COUNT(*) FROM ratings rt JOIN trips t ON t.id = rt."tripId"
 WHERE t."driverId" = ?          -- 97 linhas lidas (motorista real, produção)
```

Havia cache de **120 s** por isolate, mas o resultado só muda quando alguém avalia.

**A correção (2 alterações, nenhuma migração).**

1. **Fonte da verdade:** `ratings."ratedId"` já guarda o **userId de quem RECEBEU** a nota (o
   `POST /ratings` deriva-a do lado de quem avalia — o webapp só envia `{tripId, score, comment}`), e
   tem índice próprio desde a `0011` (`ratings_rated_idx`). A query passa a ser
   `SELECT AVG(score), COUNT(*) FROM ratings WHERE "ratedId" = ?` →
   `SEARCH ratings USING INDEX ratings_rated_idx (ratedId=?)`, **97 → 18 linhas**.
   O mesmo em `GET /api/v1/ratings/mine` (havia dois ramos, `driverIdFor()` + `JOIN` no ramo da
   motorista): **131 → 35 linhas**, plano sem `USE TEMP B-TREE` e `driverIdFor()` sai do caminho (−1 leitura).
   - **Correção de um erro antigo de graça:** o `JOIN` por `trips."driverId"` somava à média da motorista
     **todas** as avaliações das viagens dela — incluindo as que **ela deu** às passageiras. Provado em
     staging: 3 notas recebidas (5,4,3) + 1 nota dada pela motorista (1) → query antiga `3,67 (n=6)`,
     nova `4,0 (n=3)`.
2. **TTL 120 s → 600 s** (`DRV_RATING_TTL_MS`): 30 execuções/h por motorista e isolate → **6**. O
   `POST /ratings` continua a apagar a entrada em cache (`drvRatingCache.delete`), por isso a nota nova
   aparece já.

**Prova de equivalência (produção, só `SELECT`).** Para a motorista real os dois `SELECT` devolvem o mesmo valor
(`4,411764705882353`, `n=17`) — `IGUAL=true`; o mesmo para a lista de `/ratings/mine` (17 linhas, **mesmo hash**
de `score+data`). Invariantes verificadas: 0 avaliações com `ratedId` igual a um `drivers.id`, e as 5 + 2 linhas
"anómalas" são avaliações de viagens/utilizadores **já apagados** (`tripId` inexistente, `ratedId=''`), que
nenhuma das duas versões conta.

**Ensaio em staging** (`%TEMP%\opencode\p3-staging2.mjs`, **6/6**, staging a zero no fim, ~55 escritas):
`/trips/:id?view=web` → `driver.rating: 4`; `/ratings/mine` → `avg 4,5 / count 2`; sem sessão → **401**;
`/health` 200; e as duas `SELECT` a mostrarem 4,0 (nova) contra 3,67 (antiga).

**Em produção (2026-10-30):** API `c9780c53-f34d-47f6-bcb8-81a10f478fd6`; smoke só de `GET` **8/8** —
`/trips/:id?view=web` devolve `driver.rating = 4,4` (exactamente o valor de antes), `totalTrips 17`,
`/ratings/mine` 200, sem sessão 401, `/trips/history` 200 com 30, `/trips/active` 200 `null`.

### 9. Sexta vaga (2026-10-30) — `/boot` agregado, cache de 5 min e P6

Objectivo: cortar **pedidos ao Worker** no arranque (o recurso mais próximo do tecto em produção
real). Não se muda nada de esquema nem se escreve mais na D1.

**1. `GET /api/v1/boot` (novo, autenticado).** Devolve numa só resposta o que a app pedia em 5–7
pedidos: `user` (perfil + `walletBalance`), `walletBlocked` (na **mesma** linha do perfil),
`categories`, `unread`, `banner` (último aviso admin **com imagem**) e `activeTrip`. Cada peça tem o
seu `try/catch` — uma falha nunca impede o arranque — e o cliente usa os endpoints antigos como
fallback (builds antigos também).
- Custo medido em produção (`meta.rows_read`, sem viagem ativa): `1` (perfil) + `5` (categorias) +
  `0` (não lidas) + `1` (banner) + `5–6` (viagem ativa com `INDEXED BY trips_status_idx`) =
  **18 linhas lidas** para **1** pedido, contra ≈13 linhas em 6 pedidos. Troca de propósito:
  **−5 pedidos por +5 linhas**, ao câmbio do plano (50 leituras = 1 escrita).
- `activeTripRow(sql, sub)` foi extraída para `/trips/active` e `/boot` usarem **a mesma** query
  (`INDEXED BY trips_status_idx`), com a mesma resposta (`null` ou objeto).

**2. `Cache-Control` no que não muda ao segundo.** `GET /api/v1/categories` →
`public, max-age=300`; `GET /api/v1/turn/ice` → `private, max-age=300` (nos 4 caminhos: rotativa,
estática, `METERED_ICE_JSON`, fallback). Provado no browser: `/categories` com `?cb=` (cache-bust)
**1517 ms** vs `/categories` normal **2 ms** — a 2.ª não chega ao Worker. As credenciais TURN
duram 48 h, por isso 5 min de cache é irrelevante em segurança (e `private` impede caches
partilhados).

**3. P6 — `softResync` deixa de duplicar o `/drivers/nearby`:** o `pollCars()` do resync passa por
`liveSkipPoll('nearby','nearbyWsOpen',60000)` → com o WS de carros próximos aberto é só rede de
segurança a 1×/60 s.

**4. Cliente (`webapp/ladiesgo-home.html`) — nada é obrigatório para a app abrir:**
- `loadCats` foi partido em `__applyCats(lista)` + `loadCats()` (fetch); `refreshProfile` em
  `__applyProfile(u)` + `refreshProfile(force)` (fetch). O `/boot` aplica as duas metades sem pedido.
- `__bootFallback()` → se o `/boot` falhar (404 numa API antiga, rede em baixo, resposta inválida)
  corre `loadCats()` + `refreshProfile(1)`; `sharedNotifPoll`/`lgBannerCheck`/`loadDrvBlocked`
  voltam sozinhos porque só saltam quando `__bootUnreadAt`/`__bootBannerAt`/`__bootBlkAt` são
  recentes. **Provado no browser com o `/boot` abortado:** aparecem `/categories`,
  `/notifications/unread-count`, `/notifications/banner` e os preços por pessoa ficam certos.
- `lgBannerCheck(force)`: durante 60 s depois do `/boot` não repete o pedido do banner; o frame
  `{t:'notif'}` do WS e o botão de notificações passam `force=1`.
- `sharedNotifPoll(force)`: 60 s de tréguas depois do `/boot` (o `unread` já veio nele).
- `__adoptActive(pre)` aceita a viagem ativa do `/boot` (`__bootTakeActive()`, válida 120 s) e só
  faz `GET /trips/active` se não a tiver.

**Medido no browser (produção, 414×896, conta admin, 15 s depois de abrir o `/home`):**

| | pedidos `/api/*` | `/boot` | `/categories` | `unread-count` | `banner` | `trips/active` |
|---|---|---|---|---|---|---|
| **com `/boot`** | **7** | 1 | 0 | 0 | 0 | 0 (veio no boot) |
| `/boot` abortado (fallback) | 11 | 1 (falhou) | 1 | 1 | 1 | 0 (\*) |

(\*) a conta admin não é `PASSENGER` nem `DRIVER`, por isso o `__adoptActive` sai antes do fetch.
Console: **0 erros** com o `/boot` a funcionar; no teste de fallback só aparece o erro do pedido
que o próprio teste abortou.

**Popup do banner:** inserida **1** linha em `notifications` para a conta admin (imagem
`https://ladiesgo.pages.dev/logo.jpg`): o `/boot` trouxe o banner, o popup abriu 1,5 s depois com a
imagem carregada (`naturalWidth > 0`), o sino ficou `flex` com badge `1`, o X fechou e gravou o id
em `lg_bseen`; ao recarregar **não voltou** e não houve pedido de `/notifications/banner`.
Linha apagada no fim (base de produção intacta: 315 `notifications`, 26 `users`, 121 `trips`, 0
vestígios `zz%`).

**Verificação em staging** (`ladiesgo-api-staging`, antes do deploy de produção): **24/24** —
`/health`, login admin, `/boot` com as 6 chaves, `boot.user == /users/profile`,
`boot.categories == /categories`, `boot.activeTrip == /trips/active`, `Cache-Control` nas duas
rotas, `/boot` sem token → **401**, e uma passageira guest com `unread=0`/`banner=null` a passar a
`unread=1` + banner com imagem depois de um aviso admin (conta e notificação apagadas no fim,
staging a zero).

**Em produção (2026-10-30):** API `35209603-f3f8-4302-808c-d3f633bfd6f2` (smoke só de `GET`
**10/10**), Pages `c576add6.ladiesgo.pages.dev` (alias `ladiesgo.pages.dev`), Worker estático
`8c43103f-7b8f-45ce-b64b-a36912e196d7`. `ladiesgo-home.html` (443 541 bytes,
sha256 `31dd4ede…`) servido **byte a byte igual** pelo Pages e pelo Worker estático
(conferido com `?cb=` no fim, já com o `__bootFallback`).

### 10. Sétima vaga (2026-10-30) — `DriverGeo` com snapshot único (P7)

**O problema.** O `DriverGeo` (DO global `geo:global`) guardava **1 chave por motorista**
(`p:<userId>`) e o `load()`, que corre a cada hibernação, fazia
`storage.list({ prefix: 'p:' })`. Dois defeitos somavam-se: o custo de acordar o objeto crescia com
o nº de motoristas **e as chaves nunca eram apagadas** (só no `walletBlocked`) — cada motorista que
passou pela app deixava lá a sua chave para sempre. Medido em produção com **1** motorista real:
`geo:global` objecto `6f8141fd…` = **11 leituras de storage por 1 pedido** (15 365 leituras / 3 482
pedidos em 48 h). A duração do objeto é irrelevante (0,16 % do orçamento de leituras de storage);
o que crescia mal era a leitura.

**A correção (`src/index.ts`, sem migração de D1).** Tudo numa **única chave `snapshot:v1`**
(`GEO_SNAP_KEY`), valor `{ userId: {…, ts, ps} }`:
- `load()`: **1 `storage.get`** → repõe no `pos` só o que tem `ts` < `GEO_TTL_MS` (18 min). Se a
  chave não existir, cai no ramo **legacy**: 1 `storage.list({prefix:'p:'})`, `delete` das chaves
  antigas (em lote) e escrita do snapshot. **Corre uma vez e nunca mais.**
- `persistSnapshot()`: poda >18 min, ordena por `ts` desc, corta a
  `GEO_SNAP_MAX_CHARS = 100 KiB` (o limite do DO por valor é 128 KiB) e faz **1 `storage.put`**.
- `persistNow()`: `state.waitUntil(...)` — a gravação **nunca** atrasa a resposta HTTP (antes o
  `put('p:…')` também era fire-and-forget, por isso não há regressão).
- Todos os `put('p:'…)`/`delete('p:'…)` foram substituídos por `persistNow()`.
- **Diagnóstico:** rota interna `GET /stats` no DO e `GET /api/v1/debug/geo/stats` (só
  `ENVIRONMENT==='staging'` **e** role `ADMIN`; em produção **404**). Devolve
  `{ mode:'snapshot'|'legacy-list'|'empty', migrated, drivers, snapshotBytes }`. (O gate não usa
  `DEBUG_KEY`: o valor do staging não está disponível localmente.)
- `GEO_TTL_MS` já existia (junto do `geoStub`, ~linha 1220) — **não** declarar outra vez (o build
  rebenta com `The symbol "GEO_TTL_MS" has already been declared`).

**Medido com a GraphQL por objeto** (`%TEMP%\opencode\geo-cost.mjs`, janelas de 1 min):
| Momento | reads | writes | req | reads/req |
|---|---|---|---|---|
| antes (14:58–16:09Z) | 11 | 0 | 1 | **11,00** |
| migração (16:34Z) | 22 | 12 | 1 | 22,00 |
| depois (16:35–16:36Z) | 1 | 0 | 1 | **1,00** |

As 12 escritas do minuto da migração são o `delete` das 11 chaves `p:` + o `put` do snapshot.

**Provado em staging** (versão `7d0d0d0a`, D1 de staging a zero no fim — 0 `ZZ Geo%`, 0
`drvtest-geo-%`): motorista de teste com posição gravada pelo código **antigo** → depois do deploy
`mode:"legacy-list", migrated:true, drivers:1` (214 bytes) e `/drivers/nearby` com a posição velha;
130 s depois (hibernação) `mode:"snapshot", migrated:false, drivers:1`; posição **nova**
(-8.9111, 13.3111, gravada só no snapshot) recuperada depois de outra hibernação; `offline:true` →
`drivers:0`, snapshot **2 bytes**, `/drivers/nearby` vazio.

**Em produção (2026-10-30):** API `67343957-df45-465e-a20e-7ef0c0d1f045`.

### 11. Oitava vaga (2026-10-30) — o vigilante da quota mudou-se para dentro do Worker

**Porque.** O `.github/workflows/quota-watch.yml` está correto, mas **o agendador do GitHub não cumpre
neste repositório**. Prova medida: o antigo `keep-alive` tinha `cron: '*/10 * * * *'` (144 execuções/dia
esperadas) e fez **29 execuções em 6,8 dias** (06/10 20:52Z → 13/10 06:22Z), com intervalos de
**2,9 a 9,8 horas**. O `quota-watch` entrou na `main` às 10:48Z de 30/10 e às 15:00Z tinha **0 execuções**
(incluindo os slots das 12:00Z e 15:00Z). O workflow está `active`, o YAML é válido, o repo não está
arquivado/desativado e não houve incidente do GitHub relevante (só Issues+Pages, 14:31–15:02Z).
**Um guarda que não corre não guarda nada** → a vigilância passou para o cron por minuto que o Worker
**já tem** (0 pedidos extra).

**Código:** `cloudflare/api-worker/src/quota.ts` (novo) + ligações em `src/index.ts`.
- `readQuota(env)` — a **mesma** query GraphQL e a **mesma** matemática do `scripts/quota-watch.mjs`
  (validado lado a lado: pedidos 5,30 %, lidas 10,89 %, escritas 4,00 %, DO pedidos 0,75 %,
  DO duração 1,276 GB-s — idênticos). **`sum.duration` já vem em GB-s** (não dividir por 1e9/1e3).
- Níveis 70/85/92/100 % (AVISO/ALTO/CRÍTICO/ESGOTADO) e `shedFor()`: ≥92 % → `quota_shed=2`,
  ≥85 % → `1`, resto → `0`. **O `quota_shed` é escrito SEMPRE** (incluindo 0), senão um dia mau
  deixava a app degradada para sempre — é auto-curativo.
- `runQuotaWatch(env, force, fake?)` — corre no cron ao **minuto 0 dos slots de 3 em 3 horas**
  (00/03/06/…/21Z); um **claim de 90 min** em `system_flags.quota_watch` impede repetições com
  vários isolates. Alerta por Telegram (`TG_BOT_TOKEN`/`TG_CHAT_ID`, com anti-spam de 6 h) e
  devolve `{ok, level, worst, alerted, shed}`. Nunca lança: erro → `{ error }`.
- **Segredo necessário:** `CF_ANALYTICS_TOKEN` (**Account Analytics: Read** + **D1: Edit**).
  Sem ele é **no-op silencioso** (`{skipped:'sem CF_ANALYTICS_TOKEN'}`) — nunca parte a app.
  O token OAuth do wrangler local **não serve**: não consegue criar API tokens (`/user/tokens`,
  `/accounts/:id/tokens` → 403 `9109`) e **expira em horas** — a 30/10 às 17:10 a GraphQL já
  devolvia `{"code":10000,"message":"Authentication error"}` com o token que funcionara às 16:39,
  mesmo com a API REST a aceitá-lo; só voltou depois de `wrangler whoami` o renovar. Tem de ser um
  **API token** criado no dashboard pelo dono.
  Meter com `wrangler secret put CF_ANALYTICS_TOKEN` (prod) e `--env staging` (staging).
- `CF_ACCOUNT_ID = "016a8f9ed58a5cd10e9be697944905f0"` acrescentado a `[vars]` e `[env.staging.vars]`.

**Rotas:**
| Rota | Quem | O que faz |
|---|---|---|
| `GET /api/v1/admin/quota` | ADMIN | último estado guardado (`configured`, `quota_watch`, `quota_shed`) |
| `POST /api/v1/admin/quota/check` | ADMIN | força uma leitura agora (1 GraphQL) e devolve o estado |
| `POST /api/v1/debug/quota/alert` | ADMIN **e** staging | injeta uma leitura falsa CRÍTICO (93 %) e exercita alerta + corte. **404 em produção** |

**Provado em staging** (versão `2e7ebf93`): sem sessão → 401; admin → 200; **sem** segredo →
`{skipped:'sem CF_ANALYTICS_TOKEN'}`; segredo de brincadeira → `{error:"graphql: Authentication failed
(status: 400)"}` com `/health` 200 e **0 linhas escritas**; segredo real → `{ok:true,level:0}` e
`quota_watch` gravado; `/debug/quota/alert` → nível 3, `alertTs` posto (Telegram OK) e
`quota_shed='2'` escrito. **Anel 2 ponta-a-ponta:** 12 viagens sintéticas → `quota_shed=2` devolve
**8** no `/trips/history`, `quota_shed=0` devolve **12** (staging a zero no fim: 0 viagens, 0 flags,
restos `t=0/u=0`).

**Em produção (2026-10-30):** API `6da29130-0aea-416d-b4de-33dfb4dfa18f`. Smoke: `/health` 200
(`shed:0`), `/admin/quota` sem sessão **401** e com sessão **200** (`configured:false` até o dono
meter o segredo, `quota_shed:"0"`), `/debug/quota/alert` e `/debug/geo/stats` **404** com sessão
de admin (o gate de staging funciona).

**LIGADO em produção e staging (2026-10-30, 17:26Z).** `/health` 200 `shed:0`; `/admin/quota` →
`configured:true`; `POST /admin/quota/check` → `{ok:true, level:0, levelName:"OK",
worst:{key:"reads", used:545089, max:5000000, pct:0.1090189}, alerted:false, shed:0}` e
`quota_watch` gravado (`updatedAt 17:26:23`); o mesmo em staging (`updatedAt 17:26:25`). Ou seja:
a leitura da GraphQL, os níveis, o Telegram, o `quota_shed` e a rota de check funcionam todos com
o mesmo token.

> **O token que está lá agora é TEMPORÁRIO.** É o OAuth do `wrangler login` (device flow, 30 scopes,
> **expira às 18:25Z** do dia 30/10) — serviu para provar a cadeia toda ponta-a-ponta hoje.
> Quando expirar, o cron das 21:00Z passa a devolver `{error:"graphql: … 401"}`: **não escreve nada,
> não corta nada, `/health` continua 200** (`configured` fica `true` porque só testa a presença do
> segredo — a prova de que o token morreu é o `quota_watch.updatedAt` parado).
> **Falta só o dono trocar** por um **API token** (Account Analytics: Read; `D1: Edit` só se quiser
> `--apply-shed` por CLI), criado no dashboard:
> `wrangler secret put CF_ANALYTICS_TOKEN` (prod) e `--env staging`. Sem deploy, sem mais nada:
> o `secret put` cria versão nova e a corrida seguinte volta a medir.
> O workflow do GitHub fica só para `workflow_dispatch` manual.

### 12. Nona vaga (2026-10-30) — "fazer para 2×" viagens/dia

Pedido do dono: **dobrar a capacidade sem sair do Free**. O gargalo medido era o **nº de pedidos às
Durable Objects por viagem** (≈120), e dentro dele **um só item**: o `geoPushToTrip` chamava o DO da
viagem **a cada 9 s fixos** (1 pedido por fix, GPS a 1 fix/2 s) quando o recetor
(`TripPush.onGpsPush`) só redesenha a **150 m ou 30 s** — >90 % dos pedidos eram deitados fora.

**Corte 1 — servidor, `GEO_PUSH_MIN_MS` 9 000 → 20 000** (`cloudflare/api-worker/src/index.ts`).
- Teto duro de **1 push/20 s por motorista** (`geoPushAt`, 1 entrada por motorista no isolate).
- 20 s **< 30 s** do recetor ⇒ o redesenho continua a apanhar sempre um fix fresco; nada é descartado.
- `activeTripForDriver` tem cache de 20 s ⇒ **0 leituras extra na D1**.
- **Atalho por movimento testado e RECUSADO:** push aos 10 s se andou ≥150 m. No perfil "anda" dava
  **94** pedidos/viagem contra **104** sem corte nenhum (−10 % apenas, porque o limite passava a ser o
  movimento, não o relógio). Com o teto fixo são **45**. Ficou de fora para a garantia de 2× valer
  para qualquer perfil de condução (parado, trânsito, estrada).

**Corte 2 — cliente, janela de polling com WS aberto 60 s → 120 s** (`webapp/ladiesgo-home.html`).
`liveSkipPoll(key, isOn, win)` com o WebSocket aberto passa a **120 000 ms** (6 × `liveWsOpen()?`,
2 × `reqLiveOn()?`, 1 × `liveSkipPoll('nearby','nearbyWsOpen',120000)`). Sem WS as janelas ficam como
estavam (8 s / 30 s) — o polling continua a ser rede de segurança com socket fechado.

**A/B em staging** (`%TEMP%\opencode\ab-geopush.mjs <parado|anda> [s]`, 43 pings a 2 s durante 100 s,
auto-limpa): nº de **frames `driver`** que a passageira recebe na WS da viagem, e intervalos entre eles.

| Perfil | Antes (9 s) | Depois (20 s) | Intervalo entre frames |
|---|---|---|---|
| parado | 3 frames | **5 frames** | 37,4 s → **21,0 s** |
| anda (54 km/h) | 8 frames | **5 frames** | 14,1 s → **21,4 s** |

- **O mapa ficou *melhor* no carro parado** (37 s → 21 s): com pushes de 9 s o DO `trip:<id>` hibernava
  e evacuava entre pushes, e o `onGpsPush` voltava a contar o intervalo de 30 s do zero a cada
  arranque; com 20 s ele é acordado de forma regular e difunde sempre. Em estrada o intervalo passa de
  14 s para 21 s (perda aceite: 21 s num mapa de táxi é indistinguível).
- Pedidos ao DO: **≈11 → 5 por 105 s** no mesmo perfil (contado na GraphQL por objeto,
  `%TEMP%\opencode\do-window.mjs <min>`).

**Conta nova de capacidade (por viagem de 15 min):**

| Recurso | Antes | Depois | Tecto Free/dia |
|---|---|---|---|
| Pedidos DO | ≈104 (100 pushes + 4) | **≈49** (45 + 4) | 100 000 → **≈2 040** |
| Escritas D1 | ≈48 | ≈48 | 100 000 → **≈2 080** |
| Pedidos Worker | ≈25–30 | **≈20** (polling 120 s) | 100 000 → **≈5 000** |

⇒ **≈800 → ≈2 000 viagens/dia (2,5×)**, que cumpre o "2×" com folga. O que trava a seguir são as
**escritas da D1** (≈48/viagem: ciclo 13 + 5 pontos × 4 + avisos + avaliação), não os pedidos.

**Correcção de uma medição antiga (importante para não voltar a estimar mal):** uma `/home` de
passageira **parada não gasta 119 pedidos/h**. Medido no browser (414×896, produção, sessão PASSENGER,
120 s): **8 pedidos nos primeiros 3 s e ZERO nos 2 minutos seguintes**, + 2 WebSockets abertos
(`notifications/live`, `drivers/nearby-live`). O piso noturno de ~120 pedidos/h é **cron (60/h) +
trabalho de teste**, não o cliente. Todo o custo por utilizador está **dentro da viagem**.

**Publicado (2026-10-30):**
- Staging API `10c10c20-324d-4a50-a29e-1fdef6c0777a`; **produção API `9965322c-dfb8-4528-a68f-149913f203f6`**.
- Pages `6da6bfc9.ladiesgo.pages.dev` (alias `ladiesgo.pages.dev`); Worker estático `ladiesgo`
  versão `67524b5b-d293-4c53-b7a9-b4f4107854e6`.
- `ladiesgo-home.html` (443 550 bytes, sha256 `9d6fb479…`) servido **byte a byte igual** pelo Pages e
  pelo Worker estático; `poll120: 6`, `polls60: 0`.
- Verificação em produção (só `GET`): `/health` 200 `shed:0`, `/boot` 200 com as 6 chaves + 3 categorias,
  `/trips/active` 200 `null`, `/drivers/nearby` 200; browser `/home` (PASSENGER): **7 pedidos e depois 0
  durante 27 s**, 2 WS, 12 tiles, **0 erros de consola**.
- Base de produção no fim: **26 users / 121 trips / 1 motorista / 315 notifications** (conta de teste
  `+244923000111` apagada, 1 escrita); staging a zero.

> **Armadilha de deploy:** `webapp/wrangler.jsonc` diz `"name": "taxiapp-web"`. Correr
> `wrangler deploy` dentro de `webapp/` **cria um Worker novo chamado `taxiapp-web`** (aconteceu e foi
> apagado). O Worker estático tem de ser sempre `wrangler deploy --name ladiesgo`.

### 13. Décima vaga (2026-10-30) — espelho a 60 s, pontos a 600 s e o rácio REAL das mensagens WS

Objectivo: fechar o "2×" da nona vaga com números medidos, não modelados. Relatório:
`docs/MAIS-CORRIDAS-POR-DIA-2026-10-30.md` §8.

**1. As mensagens WebSocket contam 1:1 na métrica e 20:1 na facturação (medido, não estimado).**
- Ensaio controlado: **100 mensagens** num WS de viagem → **102 pedidos** no minuto desse objeto. A
  métrica `durableObjectsInvocationsAdaptiveGroups.requests` reflecte **uso real** (1:1).
- A quota/facturação aplica **20:1** às mensagens recebidas. Docs
  (`developers.cloudflare.com/durable-objects/platform/pricing`): *"For compute requests billing-only,
  a 20:1 ratio is applied to incoming WebSocket messages […] **The 20:1 ratio does not affect Durable
  Object metrics and analytics, which reflect actual usage.**"*
- **Regra ao medir:** `pedidos facturados = HTTP + mensagens/20`. Ler a métrica de DO sem descontar as
  mensagens **inflaciona** o custo por viagem (~30 "pedidos" que valem 1,5).
- Não confundir com os **pedidos ao Worker**: as mensagens WS não passam pelo Worker (só a ligação).

**2. O espelho `geoSet` dentro do `TripPush.onGps` era o maior gasto escondido — cortado para 60 s + ≥40 m, depois 180 s.**
- Viagem real em staging com a cadência do cliente (trip WS 1 fix/15 s + `live-geo` 1 fix/30 s), 5 min
  com **90 s parada**: `geo:global` fazia **21 pedidos** (10 mensagens + 10 espelhos + 1 ligação) →
  passou a **16** (10 mensagens + **5** espelhos + 1). O teto é `MIRROR_MIN_MS` **e**
  `MIRROR_MIN_M = 40`: um carro parado (semaforo, fila, à espera da passageira) não tem posição nova
  para escrever. O espelho é a **4.ª via** — com a app em primeiro plano o mesmo fix já vai pelo WS
  `drivers/live-geo` (≥10 m ou 30 s), e com esse socket caído o fallback REST `/drivers/position`
  (1/60 s) também escreve na DriverGeo.
- **`MIRROR_MIN_MS` 60 s → 180 s (2026-10-31).** Medido em staging (`%TEMP%\opencode\mirror3.mjs`,
  viagem de 420 s, espelho como **único** escritor de propósito): `geo:global` **12 pedidos** = 7 polls +
  2 setup + **3 espelhos** — exactamente t=0/180/360 s (antes seriam 7). `trip_points` = **1** (gate de
  600 s durável). Conta: **44 → 34 DO/viagem**, 2 272 → **2 941 viagens/dia**.
- `GEO_PUSH_MIN_MS` 20 s → **30 s** (= o intervalo de redesenho do recetor, `onGpsPush` 30 s ou 150 m;
  nenhum frame é descartado).
- **Prova funcional do espelho 60 s + 40 m** (staging, `%TEMP%\opencode\t-mirror60b.mjs`, **6/6**, lido
  por `GET /trips/:id` = o caminho da passageira): fix a 2,2 km espelha logo; outro fix a 15 s **não**
  espelha; aos 62 s um fix a **22 m** do último espelhado **não** espelha (guarda de 40 m); aos 73 s um
  fix a **222 m** volta a espelhar. Staging a zero no fim (1 admin, 0 trips, 0 drivers, 0 `trip_points`).
- **Duas armadilhas ao testar isto** (custaram 2 ensaios falhados, não são bugs do espelho):
  1. **O `geo:global` pode ser ejetado entre fixes** e o storage só persiste **1×/2 min** por motorista
     (throttle `ps` em `setPos`). Um fix espelhado só em memória **desaparece** na ejeção e a posição
     volta ao último valor persistido — parece "o espelho não funcionou". Num teste, manter o objeto
     quente com um poll ao `/drivers/nearby` a cada 5 s. Em produção não se nota: o cliente manda fix
     a cada ≤30 s (`live-geo`/`/drivers/position`), que volta a escrever a posição.
  2. **O espelho vive dentro do bloco da motorista**, depois do gate `PUSH_GPS_MIN_MS = 10 s` — um fix
     menos de 10 s após o anterior **sai antes** de chegar ao espelho. Ao testar, dar ≥11 s entre fixes.
- A guarda de movimento compara com o **último ponto espelhado** (`att.lastMirrorLat/Lng`), não com o
  último fix: por isso um fix bloqueado pelo teto (60 s então, **180 s** agora) **não** "gasta" a guarda
  (é o que faz o F3 do ensaio passar).

**3. `persistPoint` tinha um bug de raiz: o gate NUNCA valeu.**
- O DO da viagem **hiberna e é recriado** entre fixes; `this.lastPointAt` voltava a 0 a cada arranque.
  Provado em staging: 3 fixes em 35 s → **3 pontos** (o gate de 180 s era decorativo).
- Passou a **600 s** e o gate vive no **storage do próprio DO** (`lastPointAt`: 1 leitura por fix,
  1 escrita só quando grava um ponto — orçamento de storage do DO, não da D1). Mesmo ensaio: **1 ponto**.
- **Não subir para 900 s**: a guarda de viagens esquecidas usa o último `trip_points` como sinal de vida
  e fecha um `ACCEPTED` sem GPS há >20 min; a 900 s a margem cai para 5 min (e o backoff de erro de D1
  de 300 s podia dar falso positivo).

**Medido (staging, viagem completa com ciclo `arrived`→`in_progress`→`completed`):**
| | antes | depois |
|---|---|---|
| `trip:<id>` (métrica) | 30 | 27 |
| `geo:global` (métrica) | 21 | 16 |
| **total DO facturado / 5 min** | **26,5** | **18,5** |
| escritas D1 (incl. criar as 2 contas de teste) | 33 | 38 |

**Por viagem de 15 min (extrapolado do ensaio, perfil com ~15 % parado):**

| Recurso | antes | depois | Viagens/dia (tecto Free) |
|---|---|---|---|
| Pedidos DO facturados | ≈109 | **≈54** | **≈1 850** |
| Escritas D1 | ≈48 | **≈34** | ≈2 940 |
| Pedidos Worker | ≈25 | ≈20 | ≈5 000 |

⇒ **≈900 → ≈1 850 viagens/dia (2,0×)**. Volta a travar nos **pedidos às DO** (espelho 13 + `geoPushToTrip`
30 dos 54). **Recusado** subir o `geoPushToTrip` para 60 s: pouparia 15 pedidos/viagem mas o mapa da
passageira saltaria ~1 km de cada vez a 50 km/h.

> **CORRECÇÃO (2026-10-31):** o "30 dos 54" era uma **estimativa não verificada** — na altura não se sabia
> se a ponte disparava sempre. Medido na décima primeira vaga (abaixo): a ponte custa **2 pedidos/min = 30
> por viagem de 15 min**, e esse valor **só desaparece com o flag do cliente** (`noTripPush`). A guarda
> dentro do DO **poupa 0 pedidos** — o pedido já foi feito e facturado para lá chegar. Também o "≈54"
> ficou curto: a contagem completa (com ligações e transições de estado nos seus próprios minutos) dá
> **≈65 pedidos facturados por viagem**.

**Publicado:** API produção **`28f87bf1-4ae4-4bcf-907e-c992b2201a5c`**, staging `445b439b-4685-459a-b4d8-5ddbb36e3b54`.
Smoke de produção só de `GET` **12/12**; base intacta (26 users / 121 trips / 1 motorista / 315
notifications / 0 `ZZ %`); staging a zero.
Scripts: `%TEMP%\opencode\m-ride-cost.mjs` (custo de uma viagem) e `m-ws-ratio.mjs` (rácio das mensagens).

### 14. Décima primeira vaga (2026-10-31) — a ponte DriverGeo→TripPush só quando o WS da viagem cala

**O problema.** O mesmo fix de GPS viajava **duas vezes** para o DO da viagem:
1. pelo **WS da viagem** (`onGps`) — 1 mensagem, que na facturação vale **1/20 de pedido**;
2. pela **ponte** `DriverGeo → TripPush` (`POST /gps`, `onGpsPush`) — 1 pedido **inteiro**.

Com a app da motorista em primeiro plano as duas vias entregam o mesmo dado no mesmo instante. A ponte só
é necessária no **segundo plano** (o GPS de fundo nunca passa pelo WS da viagem).

**Duas camadas, ambas a falhar ABERTA:**

1. **Cliente → Worker (a que poupa o pedido).** `geoSend()` no `webapp/ladiesgo-home.html` passa a mandar
   `noTripPush: liveWsOpen()` no frame do WS global `drivers/live-geo`. `liveWsOpen()` só é `true` com o
   socket **aberto (`readyState===1`) e ligado à viagem atual** (`_liveTrip === myTripId`). No
   `DriverGeo.webSocketMessage` o Worker faz `geoPushToTrip(..., !!m.noTripPush, ...)` — sem o flag
   (builds antigos, segundo plano, socket caído) a ponte dispara como sempre.
2. **Guarda dentro do `TripPush.onGpsPush` (rede de segurança).** Se já houver um socket de motorista com
   `lastFixAt` < `WS_FIX_FRESH_MS` (**20 s** = 15 s do cliente + 5 s de folga), a ponte cala-se. A frescura
   vive no **attachment do socket**, não em `this.*` — o DO hiberna e é recriado entre fixes (o mesmo bug
   que fez o gate de `trip_points` nunca valer).

**A camada 2 NÃO poupa pedidos.** O pedido já foi feito e facturado para o DO poder decidir. Só poupa o
trabalho. Foi por isso que a primeira tentativa (só a guarda no DO) mediu **22 vs 22** pedidos — delta zero.
A camada 1 é a única que reduz a factura. A camada 2 fica para builds antigos e para qualquer caminho que
ainda mande a ponte.

**Bug encontrado pelo caminho:** `DriverGeo.webSocketMessage` tinha `geoPushToTrip(..., false, ...)`
**hardcoded** — o flag do cliente era ignorado. A rota `/set` já o respeitava. Corrigido para
`!!m.noTripPush`.

**Porque o flag não pode "calar" o mapa:** `liveSendGps` tem throttle de **15 s** e a ponte só dispara a
cada **30 s** (`GEO_PUSH_MIN_MS`), por isso sempre que a ponte iria disparar o WS já entregou. Além disso o
polling (`GET /trips/:id`) lê a posição da DriverGeo, portanto nem um socket de viagem morto congela o carro.

**Medido (staging, viagens de 5 min, mesma cadência real: trip WS 1 fix/15 s + live-geo 1 fix/30 s):**

| | sem flag | com `noTripPush` |
|---|---|---|
| `trip:<id>` — regime estável | **6 pedidos/min** | **4 pedidos/min** |
| `trip:<id>` — 5 min (métrica, total) | 32–37 | 20–28 |
| frames `driver` na passageira | 10 em 300 s (1/30 s) | **10 em 300 s (1/30 s)** |
| último fix recebido pela passageira | −9,5600 | **−9,5600** |

- O sinal limpo é a **taxa por minuto em regime estável**, não o total de 5 min: ligações e transições de
  estado caem em minutos diferentes e a janela da analytics corta os últimos ~2 min. Totais variam
  (32 / 28 / 37) sem significado.
- A diferença de **2 pedidos/min = exatamente 1 por fix de `live-geo`** (30 s) ⇒ **30 pedidos por viagem de
  15 min**.
- **A passageira não perdeu nada:** 10 frames em 300 s, intervalos `[30,30,…,30]`, mesma posição final.

**A/B com 150 s e analytics assentada** (`t-bridge-ab.mjs`, variante A sem flag / B com flag): **22 vs 18**
pedidos ao DO da viagem. Antes da correção do `hardcoded false` deu **22 vs 22** (prova de que o flag
estava a ser ignorado).

**Regressão do segundo plano** (`t-bridge-bg.mjs`, **5/5**): só com o WS global `live-geo` (sem socket de
viagem), os 3 fixes chegaram todos ao `GET /trips/:id` e a passageira recebeu 2 frames `driver` — a ponte
continua a funcionar quando é a única via.

**`wrangler tail` a confirmar as decisões** (staging): todas as chegadas da ponte foram saltadas com
`age=346 ms / 15 068 ms / 15 131 ms` — o cliente a 15 s mantém a janela de 20 s sempre fresca.

**Conta nova de capacidade (por viagem de 15 min):**

| Recurso | antes | depois | Viagens/dia (tecto Free) |
|---|---|---|---|
| Pedidos DO **facturados** | ≈65 | **≈35** | **≈2 900** |
| Escritas D1 | ≈34 | ≈34 | ≈2 940 |
| Pedidos Worker | ≈20 | ≈20 | ≈5 000 |

⇒ **≈1 550 → ≈2 900 viagens/dia (1,9×)**, e o que trava a seguir deixam de ser os pedidos às DO: são as
**escritas da D1** (≈34/viagem). Qualquer ganho adicional tem de vir de escritas, não de pedidos.

**Prova no browser em produção** (`https://ladiesgo.pages.dev`, conta de teste, sessão DRIVER com viagem
`ACCEPTED`): `liveWsOpen:true`, `_liveTrip === myTripId === 2a371400…`, socket da viagem `readyState 1`;
payload real de `geoSend` = `{"lat":-9.5101,"lng":13.5001,"h":null,"cats":[…],"noTripPush":true}`.
Contraprova com `liveWsOpen` forçado a `false` → `"noTripPush":false`. **0 erros de consola.**

**Publicado:** API produção **`442df0de-e53b-4873-a874-5854300fc371`** (`b6ddb05a-4639-413d-b21c-278115470419`
foi o deploy da lógica; o segundo difere só num comentário), Pages
`c5bb4188.ladiesgo.pages.dev` (alias `ladiesgo.pages.dev`), Worker estático
`5a4167a6-84ab-42cb-806b-57aad4f822ef`. `ladiesgo-home.html` (443 645 bytes, sha256 `6aa634f4…`) servido
**byte a byte igual** pelo Pages e pelo Worker estático. Smoke de produção só de `GET` **12/12**; base
intacta (26 users / 121 trips / 1 motorista / 315 notifications / 0 `ZZ %`); staging a zero.
Scripts: `%TEMP%\opencode\t-bridge-bg.mjs` (segundo plano), `t-bridge-ab.mjs` (A/B), `m-ride-cost.mjs`
(`NP=1` liga o flag e conta os frames da passageira), `t-do-count.mjs` (pedidos por objeto, já assentados).

### 15. Décima segunda vaga (2026-10-31) — pesquisa: **todos** os inputs na cache de cliente

**O que faltava.** A pesquisa de lugares já era FTS5-only no servidor (vaga 1), mas **5 sítios** do
`webapp/ladiesgo-home.html` chamavam `/api/places/search` e só **2** (`#q` e `#oq`) passavam pelo
`lgPlaceFetch` (cache de 10 min). Nos outros, cada pausa na escrita era um pedido de rede e cada
**prefixo** é uma chave de cache nova no servidor (`places:v14:<q>:<lat,lng>`): escrever "kilamba"
devagar podia valer ~7 pesquisas (3 a 2 000 linhas lidas cada).

**A alteração (só cliente, 1 linha por sítio).** `fetch('/api/places/search?q=…&lat=…&lng=…&v=3')
.then(r => r.ok ? r.json() : null)` → `lgPlaceFetch(q, [lat, lng])` nos 4 sítios que faltavam. Ficou
**1** ocorrência de `fetch('/api/places/search…')` no ficheiro — dentro do próprio `lgPlaceFetch`.
Acrescentada poda do `window.__plC` (>150 chaves → apaga as expiradas) para a memória não crescer sem
limite numa sessão longa.

| Sítio | Estado | Cache antes | Cache agora |
|---|---|---|---|
| `#q` / `#oq` (destino/origem da corrida) | vivo | já tinha | — |
| `#qs` (folha "Adicionar paragem" → `stop`) | **vivo** | não | **sim** |
| `#prmPickSearch` (picker unificado: **Premium e Partida**) | **vivo** | não | **sim** |
| `sharedPlaceInput` (`sharedSugO`/`sharedSugD`) | **código morto** | não | sim (por coerência) |
| `sharedPickSearch` (`#sharedPickSearch`) | **código morto** | não | sim (por coerência) |

- Os dois últimos são **mortos** porque `renderSharedCreate()` desenha os campos de origem/destino como
  `readonly` com `onclick="sharedPickOnMap(…)"` (o picker unificado), e `renderSharedPickBar()` — a única
  coisa que criaria `#sharedPickSearch` — **nunca é chamado** (1 ocorrência = a definição). `sharedPlaceInput`
  só é chamado por `sharedDestInput`, que também ninguém chama. Ficaram convertidos para não voltarem a ser
  um caminho directo se alguém os reactivar.
- **Não confundir `sharedPickSearch` com o picker da Partida:** "Anunciar Partida" → "Ponto de partida" abre
  o **mesmo** bar do Premium (`prmPickBar()`, `#prmPickSearch`/`#prmPickSug`), com `_prmTarget='shared'`;
  é o `prmPickSearch` que corre.

**Prova no browser (produção, `https://ladiesgo.pages.dev/home`, conta admin do backdoor — 0 escritas):**

| Sítio | 1.ª pesquisa | 2.ª (mesma) | Sugestões reais |
|---|---|---|---|
| `#qs` ("Adicionar paragem") | **1 pedido**, 784 ms | **0 pedidos** | Kilamba Escola · Rangel · 2,3 km; Kilamba Kiaxi - centro; Kilambar Pub; Bloco V Transporte |
| picker unificado (`#prmPickSearch`) | **1 pedido**, 980 ms | **0 pedidos** | Kilamba; Kilamba Kiaxi - centro; Kilambar; Bloco V |

- Contagem por `performance.getEntriesByType('resource')` filtrado por `/api/places/search` — **API real**,
  sem stubs. `window.__plC` ficou com `kilamba|-884,1329`.
- O picker continua a guardar a escolha: `prmPickSugPick(0)` → `_prmDraftName:'Kilamba'`,
  `_prmDraft:[-8.827963,13.271258]`, `_prmDraftPicked:true`.
- Com a API **stubada** (`page.route`) os 4 sítios deram todos `1 → 0` pedidos e chave em cache, incluindo
  os dois mortos — é a prova de que a conversão em si está certa.
- **0 erros de consola** próprios da alteração (só os recursos pré-existentes: 404 de uma viagem antiga
  guardada em `localStorage`, geolocalização bloqueada e pedidos abortados ao fechar a página).

**Publicado:** Pages **`bad50008.ladiesgo.pages.dev`** (alias `ladiesgo.pages.dev`), Worker estático
**`37f18fc5-d7bc-4fa1-9a6c-b81adb74f2c2`**. `ladiesgo-home.html` com **443 418 bytes**,
sha256 **`f19a75031e2cb8a34b0a0fc695071fb6352824153c7c573ff52b449da5c1bae4`**, servido **byte a byte
igual** pelo Pages (alias + deployment) e pelo Worker estático. Todos os 22 blocos `<script>` inline
compilam (`new Function`, sem erros). Base intacta: **26 users / 121 trips / 1 motorista / 315 notifications /
0 `ZZ %`**; as 2 contas guest `ZZ Pesq Cache` do ensaio foram apagadas (0 dependentes em
`notifications`/`wallet_tx`/`trips`/`shared_reservations`/`premium_reservations`).
Script: `%TEMP%\opencode\t-search-cache.mjs` (versão Node com `page.route`) e
`q-syntax.mjs`/`q-sha.mjs` (sintaxe e verificação byte a byte).

### 16. Décima terceira vaga (2026-10-31) — escritas da D1: 33 → 28 por viagem

**O lado que faltava cortar.** Todos os cortes das vagas 1–15 foram de **pedidos** (DO/Worker). As
**escritas da D1** estavam intocadas. A regra, medida e não deduzida: **cada entrada de índice é uma
linha escrita** (além da própria linha) — logo um índice que nenhuma query usa custa escritas em todas as
linhas da tabela e não devolve nada.

**Medido statement a statement** (`meta.rows_written`, duas vias independentes — SQL directo em staging e
deltas do contador `writes` do `/health` pela API; deram o mesmo):

| Statement | Antes | Depois |
|---|---|---|
| `INSERT` da viagem | 5 | **4** |
| `UPDATE` → `ACCEPTED` / `DRIVER_ARRIVED` / `IN_PROGRESS` | 3 / 2 / 2 | 3 / 2 / 2 |
| `UPDATE` → `COMPLETED` (trips) + `drivers` + `users` (carteira) + `wallet_tx` | 3+1+2+3 = 9 | **8** |
| `INSERT` avaliação | 4 | **3** |
| `INSERT trip_points` ×2 | 4+4 = 8 | **3+3 = 6** |
| **Total (viagem de 15 min)** | **33** | **28** (−15 %) |

**Migração `0024_write_cut_indexes.sql`** — 5 índices apagados, cada um com prova de que não é usado
(`EXPLAIN QUERY PLAN` em produção):

| Índice | Consumidor que se pensava ter | Realidade |
|---|---|---|
| `trips_pending_idx ("createdAt") WHERE status='REQUESTED'` | `/trips/incoming` + alarme do `RequestsHub` | ambos dão `SEARCH ... USING INDEX trips_status_idx (status=? AND createdAt>?)` |
| `ratings_trip_idx ("tripId")` | `/ratings/pending` | junta por `sqlite_autoindex_ratings_1 (id=?)` (id = `tripId:userId`); o resto usa `ratedId` |
| `users_driver_wallet_idx ("walletBalance") WHERE role='DRIVER'` | lista de carteiras do admin | passa a `SCAN users` (26 linhas) + temp B-tree, 1×/clique |
| `users_phone_idx (phone)` | login | `phone` é `UNIQUE` ⇒ `sqlite_autoindex_users_2` já serve (`SEARCH users USING INDEX sqlite_autoindex_users_2 (phone=?)`) |
| `trip_points_ts_idx (ts)` | purge de 30 dias | o purge mudou de forma (abaixo) |

- **NÃO apagar** (cada um tem consumidor medido): `trips_status_idx` (**é `INDEXED BY`** — sem ele a query
  falha com *no such index*), `trips_pax_created_idx` (Histórico 319 → 90), `trips_drv_created_idx`
  (315 → 120), `trips_completed_pax_idx` (`/ratings/pending` 83 → 11), `trip_points_trip_ts_idx` (rota +
  purge + guarda de viagens esquecidas), `wallet_tx_user_idx` (carteira da motorista).
- **`purgeTripPoints()` mudou de forma** (`src/index.ts` ~5540): `DELETE FROM trip_points WHERE ts < …`
  → `DELETE FROM trip_points WHERE "tripId" IN (SELECT id FROM trips WHERE "createdAt" < NOW() - INTERVAL
  '30 days')`. Plano: `SEARCH trip_points USING COVERING INDEX trip_points_trip_ts_idx (tripId=?)` +
  `SCAN trips` (121 linhas, **1×/dia**; medido 8 lidas / 2 escritas). Efeito colateral: posições **órfãs**
  deixam de ser limpas por idade — há **0** em produção.
- **Custo aceite:** a lista de carteiras do admin faz `SCAN users` (26 linhas) — 1 clique, irrelevante.

**Conta nova (viagem de 15 min):**

| Recurso | Antes | Depois | Tecto Free/dia | Viagens/dia |
|---|---|---|---|---|
| Escritas D1 | 34 | **28** | 100 000 | **3 571** |
| Pedidos DO facturados | 34 | 34 | 100 000 | **2 941** |
| Pedidos Worker | ≈20 | ≈20 | 100 000 | ≈5 000 |

⇒ **as viagens/dia NÃO mudaram (2 941): o muro voltou a ser as DO.** O corte comprou **folga** (3 571 de
tecto contra 2 941 reais) e **descolou** as duas travas. **Quem sobe a capacidade a partir daqui é o
`heading`** (34 → 25 DO ⇒ 3 571 viagens/dia, 893 h/dia); depois disso, um só ponto de rasto (28 → 25)
daria 4 000.

**Armadilhas ao repetir a medição:**
- `wrangler d1 execute --file` **só devolve o resumo** (sem `meta.rows_written` por statement) e
  `--command` parte-se com espaços via `cmd.exe` ⇒ usar a **REST D1 API** (`%TEMP%\opencode\d1r.mjs`,
  token OAuth do `%APPDATA%\xdg.config\.wrangler\config\default.toml`).
- Em staging, motoristas `ZZ%` deixados **online** roubam a oferta e o `PUT /trips/:id/accept` devolve
  **409** (o ensaio mede 0 escritas) ⇒ correr `clean-stg.mjs` **antes** de `measure-writes.mjs`.

**Publicado:** migração aplicada em staging **e** produção (6 comandos, ✅). API staging
**`490d9c13-c4c3-4e97-91f5-95632924532c`**, **API produção `f3831a53-0406-41d8-ba93-c22e1bfac0b1`**.
Smoke de produção **só `GET` 10/10** (`/health` 200 `shed:0`, `/trips/active` 401/200 `null`, `/boot` 200
com as 6 chaves, `/ratings/pending`, `/trips/history`, `/drivers/nearby`, `/categories` 200
`public, max-age=300`, `/admin/quota` 200 `configured:true`). Base intacta: **26 users / 121 trips /
1 motorista / 315 notifications / 24 ratings / 1 290 trip_points / 0 `ZZ %`**; staging a zero. O webapp
**não mudou** (só servidor + migração).
Scripts: `%TEMP%\opencode\measure-sql2.mjs` (por statement, auto-limpa), `measure-writes.mjs` (ponta a
ponta), `d1r.mjs` (REST + `meta`), `clean-stg.mjs`, `smoke-prod.mjs`.

### 17. Décima quarta vaga (2026-10-31) — `heading` a 1/15 s: DO 34 → 28 ⇒ 3 571 viagens/dia

**O último corte que faltava.** O `heading` (rumo do carro) ia pelo WS da viagem com gate **1/5 s + ≥10°**,
ou seja **12 msg/min no máximo** = 180 por viagem de 15 min = **9 DO facturados** (1 msg = 1 pedido na
métrica, 1/20 na factura — ver §13 da vaga 10).

**A alteração — 2 números, 1 linha** (`webapp/ladiesgo-home.html`, `liveSendHdg`):

```diff
-if(now-_liveHdgAt<5000)return true; ... if(d<10)return true
+if(now-_liveHdgAt<15000)return true; ... if(d<20)return true
```

Mais nada mudou: o frame `{t:'heading',h}`, o handler do servidor e as outras duas vias do rumo
(o `h` no frame `{t:'gps'}` a 15 s, que o servidor põe no `driver` via `normH`, e o `carBearing` do
movimento a ≥8 m) ficam iguais.

**A/B na página real** (`https://ladiesgo.pages.dev/home`), lendo `window.liveSendHdg.toString()` e
derivando as duas variantes **por substituição dos dois números do gate** (a única diferença é o gate),
com as pré-condições substituídas por literais e **60 s de viagem a 4 amostras/s** com relógio controlado:

| Perfil de rumo (60 s) | 1/5 s + 10° | 1/15 s + 20° | Redução |
|---|---|---|---|
| recta (ruído ±4°) | 1 msg | 1 msg | — |
| cidade (curva de 35° a cada 3 s) | **13 msg** | **5 msg** | **−62 %** |
| ruído GPS (0–359°) | **13 msg** | **5 msg** | **−62 %** |

- A poupança vem **das curvas** (numa recta o gate de 10°/20° já quase não deixava passar nada). Nas
  curvas o resultado é **o piso do próprio intervalo** (t=0,5,…,60 vs t=0,15,…,60), logo a conta é
  determinística: **180 → 60 mensagens por viagem** (na página já publicada, 900 s → **61** = 4,07/min).
- **120 mensagens a menos ÷ 20 = 6 DO facturados** ⇒ **34 → 28**.
- Custo aceite: a rotação do carro no mapa da passageira passa de 5 s para 15 s (o rumo continua a
  chegar pelo `gps` e pelo movimento).

**Conta nova (viagem de 15 min):**

| Recurso | Antes | Depois | Tecto Free/dia | Viagens/dia |
|---|---|---|---|---|
| Pedidos DO facturados | 34 | **28** | 100 000 | **3 571** |
| Escritas D1 | 28 | 28 | 100 000 | 3 571 |
| Pedidos Worker | ≈20 | ≈20 | 100 000 | ≈5 000 |

⇒ **2 941 → 3 571 viagens/dia (+21 %)**, **735 → 893 h/dia**. As duas travas ficam **empatadas em 28**:
**nenhum corte sozinho sobe a capacidade** a partir daqui (só `heading` ⇒ 25 DO mas D1 28; só escritas ⇒
25 D1 mas DO 28) — para passar das 3 571 têm de descer as duas (25/25 ⇒ 4 000).

**Publicado:** Pages **`869a4d0d.ladiesgo.pages.dev`** (alias `ladiesgo.pages.dev`), Worker estático
`ladiesgo` versão **`136c6aca-9c93-4159-9689-020c235d7948`**. `ladiesgo-home.html` **443 421 bytes**,
sha256 **`72aa3e84fd06a5cef3d359cd62f1b6bad567a8db83e7ad0bc41da421e88ef7c0`**, servido **byte a byte
igual** pelo alias, pelo deployment e pelo Worker estático (`gate15s`/`gate20` nos três); 22/22 blocos
`<script>` compilam. **Só cliente** — nenhuma alteração de API, migração ou base.
Armadilha do ensaio: `me`, `drvHeadVal` e `liveWsOpen` **não** são reescrevíveis por `window.x=…` em todos
os casos (o primeiro ensaio deu **0 envios**); a via que funciona é substituir as pré-condições **no texto**
da função e manter o gate intacto.

### Armadilha ao medir SQL à mão: `::` não existe no D1
O `db.ts` **remove os casts** (`s.replace(/::\s*[A-Za-z_][A-Za-z0-9_]*(\[\])?/g, '')`) antes de enviar o SQL,
por isso `SELECT ... ::float` **funciona na API** mas falha com
`unrecognized token: ":" ... SQLITE_ERROR [code: 7500]` se copiares a query para `wrangler d1 execute`.
Tirar o cast (ou usar `CAST(x AS REAL)`) para medir à mão. O `translate()` também trata `NOW()`,
`date_trunc('month', NOW())`, `NOW() - INTERVAL '…'`, `to_timestamp(...)`, `ILIKE`, `gen_random_uuid()`,
`TIMESTAMPTZ/JSONB/BOOLEAN/NUMERIC` e `ADD COLUMN IF NOT EXISTS`. **Não assumir que uma query "falha em
produção" só porque falhou no `wrangler d1 execute`.**

### O que foi medido e NÃO se fez (para não repetir a análise)
- **`localPlaces` — pool do FTS `LIMIT 800 → 120` (P1 da auditoria de 30/10): medido e RECUSADO.**
  O custo é **linear no pool, ≈3 linhas lidas por candidato** (`kilamba`: 800→**2 399**, 400→1 199, 200→599,
  120→359, 60→179), o que mostra que o `ORDER BY rank` **não** lê todos os documentos que casam — o pool é o
  único travão. Mas baixar o pool degrada exactamente as pesquisas em que ele custa: com 120, `kilamba` perde
  `Bloco D/G/F/Q/U/S/V` e passa a mostrar `Lubrificantes`/`Recauchutagem`/`Iraque`; `rua`, `viana`, `talatona`,
  `maianga` também mudam. Mesmo a **400** os distritos perdem coisas (`kilamba` → sem `Bloco G/F`;
  `viana` → sem `Viana mor` nem `Paragem de táxi da vila de Viana`). A 400 ficam **iguais** `zango`, `cazenga`,
  `escola`, `banco`, `sambizanga`, `kilamba bloco`; a 200 até `banco` perde agências (BIR, BFA, BDA).
  **O ganho seria residual**: essas respostas vivem **7 dias** em `caches.default` por datacenter, portanto o
  varrimento paga-se ~1×/semana por pesquisa distinta (~17 k linhas/dia mesmo com 50 distritos novos por dia =
  **0,3 %** do teto). Trocar as pesquisas mais usadas de Luanda (`kilamba`, `viana`, `talatona`) por 0,3 % de
  quota é mau negócio. **Fica o 800. Não voltar a propor sem medir a qualidade do top-15.**
  Medição: `%TEMP%\opencode\pool.mjs` (custo por pool) e `quality.mjs` (top-15 com o pós-processamento da API).
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
- **Índices parciais `trips_active_pax_idx`/`trips_active_drv_idx`** (`WHERE status IN ('REQUESTED',
  'ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')`): o SQLite **usa-os** (`SEARCH t USING INDEX trips_active_pax_idx
  (passengerId=?)`, sem temp B-tree), mas custam **+6 escritas por viagem** (ciclo 12 → 18, medido em staging).
  Com 5 M leituras / 100 k escritas (**50:1**), não compensa. Usou-se `INDEXED BY trips_status_idx` (secção 6).
- **Janela de tempo em `/trips/active`** (`createdAt > now-7d`): **não muda o plano** — continua
  `SEARCH ... trips_passenger_idx` + `USE TEMP B-TREE FOR ORDER BY` a ler as 76. Além disso partiria as
  viagens agendadas (`status='REQUESTED'` + `scheduledAt` no futuro).

## Como as outras plataformas lidam com o pico (2026-10-31)
Relatório: **`docs/PICOS-E-CONCORRENCIA-2026-10-31.md`**. Pesquisa em Uber, Lyft, Grab, DiDi e DoorDash
comparada com o que a LADIESGO já faz. **Não é para copiar arquitectura** — eles resolvem 10⁴–10⁷ pedidos/min.

- **Dos 10 padrões identificados, a LADIESGO já pratica 5:** oferta **exclusiva sequencial** com timeout e
  expansão de raio (DiDi/Uber modernos), **coordenação separada do cálculo** (DoorDash: `TripPush` por viagem vs.
  `DriverGeo`/`RequestsHub`), **backpressure** (`quota_shed` 0/1/2), **shadow testing** (staging + `stale_guard`
  `shadow` + flags sem deploy) e a **não-exclusiva** como rede de segurança (`pushTripToDrivers` máx. 3 resumos).
- **Faltam 5, e só 1 é urgente:**
  1. **Preço por hora/zona** (Uber/Lyft/Grab/DoorDash) — **0 pedidos**, poucas linhas. É o **único lever que
     reduz o número de viagens**; todos os cortes das vagas 1–14 só baixaram o custo por viagem. Decisão de
     negócio do dono (Angola, dinheiro vivo, frota de 1).
  2. **Shard geográfico** — `DriverGeo` é **1 DO global** com tudo numa chave `snapshot:v1` limitada a
     **100 KiB** → enche a **~600–700 motoristas**; o `RequestsHub` também é global. É o próximo muro real.
     **Não precisa de H3**: um **geohash de 4 caracteres** (~39×19,5 km) resolve e o shard vai no *nome* do DO
     (`geo:<geohash4>`) → **0 pedidos extra**. Um shard vazio não custa nada (o objeto não é criado).
  3. **Chain dispatch** (DiDi) — dar a próxima corrida a quem está a acabar; **1 leitura** por pedido, só rende
     com ≥10 motoristas ocupadas ao mesmo tempo.
  4. **Emparelhamento em lote** (Uber/DiDi) — **não agora**: com poucos pedidos só acrescenta latência. Passa a
     valer com >5 `REQUESTED` em simultâneo na mesma zona — e nessa altura **também poupa pedidos** (1 decisão
     em vez de N ofertas).
  5. **Previsão / posicionamento de oferta** — precisa de semanas de histórico por zona e hora; a base tem
     **121 viagens no total**. Falta matéria-prima, não esforço.
- **A confirmar (não copiar):** Spanner/Ringpop, Kafka+Flink, RL no despacho, solver bipartido, multi-região.
- **Capacidade em minutos de viagem, não em viagens.** O custo às DO é **por minuto** e o da D1 é
  **por viagem**. Modelos ancorados no medido: **`D1(d) = 22 + 3 × pontos de rasto`** (1 ponto/600 s,
  depois da migração `0024`; antes era `27 + 0,4d`, que vinha de uma estimativa errada — ver §16) e, para
  as DO, `17 + 3,4d` antes dos cortes, `17 + 1,8d` com `heading` a 1/5 s, `17 + 1,1d` com o espelho a
  1/3 min (`heading` a 1/5 s) e **`17 + 0,7d` com o `heading` a 1/15 s** (actual — ver §17).

  | Duração | DO hoje | Escritas D1 | Viagens/dia (hoje) | Horas de carro/dia | Trava |
  |---|---|---|---|---|---|
  | 10 min | 24 | 28 | 3 571 | 595 h | D1 |
  | 15 min | **28** | **28** | **3 571** | **893 h** | **empate DO/D1** |
  | 20 min | 31 | 31 | 3 226 | 1 075 h | empate DO/D1 |
  | 30 min | 38 | 34 | 2 632 | 1 316 h | DO |
  | 40 min | 45 | 37 | 2 222 | **1 481 h** | DO |
  | 60 min | 59 | 43 | 1 695 | 1 695 h | DO |

  (a linha dos 15 min é o ponto de operação actual: **3 571 viagens/dia ou 893 h/dia**. O tecto da D1 e o
  das DO **coincidem em 28** — ver §16 e §17 —, por isso **nenhum corte sozinho sobe a capacidade**: só
  baixando as duas (25 DO + 25 D1 ⇒ 4 000) se passa das 3 571.)

- **O `heading` era o que travava tudo — medido em staging a 2026-10-31** (não deduzido): `liveSendHdg`
  mandava **44 msg/min** com o gate antigo (900 ms + ≥2°), o que valia **33 pedidos facturados por viagem
  de 15 min** dos 68 totais. **1 mensagem = 1 pedido na métrica** (1:1 com as mensagens) e **1/20 na
  factura**. **Cortado para 1/5 s + ≥10°** (2 valores em `liveSendHdg`) → 68 → 44 DO/viagem.
  - É **redundante**: o frame `{t:'gps'}` já leva o `h` e o servidor põe-no no `driver`
    (`normH(m.h)`, `index.ts` ~4137). No ensaio a passageira recebeu **36/36 frames `driver` com `h`**
    em 36 envios de `gps`, sem nenhum `heading`. Sem `heading` o cliente ainda deriva o rumo do
    movimento (`carBearing` a cada ≥8 m, `ladiesgo-home.html` ~14575).
  - **O `heading` a 1/15 s é o que subiu a capacidade para 3 571** (§17): com a D1 em **28** e as DO em
    **34**, o muro eram as DO. Gate passou a **1/15 s + ≥20°** (`liveSendHdg`, 2 valores) ⇒ **13 → 5
    msg/min** ⇒ DO **34 → 28** ⇒ **3 571 viagens/dia (893 h/dia)**, 735 → 893 h. **Até 31/10 esta nota
    dizia o contrário** ("não eliminar, a D1 trava nas mesmas 2 941") — era verdade enquanto a D1 estava
    em 34; deixou de ser.
  - **Eliminar o `heading` já não sobe nada**: dá 25 DO mas a D1 fica em 28 ⇒ continuam 3 571. A partir
    daqui **as duas travas têm de descer juntas**.
- **"Mais viagens/dia" e "duplicar as horas" — as duas são possíveis no Free.** Análise completa em
  `docs/MAIS-CORRIDAS-POR-DIA-2026-10-30.md` §11–§14.
  - **`heading` a 1/5 s** ✅ → 68 → 44 DO/viagem → **2 272 viagens/dia**.
  - **Espelho `geo:global` 60 → 180 s** ✅ (`MIRROR_MIN_MS`, medido: 3 espelhos em 7 min em vez de 7) →
    44 → **34 DO/viagem** → **2 941 viagens/dia (+29 %)**.
  - **Escritas da D1 33 → 28** ✅ (migração `0024`, §16) → tecto da D1 **3 571**. **Não subiu as
    viagens/dia** (as DO mandam em 2 941): comprou folga e descolou as duas travas.
  - **`heading` a 1/15 s + ≥20°** ✅ (§17) → **34 → 28 DO/viagem** → **3 571 viagens/dia (+21 %)**,
    **893 h/dia**. Agora as duas travas estão **empatadas em 28**.
  - **Muro da D1 com as escritas em 28: `100 000 ÷ 28 = 3 571`.** A composição real (medida, não
    estimada) é `INSERT` 4 + `ACCEPTED` 3 + `ARRIVED` 2 + `IN_PROGRESS` 2 + `COMPLETED` 8 + avaliação 3 +
    2 pontos de rasto 6 = **28**. **Não existe linha em `notifications` por viagem** (a antiga conta de
    27 punha lá uma) — ver a correcção em §11.3 do relatório.
  - **O corte seguinte tem de mexer nas duas (25 DO + 25 D1 ⇒ 4 000 viagens/dia)**: um só ponto de rasto
    (gate 600 s → 1200 s, D1 28 → 25) **e** eliminar o `heading` (DO 28 → 25). Cada um sozinho dá
    exactamente as mesmas 3 571.
  - **Horas:** com as duas travas em 28 as horas crescem com a duração — **893 h a 15 min**, **1 481 h
    (2×) a ~40 min**, 1 695 h a 60 min.
  - **Consequência operacional:** encurtar viagens dá mais viagens mas **menos** horas; alongar dá mais
    horas mas menos viagens. A viagem média é o lever, não o número de pedidos.
- **A lição do DoorDash traduzida:** quando a procura passa a capacidade, **decide-se com informação
  incompleta em vez de fazer fila** — é exactamente o que o `quota_shed` e o `stale_guard` já fazem.

## Quem gasta a quota — atribuição ao minuto (2026-10-30)
Relatório: **`AUDITORIA-QUEM-GASTA-2026-10-30.md`**. Medição por minuto da GraphQL Analytics (só D1 de produção).

- **98,5 % das leituras de hoje vieram de 45 minutos** (424 545 de 430 840 linhas, 00:00Z–13:25Z); os outros
  **759 minutos** somam **6 295** linhas. A hora **04:00Z sozinha** valeu **346 162** (80 % do dia).
- **Cada pico é um múltiplo inteiro de 23 332 = o tamanho de `places`** (186 908 = 8,01×; 23 375 = 1,00×).
  Nenhuma outra tabela chega perto (`trips` 121, `notifications` 315) — é a assinatura de uma **varredura
  completa de `places`**, feita pelo 3.º passo `norm LIKE '%termo%'` de `localPlaces()`, **removido às 08:21Z**
  (commit `c515d18`). E o cliente mandava **1 pedido por tecla** em `#qs`(L113), `sharedPlaceInput`(L961),
  `sharedPickSearch`(L971) e `prmPick`(L1499) — só `#q`/`#oq` usavam `lgPlaceFetch`. Ou seja: **escrever
  "kilamba" = 7 varreduras = 163 324 linhas = 3,3 % do tecto diário; 214 pesquisas = os 5 M do dia.**
  *(**Corrigido em 2026-10-31:** os 4 sítios passaram a usar `lgPlaceFetch` — cache de 10 min. Dos 4, só
  `#qs` e o picker unificado (`#prmPickSearch`, que também serve a Partida) estão vivos; os outros dois são
  código morto. Ver "Décima segunda vaga".)*
- **Piso de repouso medido (sem ninguém): 120–741 linhas/hora e ~100–120 pedidos/hora** → 3–18 k linhas e
  2,4–2,9 k pedidos por dia. **O cron por minuto NÃO é problema** — a ideia antiga de "65 linhas/min ⇒ 93,6 k/dia"
  vinha de uma janela com trabalho de teste a decorrer.
- **Depois do corte (11:00/12:00/13:00Z): 502 · 126 · 631 linhas por hora** → **~10 k/dia (0,2 %)** de uso real.
  O modelo do cliente batia com o medido: **parada no `/home` ≈ 119 pedidos/h**, e o piso noturno medido era
  118–120/h (cron 60/h + um cliente).
  - **CORRECÇÃO (2026-10-30, medida no browser):** esse "119/h" vinha de uma janela com trabalho de teste. Uma
    `/home` parada faz **8 pedidos nos primeiros 3 s e ZERO depois** (+2 WebSockets abertos, que contam 1 pedido
    cada) — 0 pedidos/h em repouso. O piso noturno de ~120/h é **cron 60/h + testes**, não o cliente. O custo
    por utilizador está **dentro da viagem** (ver "12. Nona vaga").
- **A 3,56 M/dia de 29/10 tinha uma parte grande de auditoria do próprio assistente** (15:00–20:00Z = 2,64 M em
  6 h com 3 000 pedidos/h). Ao ler a quota, separar sempre uso real de trabalho de teste.
- **O que sobra por operação** (`meta.rows_read`, medido): `places/search` 3→2 399 · `/trips/history` 153 →
  90/120/22 (ver vagas 4 e 7) · `AVG` do `webDriverInfo` **18** (era 97; cache 600 s — ver vaga 8) ·
  `ratings/mine` **35** (era 131) · `/ratings/pending` 83 → **11** · `/trips/active` 5–6 (era 78/65).
- **DO:** `geo:global` 938 pedidos / 7 776 linhas de storage em 26 h por causa do `storage.list({prefix:'p:'})`
  no `load()` — **cresce com o número de motoristas** e as chaves nunca são apagadas (só no `walletBlocked`).
- **Pendente de decisão do dono:** P1 `LIMIT 800→120` no `localPlaces` — **medido e recusado a 30/10**
  (ver "O que foi medido e NÃO se fez"); P3 nota da motorista — **FEITO a 30/10** (ver "8. Quinta vaga",
  97→18 linhas e TTL 600 s); P4 `INDEXED BY` no `/ratings/pending` — **feito na migração `0023`**;
  P5 1 `JOIN` no `/trips/history` — **feito na migração `0023`** (319→90);
  P6 `softResync` respeitar `liveSkipPoll('nearby')` — **FEITO a 30/10** (ver "9. Sexta vaga": o
  `pollCars` do `softResync` passa a 1×/60 s com o WS de carros aberto); P7 snapshot do `DriverGeo`
  — **FEITO a 30/10** por decisão do dono (ver "10. Sétima vaga": snapshot numa só chave,
  **11 → 1 leitura por acordar**, medido com a GraphQL por objeto).
- **Nada mais a cortar sem medir.** O pool do FTS (P1) ficou recusado por perda de qualidade e o
  `DriverGeo` (P7) está feito; o que sobra é o sharding do `NotifHub`/`geo:global`, que só passa a
  valer com muitos utilizadores/motoristas.

## Proteção da quota — 4 anéis (2026-10-30)
Guia completo e runbook: **`docs/QUOTA-PROTECAO.md`**. Resumo operacional:

1. **Medir (autoritativo):** duas vias, a mesma query e a mesma matemática.
   - **Dentro do Worker (a que corre sempre):** `src/quota.ts` no cron por minuto, ao minuto 0 dos
     slots de 3 em 3 h (00/03/06/…/21Z). Precisa do segredo `CF_ANALYTICS_TOKEN`; sem ele é no-op.
     `GET /api/v1/admin/quota` mostra o último estado; `POST /api/v1/admin/quota/check` força uma
     leitura. **Substitui o GitHub Actions como agendador** — ver "11. Oitava vaga" e a prova do
     agendador em baixo. Escreve `quota_watch` **e** `quota_shed` (o `quota_shed` é reescrito em
     todos os níveis, incluindo 0, para o corte ser auto-curativo).
   - **À mão:** `cd cloudflare/api-worker && node scripts/quota-watch.mjs` — lê a
     GraphQL Analytics da **conta** (pedidos, D1 lidas/escritas, DO pedidos/GB-s), dá percentagem,
     projecção das 24 h e a **hora a que o teto seria atingido**. Códigos: 0 OK · 1 aviso (70%)
     · 2 alto (85%) · 3 crítico (92%) · 4 esgotado · 5 erro. Flags: `--json`, `--check`,
     `--telegram`, `--guard writes=N,reads=N` (recusa se não houver folga → exit 3), `--apply-shed`.
   - **`.github/workflows/quota-watch.yml`** (3 em 3 h + Telegram + falha a partir de CRÍTICO):
     **manter só para `workflow_dispatch` manual.** Precisa do segredo `CLOUDFLARE_API_TOKEN`
     (Settings → Secrets and variables → Actions).
     **Prova de que o agendador do GitHub não serve neste repo (medida a 30/10):** o antigo
     `keep-alive` com `cron: '*/10 * * * *'` (144/dia esperadas) fez **29 execuções em 6,8 dias**,
     com intervalos de **2,9 a 9,8 h**; e o `quota-watch`, que entrou na `main` às 10:48Z, tinha
     **0 execuções** às 15:00Z (slots das 12:00Z e 15:00Z perdidos). Repo `active`, não arquivado,
     YAML válido, sem incidente do GitHub relevante. Não há `gh` nesta máquina — **só o dono** pode
     correr *Run workflow*.
   - `scripts/monitor-writes.mjs` está **descontinuado** (media com `SELECT COUNT(*) FROM places`
     — lia 23 k linhas por chamada — e procurava uma tabela `_write_metrics` inexistente, dando
     "0 escritas" falso). Fica só como atalho para o `quota-watch`.
2. **Degradar antes do muro (conta, não isolate):** migração **`0021_system_flags.sql`** cria
   `system_flags`; `--apply-shed` escreve `quota_shed` = 0/1/2. O Worker lê-o em `src/shed.ts`
   (1 linha/isolate/60 s) e: **1** → `/api/places/search` deixa de consultar `places_fts`
   (cache + Photon/Nominatim); **2** → `/trips/history` devolve 8 em vez de 30 (e, desde a migração `0023`,
   lê 22 linhas em vez de 319). Nível 0/normal,
   tabela ausente ou D1 em baixo → nada corta (nunca parte a app). `/health` mostra `shed`.
3. **Não gastar:** os cortes das vagas 1–3 (FTS-only em `places`, 1 query por viagem,
   `INDEXED BY trips_status_idx`, caches, backoff dos WS, `trip_points` 180 s).
4. **Não deixar correr (guarda de viagens esquecidas):** migração **`0022_stale_guard.sql`** cria
   `stale_guard_log`. Uma viagem aberta sem ninguém custa **~600 pedidos de DO/hora**; o guarda
   corre **a cada minuto** no cron por minuto que já existe (**0 pedidos extra**) e fecha:
   **`REQUESTED` >6 min** (a passageira está na tela "A procurar motorista…" e ninguém aceitou);
   `ACCEPTED` sem GPS >20 min (vida ≥25); `DRIVER_ARRIVED` sem GPS >30 min
   (vida ≥40); `IN_PROGRESS` sem GPS >45 min (vida ≥60); teto 4 h (8 h em `IN_PROGRESS`).
   `scheduledAt` no futuro é ignorado em qualquer estado; `COMPLETED`/`CANCELLED` nunca.
   O `REQUESTED` é o único guiado pelo **relógio** (os outros pelo GPS): a oferta roda a 30 s e o
   raio já expandiu 3× para 12 km em 1 min, por isso 6 min é tempo demais. Correr 1×/hora deixaria
   a passageira até 66 min à espera — daí o sweep ir no cron **por minuto**.
   - **Modos** (`system_flags.stale_guard`): ausente/`shadow` (**default**) só regista em
     `stale_guard_log`; `on` fecha; `off` nada. Erro de D1 a ler a flag → `off`.
   - Ao fechar: `cancelledBy='system'` + `cancelReason` ≤80 (`REQUESTED` →
     `Nenhuma motorista aceitou em 6 minutos.`), `UPDATE` idempotente com
     `AND status = <estado lido>`, `notifyTripPush(...,{by:'system',reason})`, push Expo aos dois
     lados, **1** `hubBroadcast` no fim. O frame chega ao cliente com `by:''` e o handler do WS
     (`if(!_cbActor)`) mostra **"Viagem cancelada"** + "Motivo: …" e fecha o socket **sem** pedido
     extra (antes caía no `pollTrip`).
   - **`STALE_MAX_PER_RUN = 2`** porque o Free tem **50 subrequests por invocação** e o mesmo cron
     corre `premiumExpire` + `runNotificationSchedules` (este em `try/catch`). 2/min = 120/h.
   - Custo medido em produção: execução sem candidatas = **5 linhas lidas, 0 escritas** (≈6/min com
     a flag).
   - `GET /api/v1/admin/stale-guard` (admin, dry-run, `?max=` até 50) → `{mode,rules,active,
     candidates,log}`; `POST /api/v1/debug/cron/sweep` só staging + `DEBUG_KEY` (404 fora).
   - **Ligar só depois de rever o log:** 1 `INSERT … ON CONFLICT` em `system_flags`
     (`key='stale_guard', value='on'`), sem deploy.
   - **ESTADO (2026-10-30): LIGADO** — `stale_guard='on'` em produção, por decisão do dono.
     Antes de ligar: 0 viagens ativas e 0 candidatas (nada fechou à primeira hora). Para parar:
     `value='off'` (ou `'shadow'` para voltar a auditar). Não é preciso deploy.
   - Prova: **49/49** em staging (`%TEMP%\opencode\t-stale-guard.mjs`), staging a zero no fim
     (11 viagens sintéticas; `REQUESTED` de 2 min intacta e de 12 min fechada com o motivo
     `Nenhuma motorista aceitou em 6 minutos.`); produção após deploy (`ef0fc46e…`):
     `/health` 200, `mode:'on'`, `requestedMin:6`, `maxPerRun:2`, 0 ativas, 0 candidatas.

Regras (aplica-se a agentes): antes de qualquer operação que escreva >1 000 linhas correr o
vigilante e usar `--guard writes=N`; **nunca** reimportar a base toda (117 k escritas = o teto
do dia); medir SQL só com `SELECT` + `meta.rows_read`; ao ver `7500`/`1027`/429 **parar** até
às 00:00 UTC (repetir o comando conta e agrava).

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
**Forma oficial: `cd cloudflare/api-worker && node scripts/quota-watch.mjs`** (ver "Proteção da
quota — 3 anéis"). Lê a GraphQL Analytics da conta com o token OAuth do wrangler
(`default.toml` → `oauth_token`) e o `accountTag` `016a8f9ed58a5cd10e9be697944905f0`:
- **Workers:** `workersInvocationsAdaptive { sum { requests errors subrequests } dimensions { scriptName } }`
- **D1:** `d1AnalyticsAdaptiveGroups { sum { rowsRead rowsWritten readQueries writeQueries } dimensions { datetime databaseId } }`
- **DO:** `durableObjectsInvocationsAdaptiveGroups { sum { requests } }` + `durableObjectsPeriodicGroups { sum { duration rowsRead rowsWritten } }`

Scripts antigos (histórico, mesmos dados): `%TEMP%\opencode\cf-quota.mjs` e `cf-d1-hourly.mjs`.
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

### Quando os tokens morrem todos (aconteceu a 2026-10-30)
Sintoma: `wrangler d1 execute` devolve **`7403` "The given account is not valid"** com um `accountTag` que
**não** é o `016a8f9e…`, e `whoami` dá *"Not logged in. Your auth token has expired and could not be refreshed"*.
- O `accountTag` do erro vem do **token**, não de variáveis de ambiente (não há `CLOUDFLARE_ACCOUNT_ID` no
  sistema) — se aparecer `5c66df87…` estás com um token de outra conta no `default.toml`.
- Os três ficheiros (`default.toml`, `default.rerere670account.toml`, `default.fddsfds45account.toml`) estavam
  **todos inválidos** (`9109 Invalid access token` ao chamar `/client/v4/accounts`). Confirmar com
  `%TEMP%\opencode\wc-account.mjs <ficheiro>` (imprime a conta de cada token, sem publicar nada).
- **Saída:** `npx wrangler login` (abre o browser; o dono autoriza) e **logo a seguir**
  `Copy-Item default.toml default.rerere670account.toml` — sem isto o próximo refresh faz perder o token bom.
  Guardar o antigo como `default.backup-<data>.toml` antes de substituir.
- O refresh token é de uso único: se o `default.toml` for substituído por uma cópia velha, o refresh falha e é
  preciso login outra vez (foi o que aconteceu).

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
