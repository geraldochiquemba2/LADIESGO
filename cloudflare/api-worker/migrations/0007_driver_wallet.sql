-- LADIESGO — sistema de pontos/carregamento do motorista (D1/SQLite)
-- Aplicar: wrangler d1 execute ladiesgo --remote --file=migrations/0007_driver_wallet.sql
--          wrangler d1 execute ladiesgo --local  --file=migrations/0007_driver_wallet.sql
--
-- Regra: cada viagem concluida debita 14% do valor final (finalFare) da carteira
-- do motorista (users."walletBalance"). Se a carteira ficar negativa, conta como
-- viagem negativa ("negTrips"); ao atingir 3 viagens negativas a conta e bloqueada
-- ("walletBlocked"=1) e a motorista fica offline ate carregar a conta.

ALTER TABLE users ADD COLUMN "negTrips" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN "walletBlocked" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS wallet_tx (
  id TEXT PRIMARY KEY,
  "userId" TEXT,
  type TEXT NOT NULL,            -- TOPUP (carregamento) | COMMISSION (14%)
  amount REAL NOT NULL,          -- positivo no carregamento, negativo na comissao
  "balanceAfter" REAL NOT NULL,
  "tripId" TEXT,
  note TEXT,
  "createdAt" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS wallet_tx_user_idx ON wallet_tx("userId", "createdAt");
