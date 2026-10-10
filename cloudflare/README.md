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
`EXPO_PUBLIC_API_URL=https://api.ladiesgo.ao/api/v1` (já em `mobile/eas.json`).
GPS adaptativo: 5s/10m em viagem, 10s/20m online (ver `mobile/src/services/driverBgLocation.ts`).
Sem socket obrigatório: REST polling em `GET /trips/:id` devolve motorista+ETA.
