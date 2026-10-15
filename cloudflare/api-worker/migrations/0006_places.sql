-- Índice de lugares (base nova Yango GOD, 23346 locais de Luanda) para a
-- pesquisa de moradas. norm/nname são versões normalizadas (minúsculas + sem
-- acentos) para LIKE rápido e para boost de prefixo.
-- Aplicar: wrangler d1 execute ladiesgo --remote --file=migrations/0006_places.sql

CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  nname TEXT NOT NULL,
  norm TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  type TEXT,
  municipality TEXT,
  province TEXT,
  street TEXT,
  "number" TEXT
);
CREATE INDEX IF NOT EXISTS places_lat_idx ON places(lat);
CREATE INDEX IF NOT EXISTS places_lng_idx ON places(lng);
CREATE INDEX IF NOT EXISTS places_nname_idx ON places(nname);
