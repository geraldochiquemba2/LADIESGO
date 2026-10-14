-- O trips_driver_idx indexava também driverId = NULL, pelo que o INSERT de um
-- pedido (ainda sem motorista) gravava uma entrada extra no índice (5 escritas
-- em vez de 4). Como todas as queries filtram por driverId = <valor> (nunca
-- NULL), o índice passa a PARCIAL só das viagens com motorista atribuído.
-- Aplicar: wrangler d1 execute ladiesgo --remote --file=migrations/0005_driver_idx_partial.sql

DROP INDEX IF EXISTS trips_driver_idx;
CREATE INDEX IF NOT EXISTS trips_driver_idx ON trips("driverId") WHERE "driverId" IS NOT NULL;
