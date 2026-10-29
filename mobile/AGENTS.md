# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v56.0.0/ before writing any code.

## O que é esta app
- Casca **WebView** (`App.tsx`): `SITE_URL = 'https://ladiesgo.pages.dev/ladiesgo?v=…'` — grande parte do tempo real
  acontece no webapp (ver `webapp/AGENTS.md`), não aqui.
- O código nativo próprio é pouco: `src/services/socket.ts` (cliente realtime), `src/services/driverGeoSocket.ts`
  (GPS da motorista), tracking em fundo (`driverBgLocation`) e a ponte de auth/GPS com a WebView.
- Base da API: `EXPO_PUBLIC_API_URL` ou `https://ladiesgo-api.rererererererere670.workers.dev/api/v1`;
  `WS_BASE = API.replace(/^http/, 'ws')`. Token lido de `AsyncStorage` (`accessToken`).

## Tempo real — canais que a app nativa abre
Todos os WS levam o JWT por query (`?token=<JWT>`, `encodeURIComponent`); sem token o parâmetro é omitido.

| Rota WS | Quem abre | Recebe | Envia |
|---|---|---|---|
| `/trips/:id/live` | `openTrip(tripId, role)` ← `emit('passenger:trip-request')` / `emit('driver:trip-accepted')` | `{t:'hello', driver?, pax?, status?}`, `{t:'driver',lat,lng}`, `{t:'pax',lat,lng}`, `{t:'eta',min}`, `{t:'status',status}`, `{t:'chat',text,ts}` | `{t:'gps',role:'driver'\|'pax',lat,lng}`, `{t:'chat',text}`, `'ping'` literal (25 s) |
| `/trips/requests-live` | `emit('join:public-requests')` (as duas HomeScreen) | `{t:'refresh'}` | `'ping'` literal (25 s) |
| `/drivers/nearby-live` | `emit('join:public-drivers')` (só HomeScreen passageira) | `{t:'nearby', drivers:[…], ts}` | nada |
| `/drivers/live-geo` | `driverGeoSocket.start()` (HomeScreen motorista quando online; também `driversApi.toggleOnline(true)`) | nada (não tem `onmessage`) | `{lat,lng}`, `{offline:true}` no `stop()` |

- **Viagem:** o `hello` alimenta `server:driver-location` / `server:passenger-location` / `server:trip-update`;
  `status: ACCEPTED` → `server:driver-found` (perfil via `GET /trips/:id?view=web`); `CANCELLED` → `server:trip-cancelled`;
  `chat` → `server:chat-message`. O `chat:message` local também faz `POST /trips/:id/chat`.
- **Viagem, reconexão:** `2000 ms × tentativas` até 15 s, máx. 10 tentativas.
- **Viagem, watchdog:** a cada 15 s, se não chega frame da motorista há >35 s, faz `GET /trips/:id` (Bearer)
  e reemite a posição (1 pedido pontual, não é polling contínuo).
- **Pedidos:** ao abrir faz `fetchIncoming()` e o `{t:'refresh'}` agenda outro 1,2 s depois (debounce).
  `fetchIncoming()` → `public:requests-snapshot` + `server:new-trip-request` (só 1× por id, via `seenRequests`).
  Fallback REST: `GET /trips/incoming` a cada 30 s. Reconexão 3 s→30 s; desiste após 3 tentativas se nunca abriu.
- **GPS (`driverGeoSocket`):** módulo separado do `socketService`; reconexão fixa de 3 s.
  `driversApi.updateLocation` usa o WS e só cai para `PUT /drivers/location` se o socket não estiver aberto.

## Canal `nearby-live` (mapa público)
- `nearbyWs` em `socket.ts` → `wss://<api>/api/v1/drivers/nearby-live?token=<JWT>`.
- Frame: `{t:'nearby', drivers:[{id, lat, lng, h}]}` → despacha `public:driver-location` por motorista com
  `{ driverId, lat, lng, heading }` (o `h` ausente vira `-1`) **e** `public:drivers-snapshot` com a lista
  completa normalizada (`[{driverId, lat, lng, heading}]`, remoções incluídas). O polling também emite o snapshot.
- Sem JWT: lê `accessToken` do `AsyncStorage` e reconecta; entretanto o polling cobre.
- Backoff de reconexão: `3000 ms × tentativas`, limitado a 30 s (reset no `onopen`).
- Fallback: polling de 15 s a `GET /drivers/nearby?lat&lng`; **salta o `fetch`** quando
  `socketService.isNearbyWsOpen()` (`nearbyWs.readyState === 1`). O primeiro tick corre logo ao ligar.
- A HomeScreen da passageira faz um `GET /drivers/nearby` inicial (pinta o mapa de imediato) e um intervalo
  de **60 s** só como fallback: salta o pedido quando `socketService.isNearbyWsOpen()`. Com o WS aberto não
  há pedidos; `setNearbyDrivers` é alimentado pelo `public:drivers-snapshot`.
- Fecho: `socketService.off('public:driver-location')` sem callback limpa o timer **e** fecha o `nearbyWs`.
  A HomeScreen desinscreve o snapshot com `off('public:drivers-snapshot', handler)` (handler nomeado).

## Regra de quota
- **WS primeiro, polling só de fallback**, e o fallback salta o pedido quando o socket está aberto.
- Cada **ligação** WS conta 1 pedido ao Worker; as **mensagens** WS **não** contam como pedidos do Worker
  (contam no Durable Object a 20:1). Preferir WS a polling.
- Corolário: pings de heartbeat (`'ping'` a cada 25 s) e frames de GPS são praticamente grátis em pedidos;
  não os transformar em REST.

## Estado conhecido / armadilhas
- **Sem `node_modules`, sem `android/` nem `ios/`** (Expo managed). `npx tsc --noEmit` **não corre**
  (`This is not the tsc command you are looking for`; o `tsconfig.json` também faz `extends: expo/tsconfig.base`,
  que não existe sem dependências).
- Validação possível de um ficheiro isolado:
  `npx --yes esbuild src/services/socket.ts --loader:.ts=ts --outfile=<tmp>` (compila; avisa só do `tsconfig`).
- **Logout:** os handlers de UI que fazem `dispatch(logout())` (`ProfileScreen`, `SettingsScreen`,
  `PasswordBanner`, `PendingApprovalScreen`) chamam primeiro `driverGeoSocket.stop()` e
  `socketService.logout()` — este último limpa o token e fecha todos os canais (`disconnect()`).
- **`public:trip-requested` / `public:trip-removed`** são subscritos nas duas HomeScreen mas o `socket.ts`
  nunca os despacha — a lista de pedidos só muda no snapshot seguinte.
- A HomeScreen da passageira volta a correr o efeito quando `location` muda; o `off(...)` sem callback limpa
  *todos* os handlers desses eventos, por isso não subscrever o mesmo evento noutro ecrã em simultâneo.

## `nearby-live` nos dois lados
- O mesmo WS (webapp `nearbyWsConnect()` e mobile `nearbyWs`) é servido pelo Durable Object **`DriverGeo`**
  (`geo:global`) e devolve **só** `id`, posição e rumo — nunca nome, telefone nem categorias.
