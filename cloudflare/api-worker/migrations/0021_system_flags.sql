-- LADIESGO — 0021: flags de sistema (chave/valor) para o "corte de carga" da quota.
--
-- PORQUÊ: os contadores de src/budget.ts são POR ISOLATE; a única medida
-- autoritativa da quota diária é a da CONTA (GraphQL Analytics API). O vigilante
-- `scripts/quota-watch.mjs --apply-shed` escreve aqui o nível, e o Worker lê-o
-- (1 linha por isolate a cada 60 s) para se degradar com elegância ANTES de
-- bater no muro (100% = a D1 recusa TODAS as queries até às 00:00 UTC).
--
--   quota_shed = '0'  normal
--   quota_shed = '1'  pesquisa de lugares não toca na D1 (cache + Photon/Nominatim)
--   quota_shed = '2'  + histórico devolve 8 viagens em vez de 30
--
-- Sem linha (ou tabela ausente) = nível 0: o Worker nunca parte por causa disto.
--
-- Aplicar: npx wrangler d1 migrations apply ladiesgo --remote
CREATE TABLE IF NOT EXISTS system_flags (
  key TEXT PRIMARY KEY,
  value TEXT,
  updatedAt TEXT
);
