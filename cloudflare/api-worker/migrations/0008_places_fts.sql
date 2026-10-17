-- ============================================================================
-- LADIESGO 2026-10-17 — Pesquisa de lugares com FTS5 (full-text search).
--
-- Porquê: a pesquisa por vários termos (ex.: "kilamba bloco") obrigava a varrer
-- as ~23.345 linhas de `places` com LIKE '%...%' em cada pedido. O FTS5 indexa
-- por palavras -> a pesquisa lê pouquíssimas linhas (indexadas).
--
-- ATENÇÃO (D1):
--   * `fts5` TEM de ser minúsculas — em MAIÚSCULAS a D1 responde "not authorized".
--   * Depois de existir uma tabela virtual, `wrangler d1 export` FALHA
--     ("cannot export databases with Virtual Tables (fts5)"). Fazer o backup
--     ANTES de aplicar esta migração (já temos backup-prod.sql / backup-split.sql).
--   * Requer ESCRITA (o rebuild insere os 23.345 registos no índice). Aplicar só
--     DEPOIS das 00:00 UTC reiniciar a quota D1 Free. NÃO reimportar a BD toda.
--
-- Aplicar (escolher UMA):
--   a) Direto (recomendado; a BD veio de um dump, logo a tabela `d1_migrations`
--      pode nao ter os 0001-0007 e o `migrations apply` tentaria repetir tudo):
--      wrangler d1 execute ladiesgo --remote --config wrangler.newaccount.toml --file=migrations/0008_places_fts.sql
--   b) Incremental (SO se `d1_migrations` já tiver os 0001-0007):
--      wrangler d1 migrations apply ladiesgo --remote --config wrangler.newaccount.toml
-- ============================================================================

-- Tabela virtual FTS5 em modo "external content": o índice guarda só as palavras
-- e lê o conteúdo real de `places` (content_rowid = id, que é o rowid da tabela).
CREATE VIRTUAL TABLE IF NOT EXISTS places_fts USING fts5(
  norm,
  content='places',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- Manter o índice sincronizado com `places` (a tabela é quase estática, mas os
-- triggers garantem consistência se algo for inserido/alterado/removido).
CREATE TRIGGER IF NOT EXISTS places_ai AFTER INSERT ON places BEGIN
  INSERT INTO places_fts(rowid, norm) VALUES (new.id, new.norm);
END;
CREATE TRIGGER IF NOT EXISTS places_ad AFTER DELETE ON places BEGIN
  INSERT INTO places_fts(places_fts, rowid, norm) VALUES ('delete', old.id, old.norm);
END;
CREATE TRIGGER IF NOT EXISTS places_au AFTER UPDATE ON places BEGIN
  INSERT INTO places_fts(places_fts, rowid, norm) VALUES ('delete', old.id, old.norm);
  INSERT INTO places_fts(rowid, norm) VALUES (new.id, new.norm);
END;

-- Popular o índice a partir dos dados já existentes em `places`.
INSERT INTO places_fts(places_fts) VALUES('rebuild');
