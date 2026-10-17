-- LadiesGo — limpar contas e viagens de TESTE da PRODUCAO (D1 ladiesgo).
-- MANTEM os utilizadores reais: Geralda Abreu, Maria Gaspar, Albertina Tati,
-- Ayercia (e 1 driver + 40 viagens associadas a contas reais).
--
-- Criterio de "teste" (nao toca em contas reais):
--   length(phone) > 15  -> telefones de teste sao +244 + 9 digitos RUN + 4-5 digitos
--   name GLOB 'LT-*' / 'WS-*' -> prefixos dos harnesses
--   name IN ('Diag','Probe')   -> contas de diagnostico
--
-- !!! DESTRUTIVO E IRREVERSIVEL. Fazer BACKUP antes:
--   npx wrangler@4.151.1 d1 export ladiesgo --remote --output=backup-prod.sql
-- Depois correr:
--   npx wrangler@4.151.1 d1 execute ladiesgo --remote --file=loadtest/cleanup-prod-test-accounts.sql
--
-- Estimativa (dry-run): 1334 users, 1104 drivers, 214 trips removidos.
-- Dry-run (contagens):
--   SELECT COUNT(*) FROM users WHERE length(phone) > 15 OR name GLOB 'LT-*' OR name GLOB 'WS-*' OR name IN ('Diag','Probe');

-- 1) dados dependentes (primeiro)
DELETE FROM wallet_tx
WHERE "userId" IN (SELECT id FROM users WHERE length(phone) > 15 OR name GLOB 'LT-*' OR name GLOB 'WS-*' OR name IN ('Diag','Probe'));

DELETE FROM notifications
WHERE "userId" IN (SELECT id FROM users WHERE length(phone) > 15 OR name GLOB 'LT-*' OR name GLOB 'WS-*' OR name IN ('Diag','Probe'));

DELETE FROM ratings
WHERE "raterId" IN (SELECT id FROM users WHERE length(phone) > 15 OR name GLOB 'LT-*' OR name GLOB 'WS-*' OR name IN ('Diag','Probe'))
   OR "ratedId" IN (SELECT id FROM users WHERE length(phone) > 15 OR name GLOB 'LT-*' OR name GLOB 'WS-*' OR name IN ('Diag','Probe'))
   OR "tripId" IN (SELECT id FROM trips
                   WHERE "passengerId" IN (SELECT id FROM users WHERE length(phone) > 15 OR name GLOB 'LT-*' OR name GLOB 'WS-*' OR name IN ('Diag','Probe'))
                      OR "driverId" IN (SELECT id FROM drivers WHERE "userId" IN (SELECT id FROM users WHERE length(phone) > 15 OR name GLOB 'LT-*' OR name GLOB 'WS-*' OR name IN ('Diag','Probe'))));

DELETE FROM chat_messages
WHERE "senderId" IN (SELECT id FROM users WHERE length(phone) > 15 OR name GLOB 'LT-*' OR name GLOB 'WS-*' OR name IN ('Diag','Probe'))
   OR "tripId" IN (SELECT id FROM trips
                   WHERE "passengerId" IN (SELECT id FROM users WHERE length(phone) > 15 OR name GLOB 'LT-*' OR name GLOB 'WS-*' OR name IN ('Diag','Probe'))
                      OR "driverId" IN (SELECT id FROM drivers WHERE "userId" IN (SELECT id FROM users WHERE length(phone) > 15 OR name GLOB 'LT-*' OR name GLOB 'WS-*' OR name IN ('Diag','Probe'))));

DELETE FROM call_logs
WHERE "tripId" IN (SELECT id FROM trips
                   WHERE "passengerId" IN (SELECT id FROM users WHERE length(phone) > 15 OR name GLOB 'LT-*' OR name GLOB 'WS-*' OR name IN ('Diag','Probe'))
                      OR "driverId" IN (SELECT id FROM drivers WHERE "userId" IN (SELECT id FROM users WHERE length(phone) > 15 OR name GLOB 'LT-*' OR name GLOB 'WS-*' OR name IN ('Diag','Probe'))));

-- 2) viagens de teste
DELETE FROM trips
WHERE "passengerId" IN (SELECT id FROM users WHERE length(phone) > 15 OR name GLOB 'LT-*' OR name GLOB 'WS-*' OR name IN ('Diag','Probe'))
   OR "driverId" IN (SELECT id FROM drivers WHERE "userId" IN (SELECT id FROM users WHERE length(phone) > 15 OR name GLOB 'LT-*' OR name GLOB 'WS-*' OR name IN ('Diag','Probe')));

-- 3) perfis de motorista de teste
DELETE FROM drivers
WHERE "userId" IN (SELECT id FROM users WHERE length(phone) > 15 OR name GLOB 'LT-*' OR name GLOB 'WS-*' OR name IN ('Diag','Probe'));

-- 4) contas de teste
DELETE FROM users
WHERE length(phone) > 15 OR name GLOB 'LT-*' OR name GLOB 'WS-*' OR name IN ('Diag','Probe');
