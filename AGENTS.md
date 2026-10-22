# AGENTS.md — LADIESGO

Instruções para agentes que trabalham neste repositório.

## Git
- Fazer **sempre `git push`** depois de cada commit (decisão do dono, 2026-10-17).

## Cloudflare — duas contas (e porquê)
A conta original esgotou a quota diária do **Workers Free** (100.000 pedidos/dia, reset às 00:00 UTC → **erro 1027 / HTTP 429**). A causa foram **testes de carga** (k6 / firetest / ws-storm, ~2000 contas), **não** uso real. Para não parar a app, o **Worker da API** foi migrado para uma 2ª conta e o **Pages** ficou na conta antiga.

| Função | Conta | Email | Account ID |
|---|---|---|---|
| **API Worker** (novo, em espera) | nova | `isabelcanjamba62@gmail.com` | `2ebfcbf70c6ea8d2b84130041528e249` |
| **API Worker + Pages** (ATIVA) | antiga | `fddsfds45@gmail.com` | `5c66df87ffad64dbf294a55663baa0d4` |

- **ESTADO ATUAL (2026-10-22): a produção está na conta ANTIGA.**
  Todos os clientes (webapp + app nativa) apontam para `https://ladiesgo-api.ladiesgo-ao.workers.dev`
  e o Worker lá publicado é o que tem o código mais recente (ver `/api/v1/health`, que devolve `budget`).
  A conta nova (`ladiesgo-angola`) está em espera: o `wrangler.newaccount.toml` aponta para lá.
  **Publicar na conta errada = o fix não chega aos utilizadores.**
- API ativa: `https://ladiesgo-api.ladiesgo-ao.workers.dev` (D1 `ladiesgo` id `84893b8b-5661-4fbc-a6aa-810ffbc1ab38`)
- API nova (em espera): `https://ladiesgo-api.ladiesgo-angola.workers.dev` (D1 id `ea61eb36-483c-484f-b364-f82c844c0b30`)
- Pages: `https://ladiesgo.pages.dev`
- Passos de rollback/migração: ver `cloudflare/README.md` (secção 4).

## Regras Cloudflare (importantes)
- **Nunca** correr `wrangler logout` — revoga o token e obriga a novo login. Para alternar contas:
  `powershell -ExecutionPolicy Bypass -File cloudflare\use-account.ps1 old` (Pages) ou `new` (API).
- **Nunca** correr testes de carga contra produção. Usar staging ou a 2ª conta.
- Publicar **Worker/API (conta ativa = antiga)**: `cd cloudflare/api-worker` e `wrangler deploy --env=""`
  (o `wrangler.toml` da raiz do api-worker é a conta antiga; `--config wrangler.newaccount.toml` é a conta nova, hoje em espera).
- Publicar **Pages**: `cloudflare\use-account.ps1 old` e depois `wrangler pages deploy . --project-name=ladiesgo` a partir de `webapp/`.

## Verificações HTTPS
- PowerShell 5.1 / `curl` têm TLS quebrado para `*.workers.dev` (schannel). Usar `node`, ex.:
  `node -e "fetch('https://ladiesgo-api.ladiesgo-ao.workers.dev/api/v1/health').then(r=>r.text()).then(console.log)"`

## Tempo real (quem manda a posição do carro)
- `DriverGeo` (DO global) é a **fonte de toda a posição viva**: recebe o GPS por REST (`PUT /api/v1/drivers/location`, `POST /api/v1/drivers/position`) e por WebSocket global (`/api/v1/drivers/live-geo`).
- `TripPush` (DO por viagem) é o que serve o WebSocket da viagem (`GET /api/v1/trips/:id/live`) → é o que a passageira vê.
- **Ponte obrigatória:** o `DriverGeo` empurra cada fix para o `TripPush` da viagem ativa (rota interna `POST /gps`), senão o carro fica **parado no mapa** quando a app da motorista está em segundo plano (o GPS em background nunca passa pelo WS da viagem).
  - Viagem ativa resolvida por `activeTripForDriver()` (cache de 20 s no isolate) → 1 leitura Neon por ~20 s e por motorista.
  - O `TripPush` só difunde se a viagem estiver `ACCEPTED`/`DRIVER_ARRIVED`/`IN_PROGRESS`, com o mesmo throttle do WS (1 fix/10 s; redesenho se o carro andou ≥150 m ou a cada 30 s).

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
  Esses scripts apontam para `ladiesgo-api.ladiesgo-ao.workers.dev` — ver o `AVISO` no topo de cada um.
- **Conta nova / isabel — 100.000 escritas/dia na D1 (erro 7500):** causado por **reimportar a BD
  inteira repetidamente** durante a migracao (o log do wrangler mostra ~9 `POST .../d1/database/.../import`
  da mesma BD a 2026-10-17; cada import completo reinsere os 23.345 registos de `places`).

Regras para nao repetir:
- **Nunca** correr `loadtest/` contra producao nem contra a conta que serve a API. Usar staging/2a conta.
- **Nunca** reimportar a BD toda em ciclo; importar so o que mudou. Um import completo ~23k escritas e o teto diario e 100k.
- Preferir `wrangler d1 migrations apply` (incremental) a reimportar o dump completo.

## Tokens de login (cuidado com o use-account.ps1)
`use-account.ps1` copia `default.<conta>account.toml` -> `default.toml`, mas o wrangler **renova e
RODA** o token dentro de `default.toml` e NAO o escreve de volta no ficheiro da conta. Logo, trocar
de conta depois de um refresh restaura um token antigo e o login passa a dar
`Failed to fetch auth token: 400 Bad Request` / `Not logged in` (aconteceu a 2026-10-17).
Boas praticas: antes de trocar de conta copiar `default.toml` -> `default.<conta>account.toml`;
em caso de duvida voltar a correr `wrangler login` (NAO `wrangler logout`).

## Estado de produção (resumo operacional)
- Conta nova (isabel): escritas bloqueadas até 00:00 UTC. Leituras OK. Fase 1a 348f7ff deployada.
- Após 00:00 UTC: aplicar migrations/0008_places_fts.sql na D1 remota (new account).
- Smoke test guest/register/toggle-online: 500→200/201 com reset.
- Conta antiga (ladiesgo-ao): 429 Error 1027 (Workers req/dia) — manter inativa.
- Webapp aponta para conta nova; Pages OK.

## Fase 1 — Estabilização Imediata (concluída em código, pendente deploy)
- **Rate limiting HTTP:** 100 req/min por IP em `/api/*` (sliding window, em memória por isolate). `/ping`, `/api/v1/health` e `/api/v1/auth/guest` estão isentos.
- **Backdoor admin removido:** `999999999` / `1234567890` não entra mais como ADMIN. Qualquer admin deve existir na BD com `role='ADMIN'` e autenticar normalmente.
- **JWT_SECRET:** definir novo segredo via `wrangler secret put JWT_SECRET --config wrangler.newaccount.toml`. Não usar o valor de `.dev.vars` em produção.
- **Variáveis novas:** `RATE_LIMIT_MAX=100`, `RATE_LIMIT_WINDOW_MS=60000` em `wrangler.newaccount.toml`.
- **Deploy:** `cd cloudflare/api-worker && wrangler deploy --config wrangler.newaccount.toml` (conta nova, NUNCA wrangler logout).
- **Smoke test:** `GET /api/v1/health` deve retornar 200; `POST /api/v1/auth/login` com `999999999` deve retornar 401 (backdoor removido).
