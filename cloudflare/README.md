# LadiesGo! — Cloudflare only (sem Render)

## 1. API Worker (`cloudflare/api-worker`)
```powershell
cd cloudflare/api-worker
npm install                 # uma vez (hono, @cloudflare/workers-types, etc.)
wrangler login              # deve ficar na conta rerere…
wrangler secret put JWT_SECRET   # valor de produção (NAO o de .dev.vars)
wrangler d1 migrations apply ladiesgo --remote   # esquema (a D1 ja existe na rerere)
wrangler deploy             # publica em ladiesgo-api.rererererererere670.workers.dev
# Sem DNS proprio: usa o subdominio workers.dev acima.
```

## 2. Site Pages (`webapp/`)
```powershell
wrangler pages deploy webapp --project-name=ladiesgo
# Rotas via webapp/_redirects: /privacidade /app /home /admin /t
# URL privacidade App Store: https://ladiesgo.pages.dev/privacidade
```

## 3. Mobile
`EXPO_PUBLIC_API_URL=https://ladiesgo-api.rererererererere670.workers.dev/api/v1` (em `mobile/eas.json`; API na conta `rerere…`; trocar para `https://api.ladiesgo.ao/api/v1` quando o domínio .ao existir).
GPS adaptativo: 5s/10m em viagem, 10s/20m online (ver `mobile/src/services/driverBgLocation.ts`).
Sem socket obrigatório: REST polling em `GET /trips/:id` devolve motorista+ETA.

## 4. Conta Cloudflare (2026-10-28) — apenas `rerere…`, TUDO aqui
O projeto usa **só** a conta `rererererererere670@gmail.com` (Account ID `016a8f9ed58a5cd10e9be697944905f0`). Site, worker estático, API e base de dados vivem todos nesta conta.

- Pages: `https://ladiesgo.pages.dev` (projeto `ladiesgo`)
- Worker estático: `https://ladiesgo.rererererererere670.workers.dev` (nome `ladiesgo`)
- **Worker/API:** `https://ladiesgo-api.rererererererere670.workers.dev` (nome `ladiesgo-api`)
- **Base de dados D1:** `ladiesgo`, id `fab720b7-d96e-423f-8454-bcc9942f6d50` (bindings no `wrangler.toml` do `api-worker`)
- Deploy Pages: `cd webapp` + `wrangler pages deploy . --project-name=ladiesgo --branch=main --commit-dirty=true`
- Deploy Worker estático: `cd webapp` + `wrangler deploy --name ladiesgo`
- Deploy API: `cd cloudflare/api-worker` + `npm install` (uma vez) + `wrangler deploy`
- Aplicar migrações: `cd cloudflare/api-worker` + `wrangler d1 migrations apply ladiesgo --remote`
- Token: `~/.wrangler/config/default.rerere670account.toml`; **nunca** `wrangler logout`.

**API Worker (`cloudflare/api-worker`):**
- É Hono + D1 (via adaptador `src/db.ts` com API do `sql\`...\``) + 4 Durable Objects (`RINGER`, `TRIPPUSH`, `REQUESTSHUB`, `DRIVERGEO`).
- Segredos: `wrangler secret put JWT_SECRET` (valor de produção, **não** o de `.dev.vars`). O `JWT_EXPIRES_IN`, `RATE_LIMIT_MAX` e `RATE_LIMIT_WINDOW_MS` vêm do `wrangler.toml`.
- Migrações em `migrations/`; a `0010b_shared_departures.sql` cria `shared_departures`/`shared_reservations` e tem de ficar antes da `0011`.

**Contas antigas (legado, NÃO publicar):**
- `fddsfds45@gmail.com` (`5c66df87ffad64dbf294a55663baa0d4`): **já não serve clientes.** Ainda aloja o Worker antigo `https://ladiesgo-api.ladiesgo-ao.workers.dev` e a D1 antiga `ladiesgo` (`84893b8b-5661-4fbc-a6aa-810ffbc1ab38`) com os dados originais — ficaram lá como histórico, mas os clientes já apontam para a rerere.
- `isabelcanjamba62@gmail.com` (`2ebfcbf70c6ea8d2b84130041528e249`): conta em espera/desativada — não usar.
- `ladiesgo-bh1.pages.dev` pertence à conta antiga; não é produção.

**Migração de dados (2026-10-28):** os dados da D1 antiga (contas, motoristas, 108 viagens, avaliações, 23.345 lugares, histórico) foram exportados (só leitura) e importados na D1 da rerere. As senhas (`pbkdf2$100000$…`) são compatíveis — o `verifyPassword` lê as iterações do hash, por isso o login por senha continua a funcionar. As 3 fotos de perfil em base64 (~120 KB) foram postas a `NULL` por ultrapassarem o limite de ~100 KB por statement da D1 (as fotos são reenviáveis na app).

**Incidente de quota da D1 (2026-10-17) — NAO REPETIR:**
Logo depois da migracao, a conta nova ficou sem poder **gravar** na D1 (erro 7500: 100.000 linhas
escritas/dia do plano Free, por **conta**). Causa: a BD foi reimportada **~9 vezes** no mesmo dia
(ver `~/.wrangler/logs` -> `POST .../d1/database/ea61eb36.../import`); cada import completo reinsere
os 23.345 registos de `places`, e varias tentativas falharam com `SQLITE_TOOBIG` e foram repetidas.
Enquanto a quota de escrita esta esgotada, TODA a escrita (criar utilizador, ficar online, pedidos,
chamadas) devolve **500** ate as 00:00 UTC (01:00 Angola); a leitura continua a funcionar.
Regra: importar a BD so uma vez e so o que mudou; preferir `wrangler d1 migrations apply`. O teto
diario de escritas e 100k e o de leituras 5M.
