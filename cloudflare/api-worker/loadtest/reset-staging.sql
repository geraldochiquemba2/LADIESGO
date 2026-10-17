-- LadiesGo — limpar TODOS os dados gerados pelos testes de fogo no STAGING.
-- Preserva dados de referência: places (23346 lugares de Luanda) e ride_categories.
--
-- Correr SEMPRE contra o staging (nunca produção):
--   npx wrangler@4.151.1 d1 execute ladiesgo-staging --remote --env staging --file=loadtest/reset-staging.sql
--
-- Sem foreign keys no schema, a ordem e apenas logica (filhos -> pais).

DELETE FROM wallet_tx;       -- comissoes/topups das viagens de teste
DELETE FROM ratings;         -- avaliacoes
DELETE FROM chat_messages;   -- chat das viagens
DELETE FROM call_logs;       -- logs de chamadas
DELETE FROM notifications;   -- notificacoes
DELETE FROM trips;           -- viagens (todas, incluindo canceladas)
DELETE FROM drivers;         -- perfis de motorista
DELETE FROM users;           -- contas (master admin 999999999 e hardcoded, nao vive aqui)

-- Referencia: NAO apagar (evita reimportar).
-- DELETE FROM places;
-- DELETE FROM ride_categories;
