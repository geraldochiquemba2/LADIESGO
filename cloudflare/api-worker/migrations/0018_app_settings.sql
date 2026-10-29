-- LADIESGO — Definições da app (chave/valor). Usada pelos dados bancários do Premium.
-- Aplicar: npx wrangler d1 migrations apply ladiesgo --remote
CREATE TABLE IF NOT EXISTS app_settings (
  k TEXT PRIMARY KEY,
  v TEXT,
  updated_at TEXT
);

-- Fila do Premium: as contagens de fila e o varrimento de prazos passam a
-- consultar por (carro, estado, posição) em cada pedido.
CREATE INDEX IF NOT EXISTS premium_res_active_idx
  ON premium_reservations (car_id, status, position);
