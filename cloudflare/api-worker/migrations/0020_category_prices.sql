-- Preço por pessoa de cada categoria (usado nas partidas compartilhadas).
--
-- Até aqui o preço por pessoa era calculado pela distância (sharedQuote) ou caía
-- num mapa fixo no HTML (SHARED_PPS). O dono quer o valor na BD:
--   Económico · 1500 Kz / pessoa
--   Conforto  · 2500 Kz / pessoa
--   Família   · 3500 Kz / pessoa
--
-- `basePrice` = 0 significa "sem preço fixo": o cliente volta a calcular pela
-- distância (comportamento antigo), para não partir nenhuma categoria criada
-- depois sem preço definido.

ALTER TABLE ride_categories ADD COLUMN "basePrice" INTEGER NOT NULL DEFAULT 0;

UPDATE ride_categories SET "basePrice" = 1500 WHERE code = 'ECONOMY';
UPDATE ride_categories SET "basePrice" = 2500 WHERE code = 'COMFORT';
UPDATE ride_categories SET "basePrice" = 3500 WHERE code = 'PREMIUM';

-- "Família" volta a estar disponível (tinha sido apagada) e "Kids!" sai da app.
-- A linha do KIDS fica na tabela (deleted = 1) para o histórico continuar a
-- resolver o nome das viagens antigas — ver 0017_ride_categories_soft.sql.
UPDATE ride_categories SET active = 1, deleted = 0, sort = 3, name = 'Família' WHERE code = 'PREMIUM';
UPDATE ride_categories SET active = 0, deleted = 1 WHERE code = 'KIDS';
