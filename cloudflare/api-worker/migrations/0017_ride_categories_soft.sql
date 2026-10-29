-- Categorias de viagem: desativar e apagar sem perder o histórico.
--
-- Antes só existia code/name/color/mult/sort: não havia onde guardar
-- "indisponível" nem forma de tirar uma categoria da lista.
--
-- `active = 0`  -> não aparece na app (passageira e motorista), continua no
--                  painel admin para poder ser reativada.
-- `deleted = 1` -> sai do painel e da app, mas a LINHA FICA na tabela: é isso
--                  que faz `catMaps()` continuar a resolver o nome nas viagens
--                  antigas (as viagens guardam o code em `rideType`, não o nome).
--
-- Sem a linha, o histórico cairia no fallback 'Económico' e uma viagem de
-- "Família" passaria a aparecer como económica.

ALTER TABLE ride_categories ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ride_categories ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
