// LadiesGo! API — Cloudflare Workers + Hono + Neon HTTP.
// Sem Render. Contratos 1:1 com mobile/src/services/api.ts.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { neon } from '@neondatabase/serverless';

type Env = { DATABASE_URL: string; JWT_SECRET: string; JWT_EXPIRES_IN?: string };

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
app.post('/api/v1/auth/login', async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const { phone, password } = await c.req.json().catch(() => ({}));
  const cleanPhone = String(phone || '').trim();
  if (!cleanPhone || !password) return c.json({ message: 'Número ou senha incorretos' }, 401);
  const rows = await sql`SELECT id, phone, "passwordHash", name, email, role, "profilePhoto", "fcmToken", "isActive", "isVerified", "mustChangePassword", "adminCreated", "walletBalance", "createdAt", "updatedAt" FROM users WHERE phone = ${cleanPhone} AND "passwordHash" = crypt(${String(password)}, "passwordHash") AND "isActive" = true LIMIT 1`;
  if (!rows.length) return c.json({ message: 'Número ou senha incorretos' }, 401);
  const user = rows[0];
  const accessToken = await signJwt({ sub: user.id, phone: user.phone, role: user.role }, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN || '7d');
  return c.json({ user: withoutHash(user), accessToken, isNew: false });
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
  const rows = await sql`UPDATE users SET name = COALESCE(${body?.name ?? null}, name), "fcmToken" = COALESCE(${body?.fcmToken ?? null}, "fcmToken"), "updatedAt" = NOW() WHERE id = ${user.sub} RETURNING id, phone, name, email, role, "profilePhoto", "isVerified", "mustChangePassword", "walletBalance"`;
  return c.json(rows[0] || {});
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
app.get('/api/v1/drivers/nearby', requireAuth, async (c) => {
  const sql = neon(c.env.DATABASE_URL);
  const lat = Number(c.req.query('lat')), lng = Number(c.req.query('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return c.json({ message: 'Pedido inválido.' }, 400);
  const rows = await sql`SELECT d.id, d."currentLat", d."currentLng", u.name FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."isOnline" = true AND d.status = 'APPROVED' AND d."currentLat" IS NOT NULL LIMIT 100`;
  const out = rows
    .map((d: any) => ({ id: d.id, currentLat: Number(d.currentLat), currentLng: Number(d.currentLng), lat: Number(d.currentLat), lng: Number(d.currentLng), name: d.name, distanceKm: Math.round(havKm(lat, lng, Number(d.currentLat), Number(d.currentLng)) * 10) / 10 }))
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

// ─── TRIPS ───
app.post('/api/v1/trips/estimate', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const dist = havKm(Number(body.pickupLat), Number(body.pickupLng), Number(body.dropoffLat), Number(body.dropoffLng));
  const base = BASE_FARE + dist * PER_KM;
  const surge = surgeNow();
  const mult = RIDE_MULT[String(body.rideType || 'ECONOMY')] ?? 1.0;
  const options = Object.keys(RIDE_MULT).map((type) => ({ type, fare: Math.round(base * surge * RIDE_MULT[type] * 100) / 100 }));
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
  const fare = Math.round((BASE_FARE + dist * PER_KM) * surgeNow() * (RIDE_MULT[String(b.rideType || 'ECONOMY')] ?? 1) * 100) / 100;
  const rows = await sql`INSERT INTO trips (id, "passengerId", "pickupAddress", "pickupLat", "pickupLng", "dropoffAddress", "dropoffLat", "dropoffLng", status, "rideType", "fareEstimate", "distanceKm", "paymentMethod", "createdAt", "updatedAt") VALUES (gen_random_uuid()::text, ${user.sub}, ${String(b.pickupAddress || 'Luanda')}, ${Number(b.pickupLat)}, ${Number(b.pickupLng)}, ${String(b.dropoffAddress || 'Luanda')}, ${Number(b.dropoffLat)}, ${Number(b.dropoffLng)}, 'REQUESTED', ${String(b.rideType || 'ECONOMY')}, ${fare}, ${Math.round(dist * 10) / 10}, ${String(b.paymentMethod || 'CASH')}, NOW(), NOW()) RETURNING *`;
  return c.json(rows[0]);
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
  const cur = await sql`SELECT status FROM trips WHERE id = ${id} LIMIT 1`;
  if (!cur.length || cur[0].status !== 'REQUESTED') return c.json({ message: 'Viagem indisponível.' }, 400);
  const rows = await sql`UPDATE trips SET "driverId" = ${did}, status = 'ACCEPTED', "acceptedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id} RETURNING *`;
  return c.json(rows[0]);
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
    await sql`INSERT INTO ratings (id, "tripId", "raterId", "ratedId", score, comment, "createdAt") VALUES (gen_random_uuid()::text, ${String(b.tripId)}, ${user.sub}, ${String(b.ratedId || b.driverId || '')}, ${Number(b.score || 5)}, ${String(b.comment || '').slice(0, 500)}, NOW()) ON CONFLICT ("tripId", "raterId") DO NOTHING`;
  } catch {}
  return c.json({ success: true });
});
app.get('/api/v1/notifications', requireAuth, async (c) => c.json({ notifications: [] }));
app.get('/api/v1/notifications/unread-count', requireAuth, async (c) => c.json({ count: 0 }));
app.put('/api/v1/notifications/read-all', requireAuth, async (c) => c.json({ success: true }));
app.post('/api/v1/payments/create-intent', requireAuth, async (c) => c.json({ clientSecret: null, cash: true }));
app.post('/api/v1/payments/confirm', requireAuth, async (c) => c.json({ success: true }));

// ─── PLACES / ZONE / ROUTE (sem BD, com cache edge) ───
app.get('/api/places/search', async (c) => {
  return c.json({ places: [] }, 200, { 'Cache-Control': 'public, max-age=600' });
});
app.get('/api/zone', async (c) => {
  const la = Number(c.req.query('lat')), lo = Number(c.req.query('lng'));
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return c.json({ message: 'Pedido inválido.' }, 400);
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${la}&lon=${lo}&format=json&zoom=14`, { headers: { 'User-Agent': 'LadiesGo/1.0' } });
    const j: any = await r.json();
    const a = j?.address || {};
    return c.json({ zone: a.suburb || a.neighbourhood || a.quarter || a.city_district || a.town || a.city || '' }, 200, { 'Cache-Control': 'public, max-age=86400' });
  } catch {
    return c.json({ zone: '' }, 200, { 'Cache-Control': 'public, max-age=86400' });
  }
});
app.get('/api/route', async (c) => {
  const from = String(c.req.query('from') || '').split(',').map(Number);
  const to = String(c.req.query('to') || '').split(',').map(Number);
  if (from.length !== 2 || to.length !== 2 || ![...from, ...to].every(Number.isFinite)) return c.json({ message: 'Pedido inválido.' }, 400);
  try {
    const q = `${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`;
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${q}`);
    const j: any = await r.json();
    const g = j?.routes?.[0]?.geometry?.coordinates;
    if (!g?.length) return c.json({ message: 'Sem rota de momento.' }, 502);
    return c.json({ points: g.map((p: number[]) => [p[1], p[0]]), distance_m: j.routes[0].distance, duration_s: j.routes[0].duration }, 200, { 'Cache-Control': 'public, max-age=600' });
  } catch {
    return c.json({ message: 'Sem rota de momento.' }, 502);
  }
});

export default app;
