-- Perfil de motorista APPROVED para a conta de revisao +244923000002.
-- A conta de utilizador ja existe (criada via /auth/register).
-- Aplicar na conta Cloudflare nova (D1 ladiesgo):
--   node scripts/apply-review-driver.mjs

INSERT INTO drivers (id, "userId", "licenseNumber", "carPlate", "carMake", "carModel", "carYear", "carColor", status, "isOnline", rating, "totalTrips", "totalEarnings", "createdAt", "updatedAt")
SELECT
  lower(hex(randomblob(16))),
  u.id,
  'LA-0000-REVIEW',
  'LDG-0001',
  'Toyota',
  'Corolla',
  2019,
  'Branco',
  'APPROVED',
  0,
  5,
  0,
  0,
  datetime('now'),
  datetime('now')
FROM users u
WHERE u.phone = '+244923000002'
  AND NOT EXISTS (SELECT 1 FROM drivers d WHERE d."userId" = u.id);

-- Garantir que fica aprovada caso ja exista
UPDATE drivers SET status = 'APPROVED', "updatedAt" = datetime('now')
WHERE "userId" = (SELECT id FROM users WHERE phone = '+244923000002');

-- Confirmacao
SELECT d.id, d.status, d."isOnline", u.phone, u.name
FROM drivers d JOIN users u ON u.id = d."userId"
WHERE u.phone = '+244923000002';
