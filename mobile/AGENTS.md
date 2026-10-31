# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v56.0.0/ before writing any code.

## O que é esta app

### O que entra no bundle
O Metro compila **só estes 7 módulos** (entrada `index.ts`):

| Ficheiro | Papel |
|---|---|
| `index.ts` | Entrada: `registerRootComponent(App)` + import da task de fundo. |
| `App.tsx` | Casca WebView: bridge de auth/GPS/bússola, push, GPS em fundo. |
| `assets/icon.png` | Ícone do overlay de loading. |
| `src/services/api.ts` | Axios + JWT + refresh + `driversApi` (WS com fallback HTTP). |
| `src/services/bgLocation.ts` | Task `ladiesgo-bg-location`: `POST /drivers/position` e `POST /trips/:id/position`. |
| `src/services/driverBgLocation.ts` | Define a task `ladiesgo-driver-location` (5 s/10 m em viagem, 10 s/20 m online); hoje é só registada, não é arrancada por ninguém. |
| `src/services/driverGeoSocket.ts` | WebSocket `/drivers/live-geo` (GPS da motorista). |

- **Regra:** só estes ficheiros são compilados pelo Metro; qualquer outro ficheiro em `src/` é **código órfão** —
  não é executado nem pode quebrar o build, e não deve ser editado a pensar que tem efeito em produção.
- `api.ts` entra no bundle por causa do `require('./api')` de fallback em `driverBgLocation.ts`.
- Casca **WebView** (`App.tsx`): `SITE_URL = 'https://ladiesgo.pages.dev/ladiesgo?v=…'`. O produto
  (login, mapa, viagem, chat, SOS) vive no webapp (`webapp/ladiesgo-home.html`, ver `webapp/AGENTS.md`), não aqui.
- No mobile só corre o **GPS**: `driverGeoSocket` (via `driversApi` em `api.ts`) + as background tasks
  (`bgLocation`, `driverBgLocation`). O resto é ponte WebView (auth, geolocalização, bússola, push).
- Base da API: `EXPO_PUBLIC_API_URL` ou `https://ladiesgo-api.rererererererere670.workers.dev/api/v1`.
  O JWT do WS vem de `AsyncStorage` (`accessToken`); a task de fundo lê o estado guardado pela bridge (`lg_bg_state`).
- **`?v=` (cache da WebView):** mudar o `SITE_URL` — ou **qualquer coisa** em `App.tsx` — exige **build EAS + nova
  versão na loja**; `npm install`/`tsc` não chega para o utilizador ver a mudança. O `?v=` aumenta a cada deploy
  do site (actual: `20261029`).

## Código órfão (não corre na app)
- Estado final de `src/`: só `services/{api,bgLocation,driverBgLocation,driverGeoSocket}.ts`.
- **Não são importados por ninguém** (não correm, não são compilados): `src/services/socket.ts`,
  `src/navigation/AppNavigator.tsx`, `src/screens/**`, `src/components/**`, `src/store/**`. Não editar a contar
  com efeito em produção.
- **As rotas e a lógica descritas abaixo existem no webapp** (`webapp/ladiesgo-home.html` e `webapp/AGENTS.md`):
  `/trips/:id/live` (`liveConnect`), `/trips/requests-live` (`reqLiveConnect`), `/drivers/nearby-live`
  (`nearbyWsConnect`), chat, chamadas e notificações são abertos pela página dentro da WebView.
  O mobile **não** abre nenhum destes canais.
- O que corre hoje no mobile é o GPS: a task `bgLocation` faz `POST /drivers/position` / `POST /trips/:id/position`;
  `driverBgLocation` usa `driversApi.updateLocation` → `driverGeoSocket.send()`, com `PUT /drivers/location` de
  fallback (daí o `api.ts` no bundle). `driversApi.toggleOnline()` (que arrancava o WS em primeiro plano) era
  chamado pelos ecrãs órfãos, por isso não é invocado no bundle actual.
- O resto desta secção é **referência histórica** de como o `socket.ts` (apagado) funcionava.

### Canais WS que o `socket.ts` abria (histórico)
Todos os WS levavam o JWT por query (`?token=<JWT>`, `encodeURIComponent`); sem token o parâmetro era omitido.

| Rota WS | Quem abria | Recebia | Enviava |
|---|---|---|---|
| `/trips/:id/live` | `openTrip(tripId, role)` ← `emit('passenger:trip-request')` / `emit('driver:trip-accepted')` | `{t:'hello', driver?, pax?, status?}`, `{t:'driver',lat,lng}`, `{t:'pax',lat,lng}`, `{t:'eta',min}`, `{t:'status',status}`, `{t:'chat',text,ts}` | `{t:'gps',role:'driver'\|'pax',lat,lng}`, `{t:'chat',text}`, `'ping'` literal (25 s) |
| `/trips/requests-live` | `emit('join:public-requests')` (as duas HomeScreen) | `{t:'refresh'}` | `'ping'` literal (25 s) |
| `/drivers/nearby-live` | `emit('join:public-drivers')` (só HomeScreen passageira) | `{t:'nearby', drivers:[…], ts}` | nada |
| `/drivers/live-geo` | `driverGeoSocket.start()` (HomeScreen motorista quando online; também `driversApi.toggleOnline(true)`) | nada (não tem `onmessage`) | `{lat,lng}`, `{offline:true}` no `stop()` |

- **Viagem:** o `hello` alimentava `server:driver-location` / `server:passenger-location` / `server:trip-update`;
  `status: ACCEPTED` → `server:driver-found` (perfil via `GET /trips/:id?view=web`); `CANCELLED` → `server:trip-cancelled`;
  `chat` → `server:chat-message`. O `chat:message` local também fazia `POST /trips/:id/chat`. Hoje é o webapp que
  faz isto (o WS da viagem já não traz `{t:'chat'}`: vem `{t:'unread'}` + `GET /trips/:id/chat`).
- **Viagem, reconexão:** `2000 ms × tentativas` até 15 s, máx. 10 tentativas.
- **Viagem, watchdog:** a cada 15 s, se não chega frame da motorista há >35 s, faz `GET /trips/:id` (Bearer)
  e reemite a posição (1 pedido pontual, não é polling contínuo).
- **Pedidos:** ao abrir fazia `fetchIncoming()` e o `{t:'refresh'}` agendava outro 1,2 s depois (debounce).
  `fetchIncoming()` → `public:requests-snapshot` + `server:new-trip-request` (só 1× por id, via `seenRequests`).
  Fallback REST: `GET /trips/incoming` a cada 30 s. Reconexão 3 s→30 s; desistia após 3 tentativas se nunca abriu.
- **GPS (`driverGeoSocket`):** este módulo **continua no bundle**; era separado do `socketService` e tem reconexão
  fixa de 3 s. `driversApi.updateLocation` usa o WS e só cai para `PUT /drivers/location` se o socket não estiver aberto.

### Canal `nearby-live` (mapa público — histórico)
- `nearbyWs` em `socket.ts` → `wss://<api>/api/v1/drivers/nearby-live?token=<JWT>`. Hoje quem abre é o webapp
  (`nearbyWsConnect()`); no mobile já não existe `nearbyWs`.
- Frame: `{t:'nearby', drivers:[{id, lat, lng, h}]}` → despachava `public:driver-location` por motorista com
  `{ driverId, lat, lng, heading }` (o `h` ausente vira `-1`) **e** `public:drivers-snapshot` com a lista
  completa normalizada (`[{driverId, lat, lng, heading}]`, remoções incluídas). O polling também emitia o snapshot.
- Sem JWT: lia `accessToken` do `AsyncStorage` e reconectava; entretanto o polling cobria.
- Backoff de reconexão: `3000 ms × tentativas`, limitado a 30 s (reset no `onopen`).
- Fallback: polling de 15 s a `GET /drivers/nearby?lat&lng`; **saltava o `fetch`** quando
  `socketService.isNearbyWsOpen()` (`nearbyWs.readyState === 1`). O primeiro tick corria logo ao ligar.
- A HomeScreen da passageira fazia um `GET /drivers/nearby` inicial (pintava o mapa de imediato) e um intervalo
  de **60 s** só como fallback. Com o WS aberto não havia pedidos; `setNearbyDrivers` era alimentado pelo
  `public:drivers-snapshot`. Equivalente actual no webapp: `pollNearby()` (ver `webapp/AGENTS.md`).
- Fecho: `socketService.off('public:driver-location')` sem callback limpava o timer **e** fechava o `nearbyWs`.
  A HomeScreen desinscrevia o snapshot com `off('public:drivers-snapshot', handler)` (handler nomeado).

## Regra de quota
- **WS primeiro, polling só de fallback**, e o fallback salta o pedido quando o socket está aberto.
- Cada **ligação** WS conta 1 pedido ao Worker; as **mensagens** WS **não** contam como pedidos do Worker
  (contam no Durable Object a 20:1). Preferir WS a polling.
- Corolário: pings de heartbeat (`'ping'` a cada 25 s) e frames de GPS são praticamente grátis em pedidos;
  não os transformar em REST.
- Quem abre os WS hoje é o **webapp** (`webapp/AGENTS.md`); no mobile resta o WS de GPS (`/drivers/live-geo`)
  e as escritas REST da task de fundo.

## Splash nativo (o "flash branco" do arranque)
- O splash nativo **não é** o do webapp (`webapp/AGENTS.md`): é a *launch screen* do iOS, gerada pelo
  `expo prebuild` a partir do `app.json`.
- **Causa do flash branco (corrigida a 2026-10-31):** o `expo-splash-screen` **não estava** nas
  `dependencies` (nem no `package-lock.json`) e por isso o plugin nunca corria. Sem plugin, o prebuild deixa
  a `SplashScreen.storyboard` do template, que usa `systemBackgroundColor` = **branco**
  (`white="1"` — ver `templates/expo-template-bare-minimum/ios/HelloWorld/SplashScreen.storyboard` no
  `expo/expo` `sdk-56`). Resultado: ecrã branco até o React montar.
- **Correção:** `expo-splash-screen@~56.0.16` nas `dependencies` + plugin no `app.json`:
  `["expo-splash-screen", { backgroundColor:"#61188E", image:"./assets/icon.png", imageWidth:160, resizeMode:"contain" }]`.
  O plugin escreve `Images.xcassets/SplashScreenBackground.colorset` com o lilás e a logo no
  `SplashScreenLogo.imageset` (ver `plugin/src/withIosSplashColors.ts`). A chave legada `splash` foi removida.
- **`SplashScreen.preventAutoHideAsync()` no topo do `App.tsx`** e `hide()` no `endLoading()`: a launch screen
  só sai quando a WebView já tem conteúdo (overlay lilás + página pintada), senão havia um frame branco entre
  a splash e a primeira pintura. Rede de segurança: `hide()` aos 10 s mesmo que a página nunca carregue.
- **Só muda com build nativo novo** (`build-ios.yml`). Qualquer `push` que toque em `mobile/app.json`
  dispara o build — é o gatilho, não esquecer.

## Estado conhecido / armadilhas
- **Sem `node_modules`, sem `android/` nem `ios/`** (Expo managed). `npx tsc --noEmit` **não corre**
  (`This is not the tsc command you are looking for`; o `tsconfig.json` também faz `extends: expo/tsconfig.base`,
  que não existe sem dependências).
- Validação possível de um ficheiro isolado:
  `npx --yes esbuild src/services/driverGeoSocket.ts --loader:.ts=ts --outfile=<tmp>` (compila; avisa só do `tsconfig`).
- **Logout:** era feito nos ecrãs (`ProfileScreen`, `SettingsScreen`, `PasswordBanner`, `PendingApprovalScreen`)
  com `driverGeoSocket.stop()` + `socketService.logout()` (limpava o token e fechava todos os canais). Esses ecrãs
  e o `socket.ts` **já não estão no bundle**. Hoje o logout é do webapp (limpa o `localStorage`); a casca nativa
  reage pela bridge — sem `jwt` no estado, `ensureBgTask` desliga a task de fundo.
- **`public:trip-requested` / `public:trip-removed`** eram subscritos nas duas HomeScreen órfãs mas o `socket.ts`
  nunca os despachava — histórico; no webapp a lista de pedidos muda no snapshot do WS.
- A HomeScreen da passageira voltava a correr o efeito quando `location` mudava; o `off(...)` sem callback limpava
  *todos* os handlers desses eventos — histórico (código apagado); no webapp o equivalente é `off` com handler nomeado.

## `nearby-live` — contrato do servidor
- O WS é servido pelo Durable Object **`DriverGeo`** (`geo:global`) e devolve **só** `id`, posição e rumo
  — nunca nome, telefone nem categorias.
- Só o webapp o abre (`nearbyWsConnect()`, só `PASSENGER`, fecha quando a página está oculta). O antigo
  `nearbyWs` do mobile saiu com a limpeza do `socket.ts`.
