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
- **Worker/API**: a partir de `cloudflare/api-worker/`, primeiro `npm install` (uma vez) e depois `wrangler deploy`. O `wrangler.toml` aponta à D1 `ladiesgo` da rerere (`fab720b7…`); bindings incluem as 4 Durable Objects (`RINGER`, `TRIPPUSH`, `REQUESTSHUB`, `DRIVERGEO`).
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

## Tempo real (quem manda a posição do carro)
- `DriverGeo` (DO global) é a **fonte de toda a posição viva**: recebe o GPS por REST (`PUT /api/v1/drivers/location`, `POST /api/v1/drivers/position`) e por WebSocket global (`/api/v1/drivers/live-geo`).
- `TripPush` (DO por viagem) é o que serve o WebSocket da viagem (`GET /api/v1/trips/:id/live`) → é o que a passageira vê.
- **Ponte obrigatória:** o `DriverGeo` empurra cada fix para o `TripPush` da viagem ativa (rota interna `POST /gps`), senão o carro fica **parado no mapa** quando a app da motorista está em segundo plano (o GPS em background nunca passa pelo WS da viagem).
  - Viagem ativa resolvida por `activeTripForDriver()` (cache de 20 s no isolate) → 1 leitura **D1** por ~20 s e por motorista.
  - O `TripPush` só difunde se a viagem estiver `ACCEPTED`/`DRIVER_ARRIVED`/`IN_PROGRESS`, com o mesmo throttle do WS (1 fix/10 s; redesenho se o carro andou ≥150 m ou a cada 30 s).
- **Cancelamento de corrida:** o aviso às motoristas é um `await hubBroadcast(c.env)` **imediato** nos endpoints de cancelamento (não em `waitUntil`), para a oferta sumir rápido. Ver também o ping/pong do WS de pedidos no webapp.

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

## Fase 1 — histórico (2026-10-17; NÃO usar para deploy)
- Notas da conta `isabelcanjamba62` (em espera/desativada). **Não publicar nessa conta.**
- **Rate limiting HTTP:** 100 req/min por IP em `/api/*` (sliding window, em memória por isolate). `/ping`, `/api/v1/health` e `/api/v1/auth/guest` estão isentos.
- **Backdoor admin removido:** `999999999` / `1234567890` não entra mais como ADMIN. Qualquer admin deve existir na BD com `role='ADMIN'` e autenticar normalmente.
- **Variáveis:** `RATE_LIMIT_MAX=100`, `RATE_LIMIT_WINDOW_MS=60000` no `wrangler.toml` do Worker/API.
- **Smoke test:** `GET /api/v1/health` deve retornar 200; `POST /api/v1/auth/login` com `999999999` deve retornar 401 (backdoor removido).
