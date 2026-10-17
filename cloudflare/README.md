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
`EXPO_PUBLIC_API_URL=https://ladiesgo-api.ladiesgo-angola.workers.dev/api/v1` (em `mobile/eas.json`; trocar para `https://api.ladiesgo.ao/api/v1` quando o domínio .ao existir com custom domain no Worker).
GPS adaptativo: 5s/10m em viagem, 10s/20m online (ver `mobile/src/services/driverBgLocation.ts`).
Sem socket obrigatório: REST polling em `GET /trips/:id` devolve motorista+ETA.

## 4. Conta Cloudflare ativa (2026-10-17) — registo e como reverter

**Motivo:** a conta antiga esgotou a quota diaria de Workers Free (100.000 pedidos/dia, erro 1027 / HTTP 429). A API e a base de dados D1 foram migradas para uma 2ª conta Cloudflare (plano Free, quota nova).

**Conta NOVA (ativa):**
- Email: `isabelcanjamba62@gmail.com`
- Account ID: `2ebfcbf70c6ea8d2b84130041528e249`
- Subdominio workers.dev: `ladiesgo-angola`
- Worker/API: `https://ladiesgo-api.ladiesgo-angola.workers.dev`
- D1: `ladiesgo` (id `ea61eb36-483c-484f-b364-f82c844c0b30`)
- Deploy do Worker: `cd cloudflare/api-worker` + `wrangler deploy --config wrangler.newaccount.toml`

**Conta ANTIGA (neutralizada ate a quota reiniciar ~01:00 Angola):**
- Email: `fddsfds45@gmail.com`
- Account ID: `5c66df87ffad64dbf294a55663baa0d4`
- Worker/API: `https://ladiesgo-api.ladiesgo-ao.workers.dev`
- Subdominio: `ladiesgo-ao`
- D1: `ladiesgo` (id `84893b8b-5661-4fbc-a6aa-810ffbc1ab38`)
- O Pages (`ladiesgo.pages.dev`) continua nesta conta — é estatico, gratuito e ilimitado (nao consome a quota).

**Como VOLTAR AO NORMAL (para a conta antiga):**
1. Em `webapp/*.html` e `mobile/**`, trocar `ladiesgo-api.ladiesgo-angola.workers.dev` -> `ladiesgo-api.ladiesgo-ao.workers.dev`.
2. `wrangler login` na conta antiga (`fddsfds45@gmail.com`) + `wrangler pages deploy webapp --project-name=ladiesgo` (o Pages pertence a essa conta).
3. Mobile: ajustar `EXPO_PUBLIC_API_URL` em `mobile/eas.json` e gerar novo build (EAS).
4. Cada ficheiro alterado tem um comentario `>> LADIESGO 2026-10-17` a marcar o ponto exato.

**Backup / import:**
- `C:\Users\Geraldo\backup-prod.sql` — export D1 de produção (utilizadoras reais).
- `C:\Users\Geraldo\backup-split.sql` — versão com as fotos base64 divididas (o import falha com `SQLITE_TOOBIG` se as fotos num INSERT unico forem demasiado grandes).

**Nota:** o `JWT_SECRET` da conta nova é o de dev (`.dev.vars`) -> as sessões antigas caem; o login por password continua a funcionar.
