// LadiesGo! API — Cloudflare Workers + Hono + Neon HTTP.
// Sem Render. Contratos 1:1 com mobile/src/services/api.ts.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { neon } from '@neondatabase/serverless';

type Env = { DATABASE_URL: string; JWT_SECRET: string; JWT_EXPIRES_IN?: string; METERED_DOMAIN?: string; METERED_TURN_APIKEY?: string; METERED_FREE_MB?: string };

const app = new Hono<{ Bindings: Env }>();
app.use('*', cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization'], allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));

// ─── JWT HS256 via WebCrypto (sem deps Node) ───
function b64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function expSeconds(exp: string): number {
  const m = /^(\d+)([smhd])$/.exec(exp || '7d');
  if (!m) return 7 * 86400;
  const n = Number(m[1]);
  return m[2] === 's' ? n : m[2] === 'm' ? n * 60 : m[2] === 'h' ? n * 3600 : n * 86400;
}
async function signJwt(payload: Record<string, unknown>, secret: string, exp: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expSeconds(exp) };
  const h = b64url(JSON.stringify(header));
  const b = b64url(JSON.stringify(body));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h}.${b}`));
  return `${h}.${b}.${b64url(sig)}`;
}
async function verifyJwt(token: string, secret: string): Promise<any> {
  const [h, b, s] = token.split('.');
  if (!h || !b || !s) throw new Error('bad token');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, unb64url(s), new TextEncoder().encode(`${h}.${b}`));
  if (!ok) throw new Error('bad sig');
  const payload = JSON.parse(new TextDecoder().decode(unb64url(b)));
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) throw new Error('expired');
  return payload;
}

function withoutHash(u: any) {
  if (!u) return u;
  const { passwordHash, passwordhash, ...safe } = u;
  return safe;
}
function havKm(aLa: number, aLo: number, bLa: number, bLo: number): number {
  const R = 6371, t = Math.PI / 180;
  const dLa = (bLa - aLa) * t, dLo = (bLo - aLo) * t;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(aLa * t) * Math.cos(bLa * t) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function pinForTrip(id: string): string {
  let h = 0;
  for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return String(1000 + (h % 9000));
}
const BASE_FARE = 5, PER_KM = 2.5;
const RIDE_MULT: Record<string, number> = { ECONOMY: 1.0, COMFORT: 1.35, PREMIUM: 1.7 };
// Categorias geridas no painel admin (nome/cor/mult editáveis; code estável).
async function getCategories(sql: any) {
  await sql`CREATE TABLE IF NOT EXISTS ride_categories (code TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#61188E', mult NUMERIC NOT NULL DEFAULT 1, sort INT NOT NULL DEFAULT 0)`;
  await sql`INSERT INTO ride_categories (code, name, color, mult, sort) VALUES ('ECONOMY','Económico','#61188E',1.0,1),('COMFORT','Conforto','#ff5fc8',1.4,2),('PREMIUM','Família','#5b21c9',1.65,3) ON CONFLICT (code) DO NOTHING`;
  const rows = await sql`SELECT code, name, color, mult FROM ride_categories ORDER BY sort, code`;
  return rows.map((r: any) => ({ code: r.code, name: r.name, color: r.color, mult: Number(r.mult) }));
}
async function catMaps(sql: any) {
  const byCode: Record<string, string> = { ECONOMY: 'Económico', COMFORT: 'Conforto', PREMIUM: 'Família' };
  const byName: Record<string, string> = { 'Económico': 'ECONOMY', 'Conforto': 'COMFORT', 'Família': 'PREMIUM' };
  const mults: Record<string, number> = { ...RIDE_MULT };
  try {
    for (const c of await getCategories(sql)) {
      byCode[c.code] = c.name; byName[c.name] = c.code; mults[c.code] = c.mult;
    }
  } catch {}
  return { byCode, byName, mults };
}
function surgeNow(): number {
  const h = new Date().getHours();
  if ((h >= 7 && h <= 9) || (h >= 17 && h <= 20)) return 1.3;
  if (h >= 23 || h <= 2) return 1.2;
  return 1.0;
}

// ─── auth middleware ───
async function requireAuth(c: any, next: any) {
  const ah = c.req.header('Authorization') || '';
  const token = ah.startsWith('Bearer ') ? ah.slice(7) : '';
  if (!token) return c.json({ message: 'Não autenticado.' }, 401);
  try {
    const p = await verifyJwt(token, c.env.JWT_SECRET);
    c.set('user', p);
    await next();
  } catch {
    return c.json({ message: 'Sessão inválida.' }, 401);
  }
}

// ─── health ───
app.get('/ping', (c) => c.json({ ok: true, ts: Date.now(), worker: true }));
app.get('/api/v1/health', (c) => c.json({ ok: true, ts: Date.now() }));
app.get('/api', (c) => c.json({ name: 'LadiesGo! API', status: 'online', runtime: 'cloudflare-workers' }));

// ─── AUTH ───
app.post('/api/v1/auth/guest', async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const body = await c.req.json().catch(() => ({}));
  const phone = `+guest${[...crypto.getRandomValues(new Uint8Array(6))].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  const rows = await sql`INSERT INTO users (id, phone, role, "isVerified", name, "createdAt", "updatedAt") VALUES (gen_random_uuid()::text, ${phone}, 'PASSENGER', true, ${String(body?.name || 'Guest').slice(0, 60)}, NOW(), NOW()) RETURNING id, phone, name, role, "profilePhoto", "fcmToken", "isActive", "isVerified", "mustChangePassword", "adminCreated", "walletBalance", "createdAt", "updatedAt"`;
  const user = rows[0];
  const accessToken = await signJwt({ sub: user.id, phone: user.phone, role: user.role }, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN || '7d');
  return c.json({ user: withoutHash(user), accessToken });
});

// LOGIN: verificação bcrypt feita no Neon (pgcrypto) — Workers não tem CPU para bcrypt.
// Acesso mestre de demonstração: 999999999 / 1234567890 entra como ADMIN sem tocar na BD.
app.post('/api/v1/auth/login', async (c) => {
  const { phone, password } = await c.req.json().catch(() => ({}));
  const cleanPhone = String(phone || '').trim();
  const local = cleanPhone.startsWith('+244') ? cleanPhone.slice(4) : cleanPhone.replace(/\D/g, '');
  if (!cleanPhone || !password) return c.json({ message: 'Número ou senha incorretos' }, 401);
  // Admin master (igual ao server.js local)
  if (local === '999999999' && String(password) === '1234567890') {
    const admin = { id: 'admin-root', name: 'Admin', phone: '+244999999999', role: 'ADMIN' };
    const accessToken = await signJwt({ sub: admin.id, phone: admin.phone, role: admin.role }, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN || '7d');
    return c.json({ user: admin, accessToken, isNew: false });
  }
  const sql = neon(c.env.DATABASE_URL);
  const rows = await sql`SELECT id, phone, "passwordHash", name, email, role, "profilePhoto", "fcmToken", "isActive", "isVerified", "mustChangePassword", "adminCreated", "walletBalance", "createdAt", "updatedAt" FROM users WHERE phone = ${cleanPhone} AND "passwordHash" = crypt(${String(password)}, "passwordHash") AND "isActive" = true LIMIT 1`;
  if (!rows.length) return c.json({ message: 'Número ou senha incorretos' }, 401);
  const user = rows[0];
  const accessToken = await signJwt({ sub: user.id, phone: user.phone, role: user.role }, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN || '7d');
  return c.json({ user: withoutHash(user), accessToken, isNew: false });
});

// REGISTER: cria conta com número + senha (bcrypt via pgcrypto no Neon).
app.post('/api/v1/auth/register', async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const { phone, password, name, role } = await c.req.json().catch(() => ({}));
  const cleanPhone = String(phone || '').trim();
  if (!cleanPhone || !password || String(password).length < 4)
    return c.json({ message: 'Número ou senha inválidos.' }, 400);
  const finalRole = String(role || 'PASSENGER').toUpperCase() === 'DRIVER' ? 'DRIVER' : 'PASSENGER';
  const exists = await sql`SELECT id FROM users WHERE phone = ${cleanPhone} LIMIT 1`;
  if (exists.length) return c.json({ message: 'Número já registado. Entra com a tua senha.' }, 409);
  const rows = await sql`INSERT INTO users (id, phone, "passwordHash", name, role, "isVerified", "updatedAt") VALUES (gen_random_uuid()::text, ${cleanPhone}, crypt(${String(password)}, gen_salt('bf', 10)), ${String(name || '').slice(0, 60) || null}, ${finalRole}, true, NOW()) RETURNING id, phone, name, role, "profilePhoto", "fcmToken", "isActive", "isVerified", "mustChangePassword", "adminCreated", "walletBalance", "createdAt", "updatedAt"`;
  const user = rows[0];
  const accessToken = await signJwt({ sub: user.id, phone: user.phone, role: user.role }, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN || '7d');
  return c.json({ user: withoutHash(user), accessToken, isNew: true });
});

app.post('/api/v1/auth/refresh-token', async (c) => {
  const ah = c.req.header('Authorization') || '';
  const token = ah.startsWith('Bearer ') ? ah.slice(7) : '';
  if (!token) return c.json({ message: 'Não autenticado.' }, 401);
  try {
    const p = await verifyJwt(token, c.env.JWT_SECRET);
    const sql = neon(c.env.DATABASE_URL);
    const rows = await sql`SELECT id, phone, role FROM users WHERE id = ${p.sub} LIMIT 1`;
    if (!rows.length) return c.json({ message: 'Não autenticado.' }, 401);
    const accessToken = await signJwt({ sub: rows[0].id, phone: rows[0].phone, role: rows[0].role }, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN || '7d');
    return c.json({ accessToken });
  } catch {
    return c.json({ message: 'Sessão inválida.' }, 401);
  }
});

app.post('/api/v1/auth/change-password', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const { newPassword } = await c.req.json().catch(() => ({}));
  if (!newPassword || String(newPassword).length < 4) return c.json({ message: 'A senha deve ter pelo menos 4 caracteres' }, 400);
  await sql`UPDATE users SET "passwordHash" = crypt(${String(newPassword)}, gen_salt('bf', 10)), "mustChangePassword" = false, "updatedAt" = NOW() WHERE id = ${user.sub}`;
  return c.json({ success: true });
});

// ─── USERS ───
app.get('/api/v1/users/profile', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const rows = await sql`SELECT id, phone, name, email, role, "profilePhoto", "isVerified", "mustChangePassword", "walletBalance" FROM users WHERE id = ${user.sub} LIMIT 1`;
  if (!rows.length) return c.json({ message: 'Não encontrado.' }, 404);
  return c.json(rows[0]);
});
app.put('/api/v1/users/profile', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  // Token único por aparelho: limpa-o das outras contas (senão o próprio recebe os pushes).
  if (body?.fcmToken) {
    try { await sql`UPDATE users SET "fcmToken" = NULL, "updatedAt" = NOW() WHERE "fcmToken" = ${body.fcmToken} AND id != ${user.sub}`; } catch {}
  }
  const rows = await sql`UPDATE users SET name = COALESCE(${body?.name ?? null}, name), "fcmToken" = COALESCE(${body?.fcmToken ?? null}, "fcmToken"), "updatedAt" = NOW() WHERE id = ${user.sub} RETURNING id, phone, name, email, role, "profilePhoto", "isVerified", "mustChangePassword", "walletBalance"`;
  return c.json(rows[0] || {});
});
// DELETE /api/v1/users/push-token — Logout: este aparelho deixa de receber pushes + motorista fica offline
app.delete('/api/v1/users/push-token', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  await sql`UPDATE users SET "fcmToken" = NULL, "updatedAt" = NOW() WHERE id = ${user.sub}`;
  await sql`UPDATE drivers SET "isOnline" = false, "updatedAt" = NOW() WHERE "userId" = ${user.sub}`;
  return c.json({ ok: true });
});
app.get('/api/v1/users/trips/history', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const page = Math.max(1, Number(c.req.query('page') || 1));
  const rows = await sql`SELECT id, "dropoffAddress", "fareEstimate", status, "createdAt" FROM trips WHERE "passengerId" = ${user.sub} ORDER BY "createdAt" DESC LIMIT 20 OFFSET ${(page - 1) * 20}`;
  return c.json({ trips: rows });
});
app.delete('/api/v1/users/me', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  await sql`UPDATE users SET "isActive" = false, "updatedAt" = NOW() WHERE id = ${user.sub}`;
  return c.json({ success: true });
});
app.post('/api/v1/users/report', requireAuth, async (c) => c.json({ success: true }));

// ─── DRIVERS ───
app.get('/api/v1/drivers/status', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const rows = await sql`SELECT d.*, u.name FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."userId" = ${user.sub} LIMIT 1`;
  if (!rows.length) return c.json({ message: 'Motorista não registada.' }, 404);
  return c.json({ ...rows[0], isOnline: !!rows[0].isOnline, totalEarnings: Number(rows[0].totalEarnings || 0) });
});
app.put('/api/v1/drivers/toggle-online', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const { isOnline } = await c.req.json().catch(() => ({}));
  const rows = await sql`UPDATE drivers SET "isOnline" = ${!!isOnline}, "updatedAt" = NOW() WHERE "userId" = ${user.sub} RETURNING "isOnline"`;
  if (!rows.length) return c.json({ message: 'Motorista não registada.' }, 404);
  return c.json({ isOnline: !!rows[0].isOnline });
});
// GPS adaptativo do mobile (5s viagem / 10s idle) escreve aqui. Sem socket.
app.put('/api/v1/drivers/location', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const { lat, lng } = await c.req.json().catch(() => ({}));
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return c.json({ message: 'Posição inválida.' }, 400);
  await sql`UPDATE drivers SET "currentLat" = ${Number(lat)}, "currentLng" = ${Number(lng)}, "updatedAt" = NOW() WHERE "userId" = ${user.sub}`;
  return c.json({ ok: true });
});
app.get('/api/v1/drivers/nearby', async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const lat = Number(c.req.query('lat')), lng = Number(c.req.query('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return c.json({ message: 'Pedido inválido.' }, 400);
    try { await sql`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS cats JSONB`; } catch {}
  let rows: any[];
  try {
    rows = await sql`SELECT d.id, d."currentLat", d."currentLng", u.name, d.cats FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."isOnline" = true AND d.status = 'APPROVED' AND d."currentLat" IS NOT NULL AND d.cats IS NOT NULL AND d.cats::text NOT IN ('null', '[]') LIMIT 100`;
  } catch {
    rows = await sql`SELECT d.id, d."currentLat", d."currentLng", u.name FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."isOnline" = true AND d.status = 'APPROVED' AND d."currentLat" IS NOT NULL LIMIT 100`;
  }
  const out = rows
    .map((d: any) => ({ id: d.id, currentLat: Number(d.currentLat), currentLng: Number(d.currentLng), lat: Number(d.currentLat), lng: Number(d.currentLng), name: d.name, cats: Array.isArray(d.cats) ? d.cats.map((x: any) => String(x)) : undefined, distanceKm: Math.round(havKm(lat, lng, Number(d.currentLat), Number(d.currentLng)) * 10) / 10 }))
    .sort((a: any, b: any) => a.distanceKm - b.distanceKm)
    .slice(0, 20);
  return c.json({ drivers: out });
});
app.get('/api/v1/drivers/earnings', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const d = await sql`SELECT id, "totalEarnings", "totalTrips" FROM drivers WHERE "userId" = ${user.sub} LIMIT 1`;
  return c.json({ totalEarnings: Number(d[0]?.totalEarnings || 0), totalTrips: Number(d[0]?.totalTrips || 0), trips: [] });
});
app.post('/api/v1/drivers/register', requireAuth, async (c) => c.json({ message: 'Registo via painel admin.' }, 400));
// PUT /api/v1/drivers/vehicle — Guardar/atualizar viatura da motorista
app.put('/api/v1/drivers/vehicle', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  const did = await driverIdFor(sql, user.sub);
  if (!did) return c.json({ message: 'Sem registo de motorista.' }, 404);
  const plate = String(b.carPlate || '').trim().slice(0, 12);
  if (plate) {
    const clash = await sql`SELECT id FROM drivers WHERE "carPlate" = ${plate} AND id != ${did} LIMIT 1`;
    if (clash.length) return c.json({ message: 'Matrícula já usada noutra viatura.' }, 409);
  }
  const lic = String(b.licenseNumber || '').trim().slice(0, 30) || null;
  if (lic) {
    const clashL = await sql`SELECT id FROM drivers WHERE "licenseNumber" = ${lic} AND id != ${did} LIMIT 1`;
    if (clashL.length) return c.json({ message: 'Carta já usada noutra conta.' }, 409);
  }
  const year = parseInt(b.carYear, 10);
  await sql`
    UPDATE drivers SET "carMake" = COALESCE(${String(b.carMake || '').slice(0, 40) || null}, "carMake"),
      "carModel" = COALESCE(${String(b.carModel || '').slice(0, 40) || null}, "carModel"),
      "carColor" = COALESCE(${String(b.carColor || '').slice(0, 20) || null}, "carColor"),
      "carPlate" = COALESCE(${plate || null}, "carPlate"),
      "licenseNumber" = COALESCE(${lic}, "licenseNumber"),
      "carYear" = COALESCE(${Number.isInteger(year) ? year : null}, "carYear"),
      "updatedAt" = NOW() WHERE id = ${did}`;
  return c.json({ ok: true });
});
// GET /api/v1/ratings/pending — Viagens concluídas por avaliar (minhas)
app.get('/api/v1/ratings/pending', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  try {
    const did = await driverIdFor(sql, user.sub);
    const rows = did
      ? await sql`SELECT t.id AS "tripId" FROM trips t LEFT JOIN ratings r ON r."tripId" = t.id AND r."raterId" = ${user.sub} WHERE t.status = 'COMPLETED' AND (t."passengerId" = ${user.sub} OR t."driverId" = ${did}) AND r.id IS NULL ORDER BY t."completedAt" DESC NULLS LAST, t."createdAt" DESC LIMIT 5`
      : await sql`SELECT t.id AS "tripId" FROM trips t LEFT JOIN ratings r ON r."tripId" = t.id AND r."raterId" = ${user.sub} WHERE t.status = 'COMPLETED' AND t."passengerId" = ${user.sub} AND r.id IS NULL ORDER BY t."completedAt" DESC NULLS LAST, t."createdAt" DESC LIMIT 5`;
    return c.json({ pendings: rows.map((x: any) => ({ tripId: x.tripId })) });
  } catch (e) {
    return c.json({ pendings: [] });
  }
});

// GET /api/v1/ratings/mine — avaliações recebidas (a motorista vê as suas no perfil)
app.get('/api/v1/ratings/mine', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  try {
    const did = await driverIdFor(sql, user.sub);
    const rows = did
      ? await sql`SELECT r.score, r.comment, r."createdAt", u.name AS "raterName" FROM ratings r JOIN trips t ON t.id = r."tripId" LEFT JOIN users u ON u.id = r."raterId" WHERE t."driverId" = ${did} ORDER BY r."createdAt" DESC LIMIT 30`
      : await sql`SELECT r.score, r.comment, r."createdAt", u.name AS "raterName" FROM ratings r LEFT JOIN users u ON u.id = r."raterId" WHERE r."ratedId" = ${user.sub} ORDER BY r."createdAt" DESC LIMIT 30`;
    const scores = rows.map((x: any) => Number(x.score) || 0).filter((s: number) => s > 0);
    const avg = scores.length ? Math.round((scores.reduce((a: number, s: number) => a + s, 0) / scores.length) * 10) / 10 : 5;
    return c.json({ ratings: rows, avg, count: rows.length });
  } catch (e) {
    return c.json({ ratings: [], avg: 5, count: 0 });
  }
});
// Presença da motorista (a home chama sem token: identifica pelo id do user).
app.post('/api/v1/drivers/position', async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const b = await c.req.json().catch(() => ({}));
  const userId = String(b.id || '');
  if (!userId) return c.json({ message: 'Motorista inválida.' }, 400);
  if (b.offline) {
    await sql`UPDATE drivers SET "isOnline" = false, "updatedAt" = NOW() WHERE "userId" = ${userId}`;
    return c.json({ ok: true });
  }
  const la = Number(b.lat), lo = Number(b.lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return c.json({ message: 'Posição inválida.' }, 400);
  try { await sql`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS cats JSONB`; } catch {}
  const cats = Array.isArray(b.cats) ? b.cats.map((x: any) => String(x).slice(0, 30)).slice(0, 6) : null;
  const rows = await sql`
    UPDATE drivers SET "isOnline" = true, "currentLat" = ${la}, "currentLng" = ${lo}, "updatedAt" = NOW(), cats = COALESCE(${cats ? JSON.stringify(cats) : null}::jsonb, cats)
    WHERE "userId" = ${userId} RETURNING id`;
  if (!rows.length) return c.json({ message: 'Motorista não registada.' }, 404);
  return c.json({ ok: true });
});

// ─── TRIPS ───
app.post('/api/v1/trips/estimate', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const dist = havKm(Number(body.pickupLat), Number(body.pickupLng), Number(body.dropoffLat), Number(body.dropoffLng));
  const base = BASE_FARE + dist * PER_KM;
  const surge = surgeNow();
  const sql = neon(c.env.DATABASE_URL);
  const { mults } = await catMaps(sql);
  const mult = mults[String(body.rideType || 'ECONOMY')] ?? 1.0;
  const options = Object.keys(mults).map((type) => ({ type, fare: Math.round(base * surge * mults[type] * 100) / 100 }));
  return c.json({ distanceKm: Math.round(dist * 10) / 10, estimatedFare: Math.round(base * surge * mult * 100) / 100, currency: 'Kz', surgeMultiplier: surge, surgeActive: surge > 1, options });
});
app.post('/api/v1/trips/request', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  const active = await sql`SELECT id, status FROM trips WHERE "passengerId" = ${user.sub} AND status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') ORDER BY "createdAt" DESC LIMIT 1`;
  if (active.length && active[0].status !== 'REQUESTED') return c.json({ message: 'You already have an active trip. Complete or cancel it first.' }, 400);
  if (active.length) await sql`UPDATE trips SET status = 'CANCELLED', "cancelledBy" = ${user.sub}, "cancelReason" = 'Replaced by new booking' WHERE id = ${active[0].id}`;
  const dist = havKm(Number(b.pickupLat), Number(b.pickupLng), Number(b.dropoffLat), Number(b.dropoffLng));
  const { mults } = await catMaps(sql);
  const fare = Math.round((BASE_FARE + dist * PER_KM) * surgeNow() * (mults[String(b.rideType || 'ECONOMY')] ?? 1) * 100) / 100;
  const rows = await sql`INSERT INTO trips (id, "passengerId", "pickupAddress", "pickupLat", "pickupLng", "dropoffAddress", "dropoffLat", "dropoffLng", status, "rideType", "fareEstimate", "distanceKm", "paymentMethod", "createdAt", "updatedAt") VALUES (gen_random_uuid()::text, ${user.sub}, ${String(b.pickupAddress || 'Luanda')}, ${Number(b.pickupLat)}, ${Number(b.pickupLng)}, ${String(b.dropoffAddress || 'Luanda')}, ${Number(b.dropoffLat)}, ${Number(b.dropoffLng)}, 'REQUESTED', ${String(b.rideType || 'ECONOMY')}, ${fare}, ${Math.round(dist * 10) / 10}, ${String(b.paymentMethod || 'CASH')}, NOW(), NOW()) RETURNING *`;
  // Oferta sequencial por proximidade (60s cada); sem candidatas abre a todas.
  try {
    await ensureOfferColumns(sql);
    const q = await buildOfferQueue(sql, Number(b.pickupLat), Number(b.pickupLng), String(b.rideType || 'ECONOMY'));
    if (q.length) {
      const expAt = new Date(Date.now() + OFFER_TTL_SEC * 1000);
      await sql`UPDATE trips SET "offerQueue" = ${JSON.stringify(q)}::jsonb, "offerIdx" = 0, "offeredDriverId" = ${q[0]}, "offeredAt" = NOW(), "offerExpiresAt" = ${expAt as any}, "offerBroadcast" = FALSE, "offerSkipped" = '[]'::jsonb WHERE id = ${rows[0].id}`;
    } else {
      await sql`UPDATE trips SET "offerBroadcast" = TRUE WHERE id = ${rows[0].id}`;
    }
  } catch {}
  return c.json(rows[0]);
});
// GET /api/v1/trips/incoming — Pedidos pendentes para a motorista (web)
// (Registado antes de /:id: o Hono serve o primeiro registo em caso de colisão.)
app.get('/api/v1/trips/incoming', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const qDriver = String(c.req.query('driverId') || '');
  try {
    await ensureOfferColumns(sql);
    const did = await driverIdFor(sql, qDriver || user.sub);
    if (!did) return c.json({ trips: [] });
    const { byCode } = await catMaps(sql);
    let myCats: string[] | null = null;
    try {
      const dr = await sql`SELECT cats FROM drivers WHERE id = ${did} LIMIT 1`;
      if (dr.length && Array.isArray(dr[0].cats) && dr[0].cats.length) myCats = dr[0].cats.map((x: any) => String(x));
    } catch {}
    const rows = await sql`
      SELECT t.*, u.name AS passenger_name FROM trips t LEFT JOIN users u ON u.id = t."passengerId"
      WHERE t.status = 'REQUESTED' AND t."createdAt" > NOW() - INTERVAL '10 minutes'
      ORDER BY t."createdAt" ASC LIMIT 40`;
    const seen = new Set<string>();
    const out: any[] = [];
    for (let i = rows.length - 1; i >= 0 && out.length < 20; i--) {
      let r: any = rows[i];
      if (seen.has(r.passengerId)) continue;
      seen.add(r.passengerId);
      if (myCats && myCats.indexOf(byCode[r.rideType] || '') < 0) continue;
      if (offerSkippedOf(r).indexOf(did) >= 0) continue;
      // Oferta sequencial: só a motorista ofertada vê (60s cada, mais
      // próxima primeiro). Viagens antigas sem fila contam como broadcast.
      const q = offerQueueOf(r);
      if (!q.length && !r.offeredDriverId) {
        out.push(webTripRow(r, null, r.passenger_name, (code) => byCode[code] || 'Económico'));
        continue;
      }
      if (!r.offerBroadcast) {
        r = await advanceOfferIfNeeded(sql, r, {
          title: '🔔 Novo pedido LadiesGo!',
          body: `${String(r.pickupAddress || 'Ponto no mapa')} → ${String(r.dropoffAddress || '').split(' · ')[0]} · ${Number(r.fareEstimate || 0)} Kz`,
        });
        if (offerSkippedOf(r).indexOf(did) >= 0) continue;
        if (r.offerBroadcast) {
          out.push(webTripRow(r, null, r.passenger_name, (code) => byCode[code] || 'Económico'));
          continue;
        }
        if (String(r.offeredDriverId || '') !== did) continue;
      }
      out.push(webTripRow(r, null, r.passenger_name, (code) => byCode[code] || 'Económico'));
    }
    return c.json({ trips: out });
  } catch (e) {
    console.error('incoming error:', e);
    return c.json({ trips: [] });
  }
});

// GET /api/v1/trips/history — Histórico (web)
app.get('/api/v1/trips/history', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const p = String(c.req.query('passengerId') || '').slice(0, 64);
  const d = String(c.req.query('driverId') || '').slice(0, 64);
  try {
    let did: string | undefined;
    if (d) did = await driverIdFor(sql, d);
    let rows: any[];
    if (p && did) rows = await sql`SELECT t.*, u.name AS passenger_name, du.name AS driver_name FROM trips t LEFT JOIN users u ON u.id = t."passengerId" LEFT JOIN drivers dd ON dd.id = t."driverId" LEFT JOIN users du ON du.id = dd."userId" WHERE t."passengerId" = ${p} OR t."driverId" = ${did} ORDER BY t."createdAt" DESC LIMIT 30`;
    else if (p) rows = await sql`SELECT t.*, u.name AS passenger_name, du.name AS driver_name FROM trips t LEFT JOIN users u ON u.id = t."passengerId" LEFT JOIN drivers dd ON dd.id = t."driverId" LEFT JOIN users du ON du.id = dd."userId" WHERE t."passengerId" = ${p} ORDER BY t."createdAt" DESC LIMIT 30`;
    else if (did) rows = await sql`SELECT t.*, u.name AS passenger_name, du.name AS driver_name FROM trips t LEFT JOIN users u ON u.id = t."passengerId" LEFT JOIN drivers dd ON dd.id = t."driverId" LEFT JOIN users du ON du.id = dd."userId" WHERE t."driverId" = ${did} ORDER BY t."createdAt" DESC LIMIT 30`;
    else return c.json({ trips: [] });
    const { byCode } = await catMaps(sql);
    return c.json({ trips: rows.map((t: any) => ({
      id: t.id,
      dest: String(t.dropoffAddress || ''),
      fare: t.finalFare != null ? Number(t.finalFare) : Number(t.fareEstimate),
      cat: byCode[t.rideType] || 'Económico',
      status: NEON2WEB[t.status] || t.status,
      by: t.cancelledBy || '', reason: t.cancelReason || '',
      other: d ? (t.passenger_name || '') : (t.driver_name || ''),
      ts: t.createdAt, from: t.pickupAddress || '',
      pay: t.paymentMethod === 'CARD' ? 'Cartão' : 'Numerário',
      stopsN: Array.isArray(t.stops) ? t.stops.length : 0,
      stops: (Array.isArray(t.stops) ? t.stops : []).map((x: any) => ({ n: String(x.n || '').slice(0, 60) })),
    })) });
  } catch (e) {
    console.error('history error:', e);
    return c.json({ trips: [] });
  }
});
app.get('/api/v1/trips/active', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const rows = await sql`SELECT t.* FROM trips t LEFT JOIN drivers d ON d.id = t."driverId" WHERE t.status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') AND (t."passengerId" = ${user.sub} OR d."userId" = ${user.sub}) ORDER BY t."createdAt" DESC LIMIT 1`;
  return c.json(rows[0] || null);
});
app.get('/api/v1/trips/:id', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const id = c.req.param('id');
  const rows = await sql`SELECT t.*, d."currentLat" AS "driverLat", d."currentLng" AS "driverLng", d."userId" AS "driverUserId" FROM trips t LEFT JOIN drivers d ON d.id = t."driverId" WHERE t.id = ${id} LIMIT 1`;
  if (!rows.length) return c.json({ message: 'Viagem não encontrada.' }, 404);
  const t = rows[0];
  if (c.req.query('view') === 'web') {
    const drv = await webDriverInfo(sql, t.driverId);
    const pu = await sql`SELECT name, phone FROM users WHERE id = ${t.passengerId} LIMIT 1`;
    const pl = paxLive.get(t.id);
    const { byCode } = await catMaps(sql);
    return c.json({ ...webTripRow(t, drv, pu[0]?.name || '', (code) => byCode[code] || 'Económico', pu[0]?.phone || ''), paxLive: pl && Date.now() - pl.ts < 60000 ? { lat: pl.lat, lng: pl.lng } : null });
  }
  // Polling substitui o socket: devolve posição viva da motorista + ETA.
  let driver = null;
  if (t.driverLat != null && t.driverLng != null) {
    const targetLa = t.status === 'IN_PROGRESS' ? Number(t.dropoffLat) : Number(t.pickupLat);
    const targetLo = t.status === 'IN_PROGRESS' ? Number(t.dropoffLng) : Number(t.pickupLng);
    const dk = havKm(Number(t.driverLat), Number(t.driverLng), targetLa, targetLo);
    driver = { lat: Number(t.driverLat), lng: Number(t.driverLng), distanceKm: Math.round(dk * 10) / 10, etaMinutes: Math.max(1, Math.ceil((dk / 30) * 60)) };
  }
  const pin = user.sub === t.passengerId ? pinForTrip(t.id) : undefined;
  return c.json({ ...t, driver, ...(pin ? { pin } : {}) });
});
async function driverIdFor(sql: any, userId: string) {
  const r = await sql`SELECT id FROM drivers WHERE "userId" = ${userId} LIMIT 1`;
  return r[0]?.id as string | undefined;
}
app.put('/api/v1/trips/:id/accept', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const id = c.req.param('id');
  const did = await driverIdFor(sql, user.sub);
  if (!did) return c.json({ message: 'Só motoristas.' }, 403);
  const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
  if (!cur.length || cur[0].status !== 'REQUESTED') return c.json({ message: 'Viagem indisponível.' }, 400);
  // Oferta sequencial: só a motorista ofertada (ou qualquer uma em broadcast).
  try {
    await ensureOfferColumns(sql);
    let t: any = cur[0];
    if (!t.offerBroadcast && (offerQueueOf(t).length || t.offeredDriverId)) {
      t = await advanceOfferIfNeeded(sql, t);
      if (!t.offerBroadcast && String(t.offeredDriverId || '') !== did) {
        return c.json({ message: 'Esta oferta já passou para outra motorista.' }, 409);
      }
    }
  } catch {}
  const rows = await sql`UPDATE trips SET "driverId" = ${did}, status = 'ACCEPTED', "acceptedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id} AND status = 'REQUESTED' RETURNING *`;
  if (!rows.length) return c.json({ message: 'Viagem indisponível.' }, 400);
  return c.json(rows[0]);
});
// POST /api/v1/trips/:id/skip — Motorista rejeita/passa a oferta à seguinte
app.post('/api/v1/trips/:id/skip', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const id = c.req.param('id');
  const did = await driverIdFor(sql, user.sub);
  if (!did) return c.json({ message: 'Só motoristas.' }, 403);
  try {
    await ensureOfferColumns(sql);
    const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
    if (!cur.length || cur[0].status !== 'REQUESTED') return c.json({ ok: true });
    const t: any = cur[0];
    const skipped = offerSkippedOf(t);
    if (skipped.indexOf(did) < 0) skipped.push(did);
    if (!t.offerBroadcast && String(t.offeredDriverId || '') === did) {
      const q = offerQueueOf(t);
      const missed = offerMissedOf(t);
      const gone = (id: string) => skipped.indexOf(id) >= 0 || missed.indexOf(id) >= 0;
      let idx = Number(t.offerIdx || 0) + 1;
      while (idx < q.length && gone(q[idx])) idx += 1;
      if (idx >= q.length) {
        await sql`UPDATE trips SET "offerBroadcast" = TRUE, "offerSkipped" = ${JSON.stringify(skipped)}::jsonb, "updatedAt" = NOW() WHERE id = ${id}`;
      } else {
        const expAt = new Date(Date.now() + OFFER_TTL_SEC * 1000);
        await sql`UPDATE trips SET "offerIdx" = ${idx}, "offeredDriverId" = ${q[idx]}, "offeredAt" = NOW(), "offerExpiresAt" = ${expAt as any}, "offerSkipped" = ${JSON.stringify(skipped)}::jsonb, "updatedAt" = NOW() WHERE id = ${id}`;
        const rr = await sql`SELECT "pickupAddress", "dropoffAddress", "fareEstimate" FROM trips WHERE id = ${id} LIMIT 1`;
        if (rr.length) await pushTripToDriver(sql, q[idx], id, '🔔 Novo pedido LadiesGo!', `${String(rr[0].pickupAddress || '')} → ${String(rr[0].dropoffAddress || '').split(' · ')[0]} · ${Number(rr[0].fareEstimate || 0)} Kz`);
      }
    } else {
      await sql`UPDATE trips SET "offerSkipped" = ${JSON.stringify(skipped)}::jsonb, "updatedAt" = NOW() WHERE id = ${id}`;
    }
    return c.json({ ok: true });
  } catch (e) {
    console.error('skip error:', e);
    return c.json({ ok: true });
  }
});
app.put('/api/v1/trips/:id/arrived', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const rows = await sql`UPDATE trips SET status = 'DRIVER_ARRIVED', "arrivedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${c.req.param('id')} AND status = 'ACCEPTED' RETURNING *`;
  if (!rows.length) return c.json({ message: 'Transição inválida.' }, 400);
  return c.json(rows[0]);
});
app.put('/api/v1/trips/:id/start', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const { pin } = await c.req.json().catch(() => ({}));
  const id = c.req.param('id');
  const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
  if (!cur.length || cur[0].status !== 'DRIVER_ARRIVED') return c.json({ message: 'Transição inválida.' }, 400);
  if (String(pin || '') !== pinForTrip(id)) return c.json({ message: 'Código incorreto.' }, 400);
  const rows = await sql`UPDATE trips SET status = 'IN_PROGRESS', "startedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id} RETURNING *`;
  return c.json(rows[0]);
});
app.put('/api/v1/trips/:id/complete', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const id = c.req.param('id');
  const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
  if (!cur.length || cur[0].status !== 'IN_PROGRESS') return c.json({ message: 'Transição inválida.' }, 400);
  const t = cur[0];
  const rows = await sql`UPDATE trips SET status = 'COMPLETED', "finalFare" = COALESCE("finalFare", "fareEstimate"), "completedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id} RETURNING *`;
  if (t.driverId) await sql`UPDATE drivers SET "totalTrips" = "totalTrips" + 1, "totalEarnings" = "totalEarnings" + ${Number(t.finalFare || t.fareEstimate || 0) * 0.8} WHERE id = ${t.driverId}`;
  return c.json(rows[0]);
});
app.put('/api/v1/trips/:id/cancel', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const { reason } = await c.req.json().catch(() => ({}));
  const rows = await sql`UPDATE trips SET status = 'CANCELLED', "cancelledBy" = ${user.sub}, "cancelReason" = ${String(reason || '').slice(0, 80)}, "updatedAt" = NOW() WHERE id = ${c.req.param('id')} AND status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') RETURNING *`;
  if (!rows.length) return c.json({ message: 'Transição inválida.' }, 400);
  return c.json(rows[0]);
});

// ─── RATINGS / NOTIFS / PAYMENTS (stubs compatíveis) ───
app.post('/api/v1/ratings', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  try {
    await sql`CREATE TABLE IF NOT EXISTS ratings (id TEXT PRIMARY KEY, "tripId" TEXT NOT NULL, "raterId" TEXT NOT NULL, "ratedId" TEXT NOT NULL DEFAULT '', score INT NOT NULL DEFAULT 5, comment TEXT NOT NULL DEFAULT '', "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS ratings_trip_rater ON ratings("tripId", "raterId")`;
    let rated = String((b as any).ratedId || (b as any).driverId || '');
    try {
      const tr = await sql`SELECT "passengerId", "driverId" FROM trips WHERE id = ${String((b as any).tripId)} LIMIT 1`;
      if (tr.length && !rated) {
        if (user.sub === tr[0].passengerId && tr[0].driverId) {
          const d = await sql`SELECT "userId" FROM drivers WHERE id = ${tr[0].driverId} LIMIT 1`;
          rated = d[0]?.userId || '';
        } else if (tr[0].passengerId) rated = tr[0].passengerId;
      }
    } catch {}
    await sql`INSERT INTO ratings (id, "tripId", "raterId", "ratedId", score, comment, "createdAt") VALUES (${crypto.randomUUID()}, ${String((b as any).tripId)}, ${user.sub}, ${rated}, ${Number((b as any).score || 5)}, ${String((b as any).comment || '').slice(0, 500)}, NOW()) ON CONFLICT ("tripId", "raterId") DO NOTHING`;
  } catch (e) { console.error('ratings insert error:', e); }
  return c.json({ success: true });
});
app.get('/api/v1/notifications', requireAuth, async (c) => c.json({ notifications: [] }));
app.get('/api/v1/notifications/unread-count', requireAuth, async (c) => c.json({ count: 0 }));
app.put('/api/v1/notifications/read-all', requireAuth, async (c) => c.json({ success: true }));
app.post('/api/v1/payments/create-intent', requireAuth, async (c) => c.json({ clientSecret: null, cash: true }));
app.post('/api/v1/payments/confirm', requireAuth, async (c) => c.json({ success: true }));

// ─── TURN + CALL SIGNALING (voz passageira↔motorista via Metered) ───
const FALLBACK_ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  {
    urls: ['turn:openrelay.metered.ca:443?transport=tcp', 'turns:openrelay.metered.ca:443'],
    username: 'openrelay',
    credential: 'openrelay',
  },
];
const PER_CALL_SEC = 120;
const MB_PER_MIN = 0.6;
const CALL_TYPES = ['offer', 'answer', 'ice', 'reject', 'end', 'cancel'];

async function assertParticipant(sql: any, tripId: string, userId: string) {
  const rows = await sql`SELECT t.id FROM trips t LEFT JOIN drivers d ON d.id = t."driverId" WHERE t.id = ${tripId} AND (t."passengerId" = ${userId} OR d."userId" = ${userId}) LIMIT 1`;
  return rows.length > 0;
}
async function turnQuota(sql: any, freeMb: string | undefined) {
  const budget = Math.floor(((Number(freeMb) || 300) / MB_PER_MIN) * 60);
  const agg = await sql`SELECT COALESCE(SUM("durationSec"), 0)::int AS used FROM call_logs WHERE "createdAt" >= date_trunc('month', NOW())`;
  const used = Number(agg[0]?.used || 0);
  const remaining = Math.max(0, budget - used);
  return { remainingSec: remaining, budgetSec: budget, usedSec: used, perCallSec: PER_CALL_SEC, exhausted: remaining <= 0 };
}

app.get('/api/v1/turn/ice', requireAuth, async (c) => {
  const domain = String(c.env.METERED_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const apiKey = String(c.env.METERED_TURN_APIKEY || '').trim();
  if (!domain || !apiKey) return c.json({ iceServers: FALLBACK_ICE, demo: true });
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`, { signal: ctl.signal });
    clearTimeout(t);
    const j: any = await r.json();
    if (!r.ok || !Array.isArray(j)) throw new Error('metered');
    return c.json({ iceServers: j, demo: false });
  } catch {
    return c.json({ iceServers: FALLBACK_ICE, demo: true });
  }
});
app.get('/api/v1/turn/quota', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  return c.json(await turnQuota(sql, c.env.METERED_FREE_MB));
});
app.post('/api/v1/turn/log', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const { tripId, durationSec } = await c.req.json().catch(() => ({}));
  if (!tripId) return c.json({ message: 'Viagem inválida.' }, 400);
  if (!(await assertParticipant(sql, String(tripId), user.sub)))
    return c.json({ message: 'Sem acesso a esta viagem.' }, 403);
  const dur = Math.min(3600, Math.max(0, Math.floor(Number(durationSec) || 0)));
  await sql`INSERT INTO call_logs (id, "tripId", "userId", "durationSec") VALUES (gen_random_uuid()::text, ${String(tripId)}, ${user.sub}, ${dur})`;
  return c.json(await turnQuota(sql, c.env.METERED_FREE_MB));
});
app.post('/api/v1/trips/:id/call/signal', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const id = c.req.param('id');
  const { type, payload } = await c.req.json().catch(() => ({}));
  if (!(await assertParticipant(sql, id, user.sub)))
    return c.json({ message: 'Sem acesso a esta viagem.' }, 403);
  if (CALL_TYPES.indexOf(String(type)) < 0) return c.json({ message: 'Sinal inválido.' }, 400);
  const p = payload === undefined || payload === null ? null : JSON.stringify(payload).slice(0, 4000);
  const rows = await sql`INSERT INTO call_signals (id, "tripId", "senderId", type, payload) VALUES (gen_random_uuid()::text, ${id}, ${user.sub}, ${String(type)}, ${p}::json) RETURNING "createdAt"`;
  sql`DELETE FROM call_signals WHERE "tripId" = ${id} AND "createdAt" < NOW() - INTERVAL '10 minutes'`.catch(() => {});
  return c.json({ ok: true, ts: new Date(rows[0].createdAt).getTime() });
});
app.get('/api/v1/trips/:id/call/signal', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const id = c.req.param('id');
  if (!(await assertParticipant(sql, id, user.sub)))
    return c.json({ message: 'Sem acesso a esta viagem.' }, 403);
  const sinceMs = Number(c.req.query('since')) || 0;
  const cutoff = sinceMs > 0 ? sinceMs : Date.now() - 60 * 1000;
  const rows = await sql`SELECT "senderId", type, payload, "createdAt" FROM call_signals WHERE "tripId" = ${id} AND "createdAt" > to_timestamp(${cutoff / 1000}) ORDER BY "createdAt" ASC LIMIT 50`;
  return c.json({
    signals: rows.map((s: any) => ({
      from: s.senderId,
      type: s.type,
      payload: typeof s.payload === 'string' ? JSON.parse(s.payload) : s.payload,
      ts: new Date(s.createdAt).getTime(),
    })),
    now: Date.now(),
  });
});

// ─── CHAT DA VIAGEM (só intervenientes) ───
app.get('/api/v1/trips/:id/chat', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const id = c.req.param('id');
  if (!(await assertParticipant(sql, id, user.sub)))
    return c.json({ message: 'Sem acesso a esta viagem.' }, 403);
  const sinceMs = Number(c.req.query('since')) || 0;
  const rows = await sql`SELECT "senderName", text, "createdAt" FROM chat_messages WHERE "tripId" = ${id} AND "createdAt" > to_timestamp(${sinceMs / 1000}) ORDER BY "createdAt" ASC LIMIT 50`;
  return c.json({
    msgs: rows.map((m: any) => ({ from: m.senderName || '?', text: m.text, ts: new Date(m.createdAt).getTime() })),
  });
});
app.post('/api/v1/trips/:id/chat', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const id = c.req.param('id');
  if (!(await assertParticipant(sql, id, user.sub)))
    return c.json({ message: 'Sem acesso a esta viagem.' }, 403);
  const { from, text } = await c.req.json().catch(() => ({}));
  const clean = String(text || '').trim().slice(0, 300);
  if (!clean) return c.json({ message: 'Mensagem vazia.' }, 400);
  await sql`INSERT INTO chat_messages (id, "tripId", "senderId", "senderName", text) VALUES (gen_random_uuid()::text, ${id}, ${user.sub}, ${String(from || '').slice(0, 40) || 'Eu'}, ${clean})`;
  // Avisa a outra parte (não bloqueia a resposta).
  c.executionCtx.waitUntil((async () => {
    try {
      const t = await sql`SELECT "passengerId", "driverId" FROM trips WHERE id = ${id} LIMIT 1`;
      if (!t.length) return;
      let other: string | null = null;
      if (t[0].passengerId === user.sub && t[0].driverId) {
        const d = await sql`SELECT "userId" FROM drivers WHERE id = ${t[0].driverId} LIMIT 1`;
        other = d[0]?.userId || null;
      } else if (t[0].passengerId !== user.sub) {
        other = t[0].passengerId;
      }
      if (!other || other === user.sub) return;
      const u = await sql`SELECT "fcmToken" FROM users WHERE id = ${other} LIMIT 1`;
      const tok = u[0]?.fcmToken;
      if (!tok || String(tok).indexOf('ExponentPushToken') !== 0) return;
      await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ to: tok, sound: 'default', title: '💬 Nova mensagem — LadiesGo!', body: clean.slice(0, 120), data: { tripId: id, type: 'chat' } }]) });
    } catch {}
  })());
  return c.json({ ok: true });
});

// ─── PLACES / ZONE / ROUTE (sem BD, com cache edge) ───
app.get('/api/places/search', async (c) => {
  const q = String(c.req.query('q') || '').trim();
  const lat = Number(c.req.query('lat'));
  const lng = Number(c.req.query('lng'));
  const v = Number(c.req.query('v') || '0');
  if (q.length < 3 || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return c.json({ places: [] }, 200, { 'Cache-Control': 'public, max-age=600' });
  }
  try {
    // Nominatim search limitado a Luanda (viewbox + bounded), igual ao fallback do mobile
    const url =
      `https://nominatim.openstreetmap.org/search?format=json&limit=30&countrycodes=ao` +
      `&viewbox=13.05,-8.70,13.55,-9.05&bounded=1` +
      `&accept-language=pt&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'LadiesGo/1.0' }, signal: AbortSignal.timeout(8000) });
    const j: any = await r.json();
    if (!Array.isArray(j)) throw new Error('nominatim');
    const places = j
      .map((p: any) => {
        const plat = Number(p.lat);
        const plng = Number(p.lon);
        // Distância em km (haversine)
        const R = 6371, t = Math.PI / 180;
        const dLa = (plat - lat) * t, dLo = (plng - lng) * t;
        const s = Math.sin(dLa / 2) ** 2 + Math.cos(lat * t) * Math.cos(plat * t) * Math.sin(dLo / 2) ** 2;
        const distKm = 2 * R * Math.asin(Math.sqrt(s));
        return {
          name: String(p.display_name?.split(',').slice(0, 3).join(',') || p.display_name || q),
          lat: plat,
          lng: plng,
          municipality: '',
          province: 'Luanda',
          distanceKm: Math.round(distKm * 10) / 10,
        };
      })
      .filter((p: any) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    return c.json({ places }, 200, { 'Cache-Control': 'public, max-age=600' });
  } catch {
    return c.json({ places: [] }, 200, { 'Cache-Control': 'public, max-age=600' });
  }
});
// Fallback offline: Nominatim e bigdatacloud limitam IPs de datacenter
// (todo o tráfego do Worker sai dos mesmos IPs). Lista compacta de
// municípios de Luanda — devolve o mais próximo até 60 km.
const LUANDA_ZONES: [string, number, number][] = [
  ['Ingombota', -8.815, 13.231], ['Maianga', -8.860, 13.244],
  ['Rangel', -8.830, 13.256], ['Cazenga', -8.850, 13.292],
  ['Sambizanga', -8.822, 13.270], ['Samba', -8.873, 13.200],
  ['Viana', -8.903, 13.374], ['Cacuaco', -8.783, 13.375],
  ['Belas', -8.950, 13.200], ['Talatona', -8.920, 13.181],
  ['Kilamba Kiaxi', -8.901, 13.234], ['Icolo e Bengo', -9.070, 13.520],
  ['Benfica', -8.940, 13.165], ['Sequele', -8.888, 13.488],
];
function offlineZone(la: number, lo: number): string {
  let best = '', bd = 60;
  for (const [n, zla, zlo] of LUANDA_ZONES) {
    const d = havKm(la, lo, zla, zlo);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}
app.get('/api/zone', async (c) => {
  const la = Number(c.req.query('lat')), lo = Number(c.req.query('lng'));
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return c.json({ message: 'Pedido inválido.' }, 400);
  let zone = '';
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${la}&lon=${lo}&format=json&zoom=14`, { headers: { 'User-Agent': 'LadiesGo/1.0' }, signal: AbortSignal.timeout(8000) });
    const j: any = await r.json();
    const a = j?.address || {};
    zone = a.suburb || a.neighbourhood || a.quarter || a.city_district || a.town || a.city || '';
  } catch {}
  if (!zone) {
    try {
      const br = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${la}&longitude=${lo}&localityLanguage=pt`, { signal: AbortSignal.timeout(8000) });
      const bj: any = await br.json();
      zone = bj.locality || bj.city || bj.principalSubdivision || '';
    } catch {}
  }
  if (!zone) zone = offlineZone(la, lo);
  return c.json({ zone }, 200, { 'Cache-Control': 'public, max-age=86400' });
});
app.get('/api/route', async (c) => {
  const from = String(c.req.query('from') || '').split(',').map(Number);
  const to = String(c.req.query('to') || '').split(',').map(Number);
  if (from.length !== 2 || to.length !== 2 || ![...from, ...to].every(Number.isFinite)) return c.json({ message: 'Pedido inválido.' }, 400);
  try {
    const q = `${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`;
    const bases = [
      'https://router.project-osrm.org/route/v1/driving/',
      'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
    ];
    for (const base of bases) {
      try {
        const r = await fetch(base + q, { headers: { 'User-Agent': 'LadiesGo/1.0' }, signal: AbortSignal.timeout(6000) });
        const j: any = await r.json();
        const g = j?.routes?.[0]?.geometry?.coordinates;
        if (g?.length) return c.json({ points: g.map((p: number[]) => [p[1], p[0]]), distance_m: j.routes[0].distance, duration_s: j.routes[0].duration }, 200, { 'Cache-Control': 'public, max-age=600' });
      } catch {}
    }
    return c.json({ message: 'Sem rota de momento.' }, 502);
  } catch {
    return c.json({ message: 'Sem rota de momento.' }, 502);
  }
});

// ─── ADMIN ENDPOINTS (requireAuth + role ADMIN) ───
function requireAdmin(c: any, next: any) {
  if (!c.get('user') || c.get('user').role !== 'ADMIN') {
    return c.json({ message: 'Acesso negado.' }, 403);
  }
  return next();
}

// Admin middleware chain: auth -> admin
function adminMiddleware(c: any, next: any) {
  return requireAuth(c, () => requireAdmin(c, next));
}

// GET /api/v1/admin/stats — Dashboard stats
app.get('/api/v1/admin/stats', adminMiddleware, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const [driversRes, tripsRes, usersRes, revenueRes] = await Promise.all([
    sql`SELECT COUNT(*)::int AS total FROM drivers WHERE status = 'APPROVED' AND "isOnline" = true`,
    sql`SELECT status, COUNT(*)::int AS count FROM trips GROUP BY status`,
    sql`SELECT COUNT(*)::int AS total FROM users WHERE "isActive" = true`,
    sql`SELECT COALESCE(SUM("finalFare"), 0)::numeric AS total FROM trips WHERE status = 'COMPLETED'`,
  ]);
  const byStatus: Record<string, number> = {};
  for (const r of tripsRes) byStatus[r.status] = Number(r.count);
  return c.json({
    driversOnline: Number(driversRes[0]?.total || 0),
    trips: byStatus,
    activeDrivers: Number(driversRes[0]?.total || 0),
    totalUsers: Number(usersRes[0]?.total || 0),
    revenueKz: Number(revenueRes[0]?.total || 0),
    total: Number(tripsRes.reduce((s, r) => s + Number(r.count), 0)),
  });
});

// GET /api/v1/admin/trips — List trips with filters
app.get('/api/v1/admin/trips', adminMiddleware, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
  const status = c.req.query('status');
  const passengerId = c.req.query('passengerId');
  const offset = (page - 1) * limit;

  try {
    if (passengerId && !status) {
      const pTotal = await sql`SELECT COUNT(*)::int AS total FROM trips WHERE "passengerId" = ${passengerId}`;
      const pRows = await sql`
        SELECT t.*,
          u.name AS passenger_name, u.phone AS passenger_phone,
          du.name AS driver_name, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
        FROM trips t
        LEFT JOIN users u ON u.id = t."passengerId"
        LEFT JOIN drivers d ON d.id = t."driverId"
        LEFT JOIN users du ON du.id = d."userId"
        WHERE t."passengerId" = ${passengerId}
        ORDER BY t."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      return c.json({ trips: pRows, total: Number(pTotal[0]?.total || 0) });
    }
    if (status) {
      const totalRes = await sql`SELECT COUNT(*)::int AS total FROM trips WHERE status = ${status}`;
      const tripsRes = await sql`
        SELECT t.*, 
          u.name AS passenger_name, u.phone AS passenger_phone,
          du.name AS driver_name, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
        FROM trips t
        LEFT JOIN users u ON u.id = t."passengerId"
        LEFT JOIN drivers d ON d.id = t."driverId"
        LEFT JOIN users du ON du.id = d."userId"
        WHERE status = ${status}
        ORDER BY t."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      const trips = tripsRes.map((r: any) => ({
        id: r.id,
        passenger: r.passenger_name,
        passengerId: r.passengerId,
        from: r.pickupAddress,
        to: r.dropoffAddress,
        cat: r.rideType,
        fare: r.finalFare != null ? Number(r.finalFare) : Number(r.fareEstimate),
        status: r.status,
        by: r.cancelledBy,
        reason: r.cancelReason,
        driver: r.driver_name,
        driverId: r.driverId,
        pickupLat: r.pickupLat,
        pickupLng: r.pickupLng,
        dropoffLat: r.dropoffLat,
        dropoffLng: r.dropoffLng,
        stops: r.stops || [],
        ts: r.createdAt,
      }));
      return c.json({ trips, total: Number(totalRes[0]?.total || 0) });
    } else {
      const totalRes = await sql`SELECT COUNT(*)::int AS total FROM trips`;
      const tripsRes = await sql`
        SELECT t.*, 
          u.name AS passenger_name, u.phone AS passenger_phone,
          du.name AS driver_name, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
        FROM trips t
        LEFT JOIN users u ON u.id = t."passengerId"
        LEFT JOIN drivers d ON d.id = t."driverId"
        LEFT JOIN users du ON du.id = d."userId"
        ORDER BY t."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      const trips = tripsRes.map((r: any) => ({
        id: r.id,
        passenger: r.passenger_name,
        passengerId: r.passengerId,
        from: r.pickupAddress,
        to: r.dropoffAddress,
        cat: r.rideType,
        fare: r.finalFare != null ? Number(r.finalFare) : Number(r.fareEstimate),
        status: r.status,
        by: r.cancelledBy,
        reason: r.cancelReason,
        driver: r.driver_name,
        driverId: r.driverId,
        pickupLat: r.pickupLat,
        pickupLng: r.pickupLng,
        dropoffLat: r.dropoffLat,
        dropoffLng: r.dropoffLng,
        stops: r.stops || [],
        ts: r.createdAt,
      }));
      return c.json({ trips, total: Number(totalRes[0]?.total || 0) });
    }
  } catch (e) {
    console.error('Admin trips error:', e);
    return c.json({ message: 'Erro ao buscar viagens' }, 500);
  }
});

// GET /api/v1/admin/drivers — List drivers
app.get('/api/v1/admin/drivers', adminMiddleware, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const driversRes = await sql`
    SELECT d.*, u.name, u.phone
    FROM drivers d
    JOIN users u ON u.id = d."userId"
    WHERE d.status = 'APPROVED'
    ORDER BY d."createdAt" DESC
  `;
  return c.json({ drivers: driversRes });
});

// GET /api/v1/admin/users — List users
app.get('/api/v1/admin/users', adminMiddleware, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
  const role = c.req.query('role');
  const q = c.req.query('q');
  const offset = (page - 1) * limit;

  const like = q ? `%${q}%` : null;

try {
    // Filtros dinâmicos com template tags (mesmo padrão do resto do ficheiro).
    let totalRes, usersRes;
    if (role && like) {
      totalRes = await sql`SELECT COUNT(*)::int AS total FROM users u WHERE u."isActive" = true AND u.role = ${role} AND (u.name ILIKE ${like} OR u.phone ILIKE ${like})`;
      usersRes = await sql`
      SELECT u.id, u.name, u.phone, u.role, u."profilePhoto", u."isVerified", u."createdAt",
        d.status AS driver_status, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
      FROM users u
      LEFT JOIN drivers d ON d."userId" = u.id
      WHERE u."isActive" = true AND u.role = ${role} AND (u.name ILIKE ${like} OR u.phone ILIKE ${like})
        ORDER BY u."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}`;
    } else if (role) {
      totalRes = await sql`SELECT COUNT(*)::int AS total FROM users u WHERE u."isActive" = true AND u.role = ${role}`;
      usersRes = await sql`
      SELECT u.id, u.name, u.phone, u.role, u."profilePhoto", u."isVerified", u."createdAt",
        d.status AS driver_status, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
      FROM users u
      LEFT JOIN drivers d ON d."userId" = u.id
      WHERE u."isActive" = true AND u.role = ${role}
        ORDER BY u."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}`;
    } else if (like) {
      totalRes = await sql`SELECT COUNT(*)::int AS total FROM users u WHERE u."isActive" = true AND (u.name ILIKE ${like} OR u.phone ILIKE ${like})`;
      usersRes = await sql`
      SELECT u.id, u.name, u.phone, u.role, u."profilePhoto", u."isVerified", u."createdAt",
        d.status AS driver_status, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
      FROM users u
      LEFT JOIN drivers d ON d."userId" = u.id
      WHERE u."isActive" = true AND (u.name ILIKE ${like} OR u.phone ILIKE ${like})
        ORDER BY u."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}`;
    } else {
      totalRes = await sql`SELECT COUNT(*)::int AS total FROM users u WHERE u."isActive" = true`;
      usersRes = await sql`
      SELECT u.id, u.name, u.phone, u.role, u."profilePhoto", u."isVerified", u."createdAt",
        d.status AS driver_status, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
      FROM users u
      LEFT JOIN drivers d ON d."userId" = u.id
      WHERE u."isActive" = true
      ORDER BY u."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}`;
    }
    const total = Number(totalRes[0]?.total || 0);
    return c.json({ users: usersRes, total });
  } catch (e) {
    console.error('Admin users error:', e);
    return c.json({ message: 'Erro ao buscar utilizadores', error: String(e) }, 500);
  }
});

// POST /api/v1/admin/users/:id/reset-password — Repor senha padrão (admin)
app.post('/api/v1/admin/users/:id/reset-password', adminMiddleware, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const { id } = c.req.param();
  const rows = await sql`
    UPDATE users SET "passwordHash" = crypt('0987654321', gen_salt('bf', 10)),
      "mustChangePassword" = true, "updatedAt" = NOW()
    WHERE id = ${id} RETURNING id`;
  if (!rows.length) return c.json({ message: 'Utilizador não encontrado.' }, 404);
  return c.json({ success: true });
});

// GET /api/v1/admin/drivers/pending — Pending driver registrations
app.get('/api/v1/admin/drivers/pending', adminMiddleware, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const pendingRes = await sql`
    SELECT d.*, u.name, u.phone
    FROM drivers d
    JOIN users u ON u.id = d."userId"
    WHERE d.status = 'PENDING'
    ORDER BY d."createdAt" DESC
  `;
  return c.json(pendingRes);
});

// PUT /api/v1/admin/drivers/:id/approve — Approve driver
app.put('/api/v1/admin/drivers/:id/approve', adminMiddleware, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const { id } = c.req.param();
  await sql`UPDATE drivers SET status = 'APPROVED', "updatedAt" = NOW() WHERE id = ${id}`;
  return c.json({ success: true });
});

// PUT /api/v1/admin/drivers/:id/reject — Reject driver
app.put('/api/v1/admin/drivers/:id/reject', adminMiddleware, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const { id } = c.req.param();
  await sql`UPDATE drivers SET status = 'REJECTED', "updatedAt" = NOW() WHERE id = ${id}`;
  return c.json({ success: true });
});

// POST /api/v1/admin/drivers/create — Create driver with vehicle (auto-approve if has license+plate)
app.post('/api/v1/admin/drivers/create', adminMiddleware, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const { phone, name, licenseNumber, carPlate, carMake, carModel, carYear, carColor } = await c.req.json().catch(() => ({}));
  if (!phone || !name) return c.json({ message: 'Nome e número obrigatórios.' }, 400);
  const cleanPhone = phone.startsWith('+244') ? phone : `+244${phone.replace(/\D/g, '')}`;
  const exists = await sql`SELECT id FROM users WHERE phone = ${cleanPhone} LIMIT 1`;
  if (exists.length) return c.json({ message: 'Número já registado.' }, 409);
  // Create user
  const userRes = await sql`INSERT INTO users (id, phone, "passwordHash", name, role, "isVerified", "updatedAt") VALUES (gen_random_uuid()::text, ${cleanPhone}, crypt('0987654321', gen_salt('bf', 10)), ${name}, 'DRIVER', true, NOW()) RETURNING id`;
  const userId = userRes[0].id;
  // Create driver
  const hasVehicle = licenseNumber && carPlate;
  const driverStatus = hasVehicle ? 'APPROVED' : 'PENDING';
  await sql`
    INSERT INTO drivers (id, "userId", "licenseNumber", "carPlate", "carMake", "carModel", "carYear", "carColor", status, "updatedAt")
    VALUES (gen_random_uuid()::text, ${userId}, ${licenseNumber || null}, ${carPlate || null}, ${carMake || null}, ${carModel || null}, ${carYear || null}, ${carColor || null}, ${driverStatus}, NOW())
  `;
  return c.json({ success: true, driverStatus, password: '0987654321' });
});

// ─── MISSING MOBILE APP ENDPOINTS ───

// DELETE /api/v1/users/me — Delete account
app.delete('/api/v1/users/me', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  await sql`UPDATE users SET "isActive" = false, "updatedAt" = NOW() WHERE id = ${user.sub}`;
  return c.json({ success: true });
});

// POST /api/v1/users/report — Report a user
app.post('/api/v1/users/report', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const { reportedUserId, reason, tripId } = await c.req.json().catch(() => ({}));
  if (!reportedUserId || !reason) return c.json({ message: 'Dados inválidos.' }, 400);
  await sql`
    INSERT INTO reports (id, "reporterId", "reportedUserId", reason, "tripId", "createdAt")
    VALUES (gen_random_uuid()::text, ${user.sub}, ${reportedUserId}, ${reason}, ${tripId || null}, NOW())
  `;
  return c.json({ success: true });
});

// GET /api/v1/drivers/status — Get driver status
app.get('/api/v1/drivers/status', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const rows = await sql`
    SELECT d.*, u.name, u.phone
    FROM drivers d
    JOIN users u ON u.id = d."userId"
    WHERE d."userId" = ${user.sub}
    LIMIT 1
  `;
  if (!rows.length) return c.json({ message: 'Motorista não registada.' }, 404);
  return c.json({
    ...rows[0],
    isOnline: !!rows[0].isOnline,
    totalEarnings: Number(rows[0].totalEarnings || 0),
  });
});

// PUT /api/v1/drivers/toggle-online — Toggle online status
app.put('/api/v1/drivers/toggle-online', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const { isOnline } = await c.req.json().catch(() => ({}));
  const rows = await sql`
    UPDATE drivers SET "isOnline" = ${!!isOnline}, "updatedAt" = NOW()
    WHERE "userId" = ${user.sub}
    RETURNING "isOnline"
  `;
  if (!rows.length) return c.json({ message: 'Motorista não registada.' }, 404);
  return c.json({ isOnline: !!rows[0].isOnline });
});

// PUT /api/v1/drivers/location — Update driver location
app.put('/api/v1/drivers/location', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const { lat, lng } = await c.req.json().catch(() => ({}));
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
    return c.json({ message: 'Posição inválida.' }, 400);
  }
  await sql`
    UPDATE drivers SET "currentLat" = ${Number(lat)}, "currentLng" = ${Number(lng)}, "updatedAt" = NOW()
    WHERE "userId" = ${user.sub}
  `;
  return c.json({ ok: true });
});

// GET /api/v1/drivers/earnings — Get driver earnings
app.get('/api/v1/drivers/earnings', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
  const offset = (page - 1) * limit;
  const driverRes = await sql`SELECT id FROM drivers WHERE "userId" = ${user.sub} LIMIT 1`;
  if (!driverRes.length) return c.json({ earnings: [], total: 0, page, limit });
  const driverId = driverRes[0].id;
  const totalRes = await sql`SELECT COUNT(*)::int AS total FROM trips WHERE "driverId" = ${driverId} AND status = 'COMPLETED'`;
  const tripsRes = await sql`
    SELECT id, "finalFare", "createdAt"
    FROM trips
    WHERE "driverId" = ${driverId} AND status = 'COMPLETED'
    ORDER BY "createdAt" DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const total = Number(totalRes[0]?.total || 0);
  const earnings = tripsRes.map((r: any) => ({
    tripId: r.id,
    amount: Number(r.finalFare || 0),
    date: r.createdAt,
  }));
  return c.json({ earnings, total, page, limit });
});

// POST /api/v1/trips/estimate — Estimate trip fare
app.post('/api/v1/trips/estimate', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const dist = havKm(
    Number(body.pickupLat), Number(body.pickupLng),
    Number(body.dropoffLat), Number(body.dropoffLng)
  );
  const base = BASE_FARE + dist * PER_KM;
  const surge = surgeNow();
  const mult = RIDE_MULT[String(body.rideType || 'ECONOMY')] ?? 1.0;
  const options = Object.keys(RIDE_MULT).map((type) => ({
    type,
    fare: Math.round(base * surge * RIDE_MULT[type] * 100) / 100,
  }));
  return c.json({
    distanceKm: Math.round(dist * 10) / 10,
    estimatedFare: Math.round(base * surge * mult * 100) / 100,
    currency: 'Kz',
    surgeMultiplier: surge,
    surgeActive: surge > 1,
    options,
  });
});

// POST /api/v1/trips/request — Request a trip
app.post('/api/v1/trips/request', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  const active = await sql`
    SELECT id, status FROM trips
    WHERE "passengerId" = ${user.sub} AND status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')
    ORDER BY "createdAt" DESC LIMIT 1
  `;
  if (active.length && active[0].status !== 'REQUESTED') {
    return c.json({ message: 'You already have an active trip. Complete or cancel it first.' }, 400);
  }
  if (active.length) {
    await sql`UPDATE trips SET status = 'CANCELLED', "cancelledBy" = ${user.sub}, "cancelReason" = 'Replaced by new booking', "updatedAt" = NOW() WHERE id = ${active[0].id}`;
  }
  const dist = havKm(Number(b.pickupLat), Number(b.pickupLng), Number(b.dropoffLat), Number(b.dropoffLng));
  const fare = Math.round((BASE_FARE + dist * PER_KM) * surgeNow() * (RIDE_MULT[String(b.rideType || 'ECONOMY')] ?? 1) * 100) / 100;
  const rows = await sql`
    INSERT INTO trips (
      id, "passengerId", "pickupAddress", "pickupLat", "pickupLng",
      "dropoffAddress", "dropoffLat", "dropoffLng", status, "rideType",
      "fareEstimate", "distanceKm", "paymentMethod", "createdAt", "updatedAt"
    ) VALUES (
      gen_random_uuid()::text, ${user.sub},
      ${String(b.pickupAddress || 'Luanda')}, ${Number(b.pickupLat)}, ${Number(b.pickupLng)},
      ${String(b.dropoffAddress || 'Luanda')}, ${Number(b.dropoffLat)}, ${Number(b.dropoffLng)},
      'REQUESTED', ${String(b.rideType || 'ECONOMY')},
      ${fare}, ${Math.round(dist * 10) / 10},
      ${String(b.paymentMethod || 'CASH')}, NOW(), NOW()
    ) RETURNING *
  `;
  return c.json(rows[0]);
});

// GET /api/v1/trips/active — Get active trip
app.get('/api/v1/trips/active', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const rows = await sql`
    SELECT t.*, du.name AS driver_name
    FROM trips t
    LEFT JOIN drivers d ON d.id = t."driverId"
    LEFT JOIN users du ON du.id = d."userId"
    WHERE (t."passengerId" = ${user.sub} OR d."userId" = ${user.sub})
      AND t.status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')
    ORDER BY t."createdAt" DESC LIMIT 1
  `;
  if (!rows.length) return c.json(null);
  const t = rows[0];
  let driver = null;
  if (t.driverId) {
    const d = await sql`SELECT d."currentLat", d."currentLng", u.name FROM drivers d LEFT JOIN users u ON u.id = d."userId" WHERE d.id = ${t.driverId} LIMIT 1`;
    if (d.length) {
      const targetLa = t.status === 'IN_PROGRESS' ? Number(t.dropoffLat) : Number(t.pickupLat);
      const targetLo = t.status === 'IN_PROGRESS' ? Number(t.dropoffLng) : Number(t.pickupLng);
      const dk = havKm(Number(d[0].currentLat), Number(d[0].currentLng), targetLa, targetLo);
      driver = {
        lat: Number(d[0].currentLat),
        lng: Number(d[0].currentLng),
        name: d[0].name,
        distanceKm: Math.round(dk * 10) / 10,
        etaMinutes: Math.max(1, Math.ceil((dk / 30) * 60)),
      };
    }
  }
  const pin = user.sub === t.passengerId ? pinForTrip(t.id) : undefined;
  return c.json({
    id: t.id,
    passengerId: t.passengerId,
    pickupAddress: t.pickupAddress,
    pickupLat: t.pickupLat,
    pickupLng: t.pickupLng,
    dropoffAddress: t.dropoffAddress,
    dropoffLat: t.dropoffLat,
    dropoffLng: t.dropoffLng,
    status: t.status,
    rideType: t.rideType,
    fareEstimate: Number(t.fareEstimate),
    distanceKm: Number(t.distanceKm),
    paymentMethod: t.paymentMethod,
    driver,
    pin,
    createdAt: t.createdAt,
  });
});

// GET /api/v1/trips/:id — Get trip details
app.get('/api/v1/trips/:id', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const id = c.req.param('id');
  const rows = await sql`
    SELECT t.*, du.name AS driver_name
    FROM trips t
    LEFT JOIN drivers d ON d.id = t."driverId"
    LEFT JOIN users du ON du.id = d."userId"
    WHERE t.id = ${id} LIMIT 1
  `;
  if (!rows.length) return c.json({ message: 'Viagem não encontrada.' }, 404);
  const t = rows[0];
  if (c.req.query('view') === 'web') {
    const drv = await webDriverInfo(sql, t.driverId);
    const pu = await sql`SELECT name, phone FROM users WHERE id = ${t.passengerId} LIMIT 1`;
    const pl = paxLive.get(t.id);
    const { byCode } = await catMaps(sql);
    return c.json({ ...webTripRow(t, drv, pu[0]?.name || '', (code) => byCode[code] || 'Económico', pu[0]?.phone || ''), paxLive: pl && Date.now() - pl.ts < 60000 ? { lat: pl.lat, lng: pl.lng } : null });
  }
  let driver = null;
  if (t.driverId) {
    const d = await sql`SELECT d."currentLat", d."currentLng", u.name FROM drivers d LEFT JOIN users u ON u.id = d."userId" WHERE d.id = ${t.driverId} LIMIT 1`;
    if (d.length) {
      const targetLa = t.status === 'IN_PROGRESS' ? Number(t.dropoffLat) : Number(t.pickupLat);
      const targetLo = t.status === 'IN_PROGRESS' ? Number(t.dropoffLng) : Number(t.pickupLng);
      const dk = havKm(Number(d[0].currentLat), Number(d[0].currentLng), targetLa, targetLo);
      driver = {
        lat: Number(d[0].currentLat),
        lng: Number(d[0].currentLng),
        name: d[0].name,
        distanceKm: Math.round(dk * 10) / 10,
        etaMinutes: Math.max(1, Math.ceil((dk / 30) * 60)),
      };
    }
  }
  const pin = user.sub === t.passengerId ? pinForTrip(t.id) : undefined;
  return c.json({
    id: t.id,
    passengerId: t.passengerId,
    pickupAddress: t.pickupAddress,
    pickupLat: t.pickupLat,
    pickupLng: t.pickupLng,
    dropoffAddress: t.dropoffAddress,
    dropoffLat: t.dropoffLat,
    dropoffLng: t.dropoffLng,
    status: t.status,
    rideType: t.rideType,
    fareEstimate: Number(t.fareEstimate),
    distanceKm: Number(t.distanceKm),
    paymentMethod: t.paymentMethod,
    driver,
    pin,
    createdAt: t.createdAt,
  });
});

// PUT /api/v1/trips/:id/accept — Accept trip
app.put('/api/v1/trips/:id/accept', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const id = c.req.param('id');
  const didRes = await sql`SELECT id FROM drivers WHERE "userId" = ${user.sub} LIMIT 1`;
  if (!didRes.length) return c.json({ message: 'Só motoristas.' }, 403);
  const did = didRes[0].id;
  const cur = await sql`SELECT status FROM trips WHERE id = ${id} LIMIT 1`;
  if (!cur.length || cur[0].status !== 'REQUESTED') return c.json({ message: 'Viagem indisponível.' }, 400);
  const rows = await sql`
    UPDATE trips SET "driverId" = ${did}, status = 'ACCEPTED', "acceptedAt" = NOW(), "updatedAt" = NOW()
    WHERE id = ${id} RETURNING *
  `;
  return c.json(rows[0]);
});

// PUT /api/v1/trips/:id/arrived — Mark arrived
app.put('/api/v1/trips/:id/arrived', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const id = c.req.param('id');
  const rows = await sql`
    UPDATE trips SET status = 'DRIVER_ARRIVED', "arrivedAt" = NOW(), "updatedAt" = NOW()
    WHERE id = ${id} AND status = 'ACCEPTED' RETURNING *
  `;
  if (!rows.length) return c.json({ message: 'Transição inválida.' }, 400);
  return c.json(rows[0]);
});

// PUT /api/v1/trips/:id/start — Start trip
app.put('/api/v1/trips/:id/start', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const { pin } = await c.req.json().catch(() => ({}));
  const id = c.req.param('id');
  const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
  if (!cur.length || cur[0].status !== 'DRIVER_ARRIVED') return c.json({ message: 'Transição inválida.' }, 400);
  if (String(pin || '') !== pinForTrip(id)) return c.json({ message: 'Código incorreto.' }, 400);
  const rows = await sql`
    UPDATE trips SET status = 'IN_PROGRESS', "startedAt" = NOW(), "updatedAt" = NOW()
    WHERE id = ${id} RETURNING *
  `;
  return c.json(rows[0]);
});

// PUT /api/v1/trips/:id/complete — Complete trip
app.put('/api/v1/trips/:id/complete', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const id = c.req.param('id');
  const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
  if (!cur.length || cur[0].status !== 'IN_PROGRESS') return c.json({ message: 'Transição inválida.' }, 400);
  const t = cur[0];
  const rows = await sql`
    UPDATE trips SET status = 'COMPLETED', "finalFare" = COALESCE("finalFare", "fareEstimate"), "completedAt" = NOW(), "updatedAt" = NOW()
    WHERE id = ${id} RETURNING *
  `;
  if (t.driverId) {
    await sql`
      UPDATE drivers SET "totalTrips" = "totalTrips" + 1, "totalEarnings" = "totalEarnings" + ${Number(t.finalFare || t.fareEstimate || 0) * 0.8}
      WHERE id = ${t.driverId}
    `;
  }
  return c.json(rows[0]);
});

// PUT /api/v1/trips/:id/cancel — Cancel trip
app.put('/api/v1/trips/:id/cancel', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const { reason } = await c.req.json().catch(() => ({}));
  const rows = await sql`
    UPDATE trips SET status = 'CANCELLED', "cancelledBy" = ${user.sub}, "cancelReason" = ${String(reason || '').slice(0, 80)}, "updatedAt" = NOW()
    WHERE id = ${c.req.param('id')} AND status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') RETURNING *
  `;
  if (!rows.length) return c.json({ message: 'Transição inválida.' }, 400);
  return c.json(rows[0]);
});

// POST /api/v1/ratings — Create rating
app.post('/api/v1/ratings', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  const { tripId, ratedId, score, comment } = b;
  if (!tripId || !ratedId || !score) return c.json({ message: 'Dados inválidos.' }, 400);
  await sql`
    INSERT INTO ratings (id, "tripId", "raterId", "ratedId", score, comment, "createdAt")
    VALUES (gen_random_uuid()::text, ${tripId}, ${user.sub}, ${ratedId}, ${score}, ${comment || ''}, NOW())
    ON CONFLICT ("tripId", "raterId") DO NOTHING
  `;
  return c.json({ success: true });
});

// GET /api/v1/notifications — Get notifications
app.get('/api/v1/notifications', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
  const offset = (page - 1) * limit;
  const rows = await sql`
    SELECT id, title, body, type, "isRead", data, "createdAt"
    FROM notifications
    WHERE "userId" = ${user.sub}
    ORDER BY "createdAt" DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return c.json({ notifications: rows, page, limit });
});

// GET /api/v1/notifications/unread-count — Get unread count
app.get('/api/v1/notifications/unread-count', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const rows = await sql`
    SELECT COUNT(*)::int AS count FROM notifications WHERE "userId" = ${user.sub} AND "isRead" = false
  `;
  return c.json({ count: Number(rows[0]?.count || 0) });
});

// PUT /api/v1/notifications/read-all — Mark all as read
app.put('/api/v1/notifications/read-all', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  await sql`UPDATE notifications SET "isRead" = true WHERE "userId" = ${user.sub}`;
  return c.json({ success: true });
});

// ─── CATEGORIAS (geridas no painel admin) ───
// GET /api/v1/categories — Lista pública (a home usa para nomes/cores/preços)
app.get('/api/v1/categories', async (c) => {
  try {
    const sql = neon(c.env.DATABASE_URL);
    return c.json({ categories: await getCategories(sql) });
  } catch {
    return c.json({ categories: [
      { code: 'ECONOMY', name: 'Económico', color: '#61188E', mult: 1 },
      { code: 'COMFORT', name: 'Conforto', color: '#ff5fc8', mult: 1.4 },
      { code: 'PREMIUM', name: 'Família', color: '#5b21c9', mult: 1.65 },
    ] });
  }
});

// POST /api/v1/admin/categories — Adicionar categoria (solta o enum rideType para TEXT uma vez)
app.post('/api/v1/admin/categories', adminMiddleware, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name || '').trim().slice(0, 30);
  const color = String(b.color || '').trim();
  const mult = Number(b.mult);
  if (name.length < 2 || !/^#[0-9a-fA-F]{6}$/.test(color) || !Number.isFinite(mult) || mult < 0.5 || mult > 5) {
    return c.json({ message: 'Dados inválidos (nome 2-30, cor #hex, mult 0.5-5).' }, 400);
  }
  const code = name.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 16) || 'CAT';
  try {
    await getCategories(sql);
    try { await sql`ALTER TABLE trips ALTER COLUMN "rideType" TYPE TEXT USING "rideType"::text`; } catch {}
    const rows = await sql`INSERT INTO ride_categories (code, name, color, mult, sort) VALUES (${code}, ${name}, ${color}, ${mult}, 99) RETURNING code, name, color, mult`;
    const r = rows[0];
    return c.json({ category: { code: r.code, name: r.name, color: r.color, mult: Number(r.mult) } });
  } catch (e) {
    if (String(e).includes('duplicate') || String(e).includes('already exists')) return c.json({ message: 'Já existe categoria com esse nome.' }, 409);
    console.error('add category error:', e);
    return c.json({ message: 'Falhou ao criar.' }, 500);
  }
});

// PUT /api/v1/admin/categories/:code — Editar nome/cor/mult
app.put('/api/v1/admin/categories/:code', adminMiddleware, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const code = String(c.req.param('code') || '').toUpperCase().slice(0, 16);
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name || '').trim().slice(0, 30);
  const color = String(b.color || '').trim();
  const mult = Number(b.mult);
  if (!code || name.length < 2 || !/^#[0-9a-fA-F]{6}$/.test(color) || !Number.isFinite(mult) || mult < 0.5 || mult > 5) {
    return c.json({ message: 'Dados inválidos (nome 2-30, cor #hex, mult 0.5-5).' }, 400);
  }
  await getCategories(sql);
  const rows = await sql`UPDATE ride_categories SET name = ${name}, color = ${color}, mult = ${mult} WHERE code = ${code} RETURNING code, name, color, mult`;
  if (!rows.length) return c.json({ message: 'Categoria não encontrada.' }, 404);
  const r = rows[0];
  return c.json({ category: { code: r.code, name: r.name, color: r.color, mult: Number(r.mult) } });
});

// ─── WEB CONTRACT (home ladiesgo-home.html) — Neon-backed ───
// A home fala este dialeto (status em minúsculas, nomes incluídos).
const WEB2NEON: Record<string, string> = { pending: 'REQUESTED', accepted: 'ACCEPTED', arrived: 'DRIVER_ARRIVED', in_progress: 'IN_PROGRESS', completed: 'COMPLETED', cancelled: 'CANCELLED' };
const NEON2WEB: Record<string, string> = { REQUESTED: 'pending', ACCEPTED: 'accepted', DRIVER_ARRIVED: 'arrived', IN_PROGRESS: 'in_progress', COMPLETED: 'completed', CANCELLED: 'cancelled' };
const CAT2RIDE: Record<string, string> = { 'Económico': 'ECONOMY', 'Conforto': 'COMFORT', 'Família': 'PREMIUM' };
const RIDE2CAT: Record<string, string> = { ECONOMY: 'Económico', COMFORT: 'Conforto', PREMIUM: 'Família' };
function pay2method(p: any): string {
  return /card|tpa|multicaixa|visa|master/i.test(String(p || '')) ? 'CARD' : 'CASH';
}
// Posição viva da passageira (efémera; como no server.js local).
const paxLive = new Map<string, { lat: number; lng: number; ts: number }>();

function webTripRow(r: any, drv: any, paxName: string, catName?: (code: string) => string, paxPhone?: string) {
  const addr = String(r.dropoffAddress || 'Luanda');
  const cut = addr.indexOf(' · ');
  const destN = cut >= 0 ? addr.slice(0, cut) : addr;
  const destA = cut >= 0 ? addr.slice(cut + 3) : '';
  const stops = Array.isArray(r.stops) ? r.stops : [];
  const cat = catName ? catName(r.rideType) : (RIDE2CAT[r.rideType] || 'Económico');
  return {
    id: r.id,
    status: NEON2WEB[r.status] || r.status,
    passengerId: r.passengerId,
    passengerName: paxName || r.passengerName || 'Passageira',
    passengerPhone: paxPhone || r.passengerPhone || '',
    pickup: { lat: Number(r.pickupLat), lng: Number(r.pickupLng), name: String(r.pickupAddress || 'Ponto no mapa') },
    dest: { n: destN, a: destA, lat: Number(r.dropoffLat), lng: Number(r.dropoffLng) },
    stops: stops.map((s: any) => ({ n: String(s.n || ''), a: String(s.a || ''), lat: Number(s.lat), lng: Number(s.lng) })),
    fare: r.finalFare != null ? Number(r.finalFare) : Number(r.fareEstimate),
    cat: cat,
    pay: r.paymentMethod === 'CARD' ? 'Cartão' : 'Numerário',
    driver: drv || null,
    pin: pinForTrip(r.id),
    views: 0,
    offerExpiresAt: (r as any).offerExpiresAt ? new Date((r as any).offerExpiresAt).getTime() : 0,
    offerIndex: offerQueueOf(r).length ? Number((r as any).offerIdx || 0) + 1 : 0,
    offerTotal: offerQueueOf(r).length,
    isBroadcast: !(r as any).offeredDriverId && !offerQueueOf(r).length ? true : !!(r as any).offerBroadcast,
    ts: r.createdAt,
    by: r.cancelledBy || '',
    reason: r.cancelReason || '',
    scheduledAt: r.scheduledAt ? new Date(r.scheduledAt).getTime() : 0,
    completedAt: r.completedAt ? new Date(r.completedAt).getTime() : 0,
  };
}

async function webDriverInfo(sql: any, driverId: string | null) {
  if (!driverId) return null;
  const d = await sql`
    SELECT d."currentLat", d."currentLng", d.rating, d."totalTrips", d."carMake", d."carModel", d."carColor", d."carPlate", u.name, u.phone
    FROM drivers d LEFT JOIN users u ON u.id = d."userId" WHERE d.id = ${driverId} LIMIT 1`;
  if (!d.length) return null;
  const r = d[0];
  let avg = r.rating != null ? Number(r.rating) : 5;
  try {
    const ar = await sql`SELECT COALESCE(AVG(rt.score), 0)::float AS a, COUNT(*)::int AS n FROM ratings rt JOIN trips t ON t.id = rt."tripId" WHERE t."driverId" = ${driverId}`;
    if (ar[0] && Number(ar[0].n) > 0) avg = Math.round(Number(ar[0].a) * 10) / 10;
  } catch {}
  return {
    lat: r.currentLat != null ? Number(r.currentLat) : null,
    lng: r.currentLng != null ? Number(r.currentLng) : null,
    name: r.name || 'Motorista',
    phone: r.phone || '',
    rating: avg,
    totalTrips: Number(r.totalTrips || 0),
    carMake: r.carMake || '', carModel: r.carModel || '', carColor: r.carColor || '', carPlate: r.carPlate || '',
  };
}

// ─── OFERTA SEQUENCIAL (60s por motorista, mais próxima primeiro) ───
// A passageira pede → a oferta vai só para a motorista online mais próxima
// durante 60s. Sem resposta/rejeição, passa à seguinte. Esgotada a fila,
// abre a todas (broadcast) até ao limite de 10min.
const OFFER_TTL_SEC = 60;
const OFFER_MAX = 15;
async function ensureOfferColumns(sql: any) {
  try { await sql`ALTER TABLE trips ADD COLUMN IF NOT EXISTS "offerQueue" JSONB`; } catch {}
  try { await sql`ALTER TABLE trips ADD COLUMN IF NOT EXISTS "offerIdx" INTEGER NOT NULL DEFAULT 0`; } catch {}
  try { await sql`ALTER TABLE trips ADD COLUMN IF NOT EXISTS "offeredDriverId" TEXT`; } catch {}
  try { await sql`ALTER TABLE trips ADD COLUMN IF NOT EXISTS "offeredAt" TIMESTAMPTZ`; } catch {}
  try { await sql`ALTER TABLE trips ADD COLUMN IF NOT EXISTS "offerExpiresAt" TIMESTAMPTZ`; } catch {}
  try { await sql`ALTER TABLE trips ADD COLUMN IF NOT EXISTS "offerBroadcast" BOOLEAN NOT NULL DEFAULT FALSE`; } catch {}
  try { await sql`ALTER TABLE trips ADD COLUMN IF NOT EXISTS "offerSkipped" JSONB`; } catch {}
  try { await sql`ALTER TABLE trips ADD COLUMN IF NOT EXISTS "offerMissed" JSONB`; } catch {}
}
function offerQueueOf(t: any): string[] {
  const q = (t as any).offerQueue;
  return Array.isArray(q) ? q.map((x: any) => String(x)).filter(Boolean) : [];
}
function offerSkippedOf(t: any): string[] {
  const s = (t as any).offerSkipped;
  return Array.isArray(s) ? s.map((x: any) => String(x)).filter(Boolean) : [];
}
function offerMissedOf(t: any): string[] {
  const s = (t as any).offerMissed;
  return Array.isArray(s) ? s.map((x: any) => String(x)).filter(Boolean) : [];
}
// Candidatas online+aprovadas com GPS e sem viagem ativa, da categoria
// pedida, ordenadas por distância ao pickup (GPS fresco desempata).
async function buildOfferQueue(sql: any, pLa: number, pLo: number, rideCode: string): Promise<string[]> {
  try { await sql`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS cats JSONB`; } catch {}
  let byCode: Record<string, string> = {};
  try { byCode = (await catMaps(sql)).byCode; } catch {}
  let rows: any[] = [];
  try {
    rows = await sql`SELECT d.id, d."currentLat", d."currentLng", d.cats, d."updatedAt" FROM drivers d WHERE d."isOnline" = true AND d.status = 'APPROVED' AND d."currentLat" IS NOT NULL AND d."currentLng" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trips t2 WHERE t2."driverId" = d.id AND t2.status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS'))`;
  } catch { return []; }
  const wantCat = byCode[rideCode] || '';
  const now = Date.now();
  return rows
    .filter((d: any) => {
      if (Array.isArray(d.cats) && d.cats.length && wantCat) {
        return d.cats.map((x: any) => String(x)).indexOf(wantCat) >= 0;
      }
      return true;
    })
    .map((d: any) => {
      const km = Number.isFinite(pLa) && Number.isFinite(pLo) ? havKm(pLa, pLo, Number(d.currentLat), Number(d.currentLng)) : 0;
      let stale = 0;
      try { stale = now - new Date(d.updatedAt).getTime(); } catch {}
      return { id: String(d.id), km, stale };
    })
    .filter((d: any) => Number.isFinite(d.km))
    .sort((a: any, b: any) => (a.km - b.km) || (a.stale - b.stale))
    .slice(0, OFFER_MAX)
    .map((d: any) => d.id);
}
// Push dirigido a UMA motorista (oferta exclusiva).
async function pushTripToDriver(sql: any, driverId: string, tripId: string, title: string, body: string) {
  try {
    const r = await sql`SELECT u."fcmToken" FROM drivers d JOIN users u ON u.id = d."userId" WHERE d.id = ${driverId} LIMIT 1`;
    const tok = r[0]?.fcmToken;
    if (!tok || String(tok).indexOf('ExponentPushToken') !== 0) return;
    await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ to: tok, sound: 'default', title, body, data: { tripId, type: 'new-trip' } }]) });
  } catch {}
}
// Avança a oferta se expirou (lazy, em cada sondagem). Devolve a linha fresca.
async function advanceOfferIfNeeded(sql: any, t: any, pushBody?: { title: string; body: string }): Promise<any> {
  try {
    if (!t || t.status !== 'REQUESTED' || (t as any).offerBroadcast) return t;
    const exp = (t as any).offerExpiresAt ? new Date((t as any).offerExpiresAt).getTime() : 0;
    if (exp && Date.now() < exp) return t;
    const q = offerQueueOf(t);
    const skipped = offerSkippedOf(t);
    const missed = offerMissedOf(t);
    const cur = (t as any).offeredDriverId ? String((t as any).offeredDriverId) : '';
    // Timeout (sem resposta) != rejeicao: quem calou volta a ver em
    // broadcast, mas ja nao recebe ofertas exclusivas desta viagem.
    if (cur && missed.indexOf(cur) < 0) missed.push(cur);
    const gone = (id: string) => skipped.indexOf(id) >= 0 || missed.indexOf(id) >= 0;
    const oldIdx = Number((t as any).offerIdx || 0);
    let idx = oldIdx + (cur ? 1 : 0);
    while (idx < q.length && gone(q[idx])) idx += 1;
    const missedJson = JSON.stringify(missed);
    if (idx >= q.length) {
      const r = await sql`UPDATE trips SET "offerBroadcast" = TRUE, "offerMissed" = ${missedJson}::jsonb, "updatedAt" = NOW() WHERE id = ${t.id} AND status = 'REQUESTED' RETURNING *`;
      return r[0] || t;
    }
    const expAt = new Date(Date.now() + OFFER_TTL_SEC * 1000);
    const r = await sql`UPDATE trips SET "offerIdx" = ${idx}, "offeredDriverId" = ${q[idx]}, "offeredAt" = NOW(), "offerExpiresAt" = ${expAt as any}, "offerMissed" = ${missedJson}::jsonb, "updatedAt" = NOW() WHERE id = ${t.id} AND status = 'REQUESTED' AND COALESCE("offerIdx", 0) = ${oldIdx} RETURNING *`;
    if (!r[0]) {
      const rr = await sql`SELECT * FROM trips WHERE id = ${t.id} LIMIT 1`;
      return rr[0] || t;
    }
    if (pushBody) await pushTripToDriver(sql, q[idx], t.id, pushBody.title, pushBody.body);
    return r[0];
  } catch { return t; }
}

// POST /api/v1/trips/request-web — Pedido da home (web)
app.post('/api/v1/trips/request-web', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const user = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  const pLa = Number(b.pickupLat), pLo = Number(b.pickupLng);
  const dLa = Number(b.destLat), dLo = Number(b.destLng);
  const fare = Math.round(Number(b.fare)) || 0;
  if (!Number.isFinite(pLa) || !Number.isFinite(pLo) || !Number.isFinite(dLa) || !Number.isFinite(dLo) || fare <= 0) {
    return c.json({ message: 'Pedido inválido.' }, 400);
  }
  try {
    // Viagem ativa impede novo pedido (a home trata o 409 com o fluxo de avaliação).
    const active = await sql`SELECT id, status FROM trips WHERE "passengerId" = ${user.sub} AND status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') ORDER BY "createdAt" DESC LIMIT 1`;
    if (active.length && active[0].status !== 'REQUESTED') return c.json({ message: 'Avalia a tua última viagem para pedir outra.' }, 409);
    if (active.length) await sql`UPDATE trips SET status = 'CANCELLED', "cancelledBy" = ${user.sub}, "cancelReason" = 'Replaced by new booking', "updatedAt" = NOW() WHERE id = ${active[0].id}`;
    let pickupName = String(b.pickupName || '').slice(0, 60);
    if (!pickupName) {
      try {
        const zr = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${pLa}&lon=${pLo}&format=json&zoom=14`, { headers: { 'User-Agent': 'LadiesGo/1.0' }, signal: AbortSignal.timeout(8000) });
        const zj: any = await zr.json();
        const za = (zj && zj.address) || {};
        pickupName = za.suburb || za.neighbourhood || za.quarter || za.city_district || za.town || za.city || '';
      } catch {}
      if (!pickupName) {
        try {
          const br = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${pLa}&longitude=${pLo}&localityLanguage=pt`, { signal: AbortSignal.timeout(8000) });
          const bj: any = await br.json();
          pickupName = bj.locality || bj.city || bj.principalSubdivision || '';
        } catch {}
      }
      if (!pickupName) pickupName = offlineZone(pLa, pLo) || 'Ponto no mapa';
      pickupName = pickupName.slice(0, 60);
    }
    const dist = havKm(pLa, pLo, dLa, dLo);
    const stops = Array.isArray(b.stops) ? b.stops.slice(0, 3).map((x: any) => ({ n: String(x.n || '').slice(0, 60), a: String(x.a || '').slice(0, 80), lat: Number(x.lat), lng: Number(x.lng) })).filter((x: any) => Number.isFinite(x.lat) && Number.isFinite(x.lng)) : [];
    const sched = Number(b.scheduledAt) > Date.now() ? new Date(Number(b.scheduledAt)) : null;
    const { byName } = await catMaps(sql);
    const rows = await sql`
      INSERT INTO trips (id, "passengerId", "pickupAddress", "pickupLat", "pickupLng", "dropoffAddress", "dropoffLat", "dropoffLng",
        status, "rideType", "fareEstimate", "distanceKm", "paymentMethod", stops, "scheduledAt", "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, ${user.sub}, ${pickupName}, ${pLa}, ${pLo},
        ${String(b.destN || '').slice(0, 60) + ' · ' + String(b.destA || '').slice(0, 80)}, ${dLa}, ${dLo},
        'REQUESTED', ${byName[String(b.cat)] || 'ECONOMY'}, ${fare}, ${Math.round(dist * 10) / 10},
        ${pay2method(b.pay)}, ${JSON.stringify(stops)}::jsonb, ${sched as any}, NOW(), NOW())
      RETURNING id`;
    const tripId = rows[0].id;
    // Oferta sequencial por proximidade (60s cada); sem candidatas abre a todas.
    let offerFirst: string | null = null;
    try {
      await ensureOfferColumns(sql);
      const rideCode = byName[String(b.cat)] || 'ECONOMY';
      const q = await buildOfferQueue(sql, pLa, pLo, rideCode);
      if (q.length) {
        offerFirst = q[0];
        const expAt = new Date(Date.now() + OFFER_TTL_SEC * 1000);
        await sql`UPDATE trips SET "offerQueue" = ${JSON.stringify(q)}::jsonb, "offerIdx" = 0, "offeredDriverId" = ${q[0]}, "offeredAt" = NOW(), "offerExpiresAt" = ${expAt as any}, "offerBroadcast" = FALSE, "offerSkipped" = '[]'::jsonb WHERE id = ${tripId}`;
      } else {
        await sql`UPDATE trips SET "offerBroadcast" = TRUE WHERE id = ${tripId}`;
      }
    } catch {}
    // Push imediato + arranque do toca-toca de 3s (não bloqueia a resposta).
    try {
      const destN = String(b.destN || '').slice(0, 60);
      const body = `${pickupName} → ${destN}${stops.length ? ` · +${stops.length} paragem${stops.length > 1 ? 'ns' : ''}` : ''} · ${fare} Kz`;
      c.executionCtx.waitUntil((async () => {
        if (offerFirst) await pushTripToDriver(sql, offerFirst, tripId, '🔔 Novo pedido LadiesGo!', body);
        else await pushTripToDrivers(sql, tripId, pickupName, destN, stops.length, fare, '🔔 Novo pedido LadiesGo!', String(b.cat || ''));
        await ringStart(c.env);
        try {
          const fbTok = String((c.env as any).FB_SCRAPE_TOKEN || '');
          if (fbTok) await fetch('https://graph.facebook.com/v26.0/?id=' + encodeURIComponent('https://ladiesgo.pages.dev/t?id=' + tripId) + '&scrape=true&access_token=' + encodeURIComponent(fbTok), { method: 'POST', signal: AbortSignal.timeout(10000) });
        } catch {}
      })());
    } catch {}
    return c.json({ id: tripId });
  } catch (e) {
    console.error('request-web error:', e);
    return c.json({ message: 'Falhou o pedido. Tenta de novo.' }, 500);
  }
});

// POST /api/v1/trips/:id/status — Transições da home (web)
app.post('/api/v1/trips/:id/status', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const st = String(b.status || '');
  const neonSt = WEB2NEON[st];
  const okNext: Record<string, string[]> = { ACCEPTED: ['REQUESTED'], DRIVER_ARRIVED: ['ACCEPTED'], IN_PROGRESS: ['DRIVER_ARRIVED'], COMPLETED: ['IN_PROGRESS'], CANCELLED: ['REQUESTED', 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS'] };
  if (!neonSt || !okNext[neonSt]) return c.json({ message: 'Transição inválida.' }, 400);
  try {
    const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
    if (!cur.length) return c.json({ message: 'Viagem não encontrada.' }, 404);
    const t = cur[0];
    if (okNext[neonSt].indexOf(t.status) < 0) return c.json({ message: 'Transição inválida.' }, 400);
    if (neonSt === 'ACCEPTED') {
      const did = await driverIdFor(sql, String(b.driverId || ''));
      if (!did) return c.json({ message: 'Só motoristas.' }, 403);
      const busy = await sql`SELECT id FROM trips WHERE "driverId" = ${did} AND status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') LIMIT 1`;
      if (busy.length) return c.json({ message: 'Já tens uma viagem ativa.' }, 400);
      // Oferta sequencial: só a motorista ofertada (ou qualquer uma em broadcast).
      try {
        await ensureOfferColumns(sql);
        const oc = await sql`SELECT "offerQueue", "offerIdx", "offeredDriverId", "offerBroadcast", "offerExpiresAt", status FROM trips WHERE id = ${id} LIMIT 1`;
        if (oc.length && oc[0].status === 'REQUESTED' && !oc[0].offerBroadcast && (offerQueueOf(oc[0]).length || oc[0].offeredDriverId)) {
          const fresh: any = await advanceOfferIfNeeded(sql, oc[0]);
          if (!fresh.offerBroadcast && String(fresh.offeredDriverId || '') !== did) {
            return c.json({ message: 'Esta oferta já passou para outra motorista.' }, 409);
          }
        }
      } catch {}
      const acc = await sql`UPDATE trips SET "driverId" = ${did}, status = 'ACCEPTED', "acceptedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id} AND status = 'REQUESTED' RETURNING *`;
      if (!acc.length) return c.json({ message: 'Transição inválida.' }, 400);
    } else if (neonSt === 'DRIVER_ARRIVED') {
      await sql`UPDATE trips SET status = 'DRIVER_ARRIVED', "arrivedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id}`;
    } else if (neonSt === 'IN_PROGRESS') {
      await sql`UPDATE trips SET status = 'IN_PROGRESS', "startedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id}`;
    } else if (neonSt === 'COMPLETED') {
      const devTs = Number((b as any).ts);
      const doneAt = Number.isFinite(devTs) && Math.abs(devTs - Date.now()) <= 15 * 60 * 1000 ? new Date(devTs) : new Date();
      await sql`UPDATE trips SET status = 'COMPLETED', "finalFare" = COALESCE("finalFare", "fareEstimate"), "completedAt" = ${doneAt as any}, "updatedAt" = NOW() WHERE id = ${id}`;
      if (t.driverId) await sql`UPDATE drivers SET "totalTrips" = "totalTrips" + 1, "totalEarnings" = "totalEarnings" + ${Number(t.finalFare || t.fareEstimate || 0) * 0.8} WHERE id = ${t.driverId}`;
    } else if (neonSt === 'CANCELLED') {
      await sql`UPDATE trips SET status = 'CANCELLED', "cancelledBy" = ${String(b.by || '').slice(0, 16)}, "cancelReason" = ${String(b.reason || '').slice(0, 80)}, "updatedAt" = NOW() WHERE id = ${id}`;
    }
    return c.json({ ok: true, status: st });
  } catch (e) {
    console.error('trip status error:', e);
    return c.json({ message: 'Falhou. Tenta de novo.' }, 500);
  }
});

// GET /api/v1/trips/public/:id — Partilha com contactos (sem login: quem tem o link vê)
app.get('/api/v1/trips/public/:id', async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const id = c.req.param('id');
  try {
    const rows = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
    if (!rows.length) return c.json({ message: 'Viagem não encontrada.' }, 404);
    const t = rows[0];
    const pu = await sql`SELECT name, phone FROM users WHERE id = ${t.passengerId} LIMIT 1`;
    let driver = null;
    if (t.driverId) {
      const d = await sql`
        SELECT d."currentLat", d."currentLng", d.rating, d."carMake", d."carModel", d."carColor", d."carPlate", d."carPhoto", u.name, u.phone, u."profilePhoto"
        FROM drivers d LEFT JOIN users u ON u.id = d."userId" WHERE d.id = ${t.driverId} LIMIT 1`;
      if (d.length) {
        const r = d[0];
        const carFull = [r.carMake, r.carModel].filter(Boolean).join(' ') + (r.carColor ? ' · ' + r.carColor : '');
        driver = { name: r.name || 'Motorista', phone: r.phone || '', carFull, plate: r.carPlate || '', rating: r.rating != null ? Number(r.rating) : null, photo: r.carPhoto || r.profilePhoto || '', lat: r.currentLat != null ? Number(r.currentLat) : null, lng: r.currentLng != null ? Number(r.currentLng) : null };
      }
    }
    const stops = Array.isArray(t.stops) ? t.stops : [];
    return c.json({
      status: t.status,
      pickup: { name: String(t.pickupAddress || ''), lat: Number(t.pickupLat), lng: Number(t.pickupLng) },
      dest: { name: String(t.dropoffAddress || ''), lat: Number(t.dropoffLat), lng: Number(t.dropoffLng) },
      stops: stops.map((s: any) => ({ n: String(s.n || ''), a: String(s.a || ''), lat: Number(s.lat), lng: Number(s.lng) })),
      driver, passenger: { name: pu[0]?.name || 'Passageira', phone: pu[0]?.phone || '' },
    });
  } catch (e) {
    console.error('public trip error:', e);
    return c.json({ message: 'Falhou. Tenta de novo.' }, 500);
  }
});

// POST /api/v1/trips/:id/position — Posição viva da passageira (web)
app.post('/api/v1/trips/:id/position', requireAuth, async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const la = Number(b.lat), lo = Number(b.lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return c.json({ message: 'Posição inválida.' }, 400);
  paxLive.set(id, { lat: la, lng: lo, ts: Date.now() });
  return c.json({ ok: true });
});

// Push com som (Expo) — usado no pedido imediato e no cron de repetição.
async function pushTripToDrivers(sql: any, tripId: string, pickupName: string, destN: string, stopsN: number, fare: number, title: string, catName?: string) {
  try {
    const cands = await sql`SELECT u."fcmToken", d.cats FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."isOnline" = true AND d.status = 'APPROVED' AND u."fcmToken" LIKE 'ExponentPushToken%' LIMIT 100`;
    const toks = cands.filter((r: any) => !catName || !Array.isArray(r.cats) || !r.cats.length || r.cats.map((x: any) => String(x)).indexOf(catName) >= 0);
    const body = `${pickupName} → ${destN}${stopsN ? ` · +${stopsN} paragem${stopsN > 1 ? 'ns' : ''}` : ''} · ${fare} Kz`;
    const msgs = toks.map((r: any) => ({ to: r.fcmToken, sound: 'default', title, body, data: { tripId, type: 'new-trip' } })).filter((m: any) => m.to);
    if (msgs.length) await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msgs) });
  } catch {}
}

// Toca-toca global: 1 viagem = detalhe (local + paragens); várias = resumo
// único ("tens viagens disponíveis"). Alarme de 3s, máx. 4 repetições
// (5 pushes no total com o imediato). Pára sem pendentes.
export class TripRinger {
  state: any;
  env: any;
  constructor(state: any, env: any) {
    this.state = state;
    this.env = env;
  }
  async fetch(req: any) {
    const u = new URL(req.url);
    if (u.pathname.endsWith('/cancel')) {
      try { await this.state.storage.deleteAlarm(); } catch {}
      return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
    }
    const now = Date.now();
    const lastKick: number = (await this.state.storage.get('lastKick')) || 0;
    if (now - lastKick > 60000) await this.state.storage.put('sent', 0);
    await this.state.storage.put('lastKick', now);
    await this.state.storage.setAlarm(now + 3000);
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
  }
  async alarm() {
    try {
      const sent: number = (await this.state.storage.get('sent')) || 0;
      if (sent >= 4) return;
      const sql = neon(this.env.DATABASE_URL);
      const rows = await sql`
        SELECT id, "pickupAddress", "dropoffAddress", "fareEstimate", stops, "rideType" FROM trips
        WHERE status = 'REQUESTED' AND "createdAt" > NOW() - INTERVAL '6 minutes'
        ORDER BY "createdAt" ASC LIMIT 20`;
      if (!rows.length) return;
      if (rows.length === 1) {
        const t = rows[0];
        // Já há conversa: só o recetor é avisado por mensagem; não insistir aqui.
        try {
          const ch = await sql`SELECT id FROM chat_messages WHERE "tripId" = ${t.id} AND "createdAt" > NOW() - INTERVAL '3 minutes' LIMIT 1`;
          if (ch.length) { await this.state.storage.setAlarm(Date.now() + 3000); return; }
        } catch {}
        const addr = String(t.dropoffAddress || 'Luanda');
        const cut = addr.indexOf(' · ');
        const { byCode } = await catMaps(sql);
        // Oferta sequencial: roda a fila e avisa só a ofertada (sem
        // broadcast). Reagenda para a hora em que a oferta expira.
        try {
          await ensureOfferColumns(sql);
          const full = await sql`SELECT * FROM trips WHERE id = ${t.id} LIMIT 1`;
          if (full.length && !full[0].offerBroadcast && (offerQueueOf(full[0]).length || full[0].offeredDriverId)) {
            const fresh: any = await advanceOfferIfNeeded(sql, full[0], {
              title: '🔔 Novo pedido LadiesGo!',
              body: `${String(full[0].pickupAddress || 'Ponto no mapa')} → ${String(full[0].dropoffAddress || '').split(' · ')[0]} · ${Number(full[0].fareEstimate || 0)} Kz`,
            });
            if (!fresh.offerBroadcast) {
              const exp = fresh.offerExpiresAt ? new Date(fresh.offerExpiresAt).getTime() : 0;
              const delay = exp && exp > Date.now() ? Math.min(Math.max(exp - Date.now(), 3000), 65000) : 10000;
              await this.state.storage.setAlarm(Date.now() + delay);
              return;
            }
          }
        } catch {}
        await pushTripToDrivers(sql, t.id, String(t.pickupAddress || 'Ponto no mapa'), cut >= 0 ? addr.slice(0, cut) : addr, Array.isArray(t.stops) ? t.stops.length : 0, Number(t.fareEstimate || 0), '🔔 Novo pedido LadiesGo!', byCode[t.rideType] || '');
      } else {
        // Resumo só das viagens em broadcast (as exclusivas já avisam a
        // ofertada). Sem nenhuma aberta, reagenda em silêncio.
        let openN = rows.length;
        try {
          await ensureOfferColumns(sql);
          const oc = await sql`SELECT COUNT(*)::int AS n FROM trips WHERE status = 'REQUESTED' AND "createdAt" > NOW() - INTERVAL '6 minutes' AND ("offerBroadcast" = TRUE OR "offerQueue" IS NULL)`;
          openN = Number(oc[0]?.n || 0);
        } catch {}
        if (!openN) {
          try { await this.state.storage.setAlarm(Date.now() + 10000); } catch {}
          return;
        }
        try {
          const toks = await sql`SELECT u."fcmToken" FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."isOnline" = true AND d.status = 'APPROVED' AND u."fcmToken" LIKE 'ExponentPushToken%' LIMIT 100`;
          const msgs = toks.map((r: any) => ({
            to: r.fcmToken, sound: 'default',
            title: '🔔 Viagens disponíveis — LadiesGo!',
            body: `Tens ${openN} pedido${openN > 1 ? 's' : ''} à espera · abre a app`,
            data: { type: 'pending-summary' },
          })).filter((m: any) => m.to);
          if (msgs.length) await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msgs) });
        } catch {}
      }
      await this.state.storage.put('sent', sent + 1);
      await this.state.storage.setAlarm(Date.now() + 3000);
    } catch {
      try { await this.state.storage.setAlarm(Date.now() + 10000); } catch {}
    }
  }
}

async function ringStart(env: any) {
  try {
    const stub = env.RINGER.get(env.RINGER.idFromName('global'));
    await stub.fetch('https://ringer/kick');
  } catch {}
}

// POST /api/v1/payments/create-intent — Create payment intent
app.post('/api/v1/payments/create-intent', requireAuth, async (c) => {
  // Mock for now - would integrate with Stripe in production
  return c.json({ clientSecret: null, cash: true });
});

// POST /api/v1/payments/confirm — Confirm payment
app.post('/api/v1/payments/confirm', requireAuth, async (c) => {
  return c.json({ success: true });
});

export default {
  fetch: app.fetch,
};
