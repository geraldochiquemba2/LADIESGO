# LadiesGo! — Cloudflare only (sem Render)

## 1. API Worker (`cloudflare/api-worker`)
```powershell
cd cloudflare/api-worker
wrangler login
wrangler secret put DATABASE_URL   # URL pooled do Neon (com ?sslmode=require)
wrangler secret put JWT_SECRET     # MESMO do backend atual (mantém sessões)
# Neon SQL (uma vez): CREATE EXTENSION IF NOT EXISTS pgcrypto;
wrangler deploy
# DNS: api.ladiesgo.ao -> worker
```

## 2. Site Pages (`webapp/`)
```powershell
wrangler pages deploy webapp --project-name=ladiesgo
# Rotas via webapp/_redirects: /privacidade /app /home /admin /t
# URL privacidade App Store: https://ladiesgo.pages.dev/privacidade
```

## 3. Mobile
`EXPO_PUBLIC_API_URL=https://ladiesgo-api.ladiesgo-ao.workers.dev/api/v1` (em `mobile/eas.json`; API legada na conta `fddsfds45`; trocar para `https://api.ladiesgo.ao/api/v1` quando o domínio .ao existir).
GPS adaptativo: 5s/10m em viagem, 10s/20m online (ver `mobile/src/services/driverBgLocation.ts`).
Sem socket obrigatório: REST polling em `GET /trips/:id` devolve motorista+ETA.

## 4. Conta Cloudflare (2026-10-26) — apenas `rerere…`
O projeto usa **só** a conta `rererererererere670@gmail.com` (Account ID `016a8f9ed58a5cd10e9be697944905f0`).

- Pages: `https://ladiesgo.pages.dev` (projeto `ladiesgo`)
- Worker estático: `https://ladiesgo.rererererererere670.workers.dev` (nome `ladiesgo`)
- Deploy Pages: `cd webapp` + `wrangler pages deploy . --project-name=ladiesgo --branch=main --commit-dirty=true`
- Deploy Worker estático: `cd webapp` + `wrangler deploy --name ladiesgo`
- Token: `~/.wrangler/config/default.rerere670account.toml`; **nunca** `wrangler logout`.

**Legado (não publicar):**
- `fddsfds45@gmail.com` (`5c66df87ffad64dbf294a55663baa0d4`): ainda aloja o Worker/API `https://ladiesgo-api.ladiesgo-ao.workers.dev` (D1 `ladiesgo`, `84893b8b-5661-4fbc-a6aa-810ffbc1ab38`) usado pelos clientes. Só este Worker pode ser publicado fora da conta `rerere…`, até a API ser migrada.
- `isabelcanjamba62@gmail.com` (`2ebfcbf70c6ea8d2b84130041528e249`): conta em espera/desativada — não usar.
- `ladiesgo-bh1.pages.dev` pertence à conta antiga; não é produção.

**Backup / import:**
- `C:\Users\Geraldo\backup-prod.sql` — export D1 de produção (utilizadoras reais).
- `C:\Users\Geraldo\backup-split.sql` — versão com as fotos base64 divididas (o import falha com `SQLITE_TOOBIG` se as fotos num INSERT unico forem demasiado grandes).

**Nota:** o `JWT_SECRET` da conta nova é o de dev (`.dev.vars`) -> as sessões antigas caem; o login por password continua a funcionar.

**Incidente de quota da D1 (2026-10-17) — NAO REPETIR:**
Logo depois da migracao, a conta nova ficou sem poder **gravar** na D1 (erro 7500: 100.000 linhas
escritas/dia do plano Free, por **conta**). Causa: a BD foi reimportada **~9 vezes** no mesmo dia
(ver `~/.wrangler/logs` -> `POST .../d1/database/ea61eb36.../import`); cada import completo reinsere
os 23.345 registos de `places`, e varias tentativas falharam com `SQLITE_TOOBIG` e foram repetidas.
Enquanto a quota de escrita esta esgotada, TODA a escrita (criar utilizador, ficar online, pedidos,
chamadas) devolve **500** ate as 00:00 UTC (01:00 Angola); a leitura continua a funcionar.
Regra: importar a BD so uma vez e so o que mudou; preferir `wrangler d1 migrations apply`. O teto
diario de escritas e 100k e o de leituras 5M.
