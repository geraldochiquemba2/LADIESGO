-- LADIESGO — Reserva Premium / Gold (criada pelo ADMIN; usada pelas PASSAGEIRAS)
-- Aplicar: npx wrangler d1 execute ladiesgo --remote --file=migrations/0010_premium_fleet.sql
-- (NÃO usar `migrations apply`: a BD veio de dump e 0005-0009 podem nao estar marcadas.)

CREATE TABLE IF NOT EXISTS premium_fleet (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL DEFAULT 'Gold',
  make TEXT, model TEXT, color TEXT, year INTEGER, plate TEXT,
  price_per_km INTEGER NOT NULL DEFAULT 300,
  driver_id TEXT,
  photo TEXT,
  status TEXT NOT NULL DEFAULT 'available',   -- available | unavailable | reserved
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS premium_reservations (
  id TEXT PRIMARY KEY,
  car_id TEXT NOT NULL,
  category TEXT,
  passenger_id TEXT NOT NULL,
  pickup_lat REAL, pickup_lng REAL, pickup_name TEXT,
  dest_lat REAL, dest_lng REAL, dest_name TEXT,
  scheduled_at TEXT,
  distance_km REAL,
  price_total INTEGER,
  position INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | confirmed | expired | cancelled | completed
  expires_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS premium_fleet_cat_idx ON premium_fleet(category, status, active);
CREATE INDEX IF NOT EXISTS premium_res_car_idx ON premium_reservations(car_id, status);
CREATE INDEX IF NOT EXISTS premium_res_pax_idx ON premium_reservations(passenger_id, status);
