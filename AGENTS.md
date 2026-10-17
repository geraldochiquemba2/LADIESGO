# AGENTS.md — LADIESGO

Instruções para agentes que trabalham neste repositório.

## Git
- Fazer **sempre `git push`** depois de cada commit (decisão do dono, 2026-10-17).

## Cloudflare — duas contas (e porquê)
A conta original esgotou a quota diária do **Workers Free** (100.000 pedidos/dia, reset às 00:00 UTC → **erro 1027 / HTTP 429**). A causa foram **testes de carga** (k6 / firetest / ws-storm, ~2000 contas), **não** uso real. Para não parar a app, o **Worker da API** foi migrado para uma 2ª conta e o **Pages** ficou na conta antiga.

| Função | Conta | Email | Account ID |
|---|---|---|---|
| **API Worker** (novo) | nova | `isabelcanjamba62@gmail.com` | `2ebfcbf70c6ea8d2b84130041528e249` |
| **Pages** (site estático) | antiga | `fddsfds45@gmail.com` | `5c66df87ffad64dbf294a55663baa0d4` |

- API: `https://ladiesgo-api.ladiesgo-angola.workers.dev`
- D1 `ladiesgo` (conta nova): id `ea61eb36-483c-484f-b364-f82c844c0b30`
- Pages: `https://ladiesgo.pages.dev`
- Passos de rollback: ver `cloudflare/README.md` (secção 4).

## Regras Cloudflare (importantes)
- **Nunca** correr `wrangler logout` — revoga o token e obriga a novo login. Para alternar contas:
  `powershell -ExecutionPolicy Bypass -File cloudflare\use-account.ps1 old` (Pages) ou `new` (API).
- **Nunca** correr testes de carga contra produção. Usar staging ou a 2ª conta.
- Publicar **Worker/API**: `cd cloudflare/api-worker` e `wrangler deploy --config wrangler.newaccount.toml`.
- Publicar **Pages**: `cloudflare\use-account.ps1 old` e depois `wrangler pages deploy . --project-name=ladiesgo` a partir de `webapp/`.

## Verificações HTTPS
- PowerShell 5.1 / `curl` têm TLS quebrado para `*.workers.dev` (schannel). Usar `node`, ex.:
  `node -e "fetch('https://ladiesgo-api.ladiesgo-angola.workers.dev/api/v1/health').then(r=>r.text()).then(console.log)"`

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
