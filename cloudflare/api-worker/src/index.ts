// LadiesGo! API — Cloudflare Workers + Hono + Neon HTTP.
// Sem Render. Contratos 1:1 com mobile/src/services/api.ts.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { makeSql as neon, d1metrics, resetD1Metrics } from './db';

type Env = { DB: any; JWT_SECRET: string; JWT_EXPIRES_IN?: string; METERED_DOMAIN?: string; METERED_TURN_APIKEY?: string; METERED_FREE_MB?: string; RINGER?: any; TRIPPUSH?: any; REQUESTSHUB?: any; DEBUG_KEY?: string; TG_BOT_TOKEN?: string; TG_CHAT_ID?: string; TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string };

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

// ─── Passwords: PBKDF2-SHA256 via WebCrypto (substitui o bcrypt/pgcrypto do Neon) ───
// Formato do hash: pbkdf2$<iteracoes>$<saltB64url>$<hashB64url>
const PBKDF2_ITER = 100000;
async function pbkdf2Bits(pw: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}
async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2Bits(pw, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64url(salt)}$${b64url(bits)}`;
}
async function verifyPassword(pw: string, stored: any): Promise<boolean> {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = parseInt(parts[1], 10);
  if (!Number.isFinite(iter) || iter < 1000) return false;
  const want = unb64url(parts[3]);
  const got = await pbkdf2Bits(pw, unb64url(parts[2]), iter);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
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

// ─── debug: métricas D1 (só ativo se DEBUG_KEY estiver definido) ───
const geoMetrics: any = { calls: 0, sets: 0, gets: 0, alls: 0, dels: 0 };
function resetGeoMetrics(): void { geoMetrics.calls = 0; geoMetrics.sets = 0; geoMetrics.gets = 0; geoMetrics.alls = 0; geoMetrics.dels = 0; }
app.get('/debug/d1', (c) => {
  const key = c.env.DEBUG_KEY as string | undefined;
  if (!key || c.req.query('key') !== key) return c.json({ message: 'Not found.' }, 404);
  return c.json({ ...d1metrics, rowsPerQuery: d1metrics.queries ? +(d1metrics.rowsRead / d1metrics.queries).toFixed(2) : 0, geo: { ...geoMetrics } });
});
app.post('/debug/d1/reset', (c) => {
  const key = c.env.DEBUG_KEY as string | undefined;
  if (!key || c.req.query('key') !== key) return c.json({ message: 'Not found.' }, 404);
  resetD1Metrics();
  resetGeoMetrics();
  return c.json({ ok: true });
});
app.get('/debug/geo', (c) => {
  const key = c.env.DEBUG_KEY as string | undefined;
  if (!key || c.req.query('key') !== key) return c.json({ message: 'Not found.' }, 404);
  return c.json({ ...geoMetrics });
});

// ─── AUTH ───
app.post('/api/v1/auth/guest', async (c) => {
  const sql = neon(c.env.DB);
  const body = await c.req.json().catch(() => ({}));
  const phone = `+guest${[...crypto.getRandomValues(new Uint8Array(6))].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  const rows = await sql`INSERT INTO users (id, phone, role, "isVerified", name, "createdAt", "updatedAt") VALUES (gen_random_uuid()::text, ${phone}, 'PASSENGER', true, ${String(body?.name || 'Guest').slice(0, 60)}, NOW(), NOW()) RETURNING id, phone, name, role, "profilePhoto", "fcmToken", "isActive", "isVerified", "mustChangePassword", "adminCreated", "walletBalance", "createdAt", "updatedAt"`;
  const user = rows[0];
  const accessToken = await signJwt({ sub: user.id, phone: user.phone, role: user.role }, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN || '7d');
  return c.json({ user: withoutHash(user), accessToken });
});

// LOGIN: verificação PBKDF2 (WebCrypto) no worker — mesmo modelo do Neon (hash na BD).
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
  const sql = neon(c.env.DB);
  const rows = await sql`SELECT id, phone, "passwordHash", name, email, role, "profilePhoto", "fcmToken", "isActive", "isVerified", "mustChangePassword", "adminCreated", "walletBalance", "createdAt", "updatedAt" FROM users WHERE phone = ${cleanPhone} AND "isActive" = true LIMIT 1`;
  if (!rows.length || !(await verifyPassword(String(password), rows[0].passwordHash))) return c.json({ message: 'Número ou senha incorretos' }, 401);
  const user = rows[0];
  const accessToken = await signJwt({ sub: user.id, phone: user.phone, role: user.role }, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN || '7d');
  return c.json({ user: withoutHash(user), accessToken, isNew: false });
});

// REGISTER: cria conta com número + senha (PBKDF2 via WebCrypto no worker).
app.post('/api/v1/auth/register', async (c) => {
  const sql = neon(c.env.DB);
  const { phone, password, name, role } = await c.req.json().catch(() => ({}));
  const cleanPhone = String(phone || '').trim();
  if (!cleanPhone || !password || String(password).length < 4)
    return c.json({ message: 'Número ou senha inválidos.' }, 400);
  const finalRole = String(role || 'PASSENGER').toUpperCase() === 'DRIVER' ? 'DRIVER' : 'PASSENGER';
  const exists = await sql`SELECT id FROM users WHERE phone = ${cleanPhone} LIMIT 1`;
  if (exists.length) return c.json({ message: 'Número já registado. Entra com a tua senha.' }, 409);
  const rows = await sql`INSERT INTO users (id, phone, "passwordHash", name, role, "isVerified", "updatedAt") VALUES (gen_random_uuid()::text, ${cleanPhone}, ${await hashPassword(String(password))}, ${String(name || '').slice(0, 60) || null}, ${finalRole}, true, NOW()) RETURNING id, phone, name, role, "profilePhoto", "fcmToken", "isActive", "isVerified", "mustChangePassword", "adminCreated", "walletBalance", "createdAt", "updatedAt"`;
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
    const sql = neon(c.env.DB);
    const rows = await sql`SELECT id, phone, role FROM users WHERE id = ${p.sub} LIMIT 1`;
    if (!rows.length) return c.json({ message: 'Não autenticado.' }, 401);
    const accessToken = await signJwt({ sub: rows[0].id, phone: rows[0].phone, role: rows[0].role }, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN || '7d');
    return c.json({ accessToken });
  } catch {
    return c.json({ message: 'Sessão inválida.' }, 401);
  }
});

app.post('/api/v1/auth/change-password', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const { newPassword } = await c.req.json().catch(() => ({}));
  if (!newPassword || String(newPassword).length < 4) return c.json({ message: 'A senha deve ter pelo menos 4 caracteres' }, 400);
  await sql`UPDATE users SET "passwordHash" = ${await hashPassword(String(newPassword))}, "mustChangePassword" = false, "updatedAt" = NOW() WHERE id = ${user.sub}`;
  return c.json({ success: true });
});

// ─── USERS ───
app.get('/api/v1/users/profile', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const rows = await sql`SELECT id, phone, name, email, role, "profilePhoto", "isVerified", "mustChangePassword", "walletBalance" FROM users WHERE id = ${user.sub} LIMIT 1`;
  if (!rows.length) return c.json({ message: 'Não encontrado.' }, 404);
  return c.json(rows[0]);
});
app.put('/api/v1/users/profile', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  // Foto de perfil (data URL) enviada pela própria utilizadora.
  let photo: string | null = null;
  if (body?.profilePhoto != null) {
    photo = String(body.profilePhoto);
    if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(photo)) return c.json({ message: 'Foto invalida.' }, 400);
    if (photo.length > 2 * 1024 * 1024) return c.json({ message: 'Foto demasiado grande.' }, 413);
  }
  // Token único por aparelho: limpa-o das outras contas (senão o próprio recebe os pushes).
  if (body?.fcmToken) {
    try { await sql`UPDATE users SET "fcmToken" = NULL, "updatedAt" = NOW() WHERE "fcmToken" = ${body.fcmToken} AND id != ${user.sub}`; } catch {}
  }
  const rows = await sql`UPDATE users SET name = COALESCE(${body?.name ?? null}, name), "fcmToken" = COALESCE(${body?.fcmToken ?? null}, "fcmToken"), "profilePhoto" = COALESCE(${photo}, "profilePhoto"), "updatedAt" = NOW() WHERE id = ${user.sub} RETURNING id, phone, name, email, role, "profilePhoto", "isVerified", "mustChangePassword", "walletBalance"`;
  return c.json(rows[0] || {});
});
// DELETE /api/v1/users/push-token — Logout: este aparelho deixa de receber pushes + motorista fica offline
app.delete('/api/v1/users/push-token', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  await sql`UPDATE users SET "fcmToken" = NULL, "updatedAt" = NOW() WHERE id = ${user.sub}`;
  await sql`UPDATE drivers SET "isOnline" = false, "updatedAt" = NOW() WHERE "userId" = ${user.sub}`;
  return c.json({ ok: true });
});
app.get('/api/v1/users/trips/history', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const page = Math.max(1, Number(c.req.query('page') || 1));
  const rows = await sql`SELECT id, "dropoffAddress", "fareEstimate", status, "createdAt" FROM trips WHERE "passengerId" = ${user.sub} ORDER BY "createdAt" DESC LIMIT 20 OFFSET ${(page - 1) * 20}`;
  return c.json({ trips: rows });
});
app.delete('/api/v1/users/me', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  await sql`UPDATE users SET "isActive" = false, "updatedAt" = NOW() WHERE id = ${user.sub}`;
  return c.json({ success: true });
});
app.post('/api/v1/users/report', requireAuth, async (c) => c.json({ success: true }));

// ─── DRIVERS ───
app.get('/api/v1/drivers/status', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const rows = await sql`SELECT d.*, u.name FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."userId" = ${user.sub} LIMIT 1`;
  if (!rows.length) return c.json({ message: 'Motorista não registada.' }, 404);
  return c.json({ ...rows[0], isOnline: !!rows[0].isOnline, totalEarnings: Number(rows[0].totalEarnings || 0) });
});
app.put('/api/v1/drivers/toggle-online', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const { isOnline } = await c.req.json().catch(() => ({}));
  if (isOnline) {
    const w = await sql`SELECT "walletBlocked" FROM users WHERE id = ${user.sub} LIMIT 1`;
    if (w.length && Number(w[0].walletBlocked || 0)) return c.json({ message: 'Saldo negativo. Carrega a tua conta para voltares a ficar online.' }, 403);
  }
  const rows = await sql`UPDATE drivers SET "isOnline" = ${!!isOnline}, "updatedAt" = NOW() WHERE "userId" = ${user.sub} RETURNING "isOnline"`;
  if (!rows.length) return c.json({ message: 'Motorista não registada.' }, 404);
  return c.json({ isOnline: !!rows[0].isOnline });
});
// GET /api/v1/drivers/wallet — saldo/pontos, viagens negativas e extrato do motorista
app.get('/api/v1/drivers/wallet', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const u = await sql`SELECT "walletBalance", "negTrips", "walletBlocked", phone FROM users WHERE id = ${user.sub} LIMIT 1`;
  if (!u.length) return c.json({ message: 'Conta não encontrada.' }, 404);
  const tx = await sql`SELECT type, amount, "balanceAfter", "tripId", "createdAt" FROM wallet_tx WHERE "userId" = ${user.sub} ORDER BY "createdAt" DESC LIMIT 30`;
  return c.json({
    balance: money(u[0].walletBalance),
    negTrips: Number(u[0].negTrips || 0),
    limit: NEG_TRIP_LIMIT,
    blocked: !!Number(u[0].walletBlocked || 0),
    phone: u[0].phone,
    commissionRate: COMMISSION_RATE,
    transactions: tx.map((t: any) => ({ ...t, amount: money(t.amount), balanceAfter: money(t.balanceAfter) })),
  });
});
// GPS adaptativo do mobile (5s viagem / 10s idle) escreve aqui. Sem socket.
// A posição vai para o DO DriverGeo (memória) — 0 escritas D1 por ping.
app.put('/api/v1/drivers/location', requireAuth, async (c) => {
  const user = c.get('user');
  const { lat, lng } = await c.req.json().catch(() => ({}));
  const la = Number(lat), lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return c.json({ message: 'Posição inválida.' }, 400);
  await geoSet(c.env, { userId: user.sub, lat: la, lng: lo });
  return c.json({ ok: true });
});
app.get('/api/v1/drivers/nearby', async (c) => {
  const sql = neon(c.env.DB);
  const lat = Number(c.req.query('lat')), lng = Number(c.req.query('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return c.json({ message: 'Pedido inválido.' }, 400);
  const pos = await geoAll(c.env);
  const byUser = new Map<string, any>();
  for (const p of pos) if (p && p.userId) byUser.set(String(p.userId), p);
  let rows: any[];
  try {
    rows = await sql`SELECT d.id, d."userId", u.name, d.cats FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."isOnline" = true AND d.status = 'APPROVED' LIMIT 100`;
  } catch {
    rows = await sql`SELECT d.id, d."userId", u.name FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."isOnline" = true AND d.status = 'APPROVED' LIMIT 100`;
  }
  const out = rows
    .map((d: any) => {
      const p = byUser.get(String(d.userId));
      if (!p || !Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lng))) return null;
      return { id: d.id, currentLat: Number(p.lat), currentLng: Number(p.lng), lat: Number(p.lat), lng: Number(p.lng), name: d.name, cats: Array.isArray(d.cats) ? d.cats.map((x: any) => String(x)) : undefined, distanceKm: Math.round(havKm(lat, lng, Number(p.lat), Number(p.lng)) * 10) / 10 };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => a.distanceKm - b.distanceKm)
    .slice(0, 20);
  return c.json({ drivers: out });
});
app.get('/api/v1/drivers/earnings', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const d = await sql`SELECT id, "totalEarnings", "totalTrips" FROM drivers WHERE "userId" = ${user.sub} LIMIT 1`;
  return c.json({ totalEarnings: Number(d[0]?.totalEarnings || 0), totalTrips: Number(d[0]?.totalTrips || 0), trips: [] });
});
app.post('/api/v1/drivers/register', requireAuth, async (c) => c.json({ message: 'Registo via painel admin.' }, 400));
// PUT /api/v1/drivers/vehicle — Guardar/atualizar viatura da motorista
app.put('/api/v1/drivers/vehicle', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  if (user.role !== 'ADMIN') return c.json({ message: 'Só o admin edita viaturas.' }, 403);
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
// PUT /api/v1/admin/drivers/:id — Admin edita nome + viatura + documentos
app.put('/api/v1/admin/drivers/:id', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const cur = await sql`SELECT d.*, u.name AS uname FROM drivers d LEFT JOIN users u ON u.id = d."userId" WHERE d.id = ${id} LIMIT 1`;
  if (!cur.length) return c.json({ message: 'Motorista não encontrada.' }, 404);
  const t = cur[0];
  const plate = String(b.carPlate || '').trim().slice(0, 12);
  if (plate) {
    const clash = await sql`SELECT id FROM drivers WHERE "carPlate" = ${plate} AND id != ${id} LIMIT 1`;
    if (clash.length) return c.json({ message: 'Matrícula já usada noutra viatura.' }, 409);
  }
  const lic = String(b.licenseNumber || '').trim().slice(0, 30) || null;
  if (lic) {
    const clashL = await sql`SELECT id FROM drivers WHERE "licenseNumber" = ${lic} AND id != ${id} LIMIT 1`;
    if (clashL.length) return c.json({ message: 'Carta já usada noutra conta.' }, 409);
  }
  const year = parseInt(b.carYear, 10);
  if (b.carYear !== undefined && b.carYear !== '' && b.carYear !== null && !Number.isInteger(year)) return c.json({ message: 'Ano inválido.' }, 400);
  const nm = String(b.name || '').trim().slice(0, 60);
  if (nm && t.userId) await sql`UPDATE users SET name = ${nm}, "updatedAt" = NOW() WHERE id = ${t.userId}`;
  const rows = await sql`
    UPDATE drivers SET "carMake" = COALESCE(${String(b.carMake || '').slice(0, 40) || null}, "carMake"),
      "carModel" = COALESCE(${String(b.carModel || '').slice(0, 40) || null}, "carModel"),
      "carColor" = COALESCE(${String(b.carColor || '').slice(0, 20) || null}, "carColor"),
      "carPlate" = COALESCE(${plate || null}, "carPlate"),
      "licenseNumber" = COALESCE(${lic}, "licenseNumber"),
      "carYear" = COALESCE(${Number.isInteger(year) ? year : null}, "carYear"),
      "updatedAt" = NOW() WHERE id = ${id} RETURNING *`;
  return c.json(rows[0]);
});
// GET /api/v1/ratings/pending — Viagens concluídas por avaliar (minhas)
app.get('/api/v1/ratings/pending', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  try {
    const did = await driverIdFor(sql, user.sub);
    const rows = did
      ? await sql`SELECT t.id AS "tripId" FROM trips t LEFT JOIN ratings r ON r.id = t.id || ':' || ${user.sub} WHERE t.status = 'COMPLETED' AND (t."passengerId" = ${user.sub} OR t."driverId" = ${did}) AND r.id IS NULL ORDER BY t."completedAt" DESC NULLS LAST, t."createdAt" DESC LIMIT 5`
      : await sql`SELECT t.id AS "tripId" FROM trips t LEFT JOIN ratings r ON r.id = t.id || ':' || ${user.sub} WHERE t.status = 'COMPLETED' AND t."passengerId" = ${user.sub} AND r.id IS NULL ORDER BY t."completedAt" DESC NULLS LAST, t."createdAt" DESC LIMIT 5`;
    return c.json({ pendings: rows.map((x: any) => ({ tripId: x.tripId })) });
  } catch (e) {
    return c.json({ pendings: [] });
  }
});

// GET /api/v1/ratings/mine — avaliações recebidas (a motorista vê as suas no perfil)
app.get('/api/v1/ratings/mine', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
  const b = await c.req.json().catch(() => ({}));
  const userId = String(b.id || '');
  if (!userId) return c.json({ message: 'Motorista inválida.' }, 400);
  if (b.offline) {
    await geoDel(c.env, userId);
    await sql`UPDATE drivers SET "isOnline" = false, "updatedAt" = NOW() WHERE "userId" = ${userId}`;
    return c.json({ ok: true });
  }
  const la = Number(b.lat), lo = Number(b.lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return c.json({ message: 'Posição inválida.' }, 400);
  const cats = Array.isArray(b.cats) ? b.cats.map((x: any) => String(x).slice(0, 30)).slice(0, 6) : null;
  // Posição em memória no DO (0 escritas D1/ping). Só toca na D1 na transição
  // offline→online (1 escrita por sessão, não por ping).
  const wasOnline = await geoSet(c.env, { userId, lat: la, lng: lo, cats, online: true });
  if (!wasOnline) {
    const rows = await sql`
      UPDATE drivers SET "isOnline" = true, cats = COALESCE(${cats ? JSON.stringify(cats) : null}::jsonb, cats), "updatedAt" = NOW()
      WHERE "userId" = ${userId} RETURNING id`;
    if (!rows.length) return c.json({ message: 'Motorista não registada.' }, 404);
  }
  return c.json({ ok: true });
});

// ─── TRIPS ───
app.post('/api/v1/trips/estimate', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const dist = havKm(Number(body.pickupLat), Number(body.pickupLng), Number(body.dropoffLat), Number(body.dropoffLng));
  const base = BASE_FARE + dist * PER_KM;
  const surge = surgeNow();
  const sql = neon(c.env.DB);
  const { mults } = await catMaps(sql);
  const mult = mults[String(body.rideType || 'ECONOMY')] ?? 1.0;
  const options = Object.keys(mults).map((type) => ({ type, fare: Math.round(base * surge * mults[type] * 100) / 100 }));
  return c.json({ distanceKm: Math.round(dist * 10) / 10, estimatedFare: Math.round(base * surge * mult * 100) / 100, currency: 'Kz', surgeMultiplier: surge, surgeActive: surge > 1, options });
});
app.post('/api/v1/trips/request', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  const active = await sql`SELECT id, status FROM trips WHERE "passengerId" = ${user.sub} AND status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') ORDER BY "createdAt" DESC LIMIT 1`;
  if (active.length && active[0].status !== 'REQUESTED') return c.json({ message: 'You already have an active trip. Complete or cancel it first.' }, 400);
  if (active.length) await sql`UPDATE trips SET status = 'CANCELLED', "cancelledBy" = ${user.sub}, "cancelReason" = 'Replaced by new booking' WHERE id = ${active[0].id}`;
  const dist = havKm(Number(b.pickupLat), Number(b.pickupLng), Number(b.dropoffLat), Number(b.dropoffLng));
  const { mults, byCode } = await catMaps(sql);
  const fare = Math.round((BASE_FARE + dist * PER_KM) * surgeNow() * (mults[String(b.rideType || 'ECONOMY')] ?? 1) * 100) / 100;
  // Oferta sequencial por proximidade (30s cada); sem candidatas abre a todas.
  // Calculada ANTES do INSERT para não haver um UPDATE a mais por viagem.
  let q: string[] = [];
  try { q = await buildOfferQueue(c.env, sql, Number(b.pickupLat), Number(b.pickupLng), String(b.rideType || 'ECONOMY')); } catch {}
  const hasQ = q.length > 0;
  const expAt = hasQ ? new Date(Date.now() + OFFER_TTL_SEC * 1000) : null;
  const rows = await sql`INSERT INTO trips (id, "passengerId", "pickupAddress", "pickupLat", "pickupLng", "dropoffAddress", "dropoffLat", "dropoffLng", status, "rideType", "fareEstimate", "distanceKm", "paymentMethod", "createdAt", "updatedAt", "offerQueue", "offerIdx", "offeredDriverId", "offeredAt", "offerExpiresAt", "offerBroadcast", "offerSkipped") VALUES (gen_random_uuid()::text, ${user.sub}, ${String(b.pickupAddress || 'Luanda')}, ${Number(b.pickupLat)}, ${Number(b.pickupLng)}, ${String(b.dropoffAddress || 'Luanda')}, ${Number(b.dropoffLat)}, ${Number(b.dropoffLng)}, 'REQUESTED', ${String(b.rideType || 'ECONOMY')}, ${fare}, ${Math.round(dist * 10) / 10}, ${String(b.paymentMethod || 'CASH')}, NOW(), NOW(), ${hasQ ? JSON.stringify(q) : null}, 0, ${hasQ ? q[0] : null}, ${hasQ ? new Date().toISOString() : null}, ${expAt ? expAt.toISOString() : null}, ${hasQ ? 0 : 1}, ${hasQ ? '[]' : null}) RETURNING *`;
  hubPoke(c, [byCode[String(b.rideType || 'ECONOMY')] || '']);
  return c.json(rows[0]);
});
// GET /api/v1/trips/incoming — Pedidos pendentes para a motorista (web)
// (Registado antes de /:id: o Hono serve o primeiro registo em caso de colisão.)
app.get('/api/v1/trips/incoming', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const qDriver = String(c.req.query('driverId') || '');
  try {
    const did = await driverIdFor(sql, qDriver || user.sub);
    if (!did) return c.json({ trips: [] });
    const { byCode } = await catMaps(sql);
    let myCats: string[] | null = null;
    try {
      const dr = await sql`SELECT cats, "isOnline" FROM drivers WHERE id = ${did} LIMIT 1`;
      if (!dr.length || !dr[0].isOnline) return c.json({ trips: [] });
      if (Array.isArray(dr[0].cats) && dr[0].cats.length) myCats = dr[0].cats.map((x: any) => String(x));
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
      // Oferta sequencial: só a motorista ofertada vê (30s cada, mais
      // próxima primeiro). Viagens antigas sem fila contam como broadcast.
      const q = offerQueueOf(r);
      if (!q.length && !r.offeredDriverId) {
        out.push(webTripRow(r, null, r.passenger_name, (code) => byCode[code] || 'Económico'));
        continue;
      }
      if (!r.offerBroadcast) {
        // Rotação silenciosa: o push é dado pelo toca-toca (4s), não a cada rotação.
        r = await advanceOfferIfNeeded(c.env, sql, r);
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

// GET /api/v1/trips/requests-live → upgrade WS para o RequestsHub (motorista).
// (Registado antes de /:id.) O hub só faz "poke"; o cliente busca /trips/incoming.
app.get('/api/v1/trips/requests-live', async (c) => {
  let user: any = null;
  try {
    const ah = c.req.header('Authorization') || '';
    let tok = ah.startsWith('Bearer ') ? ah.slice(7) : '';
    if (!tok) tok = String(c.req.query('token') || '');
    if (tok) user = await verifyJwt(tok, (c.env as any).JWT_SECRET);
  } catch {}
  if (!user?.sub) return c.json({ message: 'Não autenticado.' }, 401);
  if ((c.req.header('Upgrade') || '').toLowerCase() !== 'websocket')
    return c.json({ message: 'Usa WebSocket: GET com header Upgrade: websocket.', usage: '/api/v1/trips/requests-live' }, 426);
  const sql = neon(c.env.DB);
  const did = await driverIdFor(sql, user.sub);
  if (!did) return c.json({ message: 'Só motoristas.' }, 403);
  let cats: string[] = [];
  try { const dr = await sql`SELECT cats FROM drivers WHERE id = ${did} LIMIT 1`; if (dr.length && Array.isArray(dr[0].cats)) cats = dr[0].cats.map((x: any) => String(x)); } catch {}
  const ns: any = (c.env as any).REQUESTSHUB;
  if (!ns || !ns.get) return c.json({ message: 'Feed em tempo real indisponível.' }, 503);
  const stub = ns.get(ns.idFromName('requests:global'));
  const fwd = new Headers();
  for (const h of ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
    const v = c.req.header(h);
    if (v) fwd.set(h, v);
  }
  fwd.set('X-User-Id', String(user.sub || ''));
  fwd.set('X-Driver-Id', did);
  fwd.set('X-Cats', JSON.stringify(cats));
  return stub.fetch(new Request('https://requests-hub/live', { method: 'GET', headers: fwd }));
});

// GET /api/v1/drivers/live-geo → upgrade WS para o DO DriverGeo (GPS por
// mensagem, sem pedido HTTP por ping). A motorista envia {lat,lng,cats} ou
// {offline:true}; o DO atualiza o mapa em memória. Mensagens WS não contam
// como pedidos → elimina o limite de pedidos por ping.
app.get('/api/v1/drivers/live-geo', async (c) => {
  let user: any = null;
  try {
    const ah = c.req.header('Authorization') || '';
    let tok = ah.startsWith('Bearer ') ? ah.slice(7) : '';
    if (!tok) tok = String(c.req.query('token') || '');
    if (tok) user = await verifyJwt(tok, (c.env as any).JWT_SECRET);
  } catch {}
  if (!user?.sub) return c.json({ message: 'Não autenticado.' }, 401);
  if ((c.req.header('Upgrade') || '').toLowerCase() !== 'websocket')
    return c.json({ message: 'Usa WebSocket: GET com header Upgrade: websocket.' }, 426);
  const ns: any = (c.env as any).DRIVERGEO;
  if (!ns || !ns.get) return c.json({ message: 'GPS ao vivo indisponível.' }, 503);
  const stub = ns.get(ns.idFromName('geo:global'));
  const fwd = new Headers();
  for (const h of ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
    const v = c.req.header(h);
    if (v) fwd.set(h, v);
  }
  fwd.set('X-User-Id', String(user.sub || ''));
  return stub.fetch(new Request('https://geo/live', { method: 'GET', headers: fwd }));
});

// GET /api/v1/trips/history — Histórico (web)
app.get('/api/v1/trips/history', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
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
      ts: t.createdAt ? new Date(t.createdAt).getTime() : null, from: t.pickupAddress || '',
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
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const rows = await sql`SELECT t.* FROM trips t LEFT JOIN drivers d ON d.id = t."driverId" WHERE t.status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') AND (t."passengerId" = ${user.sub} OR d."userId" = ${user.sub}) ORDER BY t."createdAt" DESC LIMIT 1`;
  return c.json(rows[0] || null);
});
// ─── LIVE PUSH BASE (WS hibernável, 1 DO por viagem; polling REST continua) ───
// GET /api/v1/trips/:id/live → upgrade WS para o TripPush do tripId.
// Auth + verificação de participante como nas rotas /call e /chat.
// (Registado antes de /:id: o Hono serve o primeiro registo em caso de colisão.)
// Hook best-effort REST → DO para as transições chamarem sem bloquear a
// resposta. LIGADO: pushStatus() é chamado após cada UPDATE de
// accept/arrived/start/complete/cancel e na rota web /status. O DO também
// aprende o status por leitura Neon esporádica (≤1/15s por viagem ativa)
// e em {"t":"state"}, como rede de segurança.
async function notifyTripPush(env: any, tripId: string, status: string) {
  try {
    const ns: any = (env as any).TRIPPUSH;
    if (!ns || !ns.get) return;
    const stub = ns.get(ns.idFromName(`trip:${tripId}`));
    await stub.fetch(new Request('https://trip-push/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }));
  } catch {}
}
// Dispara o aviso ao DO sem bloquear a resposta (best-effort).
function pushStatus(c: any, tripId: string, status: string) {
  try { c.executionCtx.waitUntil(notifyTripPush(c.env, tripId, status)); }
  catch { notifyTripPush(c.env, tripId, status); }
}
// ─── RequestsHub: feed de pedidos por WebSocket-hibernação (server push) ───
// Substitui o polling REST /trips/incoming da motorista online: 1 ligação WS
// por motorista (hibernável = sem custo de duração) e o servidor faz "poke"
// quando há novidade; a motorista faz 1 fetch pontual em vez de poll contínuo.
async function hubBroadcast(env: any, cats?: string[]) {
  try {
    const ns: any = (env as any).REQUESTSHUB;
    if (!ns || !ns.get) return;
    const stub = ns.get(ns.idFromName('requests:global'));
    await stub.fetch(new Request('https://requests-hub/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cats: cats && cats.length ? cats : null }) }));
  } catch {}
}
function hubPoke(c: any, cats?: string[]) {
  try { c.executionCtx.waitUntil(hubBroadcast(c.env, cats)); }
  catch { hubBroadcast(c.env, cats); }
}
// ─── DriverGeo: posições GPS vivas em memória (substitui Redis GEO) ───
// 1 DO global guarda { userId → { driverId, lat, lng, cats, ts, online } }.
// As escritas de GPS deixam de tocar na D1 (0 escritas/ping); a D1 fica só
// com o registo autoritativo da viagem. Frescura lógica de 5min na leitura.
const GEO_TTL_MS = 18 * 60 * 1000;
function geoStub(env: any): any {
  try { const ns: any = (env as any).DRIVERGEO; return ns && ns.get ? ns.get(ns.idFromName('geo:global')) : null; } catch { return null; }
}
function geoFetch(env: any, path: string, init?: any): Promise<any> {
  const s = geoStub(env);
  if (!s) return Promise.resolve(null);
  geoMetrics.calls++;
  return s.fetch(new Request('https://geo' + path, init)).catch(() => null);
}
// Guarda posição; devolve se a motorista já estava online no DO (para só
// escrever isOnline na D1 na transição offline→online).
async function geoSet(env: any, data: { userId: string; driverId?: string; lat: number; lng: number; cats?: string[] | null; online?: boolean }): Promise<boolean> {
  geoMetrics.sets++;
  const r = await geoFetch(env, '/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!r) return false;
  try { return !!(await r.json()).wasOnline; } catch { return false; }
}
async function geoDel(env: any, userId: string) {
  geoMetrics.dels++;
  await geoFetch(env, '/del', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
}
async function geoGet(env: any, userId: string): Promise<any | null> {
  if (!userId) return null;
  geoMetrics.gets++;
  const r = await geoFetch(env, '/get?userId=' + encodeURIComponent(userId));
  if (!r) return null;
  try { const d = (await r.json()).driver; return d && Date.now() - Number(d.ts || 0) <= GEO_TTL_MS ? d : null; } catch { return null; }
}
async function geoAll(env: any): Promise<any[]> {
  geoMetrics.alls++;
  const r = await geoFetch(env, '/all');
  if (!r) return [];
  try { const arr = (await r.json()).drivers; const now = Date.now(); return Array.isArray(arr) ? arr.filter((d: any) => now - Number(d.ts || 0) <= GEO_TTL_MS) : []; } catch { return []; }
}
app.get('/api/v1/trips/:id/live', async (c) => {
  const id = c.req.param('id');
  let user: any = null;
  try {
    const ah = c.req.header('Authorization') || '';
    let tok = ah.startsWith('Bearer ') ? ah.slice(7) : '';
    if (!tok) tok = String(c.req.query('token') || '');
    if (tok) user = await verifyJwt(tok, (c.env as any).JWT_SECRET);
  } catch {}
  if (!user?.sub) return c.json({ message: 'Não autenticado.' }, 401);
  if ((c.req.header('Upgrade') || '').toLowerCase() !== 'websocket')
    return c.json({ message: 'Usa WebSocket: GET com header Upgrade: websocket.', usage: `/api/v1/trips/${id}/live` }, 426);
  const sql = neon(c.env.DB);
  const t = await sql`SELECT t."passengerId", d."userId" AS "driverUserId" FROM trips t LEFT JOIN drivers d ON d.id = t."driverId" WHERE t.id = ${id} LIMIT 1`;
  if (!t.length) return c.json({ message: 'Viagem não encontrada.' }, 404);
  const isDriver = !!t[0].driverUserId && t[0].driverUserId === user.sub;
  const isPax = t[0].passengerId === user.sub;
  if (!isDriver && !isPax) return c.json({ message: 'Sem acesso a esta viagem.' }, 403);
  const ns: any = (c.env as any).TRIPPUSH;
  if (!ns || !ns.get) return c.json({ message: 'Push em tempo real indisponível.' }, 503);
  const stub = ns.get(ns.idFromName(`trip:${id}`));
  const fwd = new Headers();
  for (const h of ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
    const v = c.req.header(h);
    if (v) fwd.set(h, v);
  }
  fwd.set('X-Trip-Id', id);
  fwd.set('X-User-Id', String(user.sub || ''));
  fwd.set('X-Is-Driver', isDriver ? '1' : '0');
  return stub.fetch(new Request(`https://trip-push/${id}`, { method: 'GET', headers: fwd }));
});
app.get('/api/v1/trips/:id', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const id = c.req.param('id');
  const rows = await sql`SELECT t.*, d."currentLat" AS "driverLat", d."currentLng" AS "driverLng", d."userId" AS "driverUserId" FROM trips t LEFT JOIN drivers d ON d.id = t."driverId" WHERE t.id = ${id} LIMIT 1`;
  if (!rows.length) return c.json({ message: 'Viagem não encontrada.' }, 404);
  const t = rows[0];
  if (c.req.query('view') === 'web') {
    const drv = await webDriverInfo(c.env, sql, t.driverId);
    const pu = await sql`SELECT name, phone, "profilePhoto" FROM users WHERE id = ${t.passengerId} LIMIT 1`;
    const pl = paxLive.get(t.id);
    const { byCode } = await catMaps(sql);
    return c.json({ ...webTripRow(t, drv, pu[0]?.name || '', (code) => byCode[code] || 'Económico', pu[0]?.phone || '', pu[0]?.profilePhoto || ''), paxLive: pl && Date.now() - pl.ts < 60000 ? { lat: pl.lat, lng: pl.lng } : null });
  }
  // Polling substitui o socket: devolve posição viva da motorista + ETA.
  const liveD = t.driverUserId ? await geoGet(c.env, String(t.driverUserId)) : null;
  const dLat = liveD && Number.isFinite(Number(liveD.lat)) ? Number(liveD.lat) : (t.driverLat != null ? Number(t.driverLat) : null);
  const dLng = liveD && Number.isFinite(Number(liveD.lng)) ? Number(liveD.lng) : (t.driverLng != null ? Number(t.driverLng) : null);
  let driver = null;
  if (dLat != null && dLng != null) {
    const targetLa = t.status === 'IN_PROGRESS' ? Number(t.dropoffLat) : Number(t.pickupLat);
    const targetLo = t.status === 'IN_PROGRESS' ? Number(t.dropoffLng) : Number(t.pickupLng);
    const dk = havKm(dLat, dLng, targetLa, targetLo);
    driver = { lat: dLat, lng: dLng, distanceKm: Math.round(dk * 10) / 10, etaMinutes: Math.max(1, Math.ceil((dk / 30) * 60)) };
  }
  const pin = user.sub === t.passengerId ? pinForTrip(t.id) : undefined;
  return c.json({ ...t, driver, ...(pin ? { pin } : {}) });
});
async function driverIdFor(sql: any, userId: string) {
  const r = await sql`SELECT id FROM drivers WHERE "userId" = ${userId} LIMIT 1`;
  return r[0]?.id as string | undefined;
}
// ─── Carteira / pontos do motorista ───────────────────────────────────────
// Cada viagem concluida debita 14% do valor final (finalFare) da carteira.
// Saldo negativo permitido; ao atingir NEG_TRIP_LIMIT viagens negativas a conta
// fica bloqueada (walletBlocked=1) e a motorista e posta offline ate carregar.
const COMMISSION_RATE = 0.14;
const NEG_TRIP_LIMIT = 3;
function money(n: any): number { return Math.round(Number(n || 0) * 100) / 100; }
async function applyCommission(sql: any, driverRowId: string, fare: any, tripId: string) {
  try {
    if (!driverRowId) return;
    const f = Number(fare || 0);
    if (!(f > 0)) return;
    const du = await sql`SELECT "userId" FROM drivers WHERE id = ${driverRowId} LIMIT 1`;
    const userId = du[0]?.userId;
    if (!userId) return;
    const u = await sql`SELECT "walletBalance", "negTrips" FROM users WHERE id = ${userId} LIMIT 1`;
    if (!u.length) return;
    const before = Number(u[0].walletBalance || 0);
    const commission = money(f * COMMISSION_RATE);
    const after = money(before - commission);
    let negTrips = Number(u[0].negTrips || 0);
    let blocked = 0;
    if (after < 0) {
      negTrips = negTrips + 1;
      if (negTrips >= NEG_TRIP_LIMIT) blocked = 1;
    } else {
      negTrips = 0;
    }
    await sql`UPDATE users SET "walletBalance" = ${after}, "negTrips" = ${negTrips}, "walletBlocked" = ${blocked}, "updatedAt" = NOW() WHERE id = ${userId}`;
    await sql`INSERT INTO wallet_tx (id, "userId", type, amount, "balanceAfter", "tripId", note, "createdAt") VALUES (gen_random_uuid()::text, ${userId}, 'COMMISSION', ${-commission}, ${after}, ${tripId}, ${'Comissao 14% da viagem'}, NOW())`;
    if (blocked) await sql`UPDATE drivers SET "isOnline" = false, "updatedAt" = NOW() WHERE "userId" = ${userId}`;
  } catch (e) { console.error('commission error:', e); }
}
app.put('/api/v1/trips/:id/accept', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const id = c.req.param('id');
  const did = await driverIdFor(sql, user.sub);
  if (!did) return c.json({ message: 'Só motoristas.' }, 403);
  const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
  if (!cur.length || cur[0].status !== 'REQUESTED') return c.json({ message: 'Viagem indisponível.' }, 400);
  // Oferta sequencial: só a motorista ofertada (ou qualquer uma em broadcast).
  try {
    let t: any = cur[0];
    if (!t.offerBroadcast && (offerQueueOf(t).length || t.offeredDriverId)) {
      t = await advanceOfferIfNeeded(c.env, sql, t);
      if (!t.offerBroadcast && String(t.offeredDriverId || '') !== did) {
        return c.json({ message: 'Esta oferta já passou para outra motorista.' }, 409);
      }
    }
  } catch {}
  const rows = await sql`UPDATE trips SET "driverId" = ${did}, status = 'ACCEPTED', "acceptedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id} AND status = 'REQUESTED' RETURNING *`;
  if (!rows.length) return c.json({ message: 'Viagem indisponível.' }, 400);
  pushStatus(c, id, 'ACCEPTED');
  hubPoke(c);
  return c.json(rows[0]);
});
// POST /api/v1/trips/:id/skip — Motorista rejeita/passa a oferta à seguinte
app.post('/api/v1/trips/:id/skip', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const id = c.req.param('id');
  const did = await driverIdFor(sql, user.sub);
  if (!did) return c.json({ message: 'Só motoristas.' }, 403);
  try {
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
        const againS = q.filter((x: string) => skipped.indexOf(x) < 0);
        if (!againS.length) {
          await sql`UPDATE trips SET "offerBroadcast" = TRUE, "offerSkipped" = ${JSON.stringify(skipped)}::jsonb, "updatedAt" = NOW() WHERE id = ${id}`;
        } else {
          idx = q.indexOf(againS[0]);
          const expAtS = new Date(Date.now() + OFFER_TTL_SEC * 1000);
          await sql`UPDATE trips SET "offerIdx" = ${idx}, "offeredDriverId" = ${q[idx]}, "offeredAt" = NOW(), "offerExpiresAt" = ${expAtS as any}, "offerSkipped" = ${JSON.stringify(skipped)}::jsonb, "offerMissed" = '[]'::jsonb, "updatedAt" = NOW() WHERE id = ${id}`;
          const rrS = await sql`SELECT "pickupAddress", "dropoffAddress", "fareEstimate" FROM trips WHERE id = ${id} LIMIT 1`;
          if (rrS.length) await pushTripToDriver(sql, q[idx], id, '🔔 Novo pedido LadiesGo!', `${String(rrS[0].pickupAddress || '')} → ${String(rrS[0].dropoffAddress || '').split(' · ')[0]} · ${Number(rrS[0].fareEstimate || 0)} Kz`);
        }
      } else {
        const expAt = new Date(Date.now() + OFFER_TTL_SEC * 1000);
        await sql`UPDATE trips SET "offerIdx" = ${idx}, "offeredDriverId" = ${q[idx]}, "offeredAt" = NOW(), "offerExpiresAt" = ${expAt as any}, "offerSkipped" = ${JSON.stringify(skipped)}::jsonb, "updatedAt" = NOW() WHERE id = ${id}`;
        const rr = await sql`SELECT "pickupAddress", "dropoffAddress", "fareEstimate" FROM trips WHERE id = ${id} LIMIT 1`;
        if (rr.length) await pushTripToDriver(sql, q[idx], id, '🔔 Novo pedido LadiesGo!', `${String(rr[0].pickupAddress || '')} → ${String(rr[0].dropoffAddress || '').split(' · ')[0]} · ${Number(rr[0].fareEstimate || 0)} Kz`);
      }
    } else {
      await sql`UPDATE trips SET "offerSkipped" = ${JSON.stringify(skipped)}::jsonb, "updatedAt" = NOW() WHERE id = ${id}`;
    }
    hubPoke(c);
    return c.json({ ok: true });
  } catch (e) {
    console.error('skip error:', e);
    return c.json({ ok: true });
  }
});
app.put('/api/v1/trips/:id/arrived', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const rows = await sql`UPDATE trips SET status = 'DRIVER_ARRIVED', "arrivedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${c.req.param('id')} AND status = 'ACCEPTED' RETURNING *`;
  if (!rows.length) return c.json({ message: 'Transição inválida.' }, 400);
  pushStatus(c, c.req.param('id'), 'DRIVER_ARRIVED');
  return c.json(rows[0]);
});
app.put('/api/v1/trips/:id/start', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const { pin } = await c.req.json().catch(() => ({}));
  const id = c.req.param('id');
  const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
  if (!cur.length || cur[0].status !== 'DRIVER_ARRIVED') return c.json({ message: 'Transição inválida.' }, 400);
  if (String(pin || '') !== pinForTrip(id)) return c.json({ message: 'Código incorreto.' }, 400);
  const rows = await sql`UPDATE trips SET status = 'IN_PROGRESS', "startedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id} RETURNING *`;
  pushStatus(c, id, 'IN_PROGRESS');
  return c.json(rows[0]);
});
app.put('/api/v1/trips/:id/complete', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const id = c.req.param('id');
  const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
  if (!cur.length || cur[0].status !== 'IN_PROGRESS') return c.json({ message: 'Transição inválida.' }, 400);
  const t = cur[0];
  const rows = await sql`UPDATE trips SET status = 'COMPLETED', "finalFare" = COALESCE("finalFare", "fareEstimate"), "completedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id} RETURNING *`;
  if (t.driverId) await sql`UPDATE drivers SET "totalTrips" = "totalTrips" + 1, "totalEarnings" = "totalEarnings" + ${Number(t.finalFare || t.fareEstimate || 0) * 0.8} WHERE id = ${t.driverId}`;
  await applyCommission(sql, t.driverId, t.finalFare || t.fareEstimate, id);
  pushStatus(c, id, 'COMPLETED');
  return c.json(rows[0]);
});
app.put('/api/v1/trips/:id/cancel', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const { reason } = await c.req.json().catch(() => ({}));
  const rows = await sql`UPDATE trips SET status = 'CANCELLED', "cancelledBy" = ${user.sub}, "cancelReason" = ${String(reason || '').slice(0, 80)}, "updatedAt" = NOW() WHERE id = ${c.req.param('id')} AND status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') RETURNING *`;
  if (!rows.length) return c.json({ message: 'Transição inválida.' }, 400);
  pushStatus(c, c.req.param('id'), 'CANCELLED');
  hubPoke(c);
  return c.json(rows[0]);
});

// ─── RATINGS / NOTIFS / PAYMENTS (stubs compatíveis) ───
app.post('/api/v1/ratings', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  try {
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
    await sql`INSERT INTO ratings (id, "tripId", "raterId", "ratedId", score, comment, "createdAt") VALUES (${String((b as any).tripId) + ':' + user.sub}, ${String((b as any).tripId)}, ${user.sub}, ${rated}, ${Number((b as any).score || 5)}, ${String((b as any).comment || '').slice(0, 500)}, NOW()) ON CONFLICT (id) DO NOTHING`;
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
  const sql = neon(c.env.DB);
  return c.json(await turnQuota(sql, c.env.METERED_FREE_MB));
});
app.post('/api/v1/turn/log', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
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
// Normaliza texto para pesquisa (minúsculas, sem acentos).
function fold(s: string): string {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
// Categoria legível a partir do tipo (códigos internos do dataset Yango).
function placeCat(t: string): string {
  const b = String(t || '').split('[')[0].trim().toLowerCase();
  if (!b) return 'Local';
  if (/^(12 portas|13 addr|kb-porta)/.test(b)) return 'Morada';
  if (/^14 entradas/.test(b)) return 'Edifício';
  if (/^15 nos-nomeados/.test(b)) return 'Local';
  if (/^10 condominios/.test(b)) return 'Condomínio';
  if (/municipio/.test(b)) return 'Município';
  if (b === 'yes') return 'Local';
  if (/(neighbourhood|suburb|quarter|city_block)/.test(b)) return 'Bairro';
  if (b === 'apartment') return 'Edifício';
  if (b === 'square') return 'Praça';
  if (/bureau_de_change/.test(b)) return 'Câmbio';
  if (/(restaurant|fast_food|bakery|food|cafe)/.test(b) || b === 'bar') return 'Restaurante';
  if (/(bank|atm)/.test(b)) return 'Banco';
  if (/(car_parts|car_repair|tyres|fuel|motorcycle)/.test(b) || b === 'car') return 'Automóvel';
  if (/parking/.test(b)) return 'Estacionamento';
  if (/(hairdresser|beauty|cosmetic)/.test(b)) return 'Beleza';
  if (/(convenience|supermarket|kiosk|butcher|greengrocer|marketplace)/.test(b)) return 'Mercado';
  if (/(clinic|pharmacy|hospital|dentist|doctor|health)/.test(b)) return 'Saúde';
  if (/(clothes|shoes|furniture|electronics|mobile_phone|doityourself|jewel|hardware|florist|gift|optician)/.test(b)) return 'Loja';
  if (/(school|college|university|educational|kindergarten|library)/.test(b)) return 'Escola';
  if (/(place_of_worship|church|mosque)/.test(b)) return 'Igreja';
  if (/(government|diplomatic|police|townhall|embassy|administrative)/.test(b)) return 'Serviço público';
  if (/(hotel|hostel|guest|motel)/.test(b)) return 'Hotel';
  if (/(taxi|bus_stop|bus_station|transport|aeroway|aerodrome)/.test(b)) return 'Transporte';
  if (/(company|office|insurance|lawyer|consulting|logistics)/.test(b)) return 'Empresa';
  if (/(residential|tertiary|secondary|trunk|primary|unclassified|service|motorway|living_street|pedestrian|road)/.test(b)) return 'Rua';
  return b.charAt(0).toUpperCase() + b.slice(1);
}
// Pesquisa na base local de places (índice Yango GOD, 23k+ locais de Luanda):
// relevância por prefixo do nome + proximidade à localização do utilizador.
async function localPlaces(c: any, q: string, lat: number, lng: number): Promise<any[]> {
  try {
    const sql = neon(c.env.DB);
    const tf = fold(q);
    const tk = tf.split(' ').filter((t: string) => t.length >= 2).slice(0, 3);
    const t1 = tk[0] || tf, t2 = tk[1] || '', t3 = tk[2] || '';
    // Todos os tokens têm de aparecer em norm (nome+rua+município+tipo), por
    // isso "kilamba bloco" encontra os blocos do Kilamba com o número (ex.:
    // "Bloco D27") em vez de cair no Photon/Nominatim sem número.
    // Ordena por: prefixo do nome, depois bloco/quarteirão, depois distância.
    const rows: any[] = await sql`
      SELECT name, nname, lat, lng, type, municipality, province, street, "number"
      FROM places
      WHERE norm LIKE ${'%' + t1 + '%'}
        AND (${t2} = '' OR norm LIKE ${'%' + t2 + '%'})
        AND (${t3} = '' OR norm LIKE ${'%' + t3 + '%'})
      ORDER BY ((CASE WHEN nname LIKE ${tf + '%'} THEN 2 ELSE 0 END)
        + (CASE WHEN name LIKE 'Bloco %' OR name LIKE 'Bloco%' OR name LIKE 'Quarteir%' THEN 1 ELSE 0 END)) DESC,
        (ABS(lat - ${lat}) + ABS(lng - ${lng})) ASC
      LIMIT 400
    `;
    const out = rows.map((r: any) => {
      const type = String(r.type || '');
      const base = type.split('[')[0].trim();
      let name = String(r.name || '').trim();
      if (!name || name === base || name.startsWith(base) || /^\d+\s+(portas|addr)/i.test(name) || /^kb-porta/i.test(name)) {
        const st = String(r.street || '').trim(), num = String(r.number || '').trim();
        name = st && num ? `${st}, nº ${num}` : (st || (num ? `Nº ${num}` : 'Morada'));
      }
      return {
        name,
        lat: Number(r.lat),
        lng: Number(r.lng),
        cat: placeCat(type),
        municipality: String(r.municipality || ''),
        province: String(r.province || 'Luanda'),
        street: String(r.street || ''),
        distanceKm: Math.round(havKm(lat, lng, Number(r.lat), Number(r.lng)) * 10) / 10,
        _p: String(r.nname || '').startsWith(tf) ? 1 : 0,
        _b: /^(bloco\b|quarteir)/i.test(String(r.name || '').trim()) ? 1 : 0,
      };
    }).filter((p: any) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    out.sort((a: any, b: any) => (b._p - a._p) || (b._b - a._b) || (a.distanceKm - b.distanceKm));
    const seen = new Set<string>();
    const dedup = out.filter((p: any) => {
      const k = p.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return dedup.slice(0, 15).map((p: any) => { delete p._p; delete p._b; return p; });
  } catch { return []; }
}
app.get('/api/places/search', async (c) => {
  const q = String(c.req.query('q') || '').trim();
  const lat = Number(c.req.query('lat'));
  const lng = Number(c.req.query('lng'));
  if (q.length < 3 || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return c.json({ places: [] }, 200, { 'Cache-Control': 'public, max-age=600' });
  }
  const pkey = 'places:v11:' + q.toLowerCase() + ':' + Math.round(lat * 1000) / 1000 + ',' + Math.round(lng * 1000) / 1000;
  const phit = await cacheGet(c, pkey);
  if (phit) return phit;
  // Base local primeiro: instantâneo, offline e com distância à localização.
  const local: any[] = await localPlaces(c, q, lat, lng);
  if (local.length >= 1) return cachePut(c, pkey, 604800, { places: local });
  try {
    // Photon e Nominatim em paralelo: devolve o primeiro com resultados.
    // (Antes eram em série — esperava até 8s pelo Photon antes de cair no
    // Nominatim, o que atrasava a pesquisa.)
    const photon = (async () => {
      try {
        const pr = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=${lat}&lon=${lng}&limit=20&lang=pt`, { signal: AbortSignal.timeout(8000) });
        const pj: any = await pr.json();
        const feats = Array.isArray(pj?.features) ? pj.features : [];
        if (!feats.length) return null;
        const R = 6371, t = Math.PI / 180;
        const pplaces = feats.map((f: any) => {
          const co = f?.geometry?.coordinates || [];
          const plat = Number(co[1]), plng = Number(co[0]);
          const pp = f?.properties || {};
          const dLa = (plat - lat) * t, dLo = (plng - lng) * t;
          const s = Math.sin(dLa / 2) ** 2 + Math.cos(lat * t) * Math.cos(plat * t) * Math.sin(dLo / 2) ** 2;
          return { name: String(pp.name || q), lat: plat, lng: plng, cat: placeCat(String([pp.osm_key, pp.osm_value, pp.type].filter(Boolean).join('/'))), municipality: String(pp.city || pp.county || ''), province: String(pp.state || 'Luanda'), distanceKm: Math.round(2 * R * Math.asin(Math.sqrt(s)) * 10) / 10 };
        }).filter((p: any) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng));
        return pplaces.length ? pplaces : null;
      } catch { return null; }
    })();
    const nominatim = (async () => {
      try {
        const url =
          `https://nominatim.openstreetmap.org/search?format=json&limit=30&countrycodes=ao` +
          `&viewbox=13.05,-8.70,13.55,-9.05&bounded=1` +
          `&accept-language=pt&q=${encodeURIComponent(q)}`;
        const r = await fetch(url, { headers: { 'User-Agent': 'LadiesGo/1.0' }, signal: AbortSignal.timeout(8000) });
        const j: any = await r.json();
        if (!Array.isArray(j)) return null;
        const places = j.map((p: any) => {
          const plat = Number(p.lat);
          const plng = Number(p.lon);
          const R = 6371, t = Math.PI / 180;
          const dLa = (plat - lat) * t, dLo = (plng - lng) * t;
          const s = Math.sin(dLa / 2) ** 2 + Math.cos(lat * t) * Math.cos(plat * t) * Math.sin(dLo / 2) ** 2;
          const distKm = 2 * R * Math.asin(Math.sqrt(s));
          return {
            name: String(p.display_name?.split(',').slice(0, 2).join(',') || p.display_name || q),
            lat: plat, lng: plng, cat: placeCat(String([p.class, p.type].filter(Boolean).join('/'))), municipality: '', province: 'Luanda',
            distanceKm: Math.round(distKm * 10) / 10,
          };
        }).filter((p: any) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng));
        return places.length ? places : null;
      } catch { return null; }
    })();
    const places = await new Promise<any[] | null>((resolve) => {
      let done = false, pend = 2;
      const take = (r: any[] | null) => {
        if (done) return;
        if (r && r.length) { done = true; resolve(r); }
        else if (--pend === 0) { done = true; resolve(null); }
      };
      photon.then(take, () => take(null));
      nominatim.then(take, () => take(null));
    });
    const ext = (places || []).filter((p: any) => !local.some((l: any) => l.name === p.name));
    return cachePut(c, pkey, 604800, { places: local.concat(ext).slice(0, 20) });
  } catch {
    return cachePut(c, pkey, 604800, { places: local });
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
// Cache real (Cache API): corta 70-90% das chamadas externas repetidas.
// Chaves quantizadas para a mesma rota/zona/pesquisa partilhar entrada.
async function cacheGet(c: any, key: string): Promise<Response | null> {
  try {
    const hit = await caches.default.match(new Request('https://cache.local/' + key));
    return hit || null;
  } catch { return null; }
}
async function cachePut(c: any, key: string, ttlSec: number, obj: any): Promise<Response> {
  const res = c.json(obj, 200, { 'Cache-Control': `public, max-age=${ttlSec}` });
  try {
    c.executionCtx.waitUntil(caches.default.put(new Request('https://cache.local/' + key), res.clone()));
  } catch {}
  return res;
}
app.get('/api/zone', async (c) => {
  const la = Number(c.req.query('lat')), lo = Number(c.req.query('lng'));
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return c.json({ message: 'Pedido inválido.' }, 400);
  const zkey = 'zone:' + Math.round(la * 10000) / 10000 + ',' + Math.round(lo * 10000) / 10000;
  const zhit = await cacheGet(c, zkey);
  if (zhit) return zhit;
  let zone = '';
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${la}&lon=${lo}&format=json&zoom=14`, { headers: { 'User-Agent': 'LadiesGo/1.0' }, signal: AbortSignal.timeout(8000) });
    const j: any = await r.json();
    const a = j?.address || {};
    zone = a.suburb || a.neighbourhood || a.quarter || a.city_district || a.town || a.city || '';
  } catch {}
  // BigDataCloud removido aqui (402 quando chamado do servidor); offlineZone local cobre.
  if (!zone) zone = offlineZone(la, lo);
  return cachePut(c, zkey, 2592000, { zone });
});
app.get('/api/route', async (c) => {
  const from = String(c.req.query('from') || '').split(',').map(Number);
  const to = String(c.req.query('to') || '').split(',').map(Number);
  if (from.length !== 2 || to.length !== 2 || ![...from, ...to].every(Number.isFinite)) return c.json({ message: 'Pedido inválido.' }, 400);
  const qf = (n: number) => Math.round(n * 1000) / 1000;
  const rkey = 'route:' + qf(from[0]) + ',' + qf(from[1]) + '|' + qf(to[0]) + ',' + qf(to[1]);
  const rhit = await cacheGet(c, rkey);
  if (rhit) return rhit;
  try {
    const q = `${qf(from[1])},${qf(from[0])};${qf(to[1])},${qf(to[0])}?overview=full&geometries=geojson`;
    const vq = encodeURIComponent(JSON.stringify({
      locations: [{ lat: from[0], lon: from[1] }, { lat: to[0], lon: to[1] }],
      costing: 'auto', format: 'osrm', shape_format: 'geojson', directions_type: 'none',
    }));
    const bases = [
      'https://router.project-osrm.org/route/v1/driving/' + q,
      'https://routing.openstreetmap.de/routed-car/route/v1/driving/' + q,
      'https://valhalla1.openstreetmap.de/route?json=' + vq,
    ];
    for (const base of bases) {
      try {
        const r = await fetch(base, { headers: { 'User-Agent': 'LadiesGo/1.0' }, signal: AbortSignal.timeout(4000) });
        const j: any = await r.json();
        const g = j?.routes?.[0]?.geometry?.coordinates;
        if (g?.length) return cachePut(c, rkey, 3600, { points: g.map((p: number[]) => [p[1], p[0]]), distance_m: j.routes[0].distance, duration_s: j.routes[0].duration });
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
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
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
          du.name AS driver_name, du.phone AS driver_phone, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
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
          du.name AS driver_name, du.phone AS driver_phone, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
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
        passengerPhone: r.passenger_phone || '',
        driverPhone: r.driver_phone || '',
        vehicle: [r.car_make, r.car_model, r.car_plate].filter(Boolean).join(' · '),
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
          du.name AS driver_name, du.phone AS driver_phone, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
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
        passengerPhone: r.passenger_phone || '',
        driverPhone: r.driver_phone || '',
        vehicle: [r.car_make, r.car_model, r.car_plate].filter(Boolean).join(' · '),
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

// GET /api/v1/admin/driver-stats — Totais globais por motorista (o histórico da página é limitado)
app.get('/api/v1/admin/driver-stats', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  try {
    const rows = await sql`
      SELECT t."driverId", COUNT(*)::int AS total,
        SUM(CASE WHEN t.status = 'COMPLETED' THEN 1 ELSE 0 END)::int AS completed,
        SUM(CASE WHEN t.status = 'CANCELLED' THEN 1 ELSE 0 END)::int AS cancelled,
        COALESCE(SUM(CASE WHEN t.status = 'COMPLETED' THEN COALESCE(t."finalFare", t."fareEstimate", 0) ELSE 0 END), 0)::int AS revenue,
        MAX(du.name) AS name
      FROM trips t
      LEFT JOIN drivers d ON d.id = t."driverId"
      LEFT JOIN users du ON du.id = d."userId"
      WHERE t."driverId" IS NOT NULL
      GROUP BY t."driverId"
      ORDER BY total DESC`;
    return c.json({ driverStats: rows.map((r: any) => ({ driverId: r.driverId, name: r.name || '', total: Number(r.total || 0), completed: Number(r.completed || 0), cancelled: Number(r.cancelled || 0), revenue: Number(r.revenue || 0) })) });
  } catch (e) { console.error('Admin driver-stats error:', e); return c.json({ driverStats: [] }); }
});
// GET /api/v1/admin/drivers — List drivers
app.get('/api/v1/admin/drivers', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  const driversRes = await sql`
    SELECT d.*, u.name, u.phone, u."profilePhoto"
    FROM drivers d
    JOIN users u ON u.id = d."userId"
    WHERE d.status = 'APPROVED'
    ORDER BY d."createdAt" DESC
  `;
  return c.json({ drivers: driversRes });
});

// GET /api/v1/admin/users — List users
app.get('/api/v1/admin/users', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
  const { id } = c.req.param();
  const resetHash = await hashPassword('0987654321');
  const rows = await sql`
    UPDATE users SET "passwordHash" = ${resetHash},
      "mustChangePassword" = true, "updatedAt" = NOW()
    WHERE id = ${id} RETURNING id`;
  if (!rows.length) return c.json({ message: 'Utilizador não encontrado.' }, 404);
  return c.json({ success: true });
});

// POST /api/v1/admin/wallet/credit — Carregar a conta de um motorista (numero + valor pago)
// O valor soma-se à carteira; se havia saldo negativo o carregamento desconta-o.
// Carregar com saldo >= 0 desbloqueia a conta (walletBlocked=0, negTrips=0).
app.post('/api/v1/admin/wallet/credit', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  const b = await c.req.json().catch(() => ({}));
  const dg = String(b?.phone || '').replace(/\D/g, '');
  const local = dg.indexOf('244') === 0 ? dg.slice(3) : dg;
  const amount = Number(b?.amount);
  if (!/^9[123459]\d{7}$/.test(local)) return c.json({ message: 'Número angolano inválido: 9XX XXX XXX.' }, 400);
  if (!(amount > 0)) return c.json({ message: 'Valor inválido.' }, 400);
  const rows = await sql`SELECT id, name, phone, role, "walletBalance", "negTrips", "walletBlocked" FROM users WHERE phone = ${'+244' + local} AND "isActive" = true LIMIT 1`;
  if (!rows.length) return c.json({ message: 'Conta não encontrada.' }, 404);
  const u = rows[0];
  if (String(u.role) !== 'DRIVER') return c.json({ message: 'Esta conta não é de motorista.' }, 400);
  const before = money(u.walletBalance);
  const after = money(before + amount);
  const blocked = after < 0 ? 1 : 0;
  const negTrips = after < 0 ? Number(u.negTrips || 0) : 0;
  const admin = c.get('user');
  await sql`UPDATE users SET "walletBalance" = ${after}, "negTrips" = ${negTrips}, "walletBlocked" = ${blocked}, "updatedAt" = NOW() WHERE id = ${u.id}`;
  await sql`INSERT INTO wallet_tx (id, "userId", type, amount, "balanceAfter", note, "createdAt") VALUES (gen_random_uuid()::text, ${u.id}, 'TOPUP', ${money(amount)}, ${after}, ${'Carregamento admin ' + String(admin?.sub || '')}, NOW())`;
  return c.json({ ok: true, user: { id: u.id, name: u.name, phone: u.phone }, before, after, blocked: !!blocked, negTrips });
});

// GET /api/v1/admin/wallet — Lista carteiras de motoristas (saldo/negativas/bloqueio)
app.get('/api/v1/admin/wallet', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  const q = String(c.req.query('q') || '').replace(/\D/g, '');
  const rows = q
    ? await sql`SELECT id, name, phone, "walletBalance", "negTrips", "walletBlocked" FROM users WHERE role = 'DRIVER' AND phone LIKE ${'%' + q} ORDER BY "walletBalance" ASC LIMIT 100`
    : await sql`SELECT id, name, phone, "walletBalance", "negTrips", "walletBlocked" FROM users WHERE role = 'DRIVER' ORDER BY "walletBalance" ASC LIMIT 100`;
  return c.json({ wallets: rows.map((r: any) => ({ id: r.id, name: r.name, phone: r.phone, balance: money(r.walletBalance), negTrips: Number(r.negTrips || 0), blocked: !!Number(r.walletBlocked || 0) })) });
});

// ─── Foto de perfil via admin (+ registo no canal Telegram) ───────────────
// O admin carrega a foto (motorista ou passageira) no painel; guarda-se em
// users."profilePhoto" e, se TG_BOT_TOKEN + TG_CHAT_ID estiverem definidos
// (wrangler secret put), a mesma foto vai para o canal Telegram como registo.
// Os segredos nunca ficam no repo: só o Worker os lê.
async function tgSendPhoto(env: any, dataUrl: string, caption: string): Promise<boolean> {
  try {
    const tok = String(env?.TG_BOT_TOKEN || env?.TELEGRAM_BOT_TOKEN || '');
    const chat = String(env?.TG_CHAT_ID || env?.TELEGRAM_CHAT_ID || '');
    if (!tok || !chat) return false;
    const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(dataUrl || ''));
    if (!m) return false;
    const bin = Uint8Array.from(atob(m[2]), (ch: any) => ch.charCodeAt(0));
    const fd = new FormData();
    fd.append('chat_id', chat);
    if (caption) fd.append('caption', caption.slice(0, 1000));
    fd.append('photo', new Blob([bin as any], { type: m[1] }), 'foto.jpg');
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendPhoto`, { method: 'POST', body: fd, signal: AbortSignal.timeout(15000) });
    return r.ok;
  } catch {
    return false;
  }
}
// PUT /api/v1/admin/users/:id/photo — Admin define a foto de perfil (qualquer conta)
app.put('/api/v1/admin/users/:id/photo', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const photo = String(b.photo || '');
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(photo)) return c.json({ message: 'Foto invalida.' }, 400);
  if (photo.length > 2 * 1024 * 1024) return c.json({ message: 'Foto demasiado grande.' }, 413);
  const rows = await sql`UPDATE users SET "profilePhoto" = ${photo}, "updatedAt" = NOW() WHERE id = ${id} RETURNING id, name, phone, role`;
  if (!rows.length) return c.json({ message: 'Utilizador nao encontrado.' }, 404);
  const u = rows[0];
  const tgOn = !!((c.env.TG_BOT_TOKEN || c.env.TELEGRAM_BOT_TOKEN) && (c.env.TG_CHAT_ID || c.env.TELEGRAM_CHAT_ID));
  if (tgOn) {
    const caption = `LadiesGo · foto de ${u.name || u.phone || ''} (${u.role || ''})`;
    try {
      c.executionCtx.waitUntil(tgSendPhoto(c.env, photo, caption).catch(() => false));
    } catch {
      tgSendPhoto(c.env, photo, caption).catch(() => false);
    }
  }
  return c.json({ success: true, telegram: tgOn });
});

// GET /api/v1/admin/drivers/pending — Pending driver registrations
app.get('/api/v1/admin/drivers/pending', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
  const { id } = c.req.param();
  await sql`UPDATE drivers SET status = 'APPROVED', "updatedAt" = NOW() WHERE id = ${id}`;
  return c.json({ success: true });
});

// PUT /api/v1/admin/drivers/:id/reject — Reject driver
app.put('/api/v1/admin/drivers/:id/reject', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  const { id } = c.req.param();
  await sql`UPDATE drivers SET status = 'REJECTED', "isOnline" = false, "updatedAt" = NOW() WHERE id = ${id}`;
  return c.json({ success: true });
});

// POST /api/v1/admin/drivers/create — Create driver with vehicle (auto-approve if has license+plate)
app.post('/api/v1/admin/drivers/create', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  const { phone, name, licenseNumber, carPlate, carMake, carModel, carYear, carColor } = await c.req.json().catch(() => ({}));
  if (!phone || !name) return c.json({ message: 'Nome e número obrigatórios.' }, 400);
  const cleanPhone = phone.startsWith('+244') ? phone : `+244${phone.replace(/\D/g, '')}`;
  const exists = await sql`SELECT id FROM users WHERE phone = ${cleanPhone} LIMIT 1`;
  if (exists.length) return c.json({ message: 'Número já registado.' }, 409);
  // Create user
  const userRes = await sql`INSERT INTO users (id, phone, "passwordHash", name, role, "isVerified", "updatedAt") VALUES (gen_random_uuid()::text, ${cleanPhone}, ${await hashPassword('0987654321')}, ${name}, 'DRIVER', true, NOW()) RETURNING id`;
  const userId = userRes[0].id;
  // Create driver
  const driverStatus = 'APPROVED'; // criada pelo admin entra logo aprovada
  await sql`
    INSERT INTO drivers (id, "userId", "licenseNumber", "carPlate", "carMake", "carModel", "carYear", "carColor", status, "updatedAt")
    VALUES (gen_random_uuid()::text, ${userId}, ${licenseNumber || null}, ${carPlate || null}, ${carMake || null}, ${carModel || null}, ${carYear || null}, ${carColor || null}, ${driverStatus}, NOW())
  `;
  return c.json({ success: true, userId, driverStatus, password: '0987654321' });
});

// ─── MISSING MOBILE APP ENDPOINTS ───

// DELETE /api/v1/users/me — Delete account
app.delete('/api/v1/users/me', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  await sql`UPDATE users SET "isActive" = false, "updatedAt" = NOW() WHERE id = ${user.sub}`;
  return c.json({ success: true });
});

// POST /api/v1/users/report — Report a user
app.post('/api/v1/users/report', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const { isOnline } = await c.req.json().catch(() => ({}));
  if (isOnline) {
    const w = await sql`SELECT "walletBlocked" FROM users WHERE id = ${user.sub} LIMIT 1`;
    if (w.length && Number(w[0].walletBlocked || 0)) return c.json({ message: 'Saldo negativo. Carrega a tua conta para voltares a ficar online.' }, 403);
  }
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
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
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
    const drv = await webDriverInfo(c.env, sql, t.driverId);
    const pu = await sql`SELECT name, phone, "profilePhoto" FROM users WHERE id = ${t.passengerId} LIMIT 1`;
    const pl = paxLive.get(t.id);
    const { byCode } = await catMaps(sql);
    return c.json({ ...webTripRow(t, drv, pu[0]?.name || '', (code) => byCode[code] || 'Económico', pu[0]?.phone || '', pu[0]?.profilePhoto || ''), paxLive: pl && Date.now() - pl.ts < 60000 ? { lat: pl.lat, lng: pl.lng } : null });
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
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
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
  await applyCommission(sql, t.driverId, t.finalFare || t.fareEstimate, id);
  return c.json(rows[0]);
});

// PUT /api/v1/trips/:id/cancel — Cancel trip
app.put('/api/v1/trips/:id/cancel', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  const { tripId, ratedId, score, comment } = b;
  if (!tripId || !ratedId || !score) return c.json({ message: 'Dados inválidos.' }, 400);
  await sql`
    INSERT INTO ratings (id, "tripId", "raterId", "ratedId", score, comment, "createdAt")
    VALUES (${String(tripId) + ':' + user.sub}, ${tripId}, ${user.sub}, ${ratedId}, ${score}, ${comment || ''}, NOW())
    ON CONFLICT (id) DO NOTHING
  `;
  return c.json({ success: true });
});

// GET /api/v1/notifications — Get notifications
app.get('/api/v1/notifications', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const rows = await sql`
    SELECT COUNT(*)::int AS count FROM notifications WHERE "userId" = ${user.sub} AND "isRead" = false
  `;
  return c.json({ count: Number(rows[0]?.count || 0) });
});

// PUT /api/v1/notifications/read-all — Mark all as read
app.put('/api/v1/notifications/read-all', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  await sql`UPDATE notifications SET "isRead" = true WHERE "userId" = ${user.sub}`;
  return c.json({ success: true });
});

// ─── CATEGORIAS (geridas no painel admin) ───
// GET /api/v1/categories — Lista pública (a home usa para nomes/cores/preços)
app.get('/api/v1/categories', async (c) => {
  try {
    const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
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
  const sql = neon(c.env.DB);
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

function webTripRow(r: any, drv: any, paxName: string, catName?: (code: string) => string, paxPhone?: string, paxPhoto?: string) {
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
    passengerPhoto: paxPhoto || r.passengerPhoto || '',
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
    serverNow: Date.now(),
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

async function webDriverInfo(env: any, sql: any, driverId: string | null) {
  if (!driverId) return null;
  const d = await sql`
    SELECT d."userId", d."currentLat", d."currentLng", d.rating, d."totalTrips", d."carMake", d."carModel", d."carColor", d."carPlate", u.name, u.phone, u."profilePhoto"
    FROM drivers d LEFT JOIN users u ON u.id = d."userId" WHERE d.id = ${driverId} LIMIT 1`;
  if (!d.length) return null;
  const r = d[0];
  const live = await geoGet(env, String(r.userId || ''));
  const lat = live && Number.isFinite(Number(live.lat)) ? Number(live.lat) : (r.currentLat != null ? Number(r.currentLat) : null);
  const lng = live && Number.isFinite(Number(live.lng)) ? Number(live.lng) : (r.currentLng != null ? Number(r.currentLng) : null);
  let avg = r.rating != null ? Number(r.rating) : 5;
  try {
    const ar = await sql`SELECT COALESCE(AVG(rt.score), 0)::float AS a, COUNT(*)::int AS n FROM ratings rt JOIN trips t ON t.id = rt."tripId" WHERE t."driverId" = ${driverId}`;
    if (ar[0] && Number(ar[0].n) > 0) avg = Math.round(Number(ar[0].a) * 10) / 10;
  } catch {}
  return {
    lat,
    lng,
    name: r.name || 'Motorista',
    phone: r.phone || '',
    photo: r.profilePhoto || '',
    rating: avg,
    totalTrips: Number(r.totalTrips || 0),
    carMake: r.carMake || '', carModel: r.carModel || '', carColor: r.carColor || '', carPlate: r.carPlate || '',
  };
}

// ─── OFERTA SEQUENCIAL EM CICLO (30s por motorista, mais próxima primeiro, raio 20min) ───
// A passageira pede → a oferta vai só para a motorista online mais próxima
// (até 20min do pickup). Sem resposta/rejeição, passa à seguinte. No fim da
// fila volta à primeira (quem calou tem nova chance; quem rejeitou fica de
// fora) até alguém aceitar ou a viagem expirar (10min).
const OFFER_TTL_SEC = 30;
const OFFER_MAX = 15;
// Raio de oferta por degraus de tempo (segundos desde o pedido). No centro 5 km
// chega; na periferia (Camama/Talatona) expande até 12 km se ninguém aceitar.
const OFFER_RADIUS_STEPS: { after: number; km: number }[] = [
  { after: 0, km: 5 },
  { after: 28, km: 8 },
  { after: 58, km: 12 },
];
function offerRadiusKm(createdAt: any): number {
  const t0 = createdAt ? new Date(createdAt).getTime() : 0;
  const el = t0 ? (Date.now() - t0) / 1000 : 0;
  let km = OFFER_RADIUS_STEPS[0].km;
  for (const s of OFFER_RADIUS_STEPS) if (el >= s.after) km = s.km;
  return km;
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
async function buildOfferQueue(env: any, sql: any, pLa: number, pLo: number, rideCode: string, radiusKm = 5, limit = OFFER_MAX): Promise<string[]> {
  let byCode: Record<string, string> = {};
  try { byCode = (await catMaps(sql)).byCode; } catch {}
  const pos = await geoAll(env);
  const byUser = new Map<string, any>();
  for (const p of pos) if (p && p.userId) byUser.set(String(p.userId), p);
  let rows: any[] = [];
  try {
    rows = await sql`SELECT d.id, d."userId", d.cats FROM drivers d WHERE d."isOnline" = true AND d.status = 'APPROVED' AND NOT EXISTS (SELECT 1 FROM trips t2 WHERE t2."driverId" = d.id AND t2.status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS'))`;
  } catch { return []; }
  const wantCat = byCode[rideCode] || '';
  return rows
    .map((d: any) => {
      const p = byUser.get(String(d.userId));
      if (!p || !Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lng))) return null;
      if (Array.isArray(d.cats) && d.cats.length && wantCat && d.cats.map((x: any) => String(x)).indexOf(wantCat) < 0) return null;
      const km = Number.isFinite(pLa) && Number.isFinite(pLo) ? havKm(pLa, pLo, Number(p.lat), Number(p.lng)) : 0;
      return { id: String(d.id), km, stale: Date.now() - Number(p.ts || 0) };
    })
    .filter((d: any) => d && Number.isFinite(d.km) && d.km <= radiusKm)
    .sort((a: any, b: any) => (a.km - b.km) || (a.stale - b.stale))
    .slice(0, limit)
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
async function advanceOfferIfNeeded(env: any, sql: any, t: any, pushBody?: { title: string; body: string }): Promise<any> {
  try {
    if (!t || t.status !== 'REQUESTED' || (t as any).offerBroadcast) return t;
    const exp = (t as any).offerExpiresAt ? new Date((t as any).offerExpiresAt).getTime() : 0;
    if (exp && Date.now() < exp) return t;
    const q = offerQueueOf(t);
    const skipped = offerSkippedOf(t);
    const missed = offerMissedOf(t);
    const cur = (t as any).offeredDriverId ? String((t as any).offeredDriverId) : '';
    // Raio expansivo por tempo: ao expirar, junta as motoristas que agora
    // entram no raio maior (sem repetir quem já recusou). Não mexe na ordem —
    // os novos estão mais longe, logo vão para o fim da fila.
    const wantKm = offerRadiusKm((t as any).createdAt);
    if (wantKm > 5) {
      try {
        const known = new Set<string>([...q, ...skipped, ...missed]);
        const cand = await buildOfferQueue(env, sql, Number((t as any).pickupLat), Number((t as any).pickupLng), String((t as any).rideType || 'ECONOMY'), wantKm, OFFER_MAX);
        for (const id of cand) if (!known.has(id)) { q.push(id); known.add(id); }
      } catch {}
    }
    // Timeout (sem resposta) != rejeicao: quem calou entra de novo na
    // volta seguinte; quem rejeitou (skipped) fica de fora de vez.
    if (cur && missed.indexOf(cur) < 0) missed.push(cur);
    const gone = (id: string) => skipped.indexOf(id) >= 0 || missed.indexOf(id) >= 0;
    const oldIdx = Number((t as any).offerIdx || 0);
    let idx = oldIdx + (cur ? 1 : 0);
    while (idx < q.length && gone(q[idx])) idx += 1;
    let missedJson = JSON.stringify(missed);
    if (idx >= q.length) {
      // Volta ao início (ciclo até aceitar): quem calou tem nova chance.
      const again = q.filter((x: string) => skipped.indexOf(x) < 0);
      if (!again.length) {
        const r = await sql`UPDATE trips SET "offerBroadcast" = TRUE, "offerQueue" = ${JSON.stringify(q)}::jsonb, "offerMissed" = ${missedJson}::jsonb, "updatedAt" = NOW() WHERE id = ${t.id} AND status = 'REQUESTED' RETURNING *`;
        return r[0] || t;
      }
      missed.length = 0;
      missedJson = JSON.stringify(missed);
      idx = q.indexOf(again[0]);
    }
    const expAt = new Date(Date.now() + OFFER_TTL_SEC * 1000);
    const r = await sql`UPDATE trips SET "offerIdx" = ${idx}, "offeredDriverId" = ${q[idx]}, "offeredAt" = NOW(), "offerExpiresAt" = ${expAt as any}, "offerQueue" = ${JSON.stringify(q)}::jsonb, "offerMissed" = ${missedJson}::jsonb, "updatedAt" = NOW() WHERE id = ${t.id} AND status = 'REQUESTED' AND COALESCE("offerIdx", 0) = ${oldIdx} RETURNING *`;
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
  const sql = neon(c.env.DB);
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
    // Oferta sequencial por proximidade (30s cada, até passar ao próximo condutor); sem candidatas abre a todas.
    // Calculada ANTES do INSERT para não haver um UPDATE a mais por viagem.
    const rideCode = byName[String(b.cat)] || 'ECONOMY';
    let q: string[] = [];
    try { q = await buildOfferQueue(c.env, sql, pLa, pLo, rideCode); } catch {}
    const hasQ = q.length > 0;
    const offerFirst: string | null = hasQ ? q[0] : null;
    const expAt = hasQ ? new Date(Date.now() + OFFER_TTL_SEC * 1000) : null;
    const rows = await sql`
      INSERT INTO trips (id, "passengerId", "pickupAddress", "pickupLat", "pickupLng", "dropoffAddress", "dropoffLat", "dropoffLng",
        status, "rideType", "fareEstimate", "distanceKm", "paymentMethod", stops, "scheduledAt", "createdAt", "updatedAt",
        "offerQueue", "offerIdx", "offeredDriverId", "offeredAt", "offerExpiresAt", "offerBroadcast", "offerSkipped")
      VALUES (gen_random_uuid()::text, ${user.sub}, ${pickupName}, ${pLa}, ${pLo},
        ${String(b.destN || '').slice(0, 60) + ' · ' + String(b.destA || '').slice(0, 80)}, ${dLa}, ${dLo},
        'REQUESTED', ${rideCode}, ${fare}, ${Math.round(dist * 10) / 10},
        ${pay2method(b.pay)}, ${JSON.stringify(stops)}::jsonb, ${sched as any}, NOW(), NOW(),
        ${hasQ ? JSON.stringify(q) : null}, 0, ${hasQ ? q[0] : null}, ${hasQ ? new Date().toISOString() : null}, ${expAt ? expAt.toISOString() : null}, ${hasQ ? 0 : 1}, ${hasQ ? '[]' : null})
      RETURNING id`;
    const tripId = rows[0].id;
    // Toca-toca (arranque do ringer, não bloqueia a resposta).
    try {
      const destN = String(b.destN || '').slice(0, 60);
      c.executionCtx.waitUntil((async () => {
        // Oferta exclusiva: o aviso é dado pelo toca-toca (4s, 4x por motorista).
        // Sem fila (broadcast): abre a todas.
        if (!offerFirst) await pushTripToDrivers(sql, tripId, pickupName, destN, stops.length, fare, '🔔 Novo pedido LadiesGo!', String(b.cat || ''));
        await ringStart(c.env);
        try {
          const fbTok = String((c.env as any).FB_SCRAPE_TOKEN || '');
          if (fbTok) await fetch('https://graph.facebook.com/v26.0/?id=' + encodeURIComponent('https://ladiesgo.pages.dev/t?id=' + tripId) + '&scrape=true&access_token=' + encodeURIComponent(fbTok), { method: 'POST', signal: AbortSignal.timeout(10000) });
        } catch {}
      })());
    } catch {}
    hubPoke(c, [String(b.cat || '')]);
    return c.json({ id: tripId });
  } catch (e) {
    console.error('request-web error:', e);
    return c.json({ message: 'Falhou o pedido. Tenta de novo.' }, 500);
  }
});

// POST /api/v1/trips/:id/status — Transições da home (web)
app.post('/api/v1/trips/:id/status', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
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
        const oc = await sql`SELECT "offerQueue", "offerIdx", "offeredDriverId", "offerBroadcast", "offerExpiresAt", status FROM trips WHERE id = ${id} LIMIT 1`;
        if (oc.length && oc[0].status === 'REQUESTED' && !oc[0].offerBroadcast && (offerQueueOf(oc[0]).length || oc[0].offeredDriverId)) {
          const fresh: any = await advanceOfferIfNeeded(c.env, sql, oc[0]);
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
      await applyCommission(sql, t.driverId, t.finalFare || t.fareEstimate, id);
    } else if (neonSt === 'CANCELLED') {
      await sql`UPDATE trips SET status = 'CANCELLED', "cancelledBy" = ${String(b.by || '').slice(0, 16)}, "cancelReason" = ${String(b.reason || '').slice(0, 80)}, "updatedAt" = NOW() WHERE id = ${id}`;
    }
    pushStatus(c, id, neonSt);
    if (neonSt === 'ACCEPTED' || neonSt === 'CANCELLED') hubPoke(c);
    return c.json({ ok: true, status: st });
  } catch (e) {
    console.error('trip status error:', e);
    return c.json({ message: 'Falhou. Tenta de novo.' }, 500);
  }
});

// GET /api/v1/trips/public/:id — Partilha com contactos (sem login: quem tem o link vê)
app.get('/api/v1/trips/public/:id', async (c) => {
  const sql = neon(c.env.DB);
  const id = c.req.param('id');
  try {
    const rows = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
    if (!rows.length) return c.json({ message: 'Viagem não encontrada.' }, 404);
    const t = rows[0];
    const pu = await sql`SELECT name, phone FROM users WHERE id = ${t.passengerId} LIMIT 1`;
    let driver = null;
    if (t.driverId) {
      const d = await sql`
        SELECT d."userId", d."currentLat", d."currentLng", d.rating, d."carMake", d."carModel", d."carColor", d."carPlate", d."carPhoto", u.name, u.phone, u."profilePhoto"
        FROM drivers d LEFT JOIN users u ON u.id = d."userId" WHERE d.id = ${t.driverId} LIMIT 1`;
      if (d.length) {
        const r = d[0];
        const live = r.userId ? await geoGet(c.env, String(r.userId)) : null;
        const lat = live && Number.isFinite(Number(live.lat)) ? Number(live.lat) : (r.currentLat != null ? Number(r.currentLat) : null);
        const lng = live && Number.isFinite(Number(live.lng)) ? Number(live.lng) : (r.currentLng != null ? Number(r.currentLng) : null);
        const carFull = [r.carMake, r.carModel].filter(Boolean).join(' ') + (r.carColor ? ' · ' + r.carColor : '');
        driver = { name: r.name || 'Motorista', phone: r.phone || '', carFull, plate: r.carPlate || '', rating: r.rating != null ? Number(r.rating) : null, photo: r.carPhoto || r.profilePhoto || '', lat, lng };
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
    await this.state.storage.setAlarm(now + 4000);
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
  }
  async alarm() {
    try {
      const sent: number = (await this.state.storage.get('sent')) || 0;
      const sql = neon(this.env.DB);
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
          if (ch.length) { await this.state.storage.setAlarm(Date.now() + 4000); return; }
        } catch {}
        const addr = String(t.dropoffAddress || 'Luanda');
        const cut = addr.indexOf(' · ');
        const { byCode } = await catMaps(sql);
        // Oferta sequencial: roda a fila em silêncio (sem push). O toca-toca
        // avisa a motorista ofertada a cada 4s, até 4 vezes por motorista
        // (reinicia quando a oferta passa a outro condutor próximo, aos 30s).
        try {
          const full = await sql`SELECT * FROM trips WHERE id = ${t.id} LIMIT 1`;
          if (full.length && !full[0].offerBroadcast && (offerQueueOf(full[0]).length || full[0].offeredDriverId)) {
            const fresh: any = await advanceOfferIfNeeded(this.env, sql, full[0]);
            if (!fresh.offerBroadcast) {
              const offId = String(fresh.offeredDriverId || '');
              const ringKey = t.id + ':' + offId;
              const ringKeyStored = String((await this.state.storage.get('ringKey')) || '');
              let ringN = Number((await this.state.storage.get('ringN')) || 0);
              if (ringKey !== ringKeyStored) { ringN = 0; await this.state.storage.put('ringKey', ringKey); }
              if (offId && ringN < 4) {
                await pushTripToDriver(sql, offId, t.id, '🔔 Novo pedido LadiesGo!', `${String(fresh.pickupAddress || 'Ponto no mapa')} → ${String(fresh.dropoffAddress || '').split(' · ')[0]} · ${Number(fresh.fareEstimate || 0)} Kz`);
                ringN += 1;
                await this.state.storage.put('ringN', ringN);
              }
              try { await hubBroadcast(this.env); } catch {}
              await this.state.storage.setAlarm(Date.now() + 4000);
              return;
            }
          }
        } catch {}
        try { await hubBroadcast(this.env); } catch {}
        if (sent < 3) { await pushTripToDrivers(sql, t.id, String(t.pickupAddress || 'Ponto no mapa'), cut >= 0 ? addr.slice(0, cut) : addr, Array.isArray(t.stops) ? t.stops.length : 0, Number(t.fareEstimate || 0), '🔔 Novo pedido LadiesGo!', byCode[t.rideType] || ''); await this.state.storage.put('sent', sent + 1); }
      } else {
        // Resumo só das viagens em broadcast (as exclusivas já avisam a
        // ofertada). Sem nenhuma aberta, reagenda em silêncio.
        if (sent >= 3) { try { await this.state.storage.setAlarm(Date.now() + 4000); } catch {} return; }
        let openN = rows.length;
        try {
          const oc = await sql`SELECT COUNT(*)::int AS n FROM trips WHERE status = 'REQUESTED' AND "createdAt" > NOW() - INTERVAL '6 minutes' AND ("offerBroadcast" = TRUE OR "offerQueue" IS NULL)`;
          openN = Number(oc[0]?.n || 0);
        } catch {}
        if (!openN) {
          try { await this.state.storage.setAlarm(Date.now() + 10000); } catch {}
          return;
        }
        try { await hubBroadcast(this.env); } catch {}
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
        await this.state.storage.put('sent', sent + 1);
      }
      await this.state.storage.setAlarm(Date.now() + 4000);
    } catch {
      try { await this.state.storage.setAlarm(Date.now() + 10000); } catch {}
    }
  }
}

// ─── TripPush: 1 DO por viagem (id `trip:<tripId>`), WS em HIBERNAÇÃO ───
// Classe NOVA de propósito (não estende o TripRinger: ele é singleton global
// de alarmes/push Expo com lógica de oferta — misturar partia-o).
// Memória do DO: posição viva + throttle + cache de estado. Nada de GPS no Neon.
// Neon: só leituras esporádicas de estado (≤1/15s por viagem ativa) e via
// POST /notify das transições (hook notifyTripPush); escritas Neon continuam
// exclusivas do REST existente (accept/arrived/start/complete/cancel).
const PUSH_GPS_MIN_MS = 4_000;
const PUSH_STATUS_TTL_MS = 15_000;
export class TripPush {
  state: any;
  env: any;
  driver: { lat: number; lng: number; ts: number } | null = null;
  passenger: { lat: number; lng: number; ts: number } | null = null;
  status: string | null = null;
  statusAt = 0;
  tripCache: any = null;
  tripId: string | null = null;
  statusLoaded = false;
  lastEta: number | null = null;
  constructor(state: any, env: any) {
    this.state = state;
    this.env = env;
    try {
      // Keep-alive sem acordar o DO.
      this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    } catch {}
  }
  async fetch(req: any) {
    const u = new URL(req.url);
    if (req.method === 'POST' && u.pathname.endsWith('/notify')) {
      // Rede interna Worker→DO (transições). Sem auth por desenho.
      try {
        const b: any = await req.json().catch(() => ({}));
        const st = String(b?.status || '').toUpperCase().slice(0, 20);
        if (st) {
          await this.hydrate();
          const changed = this.status !== st;
          this.status = st;
          this.statusAt = Date.now();
          if (changed) {
            await this.persistStatus();
            this.broadcast({ t: 'status', status: st });
            this.pushEta();
          }
        }
      } catch {}
      return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
    }
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket')
      return new Response('Expected websocket', { status: 426 });
    const tripId = String(req.headers.get('X-Trip-Id') || u.pathname.split('/').pop() || '').slice(0, 64);
    if (!tripId) return new Response('Missing trip', { status: 400 });
    this.tripId = tripId;
    try { await this.state.storage.put('tripId', tripId); } catch {}
    // Lê o estado persistido e atualiza do Neon ANTES de aceitar o socket: assim o
    // hello já traz o status e o novo cliente não recebe um frame "status" duplicado
    // (só os sockets já ligados são avisados).
    try { await this.hydrate(); } catch {}
    try { await this.refreshStatus(false); } catch {}
    const uid = String(req.headers.get('X-User-Id') || '');
    const tag = req.headers.get('X-Is-Driver') === '1' ? 'driver' : 'pax';
    const pair: any = new WebSocketPair();
    const client = pair[0], server = pair[1];
    try {
      this.state.acceptWebSocket(server, [tag, `u:${uid.slice(0, 32)}`]);
    } catch {
      return new Response('WS failed', { status: 500 });
    }
    // Estado de throttle guardado no anexo do socket: sobrevive à hibernação
    // (ao contrário de campos em memória) e não grava em storage.
    try { server.serializeAttachment({ lastFixAt: 0, pushLat: 0, pushLng: 0, pushAt: 0, lastPaxAt: 0 }); } catch {}
    // A API de hibernação não tem callback webSocketOpen(): o hello é enviado aqui,
    // logo após o accept, antes de devolver o 101.
    try { server.send(JSON.stringify(this.helloFrame())); } catch {}
    return new Response(null, { status: 101, webSocket: client });
  }
  helloFrame(): any {
    const hello: any = { t: 'hello', tripId: this.tripId };
    if (this.status) hello.status = this.status;
    if (this.driver && Date.now() - this.driver.ts < 120000) hello.driver = { lat: this.driver.lat, lng: this.driver.lng };
    if (this.passenger && String(this.status || '') !== 'IN_PROGRESS' && Date.now() - this.passenger.ts < 120000) hello.pax = { lat: this.passenger.lat, lng: this.passenger.lng };
    return hello;
  }
  // Estado persistido: sobrevive à hibernação (sem isto um DO acordado reenviava
  // "status" ao julgar que mudou de null -> valor).
  async hydrate() {
    if (this.statusLoaded) return;
    this.statusLoaded = true;
    try {
      const s = await this.state.storage.get('status');
      if (!this.status && s) this.status = String(s);
    } catch {}
  }
  async persistStatus() {
    this.statusLoaded = true;
    try { await this.state.storage.put('status', this.status); } catch {}
  }
  // Só emite ETA quando o valor muda (evita frames repetidos).
  pushEta() {
    const eta = this.etaMin();
    if (eta == null || this.lastEta === eta) return;
    this.lastEta = eta;
    this.broadcast({ t: 'eta', min: eta });
  }
  async webSocketMessage(ws: any, raw: any) {
    let m: any;
    try { m = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'gps') { await this.onGps(ws, m).catch(() => {}); return; }
    if (m.t === 'hdg') { await this.onHdg(ws, m).catch(() => {}); return; }
    if (m.t === 'chat') {
      const text = String((m as any).text || '').trim().slice(0, 300);
      if (!text) return;
      // Efémero: difunde já (exceto a quem enviou); persistência continua no REST POST /:id/chat (fonte de verdade).
      this.broadcastExcept(ws, { t: 'chat', text, from: String((m as any).from || '').slice(0, 40), ts: Date.now() });
      return;
    }
    if (m.t === 'state') {
      await this.refreshStatus(true).catch(() => null);
      try { ws.send(JSON.stringify({ t: 'state', status: this.status, driver: this.driver ? { lat: this.driver.lat, lng: this.driver.lng } : null, pax: this.passenger ? { lat: this.passenger.lat, lng: this.passenger.lng } : null, etaMin: this.etaMin(), ts: Date.now() })); } catch {}
      return;
    }
    // Resto ignora.
  }
  async webSocketClose(_ws: any, _code: any, _reason: any, _wasClean: any) {}
  async webSocketError(ws: any, _err: any) { try { ws.close(1011, 'err'); } catch {} }
  async onGps(ws: any, m: any) {
    // Motorista e passageira enviam GPS. A tag vem do upgrade (X-Is-Driver) e é reforçada pelo claim role.
    let tags: string[] = [];
    try { tags = this.state.getTags(ws) || []; } catch {}
    const claimed = String(m?.role || '').toLowerCase();
    const la = Number(m?.lat), lo = Number(m?.lng);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return;
    const now = Date.now();
    const att: any = (() => { try { return ws.deserializeAttachment() || {}; } catch { return {}; } })();
    // Motorista: máx 1 fix/4s. SÓ memória do DO — nada no Neon por fix.
    if (tags.indexOf('driver') >= 0 && claimed === 'driver') {
      if (now - Number(att.lastFixAt || 0) < PUSH_GPS_MIN_MS) return;
      att.lastFixAt = now;
      this.driver = { lat: la, lng: lo, ts: now };
      await this.refreshStatus(false);
      // A motorista é monitorizada do início ao fim da viagem, por isso a sua
      // posição é sempre transmitida à passageira. Para não spammar, só se
      // redesenha quando o carro anda (>=20m) ou a cada 8s — o suficiente para
      // a passageira ver o carro deslizar suavemente.
      const movedKm = att.pushAt ? havKm(Number(att.pushLat), Number(att.pushLng), la, lo) : 1;
      if (movedKm >= 0.02 || now - Number(att.pushAt || 0) >= 8000) {
        att.pushLat = la; att.pushLng = lo; att.pushAt = now;
        this.broadcastExcept(ws, { t: 'driver', lat: la, lng: lo, ts: now });
        this.pushEta();
      }
      try { ws.serializeAttachment(att); } catch {}
      return;
    }
    // Passageira: máx 1 fix/10s; a motorista vê o marcador. Após o arranque
    // (IN_PROGRESS) a motorista já está com a passageira: não propaga o pax.
    if (tags.indexOf('pax') >= 0 && claimed === 'pax') {
      if (now - Number(att.lastPaxAt || 0) < PUSH_GPS_MIN_MS) return;
      att.lastPaxAt = now;
      this.passenger = { lat: la, lng: lo, ts: now };
      if (String(this.status || '') !== 'IN_PROGRESS') {
        this.broadcastExcept(ws, { t: 'pax', lat: la, lng: lo, ts: now });
      }
      try { ws.serializeAttachment(att); } catch {}
      return;
    }
  }
  // Rumo (bússola) da motorista: repassa à passageira para o carro rodar mesmo
  // parado. Sem persistência e com throttle por socket (no anexo, que sobrevive
  // à hibernação). Só a motorista envia.
  async onHdg(ws: any, m: any) {
    let tags: string[] = [];
    try { tags = this.state.getTags(ws) || []; } catch {}
    if (tags.indexOf('driver') < 0) return;
    const h = Number(m?.h);
    if (!Number.isFinite(h)) return;
    const now = Date.now();
    const att: any = (() => { try { return ws.deserializeAttachment() || {}; } catch { return {}; } })();
    if (now - Number(att.lastHdgAt || 0) < 200) return;
    att.lastHdgAt = now;
    try { ws.serializeAttachment(att); } catch {}
    const hh = ((h % 360) + 360) % 360;
    this.broadcastExcept(ws, { t: 'hdg', h: hh, ts: now });
  }
  async refreshStatus(force: boolean) {
    const now = Date.now();
    if (!force && now - this.statusAt < PUSH_STATUS_TTL_MS) return this.status;
    if (!this.tripId) {
      try { this.tripId = await this.state.storage.get('tripId'); } catch {}
    }
    if (!this.tripId) return this.status;
    try { await this.hydrate(); } catch {}
    const sql = neon(this.env.DB);
    const rows = await sql`SELECT status, "pickupLat", "pickupLng", "dropoffLat", "dropoffLng" FROM trips WHERE id = ${this.tripId} LIMIT 1`;
    this.statusAt = now;
    if (!rows.length) return this.status;
    const r: any = rows[0];
    this.tripCache = r;
    if (r.status && r.status !== this.status) {
      this.status = r.status;
      await this.persistStatus();
      this.broadcast({ t: 'status', status: r.status });
      this.pushEta();
    }
    return this.status;
  }
  etaMin(): number | null {
    try {
      if (!this.driver || !this.tripCache) return null;
      const st = String(this.status || '');
      const tLa = Number(st === 'IN_PROGRESS' ? this.tripCache.dropoffLat : this.tripCache.pickupLat);
      const tLo = Number(st === 'IN_PROGRESS' ? this.tripCache.dropoffLng : this.tripCache.pickupLng);
      if (!Number.isFinite(tLa) || !Number.isFinite(tLo)) return null;
      const dk = havKm(this.driver.lat, this.driver.lng, tLa, tLo);
      return Math.max(1, Math.ceil((dk / 30) * 60));
    } catch { return null; }
  }
  broadcast(obj: any) {
    let msg = '';
    try { msg = JSON.stringify(obj); } catch { return; }
    let socks: any[] = [];
    try { socks = this.state.getWebSockets(); } catch { return; }
    for (const s of socks) { try { s.send(msg); } catch {} }
  }
  broadcastExcept(ws: any, obj: any) {
    let msg = '';
    try { msg = JSON.stringify(obj); } catch { return; }
    let socks: any[] = [];
    try { socks = this.state.getWebSockets(); } catch { return; }
    for (const s of socks) { if (s === ws) continue; try { s.send(msg); } catch {} }
  }
}

// ─── RequestsHub: feed de pedidos em tempo real (1 DO global, WS hibernável) ───
// Motoristas online ligam-se aqui; quando entra/altera/aceita um pedido o Worker
// chama POST /broadcast e o hub faz "poke" (mensagem de saída = grátis). A
// motorista responde com 1 fetch a /trips/incoming. Sem polling contínuo e sem
// custo de duração (hiberna ocioso). Futuro: shard por cidade no nome do DO.
export class RequestsHub {
  state: any;
  env: any;
  constructor(state: any, env: any) {
    this.state = state;
    this.env = env;
    try { this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch {}
  }
  async fetch(req: any) {
    const u = new URL(req.url);
    if (req.method === 'POST' && u.pathname.endsWith('/broadcast')) {
      try {
        const b: any = await req.json().catch(() => ({}));
        const cats: string[] | null = Array.isArray(b?.cats) && b.cats.length ? b.cats.map((x: any) => String(x)) : null;
        const driverId = String(b?.driverId || '');
        const msg = JSON.stringify({ t: 'refresh', ts: Date.now() });
        for (const s of this.socks()) {
          try {
            const a: any = (s.deserializeAttachment && s.deserializeAttachment()) || {};
            if (driverId && String(a.driverId || '') !== driverId) continue;
            const sc: string[] = Array.isArray(a.cats) ? a.cats : [];
            if (cats && sc.length && !sc.some((c: string) => cats.indexOf(c) >= 0)) continue;
            s.send(msg);
          } catch {}
        }
      } catch {}
      return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
    }
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket')
      return new Response('Expected websocket', { status: 426 });
    const driverId = String(req.headers.get('X-Driver-Id') || '');
    let cats: string[] = [];
    try { cats = JSON.parse(req.headers.get('X-Cats') || '[]'); } catch {}
    const pair: any = new WebSocketPair();
    const client = pair[0], server = pair[1];
    try {
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ driverId, cats });
    } catch {
      return new Response('WS failed', { status: 500 });
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(_ws: any, _raw: any) {}
  async webSocketClose(_ws: any, _code: any, _reason: any, _wasClean: any) {}
  async webSocketError(ws: any, _err: any) { try { ws.close(1011, 'err'); } catch {} }
  socks(): any[] { try { return this.state.getWebSockets(); } catch { return []; } }
}

// ─── DriverGeo: 1 DO global, mapa em memória das posições vivas ───
// Serve /drivers/nearby, buildOfferQueue, webDriverInfo e o polling da viagem.
// Só vive em memória (rede de segurança = próximo ping repõe); TTL 5min na
// leitura. Sem custo de armazenamento e sem escritas D1 por ping.
export class DriverGeo {
  state: any;
  env: any;
  pos: Map<string, any>;
  constructor(state: any, env: any) {
    this.state = state;
    this.env = env;
    this.pos = new Map();
    try { this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch {}
  }
  json(o: any): Response {
    return new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
  }
  // A hibernação do DO limpa a memória. Sem isto, as posições desapareciam
  // quando o objeto ficava ocioso e a passagreira deixava de ver carros.
  loaded = false;
  lastPut: Map<string, number> = new Map();
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const all: any = await this.state.storage.list({ prefix: 'p:' });
      const now = Date.now();
      for (const [k, v] of all) {
        const uid = String(k).slice(2);
        if (!this.pos.has(uid) && v && now - Number(v.ts || 0) <= 18 * 60 * 1000) this.pos.set(uid, v);
      }
    } catch {}
  }
  // Aplica uma atualização de posição vinda de HTTP (/set) ou de mensagem WS.
  setPos(userId: string, lat: number, lng: number, cats: any, online: boolean | null): boolean {
    const prev = this.pos.get(userId) || null;
    const wasOnline = !!prev?.online;
    this.pos.set(userId, {
      userId,
      driverId: prev?.driverId || '',
      lat,
      lng,
      // Categorias só podem mudar com a motorista offline (regra de negócio):
      // com a sessão online, mantém as categorias já em vigor.
      cats: prev && prev.online ? (prev.cats || null) : (cats != null ? cats : (prev?.cats || null)),
      online: online != null ? !!online : !!(prev?.online),
      ts: Date.now(),
    });
    // Persiste no storage (sobrevive à hibernação). Debounce por motorista.
    try {
      const now = Date.now();
      if (now - (this.lastPut.get(userId) || 0) >= 15000) {
        this.lastPut.set(userId, now);
        this.state.storage.put('p:' + userId, this.pos.get(userId)).catch(() => {});
      }
    } catch {}
    return wasOnline;
  }
  // Espelha a transição online/offline da ligação WS na D1, para o filtro
  // "isOnline" do buildOfferQueue e do /trips/incoming ficar correto (a
  // presença por WS não passava pelo /drivers/position).
  async d1Online(userId: string, online: boolean) {
    try {
      const sql = neon(this.env.DB);
      await sql`UPDATE drivers SET "isOnline" = ${online}, "updatedAt" = NOW() WHERE "userId" = ${userId}`;
    } catch {}
  }
  async fetch(req: any): Promise<Response> {
    const u = new URL(req.url);
    const path = u.pathname;
    // GPS ao vivo por WebSocket (0 pedidos HTTP por ping). Hiberna quando ocioso.
    if (path.endsWith('/live')) {
      if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket')
        return new Response('Expected websocket', { status: 426 });
      const userId = String(req.headers.get('X-User-Id') || '');
      const pair: any = new WebSocketPair();
      const client = pair[0], server = pair[1];
      try {
        this.state.acceptWebSocket(server);
        server.serializeAttachment({ userId });
      } catch {
        return new Response('WS failed', { status: 500 });
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    if (req.method === 'POST' && path.endsWith('/set')) {
      const b: any = await req.json().catch(() => ({}));
      const userId = String(b.userId || '');
      if (!userId) return this.json({ wasOnline: false });
      await this.load();
      const wasOnline = this.setPos(userId, Number(b.lat), Number(b.lng), b.cats, b.online != null ? !!b.online : null);
      return this.json({ wasOnline });
    }
    if (req.method === 'POST' && path.endsWith('/del')) {
      const b: any = await req.json().catch(() => ({}));
      const uid = String(b.userId || '');
      this.pos.delete(uid);
      try { this.state.storage.delete('p:' + uid).catch(() => {}); } catch {}
      return this.json({ ok: true });
    }
    if (path.endsWith('/get')) {
      const uid = String(u.searchParams.get('userId') || '');
      await this.load();
      return this.json({ driver: this.pos.get(uid) || null });
    }
    if (path.endsWith('/all')) {
      await this.load();
      const now = Date.now();
      const drivers: any[] = [];
      for (const v of this.pos.values()) {
        if (now - Number(v.ts || 0) <= 18 * 60 * 1000) drivers.push(v);
      }
      return this.json({ drivers });
    }
    return new Response('not found', { status: 404 });
  }
  async webSocketMessage(ws: any, raw: any) {
    const a = (ws.deserializeAttachment && ws.deserializeAttachment()) || {};
    const userId = String(a.userId || '');
    if (!userId) return;
    let m: any = null;
    try { m = JSON.parse(typeof raw === 'string' ? raw : ''); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.offline) {
      this.pos.delete(userId);
      try { this.state.storage.delete('p:' + userId).catch(() => {}); } catch {}
      await this.d1Online(userId, false);
      return;
    }
    const lat = Number(m.lat), lng = Number(m.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const cats = Array.isArray(m.cats) ? m.cats.map((x: any) => String(x).slice(0, 30)).slice(0, 6) : null;
    await this.load();
    const wasOnline = this.setPos(userId, lat, lng, cats, true);
    if (!wasOnline) await this.d1Online(userId, true);
  }
  async webSocketClose(_ws: any, _code: any, _reason: any, _wasClean: any) {
    // Mantém a posição até expirar (TTL na leitura); nova ligação repõe.
  }
  async webSocketError(ws: any, _err: any) { try { ws.close(1011, 'err'); } catch {} }
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
