-- Fase 2 — OTP de viagem (4 dígitos, anti ghost rides)
-- Nenhum SMS é enviado; o código é gerado localmente e revelado só à passageira.
-- Aplicar: wrangler d1 migrations apply ladiesgo --remote --config wrangler.newaccount.toml

ALTER TABLE trips ADD COLUMN "otpCode" TEXT;          -- 4 chars (ex: "4827") — código em claro
ALTER TABLE trips ADD COLUMN "otpExpiresAt" TEXT;     -- ISO 8601 UTC; NULL = sem OTP ativo
ALTER TABLE trips ADD COLUMN "otpAttempts" INTEGER;   -- tentativas falhadas desde último accept (default 0)

CREATE INDEX IF NOT EXISTS idx_trips_otp ON trips ("otpCode") WHERE "otpCode" IS NOT NULL;
