-- 0016_push_diagnostics.sql
-- Diagnóstico do token de push.
--
-- Contexto (2026-10-29): a app pedia a permissão de notificações, a pessoa
-- aceitava, mas `getExpoPushTokenAsync()` falhava dentro de um `catch {}` — não
-- havia token na tabela `users` e o servidor não tinha para onde enviar. Esta
-- tabela guarda a mensagem de erro que o aparelho reporta em
-- POST /api/v1/users/push-diagnostic, para se perceber a causa no terreno
-- (entitlement em falta no iOS, google-services.json no Android, project id, …).
--
-- Só texto técnico: sem nome, telefone nem localização. Limpar com
--   DELETE FROM push_diagnostics WHERE "createdAt" < datetime('now','-7 days');

CREATE TABLE IF NOT EXISTS push_diagnostics (
  id TEXT PRIMARY KEY,
  "userId" TEXT,
  platform TEXT,
  error TEXT,
  "createdAt" TEXT
);

CREATE INDEX IF NOT EXISTS push_diagnostics_created ON push_diagnostics ("createdAt");
CREATE INDEX IF NOT EXISTS push_diagnostics_user ON push_diagnostics ("userId");
