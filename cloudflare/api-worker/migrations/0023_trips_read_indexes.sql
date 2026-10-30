-- 0023_trips_read_indexes.sql
-- Corta as duas queries "normais" mais caras da API (medido 2026-10-30).
--
-- ANTES (meta.rows_read, produção):
--   GET /api/v1/trips/history    (LIMIT 30)  319 linhas  <- USE TEMP B-TREE FOR ORDER BY
--   GET /api/v1/trips/history    (LIMIT 8)   319 linhas  <- shed nível 2 não poupava NADA
--   GET /api/v1/trips/history    motorista   315 linhas
--   GET /api/v1/ratings/pending  (LIMIT 5)    83 linhas
--
-- DEPOIS (staging, mesma base de 121 viagens, medido com meta.rows_read):
--   /trips/history LIMIT 30   90  (-72%)
--   /trips/history LIMIT  8   22  (-93%)  <- o shed passou a poupar a sério
--   /trips/history motorista 120  (-62%)
--   /ratings/pending          11  (-87%)
--   /trips/active              5  (sem alteração; continua com INDEXED BY trips_status_idx)
--
-- CUSTO EM ESCRITAS (medido em staging, ciclo REQUESTED -> ACCEPTED -> IN_PROGRESS -> COMPLETED):
--   12 -> 13 linhas escritas (+1 por viagem), porque os dois índices que estes substituem
--   (trips_passenger_idx e trips_driver_idx) foram apagados na mesma migração.
--   O plano Free dá 5M leituras / 100k escritas (50:1): +1 escrita ≈ 50 leituras equivalentes,
--   e cada abertura do Histórico poupa 229 (LIMIT 30) a 297 (LIMIT 8).
--
-- NÃO apagar `trips_status_idx` — é usado por INDEXED BY em /trips/active e /trips/request
-- (migração 0012); se desaparecer, essas queries falham com "no such index".

-- 1) Histórico da passageira: WHERE "passengerId" = ? ORDER BY "createdAt" DESC
--    Elimina o TEMP B-TREE (lê 30 em vez de varrer as 76 viagens da pessoa).
CREATE INDEX IF NOT EXISTS trips_pax_created_idx ON trips("passengerId", "createdAt");

-- 2) Histórico da motorista: WHERE "driverId" = ? ORDER BY "createdAt" DESC
--    PARCIAL (só viagens com motorista): nas REQUESTED não ocupa espaço nem escritas.
CREATE INDEX IF NOT EXISTS trips_drv_created_idx ON trips("driverId", "createdAt") WHERE "driverId" IS NOT NULL;

-- 3) Viagens concluídas por avaliar: WHERE status = 'COMPLETED' AND "passengerId" = ?
--    PARCIAL e ordenado por "completedAt" (a ordem do /ratings/pending). Um índice completo
--    sobre (status, …) custava +1 escrita em ACCEPTED e IN_PROGRESS; este custa só no COMPLETED.
CREATE INDEX IF NOT EXISTS trips_completed_pax_idx ON trips("passengerId", "completedAt") WHERE status = 'COMPLETED';

-- 4) Os dois índices antigos ficam redundantes: são prefixos dos novos
--    (passengerId) ⊂ (passengerId, createdAt) e (driverId) ⊂ (driverId, createdAt).
--    Apagá-los devolve a escrita extra que os índices novos custam. Nenhum código os
--    referencia por nome (os INDEXED BY usam só trips_status_idx).
DROP INDEX IF EXISTS trips_passenger_idx;
DROP INDEX IF EXISTS trips_driver_idx;
