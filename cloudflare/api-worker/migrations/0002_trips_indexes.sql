-- Reduz escritas/viagem: 'status' como 2º campo fazia cada transição reescrever
-- os 3 índices de trips. Mantém-se apenas no índice dedicado (trips_status_idx),
-- usado no feed de pedidos REQUESTED; os outros indexam só a coluna de ligação.
-- Aplicar: wrangler d1 execute ladiesgo --remote --file=migrations/0002_trips_indexes.sql

DROP INDEX IF EXISTS trips_passenger_idx;
DROP INDEX IF EXISTS trips_driver_idx;
CREATE INDEX IF NOT EXISTS trips_passenger_idx ON trips("passengerId");
CREATE INDEX IF NOT EXISTS trips_driver_idx ON trips("driverId");
