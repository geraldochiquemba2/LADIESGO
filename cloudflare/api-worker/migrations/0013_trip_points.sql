-- Fase 2 — histórico mínimo de posições da motorista por viagem (auditoria).
-- 1 ponto/30 s (≈40 linhas numa viagem de 20 min), retenção de 30 dias.
-- A posição viva continua só em memória (DriverGeo/TripPush); isto serve para
-- disputas, distância real e "onde estava às 21h".
-- Aplicar: npx wrangler d1 execute ladiesgo --remote --file=migrations/0013_trip_points.sql
-- (ou `migrations apply` se as anteriores estiverem todas marcadas)

CREATE TABLE IF NOT EXISTS trip_points (
  id TEXT PRIMARY KEY,
  "tripId" TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy REAL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS trip_points_trip_ts_idx ON trip_points("tripId", ts);
CREATE INDEX IF NOT EXISTS trip_points_ts_idx       ON trip_points(ts);
