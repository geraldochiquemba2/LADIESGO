-- Credenciais TURN Metered com expiração (rotação diária).
-- Uma linha por credencial criada; a mais recente não expirada é a que o /turn/ice serve.
CREATE TABLE IF NOT EXISTS turn_credentials (
  username TEXT PRIMARY KEY,
  "apiKey" TEXT NOT NULL,
  label TEXT NOT NULL,
  "createdAtMs" INTEGER NOT NULL,
  "expiresAtMs" INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS turn_credentials_label_idx
  ON turn_credentials (label, "createdAtMs" DESC);
