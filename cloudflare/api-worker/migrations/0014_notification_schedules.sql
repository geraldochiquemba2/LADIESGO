-- Notificações semanais programadas pelo admin (horários em Africa/Luanda).
-- Aplicar: npx wrangler d1 migrations apply ladiesgo --remote

CREATE TABLE IF NOT EXISTS notification_schedules (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL DEFAULT 'ALL',
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  "dayOfWeek" INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  "createdAt" TEXT DEFAULT (datetime('now')),
  "updatedAt" TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notification_schedule_slots (
  id TEXT PRIMARY KEY,
  "scheduleId" TEXT NOT NULL,
  time TEXT NOT NULL,
  "lastRunKey" TEXT,
  "createdAt" TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS notification_schedules_day_idx ON notification_schedules(enabled, "dayOfWeek");
CREATE INDEX IF NOT EXISTS notification_schedule_slots_schedule_idx ON notification_schedule_slots("scheduleId");
