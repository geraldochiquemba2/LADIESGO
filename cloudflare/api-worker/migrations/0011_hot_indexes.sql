-- LADIESGO — Índices quentes (proteção da quota de LEITURAS da D1 no plano Free).
-- Contexto: o plano Free da D1 dá 5.000.000 linhas lidas/dia e conta LINHAS VARRIDAS.
-- Sem estes índices, `shared_*`, `notifications` (contagem a cada 30s), `premium_reservations`
-- (expire em cada pedido) e `ratings` fazem SCAN completo da tabela a cada chamada.
-- Aplicar: npx wrangler d1 execute ladiesgo --remote --file=migrations/0011_hot_indexes.sql
-- (NÃO usar `migrations apply`: a BD veio de dump e 0005-0010 podem não estar marcadas.)

-- Viagens partilhadas (não tinham NENHUM índice; list/nearby/reserve/cancel/expire = full scan).
CREATE INDEX IF NOT EXISTS shared_dep_list_idx        ON shared_departures(status, scheduled_at, created_at);
CREATE INDEX IF NOT EXISTS shared_dep_driver_idx      ON shared_departures(driver_id, created_at);
CREATE INDEX IF NOT EXISTS shared_dep_expire_idx      ON shared_departures(status, expires_at);
CREATE INDEX IF NOT EXISTS shared_res_dep_idx         ON shared_reservations(departure_id, status, position);
CREATE INDEX IF NOT EXISTS shared_res_passenger_idx   ON shared_reservations(passenger_id, status);
CREATE INDEX IF NOT EXISTS shared_res_expire_idx      ON shared_reservations(status, expires_at);

-- Notificações: a contagem de não-lidas corre a cada 30s por utilizador; índice parcial
-- só sobre as não-lidas (escrita zero quando a notificação é lida).
CREATE INDEX IF NOT EXISTS notifications_unread_idx   ON notifications("userId", "createdAt") WHERE "isRead" = 0;

-- Premium: premiumExpire() corre em TODA chamada premium (GET/POST/pay) — antes varria tudo.
CREATE INDEX IF NOT EXISTS premium_res_expire_idx     ON premium_reservations(status, expires_at);

-- Avaliações: perfil (minhas recebidas / pendentes por viagem) varria a tabela toda.
CREATE INDEX IF NOT EXISTS ratings_trip_idx           ON ratings("tripId");
CREATE INDEX IF NOT EXISTS ratings_rated_idx          ON ratings("ratedId", "createdAt");
