-- O índice único ratings_trip_rater (tripId, raterId) só servia para dedupe e para o
-- lookup de /ratings/pending — e era reescrito em cada avaliação. Passa-se o id a
-- determinístico ("tripId:raterId"): o dedupe fica garantido pela PRIMARY KEY (que já
-- existe) e /ratings/pending faz lookup pela própria PK. Remove o índice extra.
-- Aplicar: wrangler d1 execute ladiesgo --remote --file=migrations/0004_ratings_deterministic_id.sql

UPDATE ratings SET id = "tripId" || ':' || "raterId";
DROP INDEX IF EXISTS ratings_trip_rater;
