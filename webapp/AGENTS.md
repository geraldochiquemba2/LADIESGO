# AGENTS.md — webapp (LadiesGo! web)

Documento para agentes que trabalham na app **web** da LadiesGo! (a mesma que a app nativa carrega numa WebView).

## O que é
- App **web estática** (HTML + JavaScript inline, **sem build step**), servida pelo **Cloudflare Pages** em `https://ladiesgo.pages.dev`.
- Cidade: **Luanda, Angola**. Idioma da UI: **português (pt-PT)**, tratamento informal ("tu").
- **Não há bundler/framework**: edita-se o HTML directamente. Cada ficheiro é uma "single page" com o JS todo lá dentro (linhas longas/minificadas — cuidado ao editar).
- A app nativa (`mobile/`) é só uma **casca WebView** que carrega este site. Mudar aqui = muda na app também (sem rebuild). Ver `mobile/AGENTS.md`.

## Ficheiros e rotas (`webapp/_redirects`)
| Rota | Ficheiro | Papel |
|---|---|---|
| `/` | `ladiesgo.html` | Landing / marketing (bolbo, lista de espera). Serve `/ladiesgo`. |
| `/app` | `ladiesgo-login.html` | Login e registo (`/api/v1/auth/login`, `/auth/register`). |
| `/home` | `ladiesgo-home.html` | **A app principal** (mapa, viagem, chat, SOS, carteira, perfil). |
| `/t` | `track.html` | Seguimento público de viagem (`/api/v1/trips/public/...`). |
| — | `admin.html` | Painel de administração (só role ADMIN). |
| — | `motoristas.html` | Página pública de motoristas. |
| — | `luanda-map.html`, `privacidade.html` | Mapa de Luanda; política de privacidade. |
| — | `index.html` | **LEGADO** (TaxiApp antigo, tema escuro). Não é rota. Não confundir com a app. |
| — | `server.js`, `package.json`, `railway.toml` | Só para **desenvolvimento local** (API Node). Railway é legado. |
| — | `_redirects`, `_headers` | Configuração do Pages. **Não remover** (ver Cache). |
| — | `page.log`, `zone.log` | Logs de runtime — não usar como fonte de verdade. |

O ficheiro mais importante é **`ladiesgo-home.html`** (~250 KB) — quase toda a lógica da app está lá.

## Como fala com a API
- No topo de **cada** HTML há um *fetch patch* que reescreve `/api/*` para o Worker:
  `var A='https://ladiesgo-api.rererererererere670.workers.dev'` (API na conta `rerere…`).
- Em `localhost` (via `node server.js`) o `/api/*` é servido localmente.
- **Se o host da API mudar de novo**, há que trocar essa constante em **todos** os HTML de `webapp/` **e** em `mobile/` (ver `cloudflare/README.md` §4).
- Base das rotas da API: `/api/v1/...` (auth, users, drivers, trips, ratings, turn).

## Sessão e estado (localStorage)
| Chave | Conteúdo |
|---|---|
| `taxi_token` | JWT (`Authorization: Bearer ...`) |
| `taxi_user` | Utilizador (JSON: id, role, name, phone, profilePhoto…) |
| `lg_trip` / `lg_mtrip` | Id da viagem activa (passageira / motorista) |
| `lg_online` | `'1'` se a motorista está online |
| `lg_account` | Dados de conta (nome, telefone, foto) |
| `lg_cats` | Categorias que a motorista aceita |
| `lg_ign`, `lg_pending_rate`, `lg_rd` | Lista ignorada; avaliação pendente; cache de rota |

Papéis: **PASSENGER**, **DRIVER**, **ADMIN** (mesma conta, papel escolhido no site).

## Tempo real (importante para a quota)
- **6 WebSockets em `ladiesgo-home.html`** (o servidor empurra updates; WS **primeiro**, polling só de fallback):
  - `.../api/v1/trips/<id>/live` — `liveConnect()` (estado da viagem; também entrega `{t:'unread'}` para o badge do chat)
  - `.../api/v1/drivers/live-geo` — `geoWsConnect()` (GPS da motorista)
  - `.../api/v1/trips/requests-live` — `reqLiveConnect()` (pedidos recebidos)
  - `.../api/v1/drivers/nearby-live` — `nearbyWsConnect()` (carros no mapa; só `PASSENGER`, fecha quando a página está oculta)
  - `.../api/v1/trips/<id>/call/live` — `callsWsConnect(tid)` (sinais da chamada: offer/answer/ice/reject/end/cancel)
  - `.../api/v1/notifications/live` — `notifWsConnect()` (avisa quando há notificação nova)
- **1 WebSocket em `track.html`** (link público, sem login):
  - `.../api/v1/trips/public/<id>/live` — `tkWsConnect()` (`hello`/`status`/`driver`/`eta`; `tick` de 4 s só como fallback quando o WS está fechado).
- **Polling só como fallback**, com `liveSkipPoll('key','liveWsOpen')` que **salta** o pedido quando o WS está aberto. Timers de mapa/contagens correm a **15 s** (na prática ~30 s com o WS aberto).
- `pollNearby(force)` é o **único** leitor de `/drivers/nearby` (cache de **3 s** em `_nearbyCacheL`/`_nearbyCacheT`); `pollCars()`/`countDrivers()` são wrappers. Não voltar a duplicar o `fetch` — era um pedido a mais por ciclo.
- Mapa ao vivo: raio filtrado **no servidor** (`radius`, metros) + filtro de **apresentação** no cliente (`searchRadiusKm`/`drawNearbyCars`).
- `pollTrip` corre a **8 s** como fallback (antes 2 s). Não baixar nem subir sem motivo.
- Badge do chat: `{t:'unread'}` no WS da viagem incrementa `__chatUnreadN`; `__chatTick` (30 s) salta quando o WS está aberto.
- Regra Cloudflare: cada **ligação** WS conta 1 pedido; as **mensagens** WS **não** contam como pedidos do Worker (contam no Durable Object a 20:1). Por isso **preferir WS a polling**.
- `geoPresence()` já se auto-limita (heartbeat 30 s em viagem, 60 s parada) — não é preciso mexer no intervalo.
- **`liveSendHdg` (rumo pelo WS da viagem): gate `1/15 s + ≥20°`** (2026-10-31; era 5 s + 10°). Cada mensagem vale 1/20 de pedido ao DO, e o gate de 5 s dava 12 msg/min = 9 DO facturados por viagem de 15 min. O rumo **não se perde**: o frame `{t:'gps'}` (15 s) já leva `h` e o `carBearing` deriva-o do movimento (≥8 m). Não baixar o intervalo sem medir — é o que separa 2 941 de 3 571 viagens/dia no plano Free.

## Cache (`webapp/_headers`)
- HTML e rotas (`/*.html`, `/`, `/app`, `/home`, `/t`, `/ladiesgo`, …) → **`no-store`**.
  Isto é **obrigatório**: sem isto o iOS/Android serve HTML antigo dentro da WebView.
- Imagens (`*.jpg/png/svg`) → cache longa/imutável.
- Não remover estas regras.

## Desenvolvimento local
```
cd webapp
node server.js          # API + ficheiros em http://localhost:3000
```
`server.js` implementa a API localmente (viagens, ofertas sequenciais 15 s, chat, geo) e serve os HTML.

## Deploy (conta única: `rerere…`)
```
$env:CLOUDFLARE_ACCOUNT_ID='016a8f9ed58a5cd10e9be697944905f0'
& ..\cloudflare\api-worker\node_modules\.bin\wrangler.cmd pages deploy . --project-name=ladiesgo --branch=main --commit-dirty=true
& ..\cloudflare\api-worker\node_modules\.bin\wrangler.cmd deploy --name ladiesgo
```
- **Conta oficial:** `rererererererere670@gmail.com` (`016a8f9ed58a5cd10e9be697944905f0`). Não usar `use-account.ps1 old/new` (legado).
- O Pages **não** gasta a quota de Workers (é estático). Ver `AGENTS.md` da raiz.
- **Nunca** correr `wrangler logout` (revoga o token).

## Convenções / cuidados
- **Sem comentários novos** salvo os de rollback.
- O host da API (constante `A=` + WebSockets `wss://`) é o da conta `rerere…`; ver `cloudflare/README.md` §4.
- Não pôr segredos no webapp — o host da API é público por design. Segredos vivem no Worker (`cloudflare/api-worker/.secrets`/`wrangler secret`).
- Ao mudar a API no topo do HTML, actualizar **todos** os HTML (o patch está repetido em cada um).
- Verificações HTTPS a `*.workers.dev` a partir do PowerShell/curl falham (TLS schannel): usar `node`.
