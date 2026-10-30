-- LADIESGO - 0022: log do "guarda de viagens esquecidas".
--
-- PORQUÊ: uma viagem que fica aberta (REQUESTED/ACCEPTED/DRIVER_ARRIVED/IN_PROGRESS)
-- sem ninguém a mexer nela continua a gastar quota 24/7 — o WS da viagem, o ciclo do
-- GPS e o polling dos dois lados. Medido em 2026-10-30: ~600 pedidos de Durable Object
-- por hora e por viagem aberta; fechar à 4.ª hora custa ~15 linhas escritas.
--
-- O modo vive em `system_flags.stale_guard` (0021): 'off' | 'shadow' | 'on'.
-- Sem linha = 'shadow' (só observa). Em 'shadow' este log é o único sítio onde as
-- candidatas aparecem, para o dono as rever antes de ligar o modo 'on'.
--
-- Escritas: 0 num dia normal (só se escreve quando há candidatas de facto).
-- O purga é feito no cron diário (07 dias de retenção).
--
-- Aplicar: npx wrangler@4.151.1 d1 migrations apply ladiesgo --remote
CREATE TABLE IF NOT EXISTS stale_guard_log (
  id TEXT PRIMARY KEY,
  "createdAt" TEXT,
  mode TEXT,
  "tripId" TEXT,
  status TEXT,
  reason TEXT,
  "ageMin" INTEGER,
  "idleMin" INTEGER,
  action TEXT
);

CREATE INDEX IF NOT EXISTS stale_guard_log_created_idx ON stale_guard_log("createdAt");
