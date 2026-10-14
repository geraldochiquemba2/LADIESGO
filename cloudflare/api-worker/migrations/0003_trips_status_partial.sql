-- Reduz escritas/viagem: o índice dedicado de status (status, "createdAt") era
-- reescrito em TODAS as transições (accept/arrived/start/complete = ~4 escritas
-- por viagem). Só o feed de pedidos REQUESTED precisa dele a quente; o dashboard
-- admin passou a ser manual (botão Atualizar), pelo que o GROUP BY status deixou
-- de correr a cada 3s. Substitui-se por um índice PARCIAL só de REQUESTED: entra
-- no INSERT e sai no accept; as restantes transições deixam de tocar em índice.
-- Aplicar: wrangler d1 execute ladiesgo --remote --file=migrations/0003_trips_status_partial.sql

DROP INDEX IF EXISTS trips_status_idx;
CREATE INDEX IF NOT EXISTS trips_pending_idx ON trips("createdAt") WHERE status = 'REQUESTED';
