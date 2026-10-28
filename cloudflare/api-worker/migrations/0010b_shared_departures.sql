-- LADIESGO — tabelas das viagens partilhadas (bolt/van).
-- Contexto: estas tabelas existiam na BD antiga mas nunca foram criadas por
-- migração (a BD antiga veio de dump), por isso a 0011 falhava aqui.
-- Esquema reconstruído a partir de TODAS as queries do index.ts (31 usos).

CREATE TABLE IF NOT EXISTS shared_departures (
  id              TEXT PRIMARY KEY,
  driver_id       TEXT NOT NULL,
  origin_lat      REAL,
  origin_lng      REAL,
  origin_name     TEXT,
  dest_lat        REAL,
  dest_lng        REAL,
  dest_name       TEXT,
  category        TEXT,
  total_price     REAL NOT NULL DEFAULT 0,
  price_per_seat  REAL NOT NULL DEFAULT 0,
  total_seats     INTEGER NOT NULL DEFAULT 1,
  seats_taken     INTEGER NOT NULL DEFAULT 0,
  iban            TEXT,
  express_code    TEXT,
  whatsapp_number TEXT,
  scheduled_at    TEXT,
  expires_at      TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  alert_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT
);

CREATE TABLE IF NOT EXISTS shared_reservations (
  id           TEXT PRIMARY KEY,
  departure_id TEXT NOT NULL,
  passenger_id TEXT NOT NULL,
  position     INTEGER,
  status       TEXT NOT NULL DEFAULT 'pending',
  expires_at   TEXT,
  created_at   TEXT,
  approved_at  TEXT
);
