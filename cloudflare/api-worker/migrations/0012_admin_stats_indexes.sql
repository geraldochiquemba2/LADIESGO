-- LADIESGO — Índices do painel de admin (quota de LEITURAS da D1 no plano Free).
-- Contexto: o plano Free da D1 dá 5.000.000 linhas lidas/dia e conta LINHAS VARRIDAS.
-- As listas do admin (/admin/stats, /trips, /users, /drivers, /wallet) filtram por
-- status/role/isActive e ordenam por "createdAt" — sem índice = SCAN completo.
-- Descobriu-se ainda que `trips_status_idx` (de 0001) NÃO existe na D1 de produção,
-- o que faz /admin/stats (GROUP BY status) varrer a tabela toda a cada abertura.
-- Aplicar: npx wrangler d1 execute ladiesgo --remote --file=migrations/0012_admin_stats_indexes.sql
-- (NÃO usar `migrations apply`: a BD veio de dump e 0005-0012 podem não estar marcadas.)

-- /admin/stats (GROUP BY status) e /admin/trips (filtro por status, ORDER BY createdAt):
-- este índice de 0001 estava em falta na D1 real.
CREATE INDEX IF NOT EXISTS trips_status_idx          ON trips(status, "createdAt");

-- /admin/drivers e /admin/drivers/pending: WHERE status = ? ORDER BY "createdAt" DESC.
-- (drivers_status_idx existente é ("isOnline", status) — não serve para filtrar status.)
CREATE INDEX IF NOT EXISTS drivers_status_created_idx ON drivers(status, "createdAt");

-- /admin/stats (utilizadores ativos) e /admin/users lista sem filtro de role.
CREATE INDEX IF NOT EXISTS users_active_created_idx  ON users("isActive", "createdAt");

-- /admin/users com filtro de role: WHERE "isActive" AND role = ?.
CREATE INDEX IF NOT EXISTS users_active_role_idx     ON users("isActive", role);

-- /admin/wallet: WHERE role='DRIVER' ORDER BY "walletBalance" ASC (índice parcial).
CREATE INDEX IF NOT EXISTS users_driver_wallet_idx   ON users("walletBalance") WHERE role = 'DRIVER';
