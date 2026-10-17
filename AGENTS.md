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
