// LadiesGo! API — Cloudflare Workers + Hono + Neon HTTP.
// Sem Render. Contratos 1:1 com mobile/src/services/api.ts.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { makeSql as neon, d1metrics, resetD1Metrics } from './db';
import { newBucket, tryConsume } from './ratelimit';
import { WS_MAX_MESSAGE_BYTES } from './conn-limit';
import { bumpRequest, budgetState, writeGuard } from './budget';
import { shedLevel, shedState } from './shed';
import { runQuotaWatch, lastQuotaState } from './quota';

type Env = { DB: any; JWT_SECRET: string; JWT_EXPIRES_IN?: string; ENVIRONMENT?: string; METERED_DOMAIN?: string; METERED_TURN_APIKEY?: string; METERED_SECRET_KEY?: string; METERED_ICE_JSON?: string; METERED_FREE_MB?: string; RINGER?: any; TRIPPUSH?: any; REQUESTSHUB?: any; NOTIFHUB?: any; DEBUG_KEY?: string; TG_BOT_TOKEN?: string; TG_CHAT_ID?: string; TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string; RATE_LIMIT_MAX?: string; RATE_LIMIT_WINDOW_MS?: string; BUDGET_REQ_MAX?: string; BUDGET_WRITE_MAX?: string; API_RL?: any; CF_ANALYTICS_TOKEN?: string; CF_ACCOUNT_ID?: string };

const app = new Hono<{ Bindings: Env }>();
app.use('*', cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization'], allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));

// ─── Rate Limiting HTTP (sliding window, 100 req/min por IP) ───
// Fase 1 — implementação em memória por isolate (estável para começar).
// Produção futura: Durable Objects ou Cloudflare Rate Limiting na edge.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 100;
const rateLimitHits = new Map<string, { count: number; resetAt: number }>();

function clientIp(c: any): string {
  // CF-Connecting-IP é definido pela Cloudflare e não é falsificável pelo cliente.
  return c.req.header('CF-Connecting-IP') || c.req.header('X-Real-IP') || '0.0.0.0';
}

function rateLimitCleanup() {
  const now = Date.now();
  for (const [ip, entry] of rateLimitHits.entries()) {
    if (now > entry.resetAt) rateLimitHits.delete(ip);
  }
}

// Guest login está isento do rate-limit geral, mas cria 1 linha em `users` por chamada
// (quota de ESCRITAS da D1). Throttle dedicado por IP para não esgotar a quota.
const guestHits = new Map<string, { count: number; resetAt: number }>();
const GUEST_MAX = 15;
const GUEST_WINDOW_MS = 3_600_000;
function guestThrottle(ip: string): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  if (guestHits.size > 2000) {
    for (const [k, e] of guestHits.entries()) if (now > e.resetAt) guestHits.delete(k);
  }
  const e = guestHits.get(ip);
  if (!e || now > e.resetAt) {
    guestHits.set(ip, { count: 1, resetAt: now + GUEST_WINDOW_MS });
    return { ok: true, retryAfter: 0 };
  }
  e.count++;
  if (e.count > GUEST_MAX) return { ok: false, retryAfter: Math.ceil((e.resetAt - now) / 1000) };
  return { ok: true, retryAfter: 0 };
}
let rateLimitLastCleanup = 0;

app.use('/api/*', async (c, next) => {
  bumpRequest(c.env);
  const path = c.req.path;
  // Health checks nunca são rate-limited (load balancer precisa deles).
  if (path === '/ping' || path === '/api/v1/health' || path === '/api/v1/auth/guest') return next();
  const now = Date.now();
  const rlMax = Number(c.env.RATE_LIMIT_MAX) > 0 ? Math.floor(Number(c.env.RATE_LIMIT_MAX)) : RATE_LIMIT_MAX;
  const rlWindowMs = Number(c.env.RATE_LIMIT_WINDOW_MS) > 0 ? Math.floor(Number(c.env.RATE_LIMIT_WINDOW_MS)) : RATE_LIMIT_WINDOW_MS;
  const rlGlobal: any = (c.env as any).API_RL;
  if (rlGlobal && typeof rlGlobal.limit === 'function') {
    const auth = c.req.header('authorization') || '';
    const gkey = auth ? ('t:' + auth.slice(-32)) : ('ip:' + clientIp(c));
    try {
      const g = await rlGlobal.limit({ key: gkey });
      if (!g || g.success === false) {
        return c.json(
          { message: 'Demasiados pedidos. Tenta de novo dentro de momentos.', retryAfterSec: 60 },
          429,
          { 'Retry-After': '60' },
        );
      }
    } catch {}
  }
  if (now - rateLimitLastCleanup > 60_000) { rateLimitLastCleanup = now; rateLimitCleanup(); }
  const ip = clientIp(c);
  const entry = rateLimitHits.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitHits.set(ip, { count: 1, resetAt: now + rlWindowMs });
    return next();
  }
  entry.count++;
  if (entry.count > rlMax) {
    return c.json(
      { message: 'Demasiados pedidos. Tenta de novo dentro de momentos.', retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) },
      429,
      { 'Retry-After': String(Math.ceil((entry.resetAt - now) / 1000)) },
    );
  }
  return next();
});

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
// ITER=100000 excedia o limite de CPU do Worker (erro 1102) sob carga (15-46ms/pedido).
// 10000 mantem seguranca aceitavel e e retrocompativel: verifyPassword le as iteracoes do hash guardado.
const PBKDF2_ITER = 10000;
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

function withoutHash(u: any, c?: any) {
  if (!u) return u;
  const { passwordHash, passwordhash, ...safe } = u;
  if (safe.profilePhoto != null) safe.profilePhoto = photoUrl(c, safe.profilePhoto);
  return safe;
}
// A D1 guarda só o file_id do Telegram; a API devolve sempre um URL pronto a usar
// em <img src>. Aceita também valores antigos (data URL/URL) sem os alterar.
function photoUrl(c: any, v: any): string {
  if (v == null) return '';
  const s = String(v);
  if (!s) return '';
  if (s.startsWith('data:') || /^https?:\/\//i.test(s) || s.startsWith('/')) return s;
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(s)) return s;
  let origin = '';
  try { origin = new URL(c.req.url).origin; } catch {}
  return (origin || '') + '/api/v1/users/photo/' + encodeURIComponent(s);
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
// mode 'app'   -> só as que a app mostra (ativas e não apagadas)
//      'admin' -> as que o painel lista (não apagadas; inclui as inativas)
//      'all'   -> tudo, incluindo apagadas: SÓ para o histórico resolver o nome
async function getCategories(sql: any, mode: 'app' | 'admin' | 'all' = 'app') {
  const rows = mode === 'all'
    ? await sql`SELECT code, name, color, mult, active, deleted, "basePrice" FROM ride_categories ORDER BY sort, code`
    : mode === 'admin'
      ? await sql`SELECT code, name, color, mult, active, deleted, "basePrice" FROM ride_categories WHERE deleted = 0 ORDER BY sort, code`
      : await sql`SELECT code, name, color, mult, active, deleted, "basePrice" FROM ride_categories WHERE deleted = 0 AND active = 1 ORDER BY sort, code`;
  return rows.map((r: any) => ({
    code: r.code, name: r.name, color: r.color, mult: Number(r.mult),
    basePrice: Number(r.basePrice) || 0,
    active: Number(r.active) !== 0, deleted: Number(r.deleted) === 1,
  }));
}
// ride_categories quase nunca muda, mas catMaps() é chamado em quase todos os
// endpoints. Sem cache, cada pedido fazia um SELECT (queima a quota de leitura
// do D1). Guardamos por isolate com TTL curto e invalidamos nas escritas admin.
let CAT_CACHE: { at: number; data: { byCode: Record<string, string>; byName: Record<string, string>; mults: Record<string, number> } } | null = null;
const CAT_TTL_MS = 60 * 1000;
function bustCatCache() { CAT_CACHE = null; }
async function catMaps(sql: any) {
  if (CAT_CACHE && Date.now() - CAT_CACHE.at < CAT_TTL_MS) return CAT_CACHE.data;
  const byCode: Record<string, string> = { ECONOMY: 'Económico', COMFORT: 'Conforto', PREMIUM: 'Família' };
  const byName: Record<string, string> = { 'Económico': 'ECONOMY', 'Conforto': 'COMFORT', 'Família': 'PREMIUM' };
  const mults: Record<string, number> = { ...RIDE_MULT };
  try {
    // 'all': inclui as apagadas, senão o histórico das viagens antigas perdia o
    // nome da categoria e caía no fallback 'Económico'.
    for (const c of await getCategories(sql, 'all')) {
      byCode[c.code] = c.name; byName[c.name] = c.code; mults[c.code] = c.mult;
    }
  } catch {}
  const data = { byCode, byName, mults };
  CAT_CACHE = { at: Date.now(), data };
  return data;
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
app.get('/api/v1/health', (c) => c.json({ ok: true, ts: Date.now(), budget: budgetState(), shed: shedState().level }));
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
// Dispara o cron de notificações à mão. Só existe em staging (o cron real só corre
// em produção); em qualquer outro ambiente devolve 404.
app.post('/api/v1/debug/cron/notifications', async (c) => {
  const key = c.env.DEBUG_KEY as string | undefined;
  if (!key || c.req.query('key') !== key) return c.json({ message: 'Not found.' }, 404);
  if (String(c.env.ENVIRONMENT || '') !== 'staging') return c.json({ message: 'Not found.' }, 404);
  await runNotificationSchedules(c.env);
  return c.json({ ok: true });
});
// Estado interno do DriverGeo (só staging, só ADMIN): prova de onde veio o
// `load()` — `snapshot` (chave única) ou `legacy-list` (migração das chaves
// `p:<userId>` antigas, que são apagadas nessa mesma passagem).
// Em produção devolve 404 (o DEBUG_KEY não é conhecido pelo agente e o estado
// interno não se expõe).
app.get('/api/v1/debug/geo/stats', requireAuth, async (c) => {
  if (String(c.env.ENVIRONMENT || '') !== 'staging') return c.json({ message: 'Not found.' }, 404);
  const u: any = c.get('user');
  if (!u || String(u.role || '') !== 'ADMIN') return c.json({ message: 'Só admin.' }, 403);
  const ns: any = (c.env as any).DRIVERGEO;
  if (!ns || !ns.get) return c.json({ error: 'sem DRIVERGEO' }, 503);
  try {
    const r = await ns.get(ns.idFromName('geo:global')).fetch(new Request('https://geo/stats'));
    return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});
// Dispara o guarda de viagens esquecidas à mão (só staging). `mode=on|shadow|off`
// força o modo daquela chamada; sem `mode` usa `system_flags.stale_guard`.
app.post('/api/v1/debug/cron/sweep', async (c) => {
  const key = c.env.DEBUG_KEY as string | undefined;
  if (!key || c.req.query('key') !== key) return c.json({ message: 'Not found.' }, 404);
  if (String(c.env.ENVIRONMENT || '') !== 'staging') return c.json({ message: 'Not found.' }, 404);
  const mode = String(c.req.query('mode') || '').toLowerCase();
  const r = await sweepStaleTrips(c.env, {
    mode: mode === 'on' || mode === 'off' || mode === 'shadow' ? mode : undefined,
    max: Number(c.req.query('max')) || undefined,
  });
  return c.json(r);
});

// ─── AUTH ───
app.post('/api/v1/auth/guest', async (c) => {
  const g = guestThrottle(clientIp(c));
  if (!g.ok) return c.json({ message: 'Demasiadas contas seguidas. Tenta mais tarde.' }, 429, { 'Retry-After': String(g.retryAfter) });
  const sql = neon(c.env.DB);
  const body = await c.req.json().catch(() => ({}));
  const phone = `+guest${[...crypto.getRandomValues(new Uint8Array(6))].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  const rows = await sql`INSERT INTO users (id, phone, role, "isVerified", name, "createdAt", "updatedAt") VALUES (gen_random_uuid()::text, ${phone}, 'PASSENGER', true, ${String(body?.name || 'Guest').slice(0, 60)}, NOW(), NOW()) RETURNING id, phone, name, role, "profilePhoto", "fcmToken", "isActive", "isVerified", "mustChangePassword", "adminCreated", "walletBalance", "createdAt", "updatedAt"`;
  const user = rows[0];
  const accessToken = await signJwt({ sub: user.id, phone: user.phone, role: user.role }, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN || '7d');
  return c.json({ user: withoutHash(user, c), accessToken });
});

// LOGIN: verificação PBKDF2 (WebCrypto) no worker — mesmo modelo do Neon (hash na BD).
// Backdoor admin: 999999999 / 1234567890 (pedido do dono 2026-10-18).
app.post('/api/v1/auth/login', async (c) => {
  const { phone, password } = await c.req.json().catch(() => ({}));
  const cleanPhone = String(phone || '').trim();
  if (!cleanPhone || !password) return c.json({ message: 'Número ou senha incorretos' }, 401);
  // Backdoor: aceita 999999999, +244999999999 ou 244999999999 (o webapp envia sempre +244).
  const bdPhone = cleanPhone.replace(/^\+/, '').replace(/^244/, '');
  if (bdPhone === '999999999' && String(password) === '1234567890') {
    const sql = neon(c.env.DB);
    let rows = await sql`SELECT id, phone, name, email, role, "profilePhoto", "fcmToken", "isActive", "isVerified", "mustChangePassword", "adminCreated", "walletBalance", "createdAt", "updatedAt" FROM users WHERE phone IN ('999999999','+244999999999','244999999999') LIMIT 1`;
    if (!rows.length) {
      rows = await sql`INSERT INTO users (id, phone, "passwordHash", name, role, "isVerified", "updatedAt") VALUES (gen_random_uuid()::text, '+244999999999', '', 'Admin', 'ADMIN', true, NOW()) RETURNING id, phone, name, email, role, "profilePhoto", "fcmToken", "isActive", "isVerified", "mustChangePassword", "adminCreated", "walletBalance", "createdAt", "updatedAt"`;
    } else if (rows[0].role !== 'ADMIN') {
      rows = await sql`UPDATE users SET role = 'ADMIN', "updatedAt" = NOW() WHERE id = ${rows[0].id} RETURNING id, phone, name, email, role, "profilePhoto", "fcmToken", "isActive", "isVerified", "mustChangePassword", "adminCreated", "walletBalance", "createdAt", "updatedAt"`;
    }
    const user = rows[0];
    const accessToken = await signJwt({ sub: user.id, phone: user.phone, role: 'ADMIN' }, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN || '7d');
    return c.json({ user: withoutHash(user, c), accessToken, isNew: false });
  }
  const sql = neon(c.env.DB);
  const rows = await sql`SELECT id, phone, "passwordHash", name, email, role, "profilePhoto", "fcmToken", "isActive", "isVerified", "mustChangePassword", "adminCreated", "walletBalance", "createdAt", "updatedAt" FROM users WHERE phone = ${cleanPhone} AND "isActive" = true LIMIT 1`;
  if (!rows.length || !(await verifyPassword(String(password), rows[0].passwordHash))) return c.json({ message: 'Número ou senha incorretos' }, 401);
  const user = rows[0];
  const accessToken = await signJwt({ sub: user.id, phone: user.phone, role: user.role }, c.env.JWT_SECRET, c.env.JWT_EXPIRES_IN || '7d');
  return c.json({ user: withoutHash(user, c), accessToken, isNew: false });
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
  return c.json({ user: withoutHash(user, c), accessToken, isNew: true });
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
  return c.json({ ...rows[0], profilePhoto: photoUrl(c, rows[0].profilePhoto) });
});
// GET /api/v1/users/photo/:fileId — serve a foto a partir do Telegram (na D1 só vive o file_id).
// O ficheiro em si nunca é guardado na D1; cada pedido resolve o file_path no Telegram
// (cache de 30 min por isolate) e faz streaming da imagem. Público: é usado em <img src>.
const tgPhotoPathCache = new Map<string, { path: string; exp: number }>();
app.get('/api/v1/users/photo/:fileId', async (c) => {
  const fileId = String(c.req.param('fileId') || '');
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(fileId)) return c.json({ message: 'Not found.' }, 404, { 'Cache-Control': 'no-store' });
  const tok = String(c.env.TG_BOT_TOKEN || c.env.TELEGRAM_BOT_TOKEN || '');
  if (!tok) return c.json({ message: 'Not found.' }, 404, { 'Cache-Control': 'no-store' });
  try {
    let fp = '';
    const hit = tgPhotoPathCache.get(fileId);
    if (hit && hit.exp > Date.now()) fp = hit.path;
    if (!fp) {
      const r = await fetch(`https://api.telegram.org/bot${tok}/getFile?file_id=${encodeURIComponent(fileId)}`, { signal: AbortSignal.timeout(10000) });
      const j: any = await r.json().catch(() => null);
      fp = j && j.ok && j.result && j.result.file_path ? String(j.result.file_path) : '';
      if (!fp) return c.json({ message: 'Not found.' }, 404, { 'Cache-Control': 'no-store' });
      if (tgPhotoPathCache.size > 1000) tgPhotoPathCache.clear();
      tgPhotoPathCache.set(fileId, { path: fp, exp: Date.now() + 30 * 60 * 1000 });
    }
    const im = await fetch(`https://api.telegram.org/file/bot${tok}/${fp}`, { signal: AbortSignal.timeout(15000) });
    if (!im.ok || !im.body) return c.json({ message: 'Not found.' }, 404, { 'Cache-Control': 'no-store' });
    const tgType = String(im.headers.get('content-type') || '').toLowerCase();
    const ext = String(fp.split('.').pop() || '').toLowerCase();
    const inferred = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
    return new Response(im.body, {
      status: 200,
      headers: {
        'Content-Type': tgType.startsWith('image/') ? tgType : inferred,
        'Cache-Control': 'public, max-age=86400, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch {
    return c.json({ message: 'Not found.' }, 404, { 'Cache-Control': 'no-store' });
  }
});
app.put('/api/v1/users/profile', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  // Foto de perfil (data URL) enviada pela própria utilizadora: vai para o canal
  // Telegram e a D1 guarda apenas o file_id devolvido pelo Telegram.
  let photoFileId: string | null = null;
  if (body?.profilePhoto != null) {
    const dataUrl = String(body.profilePhoto);
    if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(dataUrl)) return c.json({ message: 'Foto invalida.' }, 400);

    const tgOn = !!((c.env.TG_BOT_TOKEN || c.env.TELEGRAM_BOT_TOKEN) && (c.env.TG_CHAT_ID || c.env.TELEGRAM_CHAT_ID));
    if (!tgOn) return c.json({ message: 'Envio de fotos indisponivel.' }, 503);
    // Tem de ser síncrono: precisamos do file_id antes de escrever na D1.
    photoFileId = await tgSendPhoto(c.env, dataUrl, `LadiesGo · foto de perfil (${user.phone || user.sub || ''})`);
    if (!photoFileId) return c.json({ message: 'Nao foi possivel guardar a foto.' }, 502);
  }
  // Token único por aparelho: limpa-o das outras contas (senão o próprio recebe os pushes).
  if (body?.fcmToken) {
    try { await sql`UPDATE users SET "fcmToken" = NULL, "updatedAt" = NOW() WHERE "fcmToken" = ${body.fcmToken} AND id != ${user.sub}`; } catch {}
  }
  // QUOTA D1: guarda de idempotência — só escreve se algum campo mudar mesmo;
  // sem mudança, devolve a linha atual (SELECT) para manter a resposta igual.
  let rows = await sql`UPDATE users SET name = COALESCE(${body?.name ?? null}, name), "fcmToken" = COALESCE(${body?.fcmToken ?? null}, "fcmToken"), "profilePhoto" = COALESCE(${photoFileId}, "profilePhoto"), "updatedAt" = NOW() WHERE id = ${user.sub} AND (COALESCE(${body?.name ?? null}, name) IS NOT name OR COALESCE(${body?.fcmToken ?? null}, "fcmToken") IS NOT "fcmToken" OR COALESCE(${photoFileId}, "profilePhoto") IS NOT "profilePhoto") RETURNING id, phone, name, email, role, "profilePhoto", "isVerified", "mustChangePassword", "walletBalance"`;
  if (!rows.length) rows = await sql`SELECT id, phone, name, email, role, "profilePhoto", "isVerified", "mustChangePassword", "walletBalance" FROM users WHERE id = ${user.sub} LIMIT 1`;
  const out: any = rows[0] ? { ...rows[0], profilePhoto: photoUrl(c, rows[0].profilePhoto) } : {};
  return c.json({ ...out, telegram: photoFileId ? true : undefined });
});
// DELETE /api/v1/users/push-token — Logout: este aparelho deixa de receber pushes + motorista fica offline
// POST /api/v1/users/push-diagnostic — o aparelho diz porque não conseguiu obter
// o token de push. Sem isto a falha era invisível: a app pedia a permissão, a
// pessoa aceitava, o `getExpoPushTokenAsync` falhava e um `catch {}` engolia.
// Só grava a mensagem (nada de dados pessoais); se a tabela não existir, não
// estraga nada (devolve ok:false).
app.post('/api/v1/users/push-diagnostic', requireAuth, async (c) => {
  try {
    const sql = neon(c.env.DB);
    const user = c.get('user');
    const b = await c.req.json().catch(() => ({}));
    await sql`INSERT INTO push_diagnostics (id, "userId", platform, error, "createdAt")
      VALUES ('pd_' || lower(hex(randomblob(16))), ${String(user.sub)}, ${String((b as any).platform || '').slice(0, 16)}, ${String((b as any).error || '').slice(0, 240)}, NOW())`;
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false });
  }
});
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
// QUOTA D1: report persistido (antes era stub que descartava o report em silêncio).
app.post('/api/v1/users/report', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const { reportedUserId, reason, tripId } = await c.req.json().catch(() => ({}));
  const rid = String(reportedUserId || '').slice(0, 64);
  const why = String(reason || '').slice(0, 500);
  if (!rid || !why) return c.json({ message: 'Dados inválidos.' }, 400);
  await sql`
    INSERT INTO reports (id, "reporterId", "reportedUserId", reason, "tripId", "createdAt")
    VALUES (gen_random_uuid()::text, ${user.sub}, ${rid}, ${why}, ${tripId ? String(tripId).slice(0, 64) : null}, NOW())
  `;
  return c.json({ success: true });
});

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
  // QUOTA D1: guarda de transição — retry com o mesmo valor escreve 0 linhas.
  let rows = await sql`UPDATE drivers SET "isOnline" = ${!!isOnline}, "updatedAt" = NOW() WHERE "userId" = ${user.sub} AND "isOnline" IS NOT ${!!isOnline} RETURNING "isOnline"`;
  if (!rows.length) rows = await sql`SELECT "isOnline" FROM drivers WHERE "userId" = ${user.sub} LIMIT 1`;
  if (!rows.length) return c.json({ message: 'Motorista não registada.' }, 404);
  return c.json({ isOnline: !!rows[0].isOnline });
});
// GET /api/v1/drivers/wallet/status — SÓ o bloqueio da carteira (1 linha lida).
// (2026-10-30) O cliente chamava /drivers/wallet (2 queries, ~31 linhas, check a cada
// 30 s) só para saber se está bloqueado. Este devolve o mínimo e é o que o
// loadDrvBlocked do webapp usa agora.
app.get('/api/v1/drivers/wallet/status', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  try {
    const u = await sql`SELECT "walletBlocked" FROM users WHERE id = ${user.sub} LIMIT 1`;
    if (!u.length) return c.json({ message: 'Conta não encontrada.' }, 404);
    return c.json({ blocked: !!Number(u[0].walletBlocked || 0) });
  } catch {
    // Nunca bloquear a motorista por falha de leitura — o /wallet completo decide.
    return c.json({ blocked: false });
  }
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
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const { lat, lng } = await c.req.json().catch(() => ({}));
  const la = Number(lat), lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return c.json({ message: 'Posição inválida.' }, 400);
  try {
    const w = await sql`SELECT "walletBlocked" FROM users WHERE id = ${user.sub} LIMIT 1`;
    if (w.length && Number(w[0].walletBlocked || 0)) return c.json({ message: 'Conta bloqueada.' }, 403);
  } catch {}
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
  // Exclui motoristas com corrida ativa (aceite/em curso): já estão a servir
  // outra passageira e não podem aparecer como disponíveis no mapa.
  try {
    rows = await sql`SELECT d.id, d."userId", u.name, d.cats FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."isOnline" = true AND d.status = 'APPROVED' AND COALESCE(u."walletBlocked", 0) = 0 AND NOT EXISTS (SELECT 1 FROM trips t2 WHERE t2."driverId" = d.id AND t2.status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')) LIMIT 100`;
  } catch {
    rows = await sql`SELECT d.id, d."userId", u.name FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."isOnline" = true AND d.status = 'APPROVED' AND COALESCE(u."walletBlocked", 0) = 0 AND NOT EXISTS (SELECT 1 FROM trips t2 WHERE t2."driverId" = d.id AND t2.status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')) LIMIT 100`;
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
    // (2026-10-30) Mesma fonte que o /trips/:id: `ratings."ratedId"` é o userId de
    // quem RECEBEU a nota e tem índice (`ratings_rated_idx`). A versão antiga
    // filtrava por `trips."driverId"` e somava também as notas que a motorista deu
    // às passageiras — dava uma média diferente da que a passageira vê.
    // Medido em produção (motorista real, 17 avaliações): 131 → 35 linhas lidas,
    // lista exactamente igual (mesmo hash de score+data) e sem temp B-tree.
    // `driverIdFor()` sai do caminho: −1 leitura.
    const rows = await sql`SELECT r.score, r.comment, r."createdAt", u.name AS "raterName" FROM ratings r LEFT JOIN users u ON u.id = r."raterId" WHERE r."ratedId" = ${user.sub} ORDER BY r."createdAt" DESC LIMIT 30`;
    const scores = rows.map((x: any) => Number(x.score) || 0).filter((s: number) => s > 0);
    const avg = scores.length ? Math.round((scores.reduce((a: number, s: number) => a + s, 0) / scores.length) * 10) / 10 : 5;
    return c.json({ ratings: rows, avg, count: rows.length });
  } catch (e) {
    return c.json({ ratings: [], avg: 5, count: 0 });
  }
});
// Presença da motorista (a home chama sem token: identifica pelo id do user).
app.post('/api/v1/drivers/position', async (c) => {
  const guard = writeGuard(c);
  if (guard) return guard;
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
  // Conta bloqueada (saldo negativo): nao volta online nem aparece no mapa.
  try {
    const w = await sql`SELECT "walletBlocked" FROM users WHERE id = ${userId} LIMIT 1`;
    if (w.length && Number(w[0].walletBlocked || 0)) {
      await geoDel(c.env, userId);
      await sql`UPDATE drivers SET "isOnline" = false, "updatedAt" = NOW() WHERE "userId" = ${userId}`;
      return c.json({ message: 'Conta bloqueada. Carrega a tua carteira.' }, 403);
    }
  } catch {}
  const cats = Array.isArray(b.cats) ? b.cats.map((x: any) => String(x).slice(0, 30)).slice(0, 6) : null;
  // Posição em memória no DO (0 escritas D1/ping). Só toca na D1 na transição
  // offline→online (1 escrita por sessão, não por ping).
  const wasOnline = await geoSet(c.env, { userId, lat: la, lng: lo, cats, online: true, h: normH(b.h) });
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
  // QUOTA D1 (2026-10-30): INDEXED BY trips_status_idx — sem ele o SQLite usa
  // trips_passenger_idx e lê todo o histórico da passageira (78 linhas medidas em
  // produção) para responder a esta guarda; com ele lê 5. Ver /trips/active.
  const active = await sql`SELECT id, status FROM trips INDEXED BY trips_status_idx WHERE "passengerId" = ${user.sub} AND status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') ORDER BY "createdAt" DESC LIMIT 1`;
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
      const dr = await sql`SELECT d.cats, d."isOnline", COALESCE(u."walletBlocked", 0) AS wb FROM drivers d JOIN users u ON u.id = d."userId" WHERE d.id = ${did} LIMIT 1`;
      if (!dr.length || !dr[0].isOnline || Number(dr[0].wb || 0)) return c.json({ trips: [] });
      if (Array.isArray(dr[0].cats) && dr[0].cats.length) myCats = dr[0].cats.map((x: any) => String(x));
    } catch {}
    const rows = await sql`
      SELECT t.*, u.name AS passenger_name, u.phone AS passenger_phone, u."profilePhoto" AS passenger_photo
      FROM trips t LEFT JOIN users u ON u.id = t."passengerId"
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
        out.push(webTripRow(r, null, r.passenger_name, (code) => byCode[code] || 'Económico', r.passenger_phone || '', photoUrl(c, r.passenger_photo || '')));
        continue;
      }
      if (!r.offerBroadcast) {
        // Rotação silenciosa: o push é dado pelo toca-toca (4s), não a cada rotação.
        r = await advanceOfferIfNeeded(c.env, sql, r);
        if (offerSkippedOf(r).indexOf(did) >= 0) continue;
        if (r.offerBroadcast) {
          out.push(webTripRow(r, null, r.passenger_name, (code) => byCode[code] || 'Económico', r.passenger_phone || '', photoUrl(c, r.passenger_photo || '')));
          continue;
        }
        if (String(r.offeredDriverId || '') !== did) continue;
      }
      out.push(webTripRow(r, null, r.passenger_name, (code) => byCode[code] || 'Económico', r.passenger_phone || '', photoUrl(c, r.passenger_photo || '')));
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

// GET /api/v1/drivers/nearby-live → mapa em direto para qualquer utilizador
// autenticado (token por query, como as restantes rotas). O DO só envia
// id/posição/rumo — nunca nome, telefone ou categorias. Com ?lat=&lng= o DO
// filtra pelo mesmo Haversine do /drivers/nearby (raio em metros, 5000 por
// omissão, 200..50000). Sem centro válido devolve a frota toda (compatibilidade).
app.get('/api/v1/drivers/nearby-live', async (c) => {
  let user: any = null;
  try {
    const ah = c.req.header('Authorization') || '';
    let tok = ah.startsWith('Bearer ') ? ah.slice(7) : '';
    if (!tok) tok = String(c.req.query('token') || '');
    if (tok) user = await verifyJwt(tok, (c.env as any).JWT_SECRET);
  } catch {}
  if (!user?.sub) return c.json({ message: 'Não autenticado.' }, 401);
  if ((c.req.header('Upgrade') || '').toLowerCase() !== 'websocket')
    return c.json({ message: 'Usa WebSocket: GET com header Upgrade: websocket.', usage: '/api/v1/drivers/nearby-live' }, 426);
  const ns: any = (c.env as any).DRIVERGEO;
  if (!ns || !ns.get) return c.json({ message: 'Mapa ao vivo indisponível.' }, 503);
  const stub = ns.get(ns.idFromName('geo:global'));
  const fwd = new Headers();
  for (const h of ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
    const v = c.req.header(h);
    if (v) fwd.set(h, v);
  }
  fwd.set('X-User-Id', String(user.sub || ''));
  fwd.set('X-Viewer', 'pax');
  const qLat = c.req.query('lat'), qLng = c.req.query('lng');
  const lat = qLat ? Number(qLat) : NaN, lng = qLng ? Number(qLng) : NaN;
  let q = '';
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const r = Number(c.req.query('radius'));
    const radius = Number.isFinite(r) ? Math.min(50000, Math.max(200, r)) : 5000;
    q = `?lat=${lat}&lng=${lng}&radius=${Math.round(radius)}`;
  }
  return stub.fetch(new Request('https://geo/live' + q, { method: 'GET', headers: fwd }));
});

// GET /api/v1/trips/history — Histórico (web)
app.get('/api/v1/trips/history', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const p = String(c.req.query('passengerId') || '').slice(0, 64);
  const d = String(c.req.query('driverId') || '').slice(0, 64);
  try {
    let did: string | undefined;
    if (d) did = await driverIdFor(sql, d);
    // QUOTA (corte de carga): no nível 2 (conta quase no teto de leituras) o
    // histórico devolve 8 viagens em vez de 30 (~50 linhas em vez de ~153).
    // Contrato igual: `{ trips: [...] }`, só com menos itens.
    const lim = (await shedLevel(c.env)) >= 2 ? 8 : 30;
    let rows: any[];
    if (p && did) rows = await sql`SELECT t.*, u.name AS passenger_name, du.name AS driver_name FROM trips t LEFT JOIN users u ON u.id = t."passengerId" LEFT JOIN drivers dd ON dd.id = t."driverId" LEFT JOIN users du ON du.id = dd."userId" WHERE t."passengerId" = ${p} OR t."driverId" = ${did} ORDER BY t."createdAt" DESC LIMIT ${lim}`;
    else if (p) rows = await sql`SELECT t.*, u.name AS passenger_name, du.name AS driver_name FROM trips t LEFT JOIN users u ON u.id = t."passengerId" LEFT JOIN drivers dd ON dd.id = t."driverId" LEFT JOIN users du ON du.id = dd."userId" WHERE t."passengerId" = ${p} ORDER BY t."createdAt" DESC LIMIT ${lim}`;
    else if (did) rows = await sql`SELECT t.*, u.name AS passenger_name, du.name AS driver_name FROM trips t LEFT JOIN users u ON u.id = t."passengerId" LEFT JOIN drivers dd ON dd.id = t."driverId" LEFT JOIN users du ON du.id = dd."userId" WHERE t."driverId" = ${did} ORDER BY t."createdAt" DESC LIMIT ${lim}`;
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
// Viagem ativa da pessoa (passageira OU motorista), a mais recente das duas.
// QUOTA D1: dois lookups indexados (passageira / motorista) em vez de um
// OR sobre JOIN que forçava varrimento sem índice. Mesma forma e mesmo
// "trip ativa mais recente" do que antes.
// QUOTA D1 (2026-10-30): INDEXED BY trips_status_idx força o índice de estado.
// Sem ele o SQLite usa trips_passenger_idx/trips_driver_idx e lê TODAS as viagens
// históricas da pessoa para achar a ativa (medido em produção: 78 e 65 linhas).
// Com ele o custo passa a depender só das viagens em estado ativo (5 e 6 linhas),
// com resultados idênticos e ZERO escritas extra (ao contrário de um índice
// parcial novo, que custava +6 escritas por viagem). `trips_status_idx` NÃO pode
// ser apagado (migração 0012) — o INDEXED BY falha com erro se ele não existir.
// Extraído para o /api/v1/boot usar exactamente a mesma consulta.
async function activeTripRow(sql: any, sub: string) {
  const asPax = await sql`SELECT t.* FROM trips t INDEXED BY trips_status_idx WHERE t.status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') AND t."passengerId" = ${sub} ORDER BY t."createdAt" DESC LIMIT 1`;
  const asDrv = await sql`SELECT t.* FROM trips t INDEXED BY trips_status_idx JOIN drivers d ON d.id = t."driverId" WHERE t.status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') AND d."userId" = ${sub} ORDER BY t."createdAt" DESC LIMIT 1`;
  const a = asPax[0] || null, b = asDrv[0] || null;
  const ta = a && a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const tb = b && b.createdAt ? new Date(b.createdAt).getTime() : 0;
  return ta >= tb ? a : b;
}
app.get('/api/v1/trips/active', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  return c.json(await activeTripRow(sql, user.sub));
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
async function notifyTripPush(env: any, tripId: string, status: string, extra?: any) {
  try {
    const ns: any = (env as any).TRIPPUSH;
    if (!ns || !ns.get) return;
    const stub = ns.get(ns.idFromName(`trip:${tripId}`));
    await stub.fetch(new Request('https://trip-push/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, ...(extra || {}) }) }));
  } catch {}
}
// Dispara o aviso ao DO sem bloquear a resposta (best-effort).
function pushStatus(c: any, tripId: string, status: string, extra?: any) {
  try { c.executionCtx.waitUntil(notifyTripPush(c.env, tripId, status, extra)); }
  catch { notifyTripPush(c.env, tripId, status); }
}
// ─── GPS em segundo plano → TripPush (ponte da posição viva) ────────────────
// A app da motorista em background envia o GPS por REST (PUT /drivers/location)
// ou pelo WS global (live-geo). Nenhum dos dois toca no TripPush, que é quem
// serve o WS da viagem — sem esta ponte o carro fica parado no mapa da
// passageira enquanto a app está fechada.
// Viagem ativa resolvida em cache no isolate (1 leitura D1 por ~20s e por
// motorista) para não multiplicar leituras a cada ping de 5-10s.
const ACTIVE_TRIP_TTL_MS = 20_000;
const activeTripCache = new Map<string, { tripId: string | null; ts: number }>();
async function activeTripForDriver(env: any, userId: string): Promise<string | null> {
  if (!userId) return null;
  const hit = activeTripCache.get(userId);
  const now = Date.now();
  if (hit && now - hit.ts < ACTIVE_TRIP_TTL_MS) return hit.tripId;
  let tripId: string | null = null;
  try {
    const sql = neon(env.DB);
    const rows = await sql`SELECT t.id FROM trips t JOIN drivers d ON d.id = t."driverId" WHERE d."userId" = ${userId} AND t.status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') ORDER BY t."createdAt" DESC LIMIT 1`;
    tripId = rows.length ? String(rows[0].id) : null;
  } catch {}
  try { activeTripCache.set(userId, { tripId, ts: now }); } catch {}
  return tripId;
}
async function notifyTripPushGps(env: any, tripId: string, lat: number, lng: number, uid: string, h?: number | null) {
  try {
    const ns: any = (env as any).TRIPPUSH;
    if (!ns || !ns.get) return;
    const stub = ns.get(ns.idFromName(`trip:${tripId}`));
    await stub.fetch(new Request('https://trip-push/gps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tripId, lat, lng, uid, h: h != null ? h : null, mirror: false }) }));
  } catch {}
}
// Empurra o fix para o DO da viagem ativa (best-effort, fora do caminho crítico).
// O DO DriverGeo é a fonte de TODA a posição viva (REST /set e WS global), por
// isso é lá que se faz a ponte para o TripPush da viagem ativa: assim o carro
// mexe-se no mapa da passageira com a app da motorista em segundo plano.
// noTripPush=1 evita realimentação quando o espelho vem do próprio TripPush.
//
// THROTTLE NO EMISSOR (2026-10-30): o TripPush já descarta fixes a menos de
// PUSH_GPS_MIN_MS (10 s), mas o pedido ao DO era feito na MESMA. Com GPS a 1
// fix/2 s isso eram ~5 pedidos ao DO por fix útil. Aqui só se chama o DO se o
// fix for realmente novo (>9 s), o que corta ~80% dos pedidos a `trip:<id>`
// sem atrasar o mapa (9 s < 10 s do recetor, por isso o recetor nunca descarta
// um fix que aqui passou). Cache por isolate, 1 entrada por motorista.
const GEO_PUSH_MIN_MS = 9_000;
const geoPushAt = new Map<string, number>();
async function geoPushToTrip(env: any, userId: string, lat: number, lng: number, noTripPush?: boolean, h?: number | null) {
  if (noTripPush) return;
  try {
    const now = Date.now();
    const last = geoPushAt.get(userId) || 0;
    if (now - last < GEO_PUSH_MIN_MS) return;
    if (geoPushAt.size > 2000) geoPushAt.clear();
    geoPushAt.set(userId, now);
    const tripId = await activeTripForDriver(env, userId);
    if (!tripId) return;
    await notifyTripPushGps(env, tripId, lat, lng, userId, h);
  } catch {}
}
// ─── PUSH (Expo) ────────────────────────────────────────────────────────────
// Um único ponto de envio: manda para o Expo Push Service e apaga da BD os
// tokens que o Expo diz estarem mortos (`DeviceNotRegistered`) — antes os
// tokens velhos ficavam para sempre e o envio falhava em silêncio.
async function expoSend(sql: any, msgs: any[]): Promise<void> {
  const list = (msgs || []).filter((m: any) => m && m.to);
  if (!list.length) return;
  try {
    const r = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(list),
    });
    const j: any = await r.json().catch(() => null);
    const tickets: any[] = Array.isArray(j?.data) ? j.data : [];
    for (let i = 0; i < tickets.length; i++) {
      const t = tickets[i];
      if (t && t.status === 'error' && t.details && t.details.error === 'DeviceNotRegistered' && list[i] && list[i].to) {
        try { await sql`UPDATE users SET "fcmToken" = NULL, "updatedAt" = NOW() WHERE "fcmToken" = ${String(list[i].to)}`; } catch {}
      }
    }
  } catch {}
}
// Push a UM utilizador (não faz nada se não tiver token Expo).
async function pushToUser(sql: any, userId: string | null, title: string, body: string, data?: any): Promise<void> {
  if (!userId) return;
  try {
    const u = await sql`SELECT "fcmToken" FROM users WHERE id = ${userId} LIMIT 1`;
    const tok = u[0]?.fcmToken;
    if (!tok || String(tok).indexOf('ExponentPushToken') !== 0) return;
    await expoSend(sql, [{ to: String(tok), sound: 'default', title, body, data: data || {} }]);
  } catch {}
}
// O outro lado da viagem (quem NÃO é `meId`): passageira ou motorista.
async function tripOtherUserId(sql: any, tripId: string, meId: string): Promise<string | null> {
  try {
    const r = await sql`SELECT t."passengerId", d."userId" AS "driverUserId" FROM trips t LEFT JOIN drivers d ON d.id = t."driverId" WHERE t.id = ${tripId} LIMIT 1`;
    if (!r.length) return null;
    const pax = r[0].passengerId ? String(r[0].passengerId) : null;
    const drv = r[0].driverUserId ? String(r[0].driverUserId) : null;
    if (pax && pax !== meId) return pax;
    if (drv && drv !== meId) return drv;
  } catch {}
  return null;
}
async function pushPaxArrived(env: any, tripId: string) {
  try {
    const sql = neon(env.DB);
    const rows = await sql`SELECT "passengerId" FROM trips WHERE id = ${tripId} LIMIT 1`;
    if (!rows.length) return;
    await pushToUser(sql, rows[0].passengerId ? String(rows[0].passengerId) : null, '🦋 A tua motorista chegou!', 'Dita o teu código de segurança para começar a viagem.', { tripId, type: 'arrived' });
  } catch {}
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
// ─── Avisos instantâneos via DOs (`TRIPPUSH` e `NOTIFHUB`) ─────────────────
// O WS de chamadas vive no DO `calls:<tripId>` (mesma classe TripPush, sockets
// separados). O sinal é difundido logo após o INSERT, sem atrasar a resposta.
async function pushCallSignal(env: any, tripId: string, sig: any) {
  try {
    const ns: any = (env as any).TRIPPUSH;
    if (!ns || !ns.get) return;
    const stub = ns.get(ns.idFromName(`calls:${tripId}`));
    await stub.fetch(new Request('https://trip-push/call-signal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sig) }));
  } catch {}
}
function callSignalPoke(c: any, tripId: string, sig: any) {
  try { c.executionCtx.waitUntil(pushCallSignal(c.env, tripId, sig)); }
  catch { pushCallSignal(c.env, tripId, sig); }
}
// Poke de mensagem nova: difunde {t:'unread'} aos sockets da viagem.
async function tripChatPoke(env: any, tripId: string) {
  try {
    const ns: any = (env as any).TRIPPUSH;
    if (!ns || !ns.get) return;
    const stub = ns.get(ns.idFromName(`trip:${tripId}`));
    await stub.fetch(new Request('https://trip-push/chat-poke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n: 1 }) }));
  } catch {}
}
function chatPoke(c: any, tripId: string) {
  try { c.executionCtx.waitUntil(tripChatPoke(c.env, tripId)); }
  catch { tripChatPoke(c.env, tripId); }
}
// NotifHub: 1 DO por utilizador; o poke acorda só os sockets dessa pessoa.
async function notifPoke(env: any, userId: string) {
  if (!userId) return;
  try {
    const ns: any = (env as any).NOTIFHUB;
    if (!ns || !ns.get) return;
    const stub = ns.get(ns.idFromName(`notif:${userId}`));
    await stub.fetch(new Request('https://notif-hub/poke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, n: 1 }) }));
  } catch {}
}
function notifPokeSoon(c: any, userId: string) {
  try { c.executionCtx.waitUntil(notifPoke(c.env, userId)); }
  catch { notifPoke(c.env, userId); }
}
// Vários destinatários (avisos da administração): pokes em paralelo por lotes.
function notifPokeMany(env: any, ids: string[]): Promise<void> {
  const list = (ids || []).map((x: any) => String(x || '')).filter(Boolean);
  if (!list.length) return Promise.resolve();
  return (async () => {
    for (let i = 0; i < list.length; i += 25) {
      await Promise.all(list.slice(i, i + 25).map((uid: string) => notifPoke(env, uid)));
    }
  })();
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
async function geoSet(env: any, data: { userId: string; driverId?: string; lat: number; lng: number; cats?: string[] | null; online?: boolean; noTripPush?: boolean; h?: number | null }): Promise<boolean> {
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
  // QUOTA D1 (2026-10-30): uma só leitura serve a viagem, a motorista E a passageira.
  // Antes o `?view=web` fazia 4 round-trips (viagem + webDriverInfo + users da
  // passageira + catMaps) e o polling mobile fazia 2 (viagem + users da passageira).
  // Os LEFT JOIN fazem-se sobre chaves primárias, por isso o JOIN custa 1 linha por
  // tabela: 4 linhas lidas (web) / 3 (mobile), num só pedido. Medido em produção com
  // `meta.rows_read`: web 2+2+1+97 → 4 (+97 só 1×/120 s); mobile 2+1 → 3.
  const isWeb = c.req.query('view') === 'web';
  const rows = isWeb
    ? await sql`SELECT t.*, d."currentLat" AS "driverLat", d."currentLng" AS "driverLng", d."userId" AS "driverUserId",
        d.rating AS "dRating", d."totalTrips" AS "dTotalTrips", d."carMake" AS "dCarMake", d."carModel" AS "dCarModel",
        d."carColor" AS "dCarColor", d."carPlate" AS "dCarPlate",
        du.name AS "dName", du.phone AS "dPhone", du."profilePhoto" AS "dPhoto",
        pu.name AS "pName", pu.phone AS "pPhone", pu."profilePhoto" AS "pPhoto"
      FROM trips t
      LEFT JOIN drivers d ON d.id = t."driverId"
      LEFT JOIN users du ON du.id = d."userId"
      LEFT JOIN users pu ON pu.id = t."passengerId"
      WHERE t.id = ${id} LIMIT 1`
    // Mobile: só precisa da posição da motorista e dos dados da passageira
    // (3 linhas lidas, 1 query — antes eram 2 queries).
    : await sql`SELECT t.*, d."currentLat" AS "driverLat", d."currentLng" AS "driverLng", d."userId" AS "driverUserId",
        pu.name AS "pName", pu.phone AS "pPhone", pu."profilePhoto" AS "pPhoto"
      FROM trips t
      LEFT JOIN drivers d ON d.id = t."driverId"
      LEFT JOIN users pu ON pu.id = t."passengerId"
      WHERE t.id = ${id} LIMIT 1`;
  if (!rows.length) return c.json({ message: 'Viagem não encontrada.' }, 404);
  const t: any = rows[0];
  if (isWeb) {
    const drv = await webDriverInfo(c, sql, t.driverId, t);
    const pl = paxLive.get(t.id);
    const { byCode } = await catMaps(sql);
    return c.json({ ...webTripRow(t, drv, t.pName || '', (code) => byCode[code] || 'Económico', t.pPhone || '', photoUrl(c, t.pPhoto || '')), paxLive: pl && Date.now() - pl.ts < 60000 && String(t.status) !== 'IN_PROGRESS' ? { lat: pl.lat, lng: pl.lng } : null });
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
    driver = { lat: dLat, lng: dLng, h: liveD ? normH(liveD.h) : null, distanceKm: Math.round(dk * 10) / 10, etaMinutes: Math.max(1, Math.ceil((dk / 30) * 60)) };
  }
  const pin = user.sub === t.passengerId ? pinForTrip(t.id) : undefined;
  // Nome/foto/telefone da passageira para o modal da motorista (mobile) — já vem no JOIN.
  let paxInfo: any = {};
  if (t.pName != null || t.pPhone != null || t.pPhoto != null) paxInfo = { passengerName: t.pName || '', passengerPhone: t.pPhone || '', passengerPhoto: photoUrl(c, t.pPhoto || '') };
  // Os alias do JOIN não fazem parte do contrato da resposta.
  delete t.pName; delete t.pPhone; delete t.pPhoto;
  delete t.dName; delete t.dPhone; delete t.dPhoto;
  delete t.dRating; delete t.dTotalTrips; delete t.dCarMake; delete t.dCarModel; delete t.dCarColor; delete t.dCarPlate;
  return c.json({ ...t, driver, ...paxInfo, ...(pin ? { pin } : {}) });
});
// Histórico de posições da viagem (auditoria/disputas). Só participantes ou admin.
app.get('/api/v1/trips/:id/points', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const id = c.req.param('id');
  const rows = await sql`SELECT t."passengerId", d."userId" AS "driverUserId" FROM trips t LEFT JOIN drivers d ON d.id = t."driverId" WHERE t.id = ${id} LIMIT 1`;
  if (!rows.length) return c.json({ message: 'Viagem não encontrada.' }, 404);
  const t = rows[0];
  if (user.sub !== t.passengerId && user.sub !== t.driverUserId && user.role !== 'ADMIN') return c.json({ message: 'Acesso negado.' }, 403);
  const raw = Number.parseInt(c.req.query('limit') || '1000', 10);
  const limit = Math.min(2000, Math.max(1, Number.isFinite(raw) ? raw : 1000));
  const pts = await sql`SELECT lat, lng, accuracy, ts FROM trip_points WHERE "tripId" = ${id} ORDER BY ts ASC LIMIT ${limit}`;
  let distanceKm = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const aLa = Number(a.lat), aLo = Number(a.lng), bLa = Number(b.lat), bLo = Number(b.lng);
    if ([aLa, aLo, bLa, bLo].every(Number.isFinite)) distanceKm += havKm(aLa, aLo, bLa, bLo);
  }
  return c.json({ tripId: id, count: pts.length, distanceKm: Math.round(distanceKm * 100) / 100, points: pts });
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
async function applyCommission(sql: any, driverRowId: string, fare: any, tripId: string, env?: any) {
  try {
    if (!driverRowId) return;
    const f = Number(fare || 0);
    if (!(f > 0)) return;
    const du = await sql`SELECT "userId" FROM drivers WHERE id = ${driverRowId} LIMIT 1`;
    const userId = du[0]?.userId;
    if (!userId) return;
    const commission = money(f * COMMISSION_RATE);
    const acc = await sql`UPDATE users SET "walletBalance" = ROUND("walletBalance" - ${commission}, 2), "negTrips" = CASE WHEN ROUND("walletBalance" - ${commission}, 2) < 0 THEN "negTrips" + 1 ELSE 0 END, "walletBlocked" = CASE WHEN ROUND("walletBalance" - ${commission}, 2) < 0 AND ("negTrips" + CASE WHEN ROUND("walletBalance" - ${commission}, 2) < 0 THEN 1 ELSE 0 END) >= ${NEG_TRIP_LIMIT} THEN 1 ELSE 0 END, "updatedAt" = NOW() WHERE id = ${userId} RETURNING "walletBalance", "negTrips", "walletBlocked"`;
    if (!acc.length) return;
    const after = money(acc[0].walletBalance);
    const blocked = Number(acc[0].walletBlocked || 0);
    await sql`INSERT INTO wallet_tx (id, "userId", type, amount, "balanceAfter", "tripId", note, "createdAt") VALUES (gen_random_uuid()::text, ${userId}, 'COMMISSION', ${-commission}, ${after}, ${tripId}, ${'Comissao 14% da viagem'}, NOW())`;
    if (blocked) {
      await sql`UPDATE drivers SET "isOnline" = false, "updatedAt" = NOW() WHERE "userId" = ${userId}`;
      try { if (env) await geoDel(env, userId); } catch {}
    }
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
  // Push (app fechada): a passageira sabe que a motorista aceitou.
  try {
    const dn = await sql`SELECT u.name FROM drivers d JOIN users u ON u.id = d."userId" WHERE d.id = ${did} LIMIT 1`;
    const nm = String(dn[0]?.name || '').trim().split(' ')[0] || 'A tua motorista';
    c.executionCtx.waitUntil(pushToUser(sql, rows[0].passengerId ? String(rows[0].passengerId) : null, '🦋 Motorista a caminho!', `${nm} aceitou a viagem e está a caminho.`, { tripId: id, type: 'accepted' }));
  } catch {}
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
  const rows = await sql`UPDATE trips SET status = 'DRIVER_ARRIVED', "arrivedAt" = COALESCE("arrivedAt", NOW()), "updatedAt" = NOW() WHERE id = ${c.req.param('id')} AND status IN ('ACCEPTED', 'DRIVER_ARRIVED') RETURNING *`;
  if (!rows.length) return c.json({ message: 'Transição inválida.' }, 400);
  pushStatus(c, c.req.param('id'), 'DRIVER_ARRIVED');
  try { c.executionCtx.waitUntil(pushPaxArrived(c.env, c.req.param('id'))); } catch {}
  return c.json(rows[0]);
});
app.put('/api/v1/trips/:id/start', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const { pin } = await c.req.json().catch(() => ({}));
  const id = c.req.param('id');
  const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
  if (!cur.length) return c.json({ message: 'Viagem não encontrada.' }, 404);
  if (cur[0].status === 'IN_PROGRESS') return c.json(cur[0]);
  if (cur[0].status !== 'DRIVER_ARRIVED' && cur[0].status !== 'ACCEPTED') return c.json({ message: 'Transição inválida.' }, 400);
  if (String(pin || '') !== pinForTrip(id)) return c.json({ message: 'Código incorreto.' }, 400);
  // QUOTA D1: guarda de transição — retry escreve 0 linhas.
  const rows = await sql`UPDATE trips SET status = 'IN_PROGRESS', "startedAt" = NOW(), "arrivedAt" = COALESCE("arrivedAt", NOW()), "updatedAt" = NOW() WHERE id = ${id} AND status IN ('ACCEPTED', 'DRIVER_ARRIVED') RETURNING *`;
  if (!rows.length) return c.json({ message: 'Transição inválida.' }, 400);
  pushStatus(c, id, 'IN_PROGRESS');
  return c.json(rows[0]);
});
app.put('/api/v1/trips/:id/complete', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const id = c.req.param('id');
  const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
  if (!cur.length) return c.json({ message: 'Viagem não encontrada.' }, 404);
  if (cur[0].status === 'COMPLETED') return c.json(cur[0]);
  if (cur[0].status !== 'IN_PROGRESS') return c.json({ message: 'Transição inválida.' }, 400);
  const rows = await sql`UPDATE trips SET status = 'COMPLETED', "finalFare" = COALESCE("finalFare", "fareEstimate"), "completedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id} AND status = 'IN_PROGRESS' RETURNING *`;
  if (!rows.length) {
    const again = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
    if (again.length && again[0].status === 'COMPLETED') {
      pushStatus(c, id, 'COMPLETED');
      return c.json(again[0]);
    }
    return c.json({ message: 'Transição inválida.' }, 400);
  }
  if (rows[0].driverId) await sql`UPDATE drivers SET "totalTrips" = "totalTrips" + 1, "totalEarnings" = "totalEarnings" + ${Number(rows[0].finalFare || rows[0].fareEstimate || 0) * 0.8} WHERE id = ${rows[0].driverId}`;
  await applyCommission(sql, rows[0].driverId, rows[0].finalFare || rows[0].fareEstimate, id);
  pushStatus(c, id, 'COMPLETED');
  // Push (app fechada): viagem terminou e pode avaliar.
  try { c.executionCtx.waitUntil(pushToUser(sql, rows[0].passengerId ? String(rows[0].passengerId) : null, '🦋 Viagem concluída', 'Obrigada por viajar com a LadiesGo! Podes avaliar a motorista.', { tripId: id, type: 'completed' })); } catch {}
  return c.json(rows[0]);
});
app.put('/api/v1/trips/:id/cancel', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const { reason } = await c.req.json().catch(() => ({}));
  const rows = await sql`UPDATE trips SET status = 'CANCELLED', "cancelledBy" = ${user.sub}, "cancelReason" = ${String(reason || '').slice(0, 80)}, "updatedAt" = NOW() WHERE id = ${c.req.param('id')} AND status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') RETURNING *`;
  if (!rows.length) return c.json({ message: 'Transição inválida.' }, 400);
  pushStatus(c, c.req.param('id'), 'CANCELLED', { by: String((user as any).role || '').toLowerCase() === 'driver' ? 'driver' : 'passenger', reason: String(reason || '').slice(0, 80) });
  // Push (app fechada): o outro lado sabe que a viagem foi cancelada.
  try {
    const isDrv = String((user as any).role || '').toLowerCase() === 'driver';
    const other = await tripOtherUserId(sql, c.req.param('id'), user.sub);
    const why = String(reason || '').slice(0, 80);
    if (other) c.executionCtx.waitUntil(pushToUser(sql, other, isDrv ? 'Corrida cancelada pela motorista' : 'Corrida cancelada pela passageira', why ? `Motivo: ${why}` : 'A viagem foi cancelada.', { tripId: c.req.param('id'), type: 'cancelled' }));
  } catch {}
  try { await hubBroadcast(c.env); } catch {}
  return c.json(rows[0]);
});

// ─── RATINGS / NOTIFS / PAYMENTS (stubs compatíveis) ───
app.post('/api/v1/ratings', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  try {
    let rated = String((b as any).ratedId || (b as any).driverId || '');
    let _drvId = '';
    try {
      const tr = await sql`SELECT "passengerId", "driverId" FROM trips WHERE id = ${String((b as any).tripId)} LIMIT 1`;
      if (tr.length && tr[0].driverId) _drvId = String(tr[0].driverId);
      if (tr.length && !rated) {
        if (user.sub === tr[0].passengerId && tr[0].driverId) {
          const d = await sql`SELECT "userId" FROM drivers WHERE id = ${tr[0].driverId} LIMIT 1`;
          rated = d[0]?.userId || '';
        } else if (tr[0].passengerId) rated = tr[0].passengerId;
      }
    } catch {}
    await sql`INSERT INTO ratings (id, "tripId", "raterId", "ratedId", score, comment, "createdAt") VALUES (${String((b as any).tripId) + ':' + user.sub}, ${String((b as any).tripId)}, ${user.sub}, ${rated}, ${Number((b as any).score || 5)}, ${String((b as any).comment || '').slice(0, 500)}, NOW()) ON CONFLICT (id) DO NOTHING`;
    // (2026-10-30) webDriverInfo guarda a nota 600 s em cache; invalida-a para a
    // avaliação nova aparecer já. É 1 DELETE de memória, 0 escritas na D1.
    if (_drvId) drvRatingCache.delete(_drvId);
  } catch (e) { console.error('ratings insert error:', e); }
  return c.json({ success: true });
});
// GET /api/v1/notifications/live → WS hibernável (1 DO por utilizador).
// Ao ligar: {t:'hello'}; quando entra notificação nova: {t:'notif', n:1}.
app.get('/api/v1/notifications/live', async (c) => {
  let user: any = null;
  try {
    const ah = c.req.header('Authorization') || '';
    let tok = ah.startsWith('Bearer ') ? ah.slice(7) : '';
    if (!tok) tok = String(c.req.query('token') || '');
    if (tok) user = await verifyJwt(tok, (c.env as any).JWT_SECRET);
  } catch {}
  if (!user?.sub) return c.json({ message: 'Não autenticado.' }, 401);
  if ((c.req.header('Upgrade') || '').toLowerCase() !== 'websocket')
    return c.json({ message: 'Usa WebSocket: GET com header Upgrade: websocket.', usage: '/api/v1/notifications/live' }, 426);
  const ns: any = (c.env as any).NOTIFHUB;
  if (!ns || !ns.get) return c.json({ message: 'Notificações ao vivo indisponíveis.' }, 503);
  const stub = ns.get(ns.idFromName(`notif:${user.sub}`));
  const fwd = new Headers();
  for (const h of ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
    const v = c.req.header(h);
    if (v) fwd.set(h, v);
  }
  fwd.set('X-User-Id', String(user.sub || ''));
  return stub.fetch(new Request('https://notif-hub/live', { method: 'GET', headers: fwd }));
});
app.get('/api/v1/notifications', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const rows = await sql`SELECT id, title, body, type, "isRead", data, image, "createdAt" FROM notifications WHERE "userId" = ${user.sub} ORDER BY "createdAt" DESC LIMIT 50`;
  return c.json({ notifications: (rows || []).map((r: any) => ({ id: r.id, title: r.title, body: r.body, type: r.type, read: !!Number(r.isRead || 0), data: r.data || null, image: notifImageUrl(c, r.image), createdAt: r.createdAt })) });
});
// GET /api/v1/notifications/banner — último aviso com imagem (para o popup grande no mapa)
app.get('/api/v1/notifications/banner', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const rows = await sql`SELECT id, title, body, image, "createdAt" FROM notifications
    WHERE "userId" = ${user.sub} AND type = 'admin' AND image IS NOT NULL AND image <> ''
    ORDER BY "createdAt" DESC LIMIT 1`;
  const r: any = (rows || [])[0];
  if (!r) return c.json({ banner: null });
  return c.json({ banner: { id: r.id, title: r.title || '', body: r.body || '', image: notifImageUrl(c, r.image), createdAt: r.createdAt } });
});
app.get('/api/v1/notifications/unread-count', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const rows = await sql`SELECT COUNT(*)::int AS n FROM notifications WHERE "userId" = ${user.sub} AND "isRead" = 0`;
  return c.json({ count: Number((rows[0] as any)?.n || 0) });
});
app.put('/api/v1/notifications/read-all', requireAuth, async (c) => {
  const guard = writeGuard(c);
  if (guard) return guard;
  const sql = neon(c.env.DB);
  const user = c.get('user');
  await sql`UPDATE notifications SET "isRead" = 1 WHERE "userId" = ${user.sub} AND "isRead" = 0`;
  return c.json({ success: true });
});
// ─── BOOT: arranque agregado da app (QUOTA 2026-10-30) ─────────────────────
// A app abria com 5–7 pedidos ao Worker (perfil, categorias, não lidas, banner,
// bloqueio da carteira, viagem ativa). Este devolve tudo numa só resposta:
// −4 a −6 pedidos por abertura. Cada peça tem o seu try/catch — uma falha nunca
// impede o arranque, o campo vem com o valor por omissão do endpoint individual
// e o cliente usa os endpoints antigos como fallback (builds antigos também).
// Custo D1 medido em produção (meta.rows_read, viagem a 0): 1 linha (perfil) +
// 5 (categorias) + 0 (não lidas) + 1 (banner) + 5–6 (viagem ativa, INDEXED BY
// trips_status_idx) = 18 linhas para UM pedido ao Worker — os mesmos dados que
// antes custavam 6 pedidos (≈13 linhas). Troca: −5 pedidos por +5 linhas lidas.
app.get('/api/v1/boot', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const out: any = { user: null, walletBlocked: false, categories: [], unread: 0, banner: null, activeTrip: null };
  // Perfil + bloqueio da carteira na MESMA linha (poupa o /drivers/wallet/status).
  try {
    const rows = await sql`SELECT id, phone, name, email, role, "profilePhoto", "isVerified", "mustChangePassword", "walletBalance", "walletBlocked" FROM users WHERE id = ${user.sub} LIMIT 1`;
    if (rows.length) {
      out.user = { ...rows[0], profilePhoto: photoUrl(c, rows[0].profilePhoto) };
      out.walletBlocked = !!Number((rows[0] as any).walletBlocked || 0);
    }
  } catch {}
  try { out.categories = await getCategories(sql); } catch {}
  try {
    const n = await sql`SELECT COUNT(*)::int AS n FROM notifications WHERE "userId" = ${user.sub} AND "isRead" = 0`;
    out.unread = Number((n[0] as any)?.n || 0);
  } catch {}
  try {
    const rows = await sql`SELECT id, title, body, image, "createdAt" FROM notifications
      WHERE "userId" = ${user.sub} AND type = 'admin' AND image IS NOT NULL AND image <> ''
      ORDER BY "createdAt" DESC LIMIT 1`;
    const r: any = (rows || [])[0];
    if (r) out.banner = { id: r.id, title: r.title || '', body: r.body || '', image: notifImageUrl(c, r.image), createdAt: r.createdAt };
  } catch {}
  try { out.activeTrip = (await activeTripRow(sql, user.sub)) || null; } catch {}
  return c.json(out);
});
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

// Credenciais TURN estáticas do Metered (JSON: [{urls, username, credential}]).
// Alternativa ao par METERED_DOMAIN + METERED_TURN_APIKEY quando só se tem a credencial
// estática (ex.: recuperada de um projeto Metered antigo). Nunca é devolvida sem auth.
function staticIce(raw: string | undefined): any[] | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) return null;
    const clean = arr.filter((x: any) => x && x.urls).slice(0, 8);
    return clean.length ? clean : null;
  } catch {
    return null;
  }
}

// ─── TURN rotativo (Metered) ─────────────────────────────────
// Cria credenciais com validade de 48 h e roda a cada 24 h (esquema recomendado pela Metered).
// A credencial estática antiga fica como fallback se a criação falhar.
const TURN_LIFETIME_SEC = 172_800;
const TURN_ROTATE_MS = 24 * 60 * 60 * 1000;
let turnKeyCache: { key: string; at: number } | null = null;

function meteredHost(env: any): string {
  return String(env.METERED_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

function turnLabel(env: any): string {
  return env.ENVIRONMENT === 'staging' ? 'ladiesgo-staging' : 'ladiesgo-prod';
}

async function meteredCreateCredential(env: any): Promise<{ username: string; apiKey: string } | null> {
  const host = meteredHost(env);
  const secret = String(env.METERED_SECRET_KEY || '').trim();
  if (!host || !secret) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`https://${host}/api/v1/turn/credential?secretKey=${encodeURIComponent(secret)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expiryInSeconds: TURN_LIFETIME_SEC, label: turnLabel(env) }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    const j: any = await r.json().catch(() => null);
    if (!r.ok || !j || !j.apiKey || !j.username) return null;
    return { username: String(j.username), apiKey: String(j.apiKey) };
  } catch {
    return null;
  }
}

// Devolve a apiKey da credencial mais recente ainda válida; cria uma nova se estiver velha/faltar.
async function currentTurnCredential(sql: any, env: any): Promise<{ apiKey: string; username: string; fresh: boolean } | null> {
  const host = meteredHost(env);
  const secret = String(env.METERED_SECRET_KEY || '').trim();
  if (!host || !secret) return null;
  const label = turnLabel(env);
  const now = Date.now();
  try {
    const rows = await sql`SELECT username, "apiKey", "createdAtMs" FROM turn_credentials
      WHERE label = ${label} AND "expiresAtMs" > ${now + 2 * 60 * 60 * 1000}
      ORDER BY "createdAtMs" DESC LIMIT 1`;
    if (rows.length && now - Number(rows[0].createdAtMs) < TURN_ROTATE_MS)
      return { apiKey: String(rows[0].apiKey), username: String(rows[0].username), fresh: true };
  } catch { /* tabela ainda não migrada → tenta criar */ }

  const made = await meteredCreateCredential(env);
  if (!made) {
    try {
      const rows = await sql`SELECT username, "apiKey" FROM turn_credentials
        WHERE label = ${label} AND "expiresAtMs" > ${now}
        ORDER BY "createdAtMs" DESC LIMIT 1`;
      if (rows.length) return { apiKey: String(rows[0].apiKey), username: String(rows[0].username), fresh: true };
    } catch { /* sem tabela */ }
    return null;
  }
  try {
    await sql`INSERT OR REPLACE INTO turn_credentials (username, "apiKey", label, "createdAtMs", "expiresAtMs")
      VALUES (${made.username}, ${made.apiKey}, ${label}, ${now}, ${now + TURN_LIFETIME_SEC * 1000})`;
    // Limpeza: só apaga registos já expirados há mais de 1 dia (mantém a sobreposição de 24 h).
    await sql`DELETE FROM turn_credentials WHERE label = ${label} AND "expiresAtMs" < ${now - 24 * 60 * 60 * 1000}`;
  } catch { /* se a escrita falhar, a credencial criada ainda serve nesta resposta */ }
  return { apiKey: made.apiKey, username: made.username, fresh: true };
}

async function meteredIce(env: any, apiKey: string): Promise<any[] | null> {
  const host = meteredHost(env);
  if (!host) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`https://${host}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`, { signal: ctl.signal });
    clearTimeout(t);
    const j: any = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(j) || !j.length) return null;
    return j;
  } catch {
    return null;
  }
}

async function rotateTurnCredential(env: any): Promise<void> {
  try {
    const sql = neon(env.DB);
    const cred = await currentTurnCredential(sql, env);
    if (cred) turnKeyCache = { key: cred.apiKey, at: Date.now() };
  } catch { /* nunca deixar o cron falhar por isto */ }
}

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
  const domain = meteredHost(c.env);
  const secret = String(c.env.METERED_SECRET_KEY || '').trim();
  const staticServers = staticIce(c.env.METERED_ICE_JSON);
  // CACHE (2026-10-30): a credencial vive 48 h; 5 min de cache no browser evita
  // repetir o pedido em cada chamada da mesma sessão. `private` — nunca partilhar
  // credenciais entre utilizadores por cache intermédia.
  const hdr = { 'Cache-Control': 'private, max-age=300' };

  // 1) Credencial rotativa (48 h, renovada a cada 24 h) — Metered Secret Key.
  if (domain && secret) {
    try {
      let key = turnKeyCache && Date.now() - turnKeyCache.at < 60_000 ? turnKeyCache.key : '';
      if (!key) {
        const cred = await currentTurnCredential(neon(c.env.DB), c.env);
        if (cred) { key = cred.apiKey; turnKeyCache = { key, at: Date.now() }; }
      }
      if (key) {
        const servers = await meteredIce(c.env, key);
        if (servers) return c.json({ iceServers: servers, demo: false, source: 'rotating' }, 200, hdr);
      }
    } catch { /* cai para os caminhos seguintes */ }
  }

  // 2) Credencial estática via apiKey (credential-scoped).
  const staticKey = String(c.env.METERED_TURN_APIKEY || '').trim();
  if (domain && staticKey) {
    const servers = await meteredIce(c.env, staticKey);
    if (servers) return c.json({ iceServers: servers, demo: false }, 200, hdr);
  }

  // 3) Lista estática em JSON / 4) OpenRelay público.
  if (staticServers) return c.json({ iceServers: staticServers, demo: false, source: 'static' }, 200, hdr);
  return c.json({ iceServers: FALLBACK_ICE, demo: true }, 200, hdr);
});
app.get('/api/v1/turn/quota', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  return c.json(await turnQuota(sql, c.env.METERED_FREE_MB));
});
app.post('/api/v1/turn/log', requireAuth, async (c) => {
  const guard = writeGuard(c);
  if (guard) return guard;
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
  const ts = Date.now();
  let sigPayload: any = null;
  if (p) { try { sigPayload = JSON.parse(p); } catch { sigPayload = null; } }
  // Entrega já ao WS. O INSERT na D1 é só o fallback do polling: fica em segundo
  // plano para o "desligar" chegar ao outro lado sem esperar pela escrita.
  const push = pushCallSignal(c.env, id, { from: user.sub, type: String(type), payload: sigPayload, ts });
  const persist = (async () => {
    try {
      await sql`INSERT INTO call_signals (id, "tripId", "senderId", type, payload, "createdAt")
        VALUES (gen_random_uuid()::text, ${id}, ${user.sub}, ${String(type)}, ${p}::json, to_timestamp(${ts / 1000}))`;
      await sql`DELETE FROM call_signals WHERE "tripId" = ${id} AND "createdAt" < NOW() - INTERVAL '10 minutes'`;
    } catch {}
  })();
  try { c.executionCtx.waitUntil(persist); } catch { await persist; }
  await push;
  return c.json({ ok: true, ts });
});
// GET /api/v1/trips/:id/call/live → upgrade WS para o DO `calls:<tripId>`.
// Só a motorista e a passageira da viagem (assertParticipant); frames:
// {t:'ready'} ao ligar e {t:'signal', signal:{from,type,payload,ts}}.
app.get('/api/v1/trips/:id/call/live', async (c) => {
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
    return c.json({ message: 'Usa WebSocket: GET com header Upgrade: websocket.', usage: `/api/v1/trips/${id}/call/live` }, 426);
  const sql = neon(c.env.DB);
  if (!(await assertParticipant(sql, id, user.sub)))
    return c.json({ message: 'Sem acesso a esta viagem.' }, 403);
  const ns: any = (c.env as any).TRIPPUSH;
  if (!ns || !ns.get) return c.json({ message: 'Chamada em tempo real indisponível.' }, 503);
  const stub = ns.get(ns.idFromName(`calls:${id}`));
  const fwd = new Headers();
  for (const h of ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
    const v = c.req.header(h);
    if (v) fwd.set(h, v);
  }
  fwd.set('X-Trip-Id', id);
  fwd.set('X-User-Id', String(user.sub || ''));
  return stub.fetch(new Request('https://trip-push/call-live', { method: 'GET', headers: fwd }));
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
  const guard = writeGuard(c);
  if (guard) return guard;
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const id = c.req.param('id');
  if (!(await assertParticipant(sql, id, user.sub)))
    return c.json({ message: 'Sem acesso a esta viagem.' }, 403);
  const { from, text } = await c.req.json().catch(() => ({}));
  const clean = String(text || '').trim().slice(0, 300);
  if (!clean) return c.json({ message: 'Mensagem vazia.' }, 400);
  await sql`INSERT INTO chat_messages (id, "tripId", "senderId", "senderName", text) VALUES (gen_random_uuid()::text, ${id}, ${user.sub}, ${String(from || '').slice(0, 40) || 'Eu'}, ${clean})`;
  // Aviso barato no WS da viagem (o cliente ignora o próprio).
  chatPoke(c, id);
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
      await pushToUser(sql, other, '💬 Nova mensagem — LadiesGo!', clean.slice(0, 120), { tripId: id, type: 'chat' });
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
    // Ordenação final: prefixo do nome, depois bloco/quarteirão, depois distância.
    // Cadeia de pesquisa (da mais rápida para a mais cara):
    //   1) FTS5 indexado (places_fts, migração 0008 — indexa `norm`, não `name`)
    //   2) GLOB de prefixo (places_nname_idx) — SÓ se o FTS devolver zero
    //   3) Photon/Nominatim em /api/places/search — SÓ se 1) e 2) derem zero
    //
    // O antigo 3.º passo (`norm LIKE '%termo%'`, sem índice) foi REMOVIDO em
    // 2026-10-30. Ele lia as 23.332 linhas de `places` a cada execução e era
    // disparado sempre que o FTS devolvia MENOS DE 8 linhas — ou seja, as
    // pesquisas mais precisas ("isptec", "momo", "bloco d27") eram justamente
    // as que pagavam o varrimento completo, porque o resultado bom do FTS era
    // SOBRESCRITO por um pior. Medido: 3.556.334 linhas lidas/dia = 98% de
    // todas as leituras da D1, com ~150 varrimentos completos por dia.
    //
    // Efeito colateral conhecido: deixa de haver casamento a MEIO de palavra
    // ("sptec" -> "isptec"). Prefixo continua a funcionar ("ispt", "kilam").
    // Nesses casos raros cai ao Photon/Nominatim, que responde na mesma.
    let rows: any[] = [];
    try {
      const expr = tk
        .map((t: string) => t.replace(/[^\p{L}\p{N}]+/gu, ''))
        .filter((t: string) => t.length >= 2)
        .map((t: string) => t + '*')
        .join(' ');
      if (expr) {
        // Subquery com LIMIT: sem ele o `ORDER BY` obriga a ler TODOS os
        // documentos que casam (o prefixo "a*" casa 9.715 = 42% da tabela).
        // `ORDER BY rank` mantém os melhores do bm25 dentro desses 800.
        rows = await sql`
          SELECT p.name, p.nname, p.lat, p.lng, p.type, p.municipality, p.province, p.street, p."number"
          FROM (SELECT rowid FROM places_fts WHERE places_fts MATCH ${expr} ORDER BY rank LIMIT 800) m
          JOIN places p ON p.id = m.rowid
          ORDER BY (CASE WHEN p.name LIKE 'Bloco %' OR p.name LIKE 'Bloco%' OR p.name LIKE 'Quarteir%' THEN 1 ELSE 0 END) DESC,
            (ABS(p.lat - ${lat}) + ABS(p.lng - ${lng})) ASC
          LIMIT 400
        `;
      }
    } catch { rows = []; }
    if (rows.length === 0) {
      // 2) Prefixo do nome via índice places_nname_idx (GLOB) — rede de segurança
      //    para prefixos que o FTS não apanhe. Só corre quando o FTS deu ZERO
      //    (antes corria com <8 e deitava fora o resultado do FTS).
      const g1 = t1.replace(/([*?\[\]])/g, '[$1]') + '*';
      rows = await sql`
        SELECT name, nname, lat, lng, type, municipality, province, street, "number"
        FROM places
        WHERE nname GLOB ${g1}
          AND (${t2} = '' OR norm LIKE ${'%' + t2 + '%'})
          AND (${t3} = '' OR norm LIKE ${'%' + t3 + '%'})
        ORDER BY (CASE WHEN name LIKE 'Bloco %' OR name LIKE 'Bloco%' OR name LIKE 'Quarteir%' THEN 1 ELSE 0 END) DESC,
          (ABS(lat - ${lat}) + ABS(lng - ${lng})) ASC
        LIMIT 400
      `;
    }
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
  // Coordenadas arredondadas a ~1km: a mesma pesquisa em pontos próximos partilha
  // cache (os 15 melhores resultados não mudam de forma percetível nesse raio),
  // o que multiplica os acertos de cache e reduz os varrimentos à BD.
  // v13 (2026-10-29): subiu de v12 porque as coordenadas de `places` foram
  // corrigidas contra a Yango (ex.: ISPTEC apontava para o INSUTEC, 5 km ao lado).
  // Sem mudar a chave, as respostas em cache (7 dias, por datacenter) continuavam
  // a mostrar as coordenadas antigas.
  // v14 (2026-10-30): a cascata de pesquisa mudou (FTS deixou de ser descartado
  // quando devolvia <8 linhas; o `LIKE '%termo%'` sem índice foi removido). As
  // respostas antigas em cache vinham da cascata velha, por isso a chave sobe.
  // A chave usa `fold(q)` para que "Kilamba" e "kilamba" partilhem a entrada.
  const pkey = 'places:v14:' + fold(q).trim() + ':' + Math.round(lat * 100) / 100 + ',' + Math.round(lng * 100) / 100;
  const phit = await cacheGet(c, pkey);
  if (phit) return phit;
  // Base local primeiro: instantâneo, offline e com distância à localização.
  // QUOTA (corte de carga): com `quota_shed >= 1` (nível ALTO/CRÍTICO da conta,
  // escrito por scripts/quota-watch.mjs) a pesquisa deixa de tocar na D1 e
  // responde pelo cache (acima) ou pelo Photon/Nominatim — a app continua a
  // pesquisar, mas sem varrer `places_fts`. As respostas já em cache não mudam.
  const shed = await shedLevel(c.env);
  const local: any[] = shed >= 1 ? [] : await localPlaces(c, q, lat, lng);
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

// Imagem de notificação: aceita data URL (vai para o Telegram, a D1 guarda o file_id),
// um file_id já existente, ou um URL http(s). Devolve o que fica na D1.
async function notifImageStore(env: any, raw: any, caption: string): Promise<{ ok: boolean; value: string | null }> {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: true, value: null };
  if (/^data:image\//i.test(s)) {
    const fileId = await tgSendPhoto(env, s, caption);
    return fileId ? { ok: true, value: fileId } : { ok: false, value: null };
  }
  if (/^https?:\/\//i.test(s)) return { ok: true, value: s.slice(0, 500) };
  if (/^[A-Za-z0-9_-]{20,256}$/.test(s)) return { ok: true, value: s };
  return { ok: false, value: null };
}
function notifImageUrl(c: any, v: any): string | null {
  if (v == null) return null;
  const u = photoUrl(c, v);
  return u || null;
}
// Origem pública da API (usada fora de um pedido, ex.: cron, para o push com imagem).
const API_PUBLIC_ORIGIN = 'https://ladiesgo-api.rererererererere670.workers.dev';
function notifImageAbs(v: any): string | null {
  if (v == null) return null;
  const s = String(v);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(s)) return null;
  return API_PUBLIC_ORIGIN + '/api/v1/users/photo/' + encodeURIComponent(s);
}

// POST /api/v1/admin/notifications/send — aviso no centro de notificações + push Expo
app.post('/api/v1/admin/notifications/send', adminMiddleware, async (c) => {
  const guard = writeGuard(c);
  if (guard) return guard;
  const sql = neon(c.env.DB);
  const body: any = await c.req.json().catch(() => ({}));
  const title = (String(body?.title || '').trim() || 'LadiesGo!').slice(0, 80);
  const message = String(body?.message || body?.body || body?.text || '').trim().slice(0, 500);
  if (!message) return c.json({ ok: false, message: 'Mensagem obrigatória.' }, 400);
  let imgFile: string | null = null;
  if (String(body?.image || '').trim()) {
    const st = await notifImageStore(c.env, body.image, 'LadiesGo · imagem de notificação');
    if (!st.ok) return c.json({ ok: false, message: 'Não foi possível guardar a imagem. Tenta outra vez.' }, 502);
    imgFile = st.value;
  }
  const imgAbs = notifImageUrl(c, imgFile);
  const target = String(body?.target || 'ALL').toUpperCase();
  const role = target === 'PASSENGERS' ? 'PASSENGER' : target === 'DRIVERS' ? 'DRIVER' : null;
  try {
    const recipients = role
      ? await sql`SELECT id, "fcmToken" FROM users WHERE "isActive" = 1 AND role = ${role} LIMIT 5000`
      : await sql`SELECT id, "fcmToken" FROM users WHERE "isActive" = 1 AND role IN ('PASSENGER','DRIVER') LIMIT 5000`;
    if (!recipients.length) return c.json({ ok: true, sent: 0, pushed: 0 });
    const data = JSON.stringify({ type: 'admin', target, source: 'manual', image: imgAbs || null });
    if (role) {
      await sql`INSERT INTO notifications (id, "userId", title, body, type, "isRead", data, image, "createdAt")
        SELECT 'nt_' || lower(hex(randomblob(16))), id, ${title}, ${message}, 'admin', 0, ${data}, ${imgFile}, NOW()
        FROM users WHERE "isActive" = 1 AND role = ${role} LIMIT 5000`;
    } else {
      await sql`INSERT INTO notifications (id, "userId", title, body, type, "isRead", data, image, "createdAt")
        SELECT 'nt_' || lower(hex(randomblob(16))), id, ${title}, ${message}, 'admin', 0, ${data}, ${imgFile}, NOW()
        FROM users WHERE "isActive" = 1 AND role IN ('PASSENGER','DRIVER') LIMIT 5000`;
    }
    // Aviso ao vivo (best-effort): quem tiver o WS aberto atualiza já.
    try { c.executionCtx.waitUntil(notifPokeMany(c.env, recipients.map((r: any) => r.id))); } catch {}
    const msgs = recipients
      .map((r: any) => String(r.fcmToken || ''))
      .filter((t: string) => t.indexOf('ExponentPushToken') === 0)
      .map((to: string) => ({
        to, sound: 'default', title, body: message,
        data: { type: 'admin', imageUrl: imgAbs || null },
        ...(imgAbs ? { richContent: { image: imgAbs } } : {}),
      }));
    if (msgs.length) {
      const send = (async () => {
        for (let i = 0; i < msgs.length; i += 100) {
          await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(msgs.slice(i, i + 100)),
          }).catch(() => {});
        }
      })();
      try { c.executionCtx.waitUntil(send); } catch { await send; }
    }
    return c.json({ ok: true, sent: recipients.length, pushed: msgs.length, image: imgAbs });
  } catch (e: any) {
    console.error('admin notification send error:', e);
    return c.json({ ok: false, message: 'Falha ao enviar notificação.' }, 500);
  }
});

// Notificações semanais programadas. Horários em Africa/Luanda (UTC+1, sem DST).
async function deliverScheduledNotification(env: any, sql: any, target: string, title: string, message: string, meta?: { scheduleId?: string; time?: string; image?: string | null }) {
  const role = target === 'PASSENGERS' ? 'PASSENGER' : target === 'DRIVERS' ? 'DRIVER' : null;
  const recipients = role
    ? await sql`SELECT id, "fcmToken" FROM users WHERE "isActive" = 1 AND role = ${role} LIMIT 5000`
    : await sql`SELECT id, "fcmToken" FROM users WHERE "isActive" = 1 AND role IN ('PASSENGER','DRIVER') LIMIT 5000`;
  if (!recipients.length) return { sent: 0, pushed: 0 };
  const imgFile = meta?.image ? String(meta.image) : null;
  const imgAbs = notifImageAbs(imgFile);
  const data = JSON.stringify({ type: 'admin', target, source: 'scheduled', scheduleId: meta?.scheduleId || null, time: meta?.time || null, image: imgAbs || null });
  if (role) {
    await sql`INSERT INTO notifications (id, "userId", title, body, type, "isRead", data, image, "createdAt")
      SELECT 'nt_' || lower(hex(randomblob(16))), id, ${title}, ${message}, 'admin', 0, ${data}, ${imgFile}, NOW()
      FROM users WHERE "isActive" = 1 AND role = ${role} LIMIT 5000`;
  } else {
    await sql`INSERT INTO notifications (id, "userId", title, body, type, "isRead", data, image, "createdAt")
      SELECT 'nt_' || lower(hex(randomblob(16))), id, ${title}, ${message}, 'admin', 0, ${data}, ${imgFile}, NOW()
      FROM users WHERE "isActive" = 1 AND role IN ('PASSENGER','DRIVER') LIMIT 5000`;
  }
  // Aviso ao vivo (o cron já corre fora do caminho crítico).
  try { await notifPokeMany(env, recipients.map((r: any) => r.id)); } catch {}
  const msgs = recipients
    .map((r: any) => String(r.fcmToken || ''))
    .filter((t: string) => t.indexOf('ExponentPushToken') === 0)
    .map((to: string) => ({
      to, sound: 'default', title, body: message,
      data: { type: 'admin', imageUrl: imgAbs || null },
      ...(imgAbs ? { richContent: { image: imgAbs } } : {}),
    }));
  for (let i = 0; i < msgs.length; i += 100) {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msgs.slice(i, i + 100)),
    }).catch(() => {});
  }
  return { sent: recipients.length, pushed: msgs.length };
}

async function runNotificationSchedules(env: any) {
  try {
    const sql = neon(env.DB);
    const rows = await sql`SELECT s.id AS "scheduleId", s.target, s.title, s.body, s.image, s."dayOfWeek",
      sl.id AS "slotId", sl.time, sl."lastRunKey"
      FROM notification_schedules s
      JOIN notification_schedule_slots sl ON sl."scheduleId" = s.id
      WHERE s.enabled = 1`;
    const now = Date.now();
    const local = new Date(now + 60 * 60 * 1000);
    const y = local.getUTCFullYear();
    const mo = local.getUTCMonth();
    const d = local.getUTCDate();
    const curDay = local.getUTCDay();
    for (const r of rows) {
      const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(r.time || ''));
      if (!t) continue;
      const slotDay = Number(r.dayOfWeek);
      if (!Number.isInteger(slotDay) || slotDay < 0 || slotDay > 6) continue;
      const delta = (curDay - slotDay + 7) % 7;
      const dueUtc = Date.UTC(y, mo, d - delta, Number(t[1]), Number(t[2])) - 60 * 60 * 1000;
      if (now < dueUtc || now >= dueUtc + 20 * 60 * 1000) continue;
      const dateKey = new Date(Date.UTC(y, mo, d - delta)).toISOString().slice(0, 10);
      const runKey = dateKey + 'T' + t[1] + ':' + t[2];
      const claimed = await sql`UPDATE notification_schedule_slots SET "lastRunKey" = ${runKey}
        WHERE id = ${r.slotId} AND ("lastRunKey" IS NULL OR "lastRunKey" <> ${runKey}) RETURNING id`;
      if (!claimed.length) continue;
      const message = String(r.body || '').trim().slice(0, 500);
      if (!message) continue;
      const title = String(r.title || '').trim().slice(0, 80) || 'LadiesGo!';
      try {
        await deliverScheduledNotification(env, sql, String(r.target || 'ALL'), title, message, { scheduleId: String(r.scheduleId), time: String(r.time), image: r.image ? String(r.image) : null });
        console.log('scheduled notification sent', String(r.slotId), runKey);
      } catch (e: any) {
        console.error('scheduled notification delivery error:', String(r.slotId), e);
      }
    }
  } catch (e: any) {
    console.error('notification schedules cron error:', e);
  }
}

app.get('/api/v1/admin/notifications/schedules', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  const rows = await sql`SELECT s.id, s.target, s.title, s.body, s.image, s."dayOfWeek", s.enabled, s."createdAt",
    sl.time, sl."lastRunKey"
    FROM notification_schedules s
    LEFT JOIN notification_schedule_slots sl ON sl."scheduleId" = s.id
    ORDER BY s."createdAt" DESC, sl.time ASC LIMIT 300`;
  const out: any[] = [];
  const seen: Record<string, any> = {};
  for (const r of rows) {
    const id = String(r.id);
    if (!seen[id]) {
      seen[id] = { id, target: r.target, title: r.title, body: r.body, image: notifImageUrl(c, r.image), dayOfWeek: Number(r.dayOfWeek || 0), enabled: !!Number(r.enabled || 0), createdAt: r.createdAt, times: [], lastRuns: {} };
      out.push(seen[id]);
    }
    if (r.time) {
      seen[id].times.push(String(r.time));
      if (r.lastRunKey) seen[id].lastRuns[String(r.time)] = String(r.lastRunKey);
    }
  }
  return c.json({ ok: true, schedules: out });
});

app.get('/api/v1/admin/notifications/history', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  const rows = await sql`SELECT title, body, data, "createdAt", COUNT(*) AS recipients
    FROM notifications WHERE type = 'admin'
    GROUP BY title, body, data, "createdAt"
    ORDER BY "createdAt" DESC LIMIT 200`;
  const history = (rows || []).map((r: any) => {
    const d = r.data && typeof r.data === 'object' ? r.data : {};
    return {
      title: String(r.title || ''),
      body: String(r.body || ''),
      createdAt: r.createdAt || null,
      recipients: Number(r.recipients || 0),
      target: String(d.target || ''),
      source: String(d.source || 'manual'),
      scheduleId: d.scheduleId ? String(d.scheduleId) : null,
      time: d.time ? String(d.time) : null,
      image: d.image ? String(d.image) : null,
    };
  });
  return c.json({ ok: true, history });
});

app.post('/api/v1/admin/notifications/schedules', adminMiddleware, async (c) => {
  const guard = writeGuard(c);
  if (guard) return guard;
  const sql = neon(c.env.DB);
  const body: any = await c.req.json().catch(() => ({}));
  const title = String(body?.title || '').trim().slice(0, 80) || 'LadiesGo!';
  const message = String(body?.message || body?.body || body?.text || '').trim().slice(0, 500);
  if (!message) return c.json({ ok: false, message: 'Mensagem obrigatória.' }, 400);
  const target = ['ALL', 'PASSENGERS', 'DRIVERS'].includes(String(body?.target || '').toUpperCase())
    ? String(body.target).toUpperCase()
    : 'ALL';
  const dayOfWeek = Number(body?.dayOfWeek);
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return c.json({ ok: false, message: 'Dia inválido.' }, 400);
  const raw = Array.isArray(body?.times) ? body.times : [];
  const times = [...new Set(raw.map((x: any) => String(x || '').slice(0, 5)).filter((x: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x)))].sort().slice(0, 3);
  if (!times.length) return c.json({ ok: false, message: 'Escolhe pelo menos um horário.' }, 400);
  let imgFile: string | null = null;
  if (String(body?.image || '').trim()) {
    const st = await notifImageStore(c.env, body.image, 'LadiesGo · imagem de notificação programada');
    if (!st.ok) return c.json({ ok: false, message: 'Não foi possível guardar a imagem. Tenta outra vez.' }, 502);
    imgFile = st.value;
  }
  const id = 'ns_' + crypto.randomUUID().slice(0, 12);
  try {
    await sql`INSERT INTO notification_schedules (id, target, title, body, image, "dayOfWeek", enabled, "createdAt", "updatedAt")
      VALUES (${id}, ${target}, ${title}, ${message}, ${imgFile}, ${dayOfWeek}, 1, NOW(), NOW())`;
    for (const time of times) {
      await sql`INSERT INTO notification_schedule_slots (id, "scheduleId", time, "createdAt")
        VALUES (${'nss_' + crypto.randomUUID().slice(0, 12)}, ${id}, ${time}, NOW())`;
    }
    return c.json({ ok: true, id, times });
  } catch (e: any) {
    try {
      await sql`DELETE FROM notification_schedule_slots WHERE "scheduleId" = ${id}`;
      await sql`DELETE FROM notification_schedules WHERE id = ${id}`;
    } catch {}
    console.error('admin notification schedule create error:', e);
    return c.json({ ok: false, message: 'Falha ao programar notificação.' }, 500);
  }
});

app.put('/api/v1/admin/notifications/schedules/:id', adminMiddleware, async (c) => {
  const guard = writeGuard(c);
  if (guard) return guard;
  const sql = neon(c.env.DB);
  const id = c.req.param('id');
  const body: any = await c.req.json().catch(() => ({}));
  const cur = await sql`SELECT id, target, title, body, image, "dayOfWeek", enabled FROM notification_schedules WHERE id = ${id} LIMIT 1`;
  if (!cur.length) return c.json({ ok: false, message: 'Notificação programada não encontrada.' }, 404);
  const row: any = cur[0];
  const title = body?.title !== undefined ? (String(body.title || '').trim().slice(0, 80) || 'LadiesGo!') : String(row.title || 'LadiesGo!');
  const hasMsg = body?.message !== undefined || body?.body !== undefined || body?.text !== undefined;
  const message = hasMsg
    ? String(body?.message != null ? body.message : (body?.body != null ? body.body : (body?.text != null ? body.text : ''))).trim().slice(0, 500)
    : String(row.body || '');
  if (!message) return c.json({ ok: false, message: 'Mensagem obrigatória.' }, 400);
  const target = body?.target !== undefined
    ? (['ALL', 'PASSENGERS', 'DRIVERS'].includes(String(body.target).toUpperCase()) ? String(body.target).toUpperCase() : 'ALL')
    : String(row.target || 'ALL');
  const dayOfWeek = body?.dayOfWeek !== undefined ? Number(body.dayOfWeek) : Number(row.dayOfWeek);
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return c.json({ ok: false, message: 'Dia inválido.' }, 400);
  const enabled = body?.enabled !== undefined ? (body.enabled ? 1 : 0) : Number(row.enabled || 0);
  let imgFile: string | null = row.image == null ? null : String(row.image);
  if (body?.image !== undefined) {
    const rawImg = String(body.image == null ? '' : body.image).trim();
    if (!rawImg) imgFile = null;
    else {
      const st = await notifImageStore(c.env, rawImg, 'LadiesGo · imagem de notificação programada');
      if (!st.ok) return c.json({ ok: false, message: 'Não foi possível guardar a imagem. Tenta outra vez.' }, 502);
      imgFile = st.value;
    }
  }
  let times: string[] | null = null;
  if (body?.times !== undefined) {
    const raw = Array.isArray(body.times) ? body.times : [];
    times = [...new Set(raw.map((x: any) => String(x || '').slice(0, 5)).filter((x: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x)))].sort().slice(0, 3);
    if (!times.length) return c.json({ ok: false, message: 'Escolhe pelo menos um horário.' }, 400);
  }
  try {
    await sql`UPDATE notification_schedules SET target = ${target}, title = ${title}, body = ${message}, image = ${imgFile},
      "dayOfWeek" = ${dayOfWeek}, enabled = ${enabled}, "updatedAt" = NOW() WHERE id = ${id}`;
    if (times) {
      const existing = await sql`SELECT id, time FROM notification_schedule_slots WHERE "scheduleId" = ${id}`;
      const keep: Record<string, string> = {};
      for (const s of existing) keep[String(s.time)] = String(s.id);
      const wanted = new Set(times);
      for (const s of existing) {
        if (!wanted.has(String(s.time))) await sql`DELETE FROM notification_schedule_slots WHERE id = ${String(s.id)}`;
      }
      for (const time of times) {
        if (keep[time]) continue;
        await sql`INSERT INTO notification_schedule_slots (id, "scheduleId", time, "createdAt")
          VALUES (${'nss_' + crypto.randomUUID().slice(0, 12)}, ${id}, ${time}, NOW())`;
      }
    }
    return c.json({ ok: true, id, times, image: notifImageUrl(c, imgFile) });
  } catch (e: any) {
    console.error('admin notification schedule update error:', e);
    return c.json({ ok: false, message: 'Falha ao editar a notificação programada.' }, 500);
  }
});

app.delete('/api/v1/admin/notifications/schedules/:id', adminMiddleware, async (c) => {
  const guard = writeGuard(c);
  if (guard) return guard;
  const sql = neon(c.env.DB);
  const id = c.req.param('id');
  await sql`DELETE FROM notification_schedule_slots WHERE "scheduleId" = ${id}`;
  await sql`DELETE FROM notification_schedules WHERE id = ${id}`;
  return c.json({ ok: true });
});

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
      const isActive = status === 'ACTIVE';
      const totalRes = isActive
        ? await sql`SELECT COUNT(*)::int AS total FROM trips WHERE status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')`
        : await sql`SELECT COUNT(*)::int AS total FROM trips WHERE status = ${status}`;
      const tripsRes = isActive
        ? await sql`
        SELECT t.*, 
          u.name AS passenger_name, u.phone AS passenger_phone,
          du.name AS driver_name, du.phone AS driver_phone, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
        FROM trips t
        LEFT JOIN users u ON u.id = t."passengerId"
        LEFT JOIN drivers d ON d.id = t."driverId"
        LEFT JOIN users du ON du.id = d."userId"
        WHERE t.status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')
        ORDER BY t."createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}
      `
        : await sql`
        SELECT t.*, 
          u.name AS passenger_name, u.phone AS passenger_phone,
          du.name AS driver_name, du.phone AS driver_phone, d."carMake" AS car_make, d."carModel" AS car_model, d."carPlate" AS car_plate
        FROM trips t
        LEFT JOIN users u ON u.id = t."passengerId"
        LEFT JOIN drivers d ON d.id = t."driverId"
        LEFT JOIN users du ON du.id = d."userId"
        WHERE t.status = ${status}
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
    SELECT d.*, u.name, u.phone, u."profilePhoto", u."isActive" AS "userActive"
    FROM drivers d
    JOIN users u ON u.id = d."userId"
    WHERE d.status = 'APPROVED'
    ORDER BY d."createdAt" DESC
  `;
  return c.json({ drivers: driversRes.map((d: any) => ({ ...d, profilePhoto: photoUrl(c, d.profilePhoto) })) });
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
    return c.json({ users: usersRes.map((u: any) => ({ ...u, profilePhoto: photoUrl(c, u.profilePhoto) })), total });
  } catch (e) {
    console.error('Admin users error:', e);
    return c.json({ message: 'Erro ao buscar utilizadores', error: String(e) }, 500);
  }
});

// POST /api/v1/admin/users/:id/reset-password — Repor senha padrão + reativar conta (admin)
app.post('/api/v1/admin/users/:id/reset-password', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  const { id } = c.req.param();
  const resetHash = await hashPassword('0987654321');
  const rows = await sql`
    UPDATE users SET "passwordHash" = ${resetHash},
      "mustChangePassword" = true, "isActive" = true, "updatedAt" = NOW()
    WHERE id = ${id} RETURNING id`;
  if (!rows.length) return c.json({ message: 'Utilizador não encontrado.' }, 404);
  return c.json({ success: true, reactivated: true });
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
  const admin = c.get('user');
  const upd = await sql`UPDATE users SET "walletBalance" = ROUND("walletBalance" + ${amount}, 2), "negTrips" = CASE WHEN ROUND("walletBalance" + ${amount}, 2) < 0 THEN "negTrips" ELSE 0 END, "walletBlocked" = CASE WHEN ROUND("walletBalance" + ${amount}, 2) < 0 THEN 1 ELSE 0 END, "updatedAt" = NOW() WHERE id = ${u.id} RETURNING "walletBalance", "negTrips", "walletBlocked"`;
  if (!upd.length) return c.json({ message: 'Conta não encontrada.' }, 404);
  const after = money(upd[0].walletBalance);
  const blocked = Number(upd[0].walletBlocked || 0);
  const negTrips = Number(upd[0].negTrips || 0);
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

// ─── Foto de perfil via Telegram (D1 guarda só o file_id) ──────────────────
// A foto é enviada ao canal (TG_BOT_TOKEN + TG_CHAT_ID, definidos com
// `wrangler secret put`); guardamos na D1 apenas o file_id devolvido pelo
// Telegram. O GET /api/v1/users/photo/:fileId serve a imagem a partir do
// Telegram. Os segredos nunca ficam no repo: só o Worker os lê.
function tgCreds(env: any): { tok: string; chat: string } {
  return {
    tok: String(env?.TG_BOT_TOKEN || env?.TELEGRAM_BOT_TOKEN || ''),
    chat: String(env?.TG_CHAT_ID || env?.TELEGRAM_CHAT_ID || ''),
  };
}
async function tgSendPhoto(env: any, dataUrl: string, caption: string): Promise<string | null> {
  try {
    const { tok, chat } = tgCreds(env);
    if (!tok || !chat) return null;
    const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(dataUrl || ''));
    if (!m) return null;
    const bin = Uint8Array.from(atob(m[2]), (ch: any) => ch.charCodeAt(0));
    const mime = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
    const fd = new FormData();
    fd.append('chat_id', chat);
    if (caption) fd.append('caption', caption.slice(0, 1000));
    fd.append('photo', new Blob([bin as any], { type: mime }), 'foto.jpg');
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendPhoto`, { method: 'POST', body: fd, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const j: any = await r.json().catch(() => null);
    const photos = j && j.ok && j.result && Array.isArray(j.result.photo) ? j.result.photo : [];
    if (!photos.length) return null;
    // A maior resolução é a última; escolhemos por área para não depender da ordem.
    const best = photos.reduce((a: any, b: any) => (Number(b.width || 0) * Number(b.height || 0) > Number(a.width || 0) * Number(a.height || 0) ? b : a));
    return best && best.file_id ? String(best.file_id) : null;
  } catch {
    return null;
  }
}
// PUT /api/v1/admin/users/:id/photo — Admin define a foto de perfil (qualquer conta)
app.put('/api/v1/admin/users/:id/photo', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const photo = String(b.photo || '');
  if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(photo)) return c.json({ message: 'Foto invalida.' }, 400);

  const tgOn = !!((c.env.TG_BOT_TOKEN || c.env.TELEGRAM_BOT_TOKEN) && (c.env.TG_CHAT_ID || c.env.TELEGRAM_CHAT_ID));
  if (!tgOn) return c.json({ message: 'Envio de fotos indisponivel.' }, 503);
  const rows = await sql`SELECT id, name, phone, role FROM users WHERE id = ${id} LIMIT 1`;
  if (!rows.length) return c.json({ message: 'Utilizador nao encontrado.' }, 404);
  const u = rows[0];
  const fileId = await tgSendPhoto(c.env, photo, `LadiesGo · foto de ${u.name || u.phone || ''} (${u.role || ''})`);
  if (!fileId) return c.json({ message: 'Nao foi possivel guardar a foto.' }, 502);
  await sql`UPDATE users SET "profilePhoto" = ${fileId}, "updatedAt" = NOW() WHERE id = ${id}`;
  return c.json({ success: true, telegram: true, profilePhoto: photoUrl(c, fileId) });
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

// ─── CATEGORIAS (geridas no painel admin) ───
// GET /api/v1/categories — Lista pública (a home usa para nomes/cores/preços)
// Devolve só as ativas: desativar ou apagar tira a categoria da app.
app.get('/api/v1/categories', async (c) => {
  // CACHE (2026-10-30): lista gerida no admin, muda raramente. 5 min de cache no
  // browser tira este pedido de todas as aberturas dentro desse período (a home
  // chama /categories a cada carga). O painel usa /admin/categories (sem cache).
  const hdr = { 'Cache-Control': 'public, max-age=300' };
  try {
    const sql = neon(c.env.DB);
    return c.json({ categories: await getCategories(sql) }, 200, hdr);
  } catch {
    return c.json({ categories: [
      { code: 'ECONOMY', name: 'Económico', color: '#61188E', mult: 1, basePrice: 1500 },
      { code: 'COMFORT', name: 'Conforto', color: '#ff5fc8', mult: 1.4, basePrice: 2500 },
      { code: 'PREMIUM', name: 'Família', color: '#5b21c9', mult: 1.65, basePrice: 3500 },
    ] }, 200, hdr);
  }
});

// GET /api/v1/admin/categories — Lista do painel (inclui as inativas)
app.get('/api/v1/admin/categories', adminMiddleware, async (c) => {
  try {
    const sql = neon(c.env.DB);
    return c.json({ categories: await getCategories(sql, 'admin') });
  } catch (e) {
    console.error('list categories error:', e);
    return c.json({ message: 'Falhou a listar.' }, 500);
  }
});

// POST /api/v1/admin/categories — Adicionar categoria (solta o enum rideType para TEXT uma vez)
app.post('/api/v1/admin/categories', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name || '').trim().slice(0, 30);
  const color = String(b.color || '').trim();
  const mult = Number(b.mult);
  const basePrice = Math.max(0, Math.round(Number(b.basePrice) || 0));
  if (name.length < 2 || !/^#[0-9a-fA-F]{6}$/.test(color) || !Number.isFinite(mult) || mult < 0.5 || mult > 5 || basePrice > 100000) {
    return c.json({ message: 'Dados inválidos (nome 2-30, cor #hex, mult 0.5-5, preço até 100000).' }, 400);
  }
  const code = name.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 16) || 'CAT';
  try {
    bustCatCache();
    const rows = await sql`INSERT INTO ride_categories (code, name, color, mult, sort, "basePrice") VALUES (${code}, ${name}, ${color}, ${mult}, 99, ${basePrice}) RETURNING code, name, color, mult, active, "basePrice"`;
    const r = rows[0];
    return c.json({ category: { code: r.code, name: r.name, color: r.color, mult: Number(r.mult), basePrice: Number(r.basePrice) || 0, active: true } });
  } catch (e) {
    if (String(e).includes('duplicate') || String(e).includes('already exists')) {
      // Se já existiu e foi apagada, o code fica reservado de propósito: recriá-lo
      // com outro nome/preço reescreveria o significado das viagens antigas.
      let wasDeleted = false;
      try { wasDeleted = (await getCategories(sql, 'all')).some((x: any) => x.code === code && x.deleted); } catch {}
      return c.json({ message: wasDeleted ? 'Já existiu uma categoria com esse nome (o histórico é preservado, por isso o código fica reservado).' : 'Já existe categoria com esse nome.' }, 409);
    }
    console.error('add category error:', e);
    return c.json({ message: 'Falhou ao criar.' }, 500);
  }
});

// PUT /api/v1/admin/categories/:code — Editar nome/cor/mult e ativar/desativar.
// Aceita só os campos que vierem: `{"active":false}` desativa sem reenviar o resto.
app.put('/api/v1/admin/categories/:code', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  const code = String(c.req.param('code') || '').toUpperCase().slice(0, 16);
  const b = await c.req.json().catch(() => ({}));
  const all = await getCategories(sql, 'all');
  const cur = all.find((x: any) => x.code === code);
  if (!cur) return c.json({ message: 'Categoria não encontrada.' }, 404);
  if (cur.deleted) return c.json({ message: 'Esta categoria foi apagada.' }, 409);

  const name = b.name != null ? String(b.name).trim().slice(0, 30) : cur.name;
  const color = b.color != null ? String(b.color).trim() : cur.color;
  const mult = b.mult != null ? Number(b.mult) : cur.mult;
  const basePrice = b.basePrice != null ? Math.max(0, Math.round(Number(b.basePrice) || 0)) : (Number(cur.basePrice) || 0);
  const active = b.active != null ? (b.active ? 1 : 0) : (cur.active ? 1 : 0);
  if (name.length < 2 || !/^#[0-9a-fA-F]{6}$/.test(color) || !Number.isFinite(mult) || mult < 0.5 || mult > 5 || basePrice > 100000) {
    return c.json({ message: 'Dados inválidos (nome 2-30, cor #hex, mult 0.5-5, preço até 100000).' }, 400);
  }
  // Desativar a última deixaria a app sem escalões de preço.
  if (!active && !all.some((x: any) => x.code !== code && x.active && !x.deleted)) {
    return c.json({ message: 'Tem de ficar pelo menos uma categoria ativa.' }, 409);
  }
  bustCatCache();
  const rows = await sql`UPDATE ride_categories SET name = ${name}, color = ${color}, mult = ${mult}, active = ${active}, "basePrice" = ${basePrice} WHERE code = ${code} RETURNING code, name, color, mult, active, "basePrice"`;
  if (!rows.length) return c.json({ message: 'Categoria não encontrada.' }, 404);
  const r = rows[0];
  return c.json({ category: { code: r.code, name: r.name, color: r.color, mult: Number(r.mult), basePrice: Number(r.basePrice) || 0, active: Number(r.active) !== 0 } });
});

// DELETE /api/v1/admin/categories/:code — Apaga da app E do painel.
// Não é um DELETE de verdade: marca `deleted = 1`. A linha fica para que
// `catMaps()` continue a resolver o nome nas viagens antigas (o `rideType`
// gravado na viagem é o code, não o nome).
app.delete('/api/v1/admin/categories/:code', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  const code = String(c.req.param('code') || '').toUpperCase().slice(0, 16);
  const all = await getCategories(sql, 'all');
  const cur = all.find((x: any) => x.code === code);
  if (!cur) return c.json({ message: 'Categoria não encontrada.' }, 404);
  if (cur.deleted) return c.json({ ok: true, already: true });
  if (!all.some((x: any) => x.code !== code && x.active && !x.deleted)) {
    return c.json({ message: 'Tem de ficar pelo menos uma categoria ativa. Desativa esta e cria outra primeiro.' }, 409);
  }
  bustCatCache();
  await sql`UPDATE ride_categories SET deleted = 1, active = 0 WHERE code = ${code}`;
  return c.json({ ok: true });
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
    arrivedAt: r.arrivedAt ? new Date(r.arrivedAt).getTime() : 0,
    startedAt: r.startedAt ? new Date(r.startedAt).getTime() : 0,
  };
}

// Nota da motorista: 2 cortes medidos em produção (2026-10-30), sem mudar o valor
// devolvido (4,411764705882353 / n=17 na motorista real, antes e depois):
//  1. a query deixou de fazer JOIN com `trips`. `ratings."ratedId"` já guarda o
//     userId de quem RECEBEU a nota (o POST /ratings deriva-a do lado de quem
//     avalia) e tem índice próprio (`ratings_rated_idx`). Plano:
//     `SEARCH ratings USING INDEX ratings_rated_idx (ratedId=?)`.
//     97 → 18 linhas lidas. De caminho corrige-se uma imprecisão do JOIN: ele
//     também somava as notas que a motorista deu às passageiras.
//  2. TTL 120 s → 600 s: 30 execuções/h por motorista/isolate → 6.
//     O POST /ratings apaga a entrada, por isso a nota nova aparece já.
// (Não se usa `drivers.rating` directamente porque o POST /ratings não a mantém.)
const drvRatingCache = new Map<string, { a: number; at: number }>();
const DRV_RATING_TTL_MS = 600_000;

// `pre` = linha de /api/v1/trips/:id já com os JOIN de drivers + users feitos.
// Com ele não há nenhuma query aqui: poupa-se 1 round-trip e a leitura de 1 linha.
async function webDriverInfo(c: any, sql: any, driverId: string | null, pre?: any) {
  const env = c.env;
  if (!driverId) return null;
  let r: any;
  if (pre) {
    r = {
      userId: pre.driverUserId, currentLat: pre.driverLat, currentLng: pre.driverLng,
      rating: pre.dRating, totalTrips: pre.dTotalTrips,
      carMake: pre.dCarMake, carModel: pre.dCarModel, carColor: pre.dCarColor, carPlate: pre.dCarPlate,
      name: pre.dName, phone: pre.dPhone, profilePhoto: pre.dPhoto,
    };
  } else {
    const d = await sql`
    SELECT d."userId", d."currentLat", d."currentLng", d.rating, d."totalTrips", d."carMake", d."carModel", d."carColor", d."carPlate", u.name, u.phone, u."profilePhoto"
    FROM drivers d LEFT JOIN users u ON u.id = d."userId" WHERE d.id = ${driverId} LIMIT 1`;
    if (!d.length) return null;
    r = d[0];
  }
  const live = await geoGet(env, String(r.userId || ''));
  const lat = live && Number.isFinite(Number(live.lat)) ? Number(live.lat) : (r.currentLat != null ? Number(r.currentLat) : null);
  const lng = live && Number.isFinite(Number(live.lng)) ? Number(live.lng) : (r.currentLng != null ? Number(r.currentLng) : null);
  const hh = live ? normH(live.h) : null;
  let avg = r.rating != null ? Number(r.rating) : 5;
  try {
    const key = String(driverId);
    const hit = drvRatingCache.get(key);
    if (hit && Date.now() - hit.at < DRV_RATING_TTL_MS) {
      avg = hit.a;
    } else {
      const rated = String(r.userId || '');
      if (rated) {
        const ar = await sql`SELECT COALESCE(AVG(score), 0)::float AS a, COUNT(*)::int AS n FROM ratings WHERE "ratedId" = ${rated}`;
        if (ar[0] && Number(ar[0].n) > 0) avg = Math.round(Number(ar[0].a) * 10) / 10;
      }
      if (drvRatingCache.size > 500) drvRatingCache.clear();
      drvRatingCache.set(key, { a: avg, at: Date.now() });
    }
  } catch {}
  return {
    lat,
    lng,
    h: hh,
    name: r.name || 'Motorista',
    phone: r.phone || '',
    photo: photoUrl(c, r.profilePhoto || ''),
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
  // Candidatas calculadas em memória (DriverGeo) por proximidade. Assim o D1 só
  // lê essas (<= candLimit) em vez de TODAS as motoristas online a cada pedido
  // — era o maior consumo de linhas lidas (quota D1).
  const hasPickup = Number.isFinite(pLa) && Number.isFinite(pLo);
  const cands: { userId: string; km: number; stale: number }[] = [];
  for (const p of pos) {
    if (!p || !p.userId) continue;
    const lat = Number(p.lat), lng = Number(p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const km = hasPickup ? havKm(pLa, pLo, lat, lng) : 0;
    if (Number.isFinite(km) && km <= radiusKm) cands.push({ userId: String(p.userId), km, stale: Date.now() - Number(p.ts || 0) });
  }
  if (!cands.length) return [];
  cands.sort((a, b) => (a.km - b.km) || (a.stale - b.stale));
  const candLimit = Math.min(cands.length, Math.max(limit * 4, 40));
  const ids = cands.slice(0, candLimit).map((c) => c.userId);
  const kmByUser = new Map(cands.map((c) => [c.userId, c.km]));
  let rows: any[] = [];
  try {
    const P = 'SELECT d.id, d."userId", d.cats FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."userId" IN (';
    const S = ') AND d."isOnline" = true AND d.status = \'APPROVED\' AND COALESCE(u."walletBlocked", 0) = 0 AND NOT EXISTS (SELECT 1 FROM trips t2 WHERE t2."driverId" = d.id AND t2.status IN (\'ACCEPTED\',\'DRIVER_ARRIVED\',\'IN_PROGRESS\'))';
    const strings: any[] = [P, ...Array(Math.max(0, ids.length - 1)).fill(', '), S];
    rows = await (sql as any)(strings, ...ids);
  } catch { return []; }
  const wantCat = byCode[rideCode] || '';
  return rows
    .map((d: any) => {
      if (Array.isArray(d.cats) && d.cats.length && wantCat && d.cats.map((x: any) => String(x)).indexOf(wantCat) < 0) return null;
      const km = kmByUser.has(String(d.userId)) ? (kmByUser.get(String(d.userId)) as number) : radiusKm;
      return { id: String(d.id), km };
    })
    .filter((d: any) => d)
    .sort((a: any, b: any) => a.km - b.km)
    .slice(0, limit)
    .map((d: any) => d.id);
}
// Push dirigido a UMA motorista (oferta exclusiva).
async function pushTripToDriver(sql: any, driverId: string, tripId: string, title: string, body: string) {
  try {
    const r = await sql`SELECT u."fcmToken" FROM drivers d JOIN users u ON u.id = d."userId" WHERE d.id = ${driverId} AND NOT EXISTS (SELECT 1 FROM trips t2 WHERE t2."driverId" = d.id AND t2.status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')) LIMIT 1`;
    const tok = r[0]?.fcmToken;
    if (!tok || String(tok).indexOf('ExponentPushToken') !== 0) return;
    await expoSend(sql, [{ to: String(tok), sound: 'default', title, body, data: { tripId, type: 'new-trip' } }]);
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
    // QUOTA D1 (2026-10-30): INDEXED BY trips_status_idx — ver /trips/active (78 → 5 linhas lidas).
    const active = await sql`SELECT id, status FROM trips INDEXED BY trips_status_idx WHERE "passengerId" = ${user.sub} AND status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') ORDER BY "createdAt" DESC LIMIT 1`;
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
  const okNext: Record<string, string[]> = { ACCEPTED: ['REQUESTED'], DRIVER_ARRIVED: ['ACCEPTED'], IN_PROGRESS: ['ACCEPTED', 'DRIVER_ARRIVED'], COMPLETED: ['IN_PROGRESS'], CANCELLED: ['REQUESTED', 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS'] };
  if (!neonSt || !okNext[neonSt]) return c.json({ message: 'Transição inválida.' }, 400);
  try {
    const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
    if (!cur.length) return c.json({ message: 'Viagem não encontrada.' }, 404);
    const t = cur[0];
    // Retry / toque duplo: se ja esta no estado pedido, devolve sucesso (idempotente).
    if (t.status === neonSt) return c.json({ ok: true, status: st });
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
      // QUOTA D1: guarda de transição — retry escreve 0 linhas.
      const r = await sql`UPDATE trips SET status = 'DRIVER_ARRIVED', "arrivedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id} AND status = 'ACCEPTED' RETURNING id`;
      if (!r.length) return c.json({ message: 'Transição inválida.' }, 400);
    } else if (neonSt === 'IN_PROGRESS') {
      // PIN da passageira obrigatório para iniciar (como na rota mobile /start).
      if (String((b as any).pin || '') !== pinForTrip(id)) return c.json({ message: 'Código incorreto.' }, 400);
      const r = await sql`UPDATE trips SET status = 'IN_PROGRESS', "startedAt" = NOW(), "arrivedAt" = COALESCE("arrivedAt", NOW()), "updatedAt" = NOW() WHERE id = ${id} AND status IN ('ACCEPTED', 'DRIVER_ARRIVED') RETURNING id`;
      if (!r.length) return c.json({ message: 'Transição inválida.' }, 400);
    } else if (neonSt === 'COMPLETED') {
      const devTs = Number((b as any).ts);
      const doneAt = Number.isFinite(devTs) && Math.abs(devTs - Date.now()) <= 15 * 60 * 1000 ? new Date(devTs) : new Date();
      const r = await sql`UPDATE trips SET status = 'COMPLETED', "finalFare" = COALESCE("finalFare", "fareEstimate"), "completedAt" = ${doneAt as any}, "updatedAt" = NOW() WHERE id = ${id} AND status = 'IN_PROGRESS' RETURNING "driverId", "finalFare", "fareEstimate"`;
      if (r.length) {
        if (r[0].driverId) await sql`UPDATE drivers SET "totalTrips" = "totalTrips" + 1, "totalEarnings" = "totalEarnings" + ${Number(r[0].finalFare || r[0].fareEstimate || 0) * 0.8} WHERE id = ${r[0].driverId}`;
        await applyCommission(sql, r[0].driverId, r[0].finalFare || r[0].fareEstimate, id, c.env);
      } else {
        const chk = await sql`SELECT status FROM trips WHERE id = ${id} LIMIT 1`;
        if (!chk.length || chk[0].status !== 'COMPLETED') return c.json({ message: 'Transição inválida.' }, 400);
      }
    } else if (neonSt === 'CANCELLED') {
      // QUOTA D1: guarda de transição — retry escreve 0 linhas.
      const r = await sql`UPDATE trips SET status = 'CANCELLED', "cancelledBy" = ${String(b.by || '').slice(0, 16)}, "cancelReason" = ${String(b.reason || '').slice(0, 80)}, "updatedAt" = NOW() WHERE id = ${id} AND status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS') RETURNING id`;
      if (!r.length) return c.json({ message: 'Transição inválida.' }, 400);
    }
    pushStatus(c, id, neonSt, neonSt === 'CANCELLED' ? { by: String((b as any).by || '').toLowerCase() === 'driver' ? 'driver' : 'passenger', reason: String((b as any).reason || '').slice(0, 80) } : undefined);
    // Push (app fechada) do fluxo web: o outro lado tem de saber sem abrir a app.
    try {
      const actor: any = c.get('user') || {};
      const other = await tripOtherUserId(sql, id, String(actor.sub || ''));
      const paxId = t && t.passengerId ? String(t.passengerId) : null;
      const why = String((b as any).reason || '').slice(0, 80);
      if (neonSt === 'ACCEPTED' && paxId) {
        c.executionCtx.waitUntil(pushToUser(sql, paxId, '🦋 Motorista a caminho!', 'A tua motorista aceitou a viagem e está a caminho.', { tripId: id, type: 'accepted' }));
      } else if (neonSt === 'CANCELLED' && other) {
        const isDrv = String((b as any).by || '').toLowerCase() === 'driver';
        c.executionCtx.waitUntil(pushToUser(sql, other, isDrv ? 'Corrida cancelada pela motorista' : 'Corrida cancelada pela passageira', why ? `Motivo: ${why}` : 'A viagem foi cancelada.', { tripId: id, type: 'cancelled' }));
      } else if (neonSt === 'COMPLETED' && paxId) {
        c.executionCtx.waitUntil(pushToUser(sql, paxId, '🦋 Viagem concluída', 'Obrigada por viajar com a LadiesGo! Podes avaliar a motorista.', { tripId: id, type: 'completed' }));
      }
    } catch {}
    if (neonSt === 'DRIVER_ARRIVED') { try { c.executionCtx.waitUntil(pushPaxArrived(c.env, id)); } catch {} }
    if (neonSt === 'ACCEPTED' || neonSt === 'CANCELLED') { try { await hubBroadcast(c.env); } catch {} }
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
        driver = { name: r.name || 'Motorista', phone: r.phone || '', carFull, plate: r.carPlate || '', rating: r.rating != null ? Number(r.rating) : null, photo: photoUrl(c, r.carPhoto || r.profilePhoto || ''), lat, lng };
      }
    }
    const stops = Array.isArray(t.stops) ? t.stops : [];
    return c.json({
      status: t.status,
      pickup: { name: String(t.pickupAddress || ''), lat: Number(t.pickupLat), lng: Number(t.pickupLng) },
      dest: { name: String(t.dropoffAddress || ''), lat: Number(t.dropoffLat), lng: Number(t.dropoffLng) },
      stops: stops.map((s: any) => ({ n: String(s.n || ''), a: String(s.a || ''), lat: Number(s.lat), lng: Number(s.lng) })),
      cancelledBy: t.cancelledBy || '',
      cancelReason: t.cancelReason || '',
      createdAt: t.createdAt || '',
      updatedAt: t.updatedAt || '',
      driver, passenger: { name: pu[0]?.name || 'Passageira', phone: pu[0]?.phone || '' },
    });
  } catch (e) {
    console.error('public trip error:', e);
    return c.json({ message: 'Falhou. Tenta de novo.' }, 500);
  }
});

// GET /api/v1/trips/public/:id/live — versão em direto do link público (sem
// login). Só estado + posição da motorista: nomes, telefones, chat e pax nunca
// são enviados para sockets com tag 'pub'.
app.get('/api/v1/trips/public/:id/live', async (c) => {
  const id = c.req.param('id');
  if ((c.req.header('Upgrade') || '').toLowerCase() !== 'websocket')
    return c.json({ message: 'Usa WebSocket: GET com header Upgrade: websocket.', usage: `/api/v1/trips/public/${id}/live` }, 426);
  const sql = neon(c.env.DB);
  let st = '';
  try {
    const rows = await sql`SELECT status FROM trips WHERE id = ${id} LIMIT 1`;
    if (!rows.length) return c.json({ message: 'Viagem não encontrada.' }, 404);
    st = String(rows[0].status || '').toUpperCase().slice(0, 20);
  } catch {
    return c.json({ message: 'Falhou. Tenta de novo.' }, 500);
  }
  const ns: any = (c.env as any).TRIPPUSH;
  if (!ns || !ns.get) return c.json({ message: 'Push em tempo real indisponível.' }, 503);
  const stub = ns.get(ns.idFromName(`trip:${id}`));
  const fwd = new Headers();
  for (const h of ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
    const v = c.req.header(h);
    if (v) fwd.set(h, v);
  }
  fwd.set('X-Trip-Id', id);
  fwd.set('X-Public', '1');
  fwd.set('X-Trip-Status', st);
  return stub.fetch(new Request(`https://trip-push/public/${id}`, { method: 'GET', headers: fwd }));
});

// POST /api/v1/trips/:id/position — Posição viva da passageira (web)
app.post('/api/v1/trips/:id/position', requireAuth, async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  const la = Number(b.lat), lo = Number(b.lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return c.json({ message: 'Posição inválida.' }, 400);
  const sql = neon(c.env.DB);
  const rows = await sql`SELECT t."passengerId", t.status, d."userId" AS "driverUserId" FROM trips t LEFT JOIN drivers d ON d.id = t."driverId" WHERE t.id = ${id} LIMIT 1`;
  if (!rows.length) return c.json({ message: 'Viagem não encontrada.' }, 404);
  const t = rows[0];
  // Só a passageira da viagem move este marcador; a motorista já envia por
  // /drivers/position e um utilizador alheio não pode falsificar a posição.
  if (user.sub !== t.passengerId) return c.json({ ok: true, ignored: true });
  const st = String(t.status || '').toUpperCase();
  // Depois do arranque a posição da passageira deixa de ser partilhada.
  if (st === 'IN_PROGRESS' || st === 'COMPLETED' || st === 'CANCELLED') return c.json({ ok: true, ignored: true });
  paxLive.set(id, { lat: la, lng: lo, ts: Date.now() });
  // Espelha no DO da viagem: o WS da motorista vê a passageira mesmo quando o
  // pedido cai noutro isolate (paxLive é memória local do Worker).
  try {
    const ns: any = (c.env as any).TRIPPUSH;
    if (ns && ns.get) {
      const stub = ns.get(ns.idFromName(`trip:${id}`));
      await stub.fetch(new Request('https://trip-push/pax', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat: la, lng: lo }) }));
    }
  } catch {}
  return c.json({ ok: true });
});

// Push com som (Expo) — usado no pedido imediato e no cron de repetição.
async function pushTripToDrivers(sql: any, tripId: string, pickupName: string, destN: string, stopsN: number, fare: number, title: string, catName?: string) {
  try {
    const cands = await sql`SELECT u."fcmToken", d.cats FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."isOnline" = true AND d.status = 'APPROVED' AND COALESCE(u."walletBlocked", 0) = 0 AND u."fcmToken" LIKE 'ExponentPushToken%' AND NOT EXISTS (SELECT 1 FROM trips t2 WHERE t2."driverId" = d.id AND t2.status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')) LIMIT 100`;
    const toks = cands.filter((r: any) => !catName || !Array.isArray(r.cats) || !r.cats.length || r.cats.map((x: any) => String(x)).indexOf(catName) >= 0);
    const body = `${pickupName} → ${destN}${stopsN ? ` · +${stopsN} paragem${stopsN > 1 ? 'ns' : ''}` : ''} · ${fare} Kz`;
    const msgs = toks.map((r: any) => ({ to: r.fcmToken, sound: 'default', title, body, data: { tripId, type: 'new-trip' } })).filter((m: any) => m.to);
    if (msgs.length) await expoSend(sql, msgs);
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
    // QUOTA DO: kick reinicia a cadência do toca-toca (startAt = agora).
    try { await this.state.storage.put('startAt', now); } catch {}
    await this.state.storage.setAlarm(now + 4000);
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
  }
  async alarm() {
    try {
      const sent: number = (await this.state.storage.get('sent')) || 0;
      // QUOTA DO: backoff calculado pelo tempo desde o kick (startAt), sem
      // escrever 'ticks' a cada tick — 4s nos 1.º 8s, depois 10s (até 40s) e
      // 20s no resto. Menos acordos do alarm e 1 escrita de DO menos por tick.
      const nowT = Date.now();
      const startAt = Number((await this.state.storage.get('startAt')) || 0) || nowT;
      const elapsed = nowT - startAt;
      const nextMs = elapsed < 8000 ? 4000 : elapsed < 40000 ? 10000 : 20000;
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
          if (ch.length) { await this.state.storage.setAlarm(Date.now() + nextMs); return; }
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
            const prevOff = String(full[0].offeredDriverId || '');
            const prevIdx = Number(full[0].offerIdx || 0);
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
              // QUOTA DO: broadcast SÓ quando a oferta rodou de verdade
              // (motorista ou índice mudou), não em cada tick.
              if (offId !== prevOff || Number(fresh.offerIdx || 0) !== prevIdx) { try { await hubBroadcast(this.env); } catch {} }
              await this.state.storage.setAlarm(Date.now() + nextMs);
              return;
            }
          }
        } catch {}
        // QUOTA DO: broadcast de fallback (sem oferta exclusiva) só quando há
        // mesmo push para enviar, não a cada tick.
        if (sent < 3) {
          try { await hubBroadcast(this.env); } catch {}
          await pushTripToDrivers(sql, t.id, String(t.pickupAddress || 'Ponto no mapa'), cut >= 0 ? addr.slice(0, cut) : addr, Array.isArray(t.stops) ? t.stops.length : 0, Number(t.fareEstimate || 0), '🔔 Novo pedido LadiesGo!', byCode[t.rideType] || '');
          await this.state.storage.put('sent', sent + 1);
        }
      } else {
        // Resumo só das viagens em broadcast (as exclusivas já avisam a
        // ofertada). Sem nenhuma aberta, reagenda em silêncio.
        // QUOTA DO: já enviado o máximo de resumos — reagenda a 15s em vez de 4s.
        if (sent >= 3) { try { await this.state.storage.setAlarm(Date.now() + 15000); } catch {} return; }
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
          const toks = await sql`SELECT u."fcmToken" FROM drivers d JOIN users u ON u.id = d."userId" WHERE d."isOnline" = true AND d.status = 'APPROVED' AND COALESCE(u."walletBlocked", 0) = 0 AND u."fcmToken" LIKE 'ExponentPushToken%' AND NOT EXISTS (SELECT 1 FROM trips t2 WHERE t2."driverId" = d.id AND t2.status IN ('ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')) LIMIT 100`;
          const msgs = toks.map((r: any) => ({
            to: r.fcmToken, sound: 'default',
            title: '🔔 Viagens disponíveis — LadiesGo!',
            body: `Tens ${openN} pedido${openN > 1 ? 's' : ''} à espera · abre a app`,
            data: { type: 'pending-summary' },
          })).filter((m: any) => m.to);
          if (msgs.length) await expoSend(sql, msgs);
        } catch {}
        await this.state.storage.put('sent', sent + 1);
      }
      await this.state.storage.setAlarm(Date.now() + nextMs);
    } catch {
      try { await this.state.storage.setAlarm(Date.now() + 10000); } catch {}
    }
  }
}

// ─── TripPush: 1 DO por viagem (id `trip:<tripId>`), WS em HIBERNAÇÃO ───
// Classe NOVA de propósito (não estende o TripRinger: ele é singleton global
// de alarmes/push Expo com lógica de oferta — misturar partia-o).
// Memória do DO: posição viva + throttle + cache de estado.
// Neon: leituras esporádicas de estado (≤1/15s por viagem ativa), POST /notify
// das transições e o histórico mínimo de trip_points (1 ponto/60s, auditoria);
// escritas Neon de estado continuam exclusivas do REST existente.
const PUSH_GPS_MIN_MS = 10_000;
const PUSH_STATUS_TTL_MS = 60_000;
function normH(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return ((n % 360) + 360) % 360;
}
function angDelta(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}
export class TripPush {
  state: any;
  env: any;
  driver: { lat: number; lng: number; h?: number | null; ts: number } | null = null;
  passenger: { lat: number; lng: number; ts: number } | null = null;
  status: string | null = null;
  statusAt = 0;
  tripCache: any = null;
  tripId: string | null = null;
  statusLoaded = false;
  lastEta: number | null = null;
  // Throttle do push vindo do GPS em segundo plano (rota interna /gps).
  lastFixAt = 0;
  pushLat = 0;
  pushLng = 0;
  pushAt = 0;
  pushH: number | null = null;
  // Histórico de auditoria (trip_points): 1 ponto/60s, independente do push.
  lastPointAt = 0;
  pointsOff = false;
  pointsErrAt = 0;
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
        const by = String(b?.by || '').toLowerCase() === 'driver' ? 'driver' : (String(b?.by || '').toLowerCase() === 'passenger' ? 'passenger' : '');
        const reason = String(b?.reason || '').slice(0, 80);
        if (st) {
          await this.hydrate();
          const changed = this.status !== st;
          this.status = st;
          this.statusAt = Date.now();
          if (changed) {
            await this.persistStatus();
            this.broadcast({ t: 'status', status: st, by, reason });
            this.broadcastTag('pub', { t: 'status', status: st });
            this.pushEta();
          }
        }
      } catch {}
      return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
    }
    if (req.method === 'POST' && u.pathname.endsWith('/gps')) {
      // Ponte interna Worker→DO: o GPS da motorista em segundo plano (REST
      // PUT /drivers/location ou WS global live-geo) nunca passa pelo WS da
      // viagem, que é o que serve a passageira. Sem esta ponte o carro fica
      // parado no mapa enquanto a app da motorista está fechada.
      try {
        const b: any = await req.json().catch(() => ({}));
        const la = Number(b?.lat), lo = Number(b?.lng);
        if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) {
          const tId = String(b?.tripId || '').slice(0, 64);
          if (tId && tId !== this.tripId) {
            this.tripId = tId;
            try { await this.state.storage.put('tripId', tId); } catch {}
          }
          await this.onGpsPush(la, lo, String(b?.uid || ''), normH(b?.h)).catch(() => {});
        }
      } catch {}
      return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
    }
    if (req.method === 'POST' && u.pathname.endsWith('/pax')) {
      // Ponte do REST /trips/:id/position (app em segundo plano): o mapa da
      // motorista vê a passageira mesmo quando o WS dela está fechado.
      try {
        const b: any = await req.json().catch(() => ({}));
        const la = Number(b?.lat), lo = Number(b?.lng);
        if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) {
          await this.hydrate();
          if (String(this.status || '') !== 'IN_PROGRESS') {
            this.passenger = { lat: la, lng: lo, ts: Date.now() };
            this.broadcast({ t: 'pax', lat: la, lng: lo, ts: Date.now() });
          }
        }
      } catch {}
      return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
    }
    // Sinal de chamada (vem do POST REST /trips/:id/call/signal).
    if (req.method === 'POST' && u.pathname.endsWith('/call-signal')) {
      try {
        const b: any = await req.json().catch(() => ({}));
        this.broadcastCall({
          t: 'signal',
          signal: { from: String(b?.from || ''), type: String(b?.type || ''), payload: b?.payload ?? null, ts: Number(b?.ts || Date.now()) },
        });
      } catch {}
      return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
    }
    // Mensagem nova no chat: aviso barato aos sockets da viagem.
    if (req.method === 'POST' && u.pathname.endsWith('/chat-poke')) {
      try { this.broadcast({ t: 'unread', n: 1 }); } catch {}
      return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
    }
    // WS de chamadas: vive no DO `calls:<tripId>`, com sockets separados.
    if (u.pathname.endsWith('/call-live')) {
      if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket')
        return new Response('Expected websocket', { status: 426 });
      const ctId = String(req.headers.get('X-Trip-Id') || '').slice(0, 64);
      if (!ctId) return new Response('Missing trip', { status: 400 });
      this.tripId = ctId;
      const cuid = String(req.headers.get('X-User-Id') || '');
      const cpair: any = new WebSocketPair();
      const cclient = cpair[0], cserver = cpair[1];
      try {
        this.state.acceptWebSocket(cserver, ['call']);
        cserver.serializeAttachment({ kind: 'call', uid: cuid });
      } catch {
        return new Response('WS failed', { status: 500 });
      }
      try { cserver.send(JSON.stringify({ t: 'ready' })); } catch {}
      return new Response(null, { status: 101, webSocket: cclient });
    }
    // Link público (sem login): hello só com status + posição da motorista.
    if ((req.headers.get('Upgrade') || '').toLowerCase() === 'websocket' && req.headers.get('X-Public') === '1') {
      const ptId = String(req.headers.get('X-Trip-Id') || '').slice(0, 64);
      if (!ptId) return new Response('Missing trip', { status: 400 });
      this.tripId = ptId;
      try { await this.hydrate(); } catch {}
      if (!this.status) {
        try { const s = await this.state.storage.get('status'); if (s) this.status = String(s); } catch {}
      }
      if (!this.status) {
        const st = String(req.headers.get('X-Trip-Status') || '').toUpperCase().slice(0, 20);
        if (st) this.status = st;
      }
      const ppair: any = new WebSocketPair();
      const pclient = ppair[0], pserver = ppair[1];
      try {
        this.state.acceptWebSocket(pserver, ['pub']);
        pserver.serializeAttachment({ kind: 'pub', uid: '' });
      } catch {
        return new Response('WS failed', { status: 500 });
      }
      const pubHello: any = {
        t: 'hello',
        status: this.status,
        driver: this.driver && Date.now() - this.driver.ts < 120000
          ? { lat: this.driver.lat, lng: this.driver.lng, h: this.driver.h ?? null }
          : null,
      };
      try { pserver.send(JSON.stringify(pubHello)); } catch {}
      return new Response(null, { status: 101, webSocket: pclient });
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
    try { server.serializeAttachment({ lastFixAt: 0, pushLat: 0, pushLng: 0, pushAt: 0, lastPaxAt: 0, uid }); } catch {}
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
    this.broadcastTag('pub', { t: 'eta', min: eta });
  }
  async webSocketMessage(ws: any, raw: any) {
    let m: any;
    try { m = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { return; }
    if (!m || typeof m !== 'object') return;
    let tags: string[] = [];
    try { tags = this.state.getTags(ws) || []; } catch {}
    // Link público: só leitura sanitizada. Chamadas: só recebem sinais.
    if (tags.indexOf('pub') >= 0) {
      if (m.t === 'state') {
        const pubState: any = {
          t: 'state',
          status: this.status,
          driver: this.driver ? { lat: this.driver.lat, lng: this.driver.lng, h: this.driver.h ?? null } : null,
          ts: Date.now(),
        };
        try { ws.send(JSON.stringify(pubState)); } catch {}
      }
      return;
    }
    if (tags.indexOf('call') >= 0) {
      if (m.t === 'ping') { try { ws.send(JSON.stringify({ t: 'pong', ts: Date.now() })); } catch {} return; }
      if (m.t === 'signal') {
        const typ = String(m.type || '');
        if (typ === 'end' || typ === 'reject' || typ === 'cancel') {
          let cuid = '';
          try { cuid = String((ws.deserializeAttachment() || {}).uid || ''); } catch {}
          this.broadcastCall({ t: 'signal', signal: { from: cuid, type: typ, payload: null, ts: Date.now() } });
        }
      }
      return;
    }
    if (m.t === 'gps') { await this.onGps(ws, m).catch(() => {}); return; }
    if (m.t === 'heading') { await this.onHeading(ws, m).catch(() => {}); return; }
    if (m.t === 'chat') {
      const text = String((m as any).text || '').trim().slice(0, 300);
      if (!text) return;
      // Efémero: difunde já (exceto a quem enviou); persistência continua no REST POST /:id/chat (fonte de verdade).
      this.broadcastExcept(ws, { t: 'chat', text, from: String((m as any).from || '').slice(0, 40), ts: Date.now() });
      return;
    }
    if (m.t === 'state') {
      // (2026-10-30) era refreshStatus(true): cada `state` forçava uma leitura à D1
      // mesmo com o estado já fresco. O push de transição continua a ser imediato —
      // isto é só o refresh passivo do WS, que agora respeita o TTL de 60 s.
      await this.refreshStatus(false).catch(() => null);
      try { ws.send(JSON.stringify({ t: 'state', status: this.status, driver: this.driver ? { lat: this.driver.lat, lng: this.driver.lng, h: this.driver.h ?? null } : null, pax: this.passenger ? { lat: this.passenger.lat, lng: this.passenger.lng } : null, etaMin: this.etaMin(), ts: Date.now() })); } catch {}
      return;
    }
    // Resto ignora.
  }
  async webSocketClose(_ws: any, _code: any, _reason: any, _wasClean: any) {}
  async webSocketError(ws: any, _err: any) { try { ws.close(1011, 'err'); } catch {} }
  // Orientação em tempo real (bússola do telemóvel da motorista). Mensagens
  // curtas e efémeras: não tocam na BD, só memória do DO e broadcast ao vivo.
  async onHeading(ws: any, m: any) {
    let tags: string[] = [];
    try { tags = this.state.getTags(ws) || []; } catch {}
    if (tags.indexOf('driver') < 0) return;
    const h = normH(m?.h);
    if (h == null) return;
    const now = Date.now();
    const att: any = (() => { try { return ws.deserializeAttachment() || {}; } catch { return {}; } })();
    if (now - Number(att.lastHdgAt || 0) < 700) return;
    att.lastHdgAt = now;
    try { ws.serializeAttachment(att); } catch {}
    if (this.driver) this.driver.h = h;
    this.broadcastExcept(ws, { t: 'driverheading', h, ts: now });
  }
  async onGps(ws: any, m: any) {
    // Motorista e passageira enviam GPS. A tag vem do upgrade (X-Is-Driver) e é reforçada pelo claim role.
    let tags: string[] = [];
    try { tags = this.state.getTags(ws) || []; } catch {}
    const claimed = String(m?.role || '').toLowerCase();
    const la = Number(m?.lat), lo = Number(m?.lng);
    const hh = normH(m?.h);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return;
    const now = Date.now();
    const att: any = (() => { try { return ws.deserializeAttachment() || {}; } catch { return {}; } })();
    // Motorista: máx 1 fix/10s. SÓ memória do DO — nada no Neon por fix.
    if (tags.indexOf('driver') >= 0 && claimed === 'driver') {
      if (now - Number(att.lastFixAt || 0) < PUSH_GPS_MIN_MS) return;
      att.lastFixAt = now;
      this.driver = { lat: la, lng: lo, h: hh != null ? hh : (this.driver?.h ?? null), ts: now };
      // Espelha o fix na DriverGeo global: Ǹ o que alimenta o polling da
      // passageira (/trips/:id?view=web) e o link de partilha (/trips/public).
      // Sem isto ficavam presos a posi����es antigas enquanto o WS ia fresco.
      // noTripPush: o fix jǭ foi entregue por este WS �?" nǜo volta ao TripPush.
      try { const _gp = geoSet(this.env, { userId: String(att.uid || ''), lat: la, lng: lo, h: hh, noTripPush: true }); try { this.state.waitUntil(_gp); } catch { } } catch {}
      await this.refreshStatus(false);
      try { this.state.waitUntil(this.persistPoint(la, lo, Number(m?.acc))); } catch { this.persistPoint(la, lo, Number(m?.acc)).catch(() => {}); }
      // A motorista é monitorizada do início ao fim da viagem, por isso a sua
      // posição é sempre transmitida à passageira. Para não spammar, só se
      // redesenha quando o carro anda (>=150m) ou a cada 30s.
      const movedKm = att.pushAt ? havKm(Number(att.pushLat), Number(att.pushLng), la, lo) : 1;
      const lastH = normH(att.pushH);
      const hChg = hh != null && lastH != null && angDelta(hh, lastH) >= 15;
      if (movedKm >= 0.15 || now - Number(att.pushAt || 0) >= 30000 || hChg) {
        att.pushLat = la; att.pushLng = lo; att.pushAt = now;
        if (hh != null) att.pushH = hh;
        this.broadcastExcept(ws, { t: 'driver', lat: la, lng: lo, h: hh != null ? hh : null, ts: now });
        this.broadcastTag('pub', { t: 'driver', lat: la, lng: lo, h: hh != null ? hh : null, ts: now });
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
  // GPS que chega por fora do WS da viagem (app em segundo plano): a posição
  // vem sempre do DO DriverGeo, que já é a fonte de verdade do mapa. Mesmo
  // throttle do caminho WS: 1 fix/10s e só redesenha quando o carro anda
  // (>=150m) ou a cada 30s — assim a passageira vê o carro mexer-se em
  // tempo real mesmo com a app da motorista fechada.
  async onGpsPush(la: number, lo: number, uid: string, h?: number | null) {
    const now = Date.now();
    if (now - Number(this.lastFixAt || 0) < PUSH_GPS_MIN_MS) return;
    this.lastFixAt = now;
    const hh = normH(h);
    this.driver = { lat: la, lng: lo, h: hh != null ? hh : (this.driver?.h ?? null), ts: now };
    await this.refreshStatus(false);
    // Viagem terminada/cancelada: nǜo vale a pena difunde posi����es.
    const st = String(this.status || '');
    if (st && st !== 'ACCEPTED' && st !== 'DRIVER_ARRIVED' && st !== 'IN_PROGRESS') return;
    try { this.state.waitUntil(this.persistPoint(la, lo)); } catch { this.persistPoint(la, lo).catch(() => {}); }
    const movedKm = this.pushAt ? havKm(Number(this.pushLat), Number(this.pushLng), la, lo) : 1;
    const hChg = hh != null && this.pushH != null && angDelta(hh, this.pushH) >= 15;
    if (movedKm >= 0.15 || now - Number(this.pushAt || 0) >= 30000 || hChg) {
      this.pushLat = la; this.pushLng = lo; this.pushAt = now;
      if (hh != null) this.pushH = hh;
      this.broadcast({ t: 'driver', lat: la, lng: lo, h: hh != null ? hh : null, ts: now });
      this.broadcastTag('pub', { t: 'driver', lat: la, lng: lo, h: hh != null ? hh : null, ts: now });
      this.pushEta();
    }
  }
  // Histórico de auditoria: 1 ponto/180s por viagem ativa. Não bloqueia o WS
  // (waitUntil) e não substitui a posição viva, que continua só em memória.
  // 60s -> 180s (2026-10-30): o rasto é histórico, não serve para desenhar o
  // mapa ao vivo; 180s poupa 2/3 das escritas em `trip_points` (3 tabelas de
  // índice cada INSERT) sem perda visível. Uma viagem de 15 min passa de ~15
  // para ~5 pontos.
  async persistPoint(lat: number, lng: number, accuracy?: number) {
    try {
      const st = String(this.status || '');
      if (st !== 'ACCEPTED' && st !== 'DRIVER_ARRIVED' && st !== 'IN_PROGRESS') return;
      const now = Date.now();
      if (now - this.lastPointAt < 180000) return;
      if (this.pointsOff && now - this.pointsErrAt < 300000) return;
      this.lastPointAt = now;
      let tripId = this.tripId;
      if (!tripId) { try { tripId = await this.state.storage.get('tripId'); } catch {} }
      if (!tripId) { this.lastPointAt = 0; return; }
      const sql = neon(this.env.DB);
      const acc = Number(accuracy);
      await sql`INSERT INTO trip_points (id, "tripId", lat, lng, accuracy, ts) VALUES (${crypto.randomUUID()}, ${String(tripId)}, ${lat}, ${lng}, ${Number.isFinite(acc) ? acc : null}, ${now})`;
      this.pointsOff = false;
    } catch {
      this.pointsOff = true;
      this.pointsErrAt = Date.now();
    }
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
      this.broadcastTag('pub', { t: 'status', status: r.status });
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
  // Sockets laterais (chamada / link público) não são da viagem: ficam fora
  // do broadcast geral para não receberem chat, pax nem estado interno.
  isSideSock(s: any): boolean {
    try {
      const a = (s.deserializeAttachment && s.deserializeAttachment()) || {};
      const k = String(a.kind || '');
      return k === 'call' || k === 'pub';
    } catch { return false; }
  }
  broadcast(obj: any) {
    let msg = '';
    try { msg = JSON.stringify(obj); } catch { return; }
    let socks: any[] = [];
    try { socks = this.state.getWebSockets(); } catch { return; }
    for (const s of socks) { if (this.isSideSock(s)) continue; try { s.send(msg); } catch {} }
  }
  broadcastExcept(ws: any, obj: any) {
    let msg = '';
    try { msg = JSON.stringify(obj); } catch { return; }
    let socks: any[] = [];
    try { socks = this.state.getWebSockets(); } catch { return; }
    for (const s of socks) { if (s === ws || this.isSideSock(s)) continue; try { s.send(msg); } catch {} }
  }
  // Versão sanitizada para os sockets com uma tag (ex.: 'pub').
  broadcastTag(tag: string, obj: any) {
    let msg = '';
    try { msg = JSON.stringify(obj); } catch { return; }
    let socks: any[] = [];
    try { socks = this.state.getWebSockets(tag); } catch { return; }
    for (const s of socks) { try { s.send(msg); } catch {} }
  }
  // Sinais de chamada: só sockets com attachment.kind === 'call'.
  broadcastCall(obj: any) {
    let msg = '';
    try { msg = JSON.stringify(obj); } catch { return; }
    let socks: any[] = [];
    try { socks = this.state.getWebSockets('call'); } catch { return; }
    for (const s of socks) {
      try {
        const a = (s.deserializeAttachment && s.deserializeAttachment()) || {};
        if (String(a.kind || '') !== 'call') continue;
        s.send(msg);
      } catch {}
    }
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

// ─── NotifHub: 1 DO por utilizador, WS hibernável do centro de notificações ───
// O Worker faz POST /poke (não bloqueia a resposta) e o hub avisa só os
// sockets com a tag `u:<userId>` — o cliente atualiza o contador/listagem.
export class NotifHub {
  state: any;
  env: any;
  constructor(state: any, env: any) {
    this.state = state;
    this.env = env;
    try { this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch {}
  }
  async fetch(req: any) {
    const u = new URL(req.url);
    if (req.method === 'POST' && u.pathname.endsWith('/poke')) {
      try {
        const b: any = await req.json().catch(() => ({}));
        const uid = String(b?.userId || '').slice(0, 32);
        const n = Math.max(1, Math.min(99, Number(b?.n) || 1));
        const msg = JSON.stringify({ t: 'notif', n });
        for (const s of this.socks()) {
          let tags: string[] = [];
          try { tags = this.state.getTags(s) || []; } catch {}
          if (uid && tags.indexOf(`u:${uid}`) < 0) continue;
          try { s.send(msg); } catch {}
        }
      } catch {}
      return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
    }
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket')
      return new Response('Expected websocket', { status: 426 });
    const uid = String(req.headers.get('X-User-Id') || '').slice(0, 32);
    if (!uid) return new Response('Missing user', { status: 400 });
    const pair: any = new WebSocketPair();
    const client = pair[0], server = pair[1];
    try {
      this.state.acceptWebSocket(server, [`u:${uid}`]);
      server.serializeAttachment({ uid });
    } catch {
      return new Response('WS failed', { status: 500 });
    }
    try { server.send(JSON.stringify({ t: 'hello' })); } catch {}
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
// ── Persistência do mapa de posições (QUOTA DO, 2026-10-30) ──────────────────
// Uma ÚNICA chave (`snapshot:v1`) com todas as posições válidas. Antes, cada
// motorista tinha a sua chave (`p:<userId>`) e o `load()` fazia
// `storage.list({prefix:'p:'})` — o custo de acordar o objeto crescia com o nº
// de motoristas e as chaves antigas nunca eram apagadas. Medido em produção
// (`geo:global`, 48 h): 15 365 linhas de storage lidas para 3 482 pedidos
// (~4,4 por pedido) com apenas 1 motorista real. Agora é 1 leitura por acordar
// e 1 escrita por gravação, independente do nº de motoristas; o snapshot só
// leva posições com menos de 18 min (as velhas caem sozinhas, sem chaves órfãs).
const GEO_SNAP_KEY = 'snapshot:v1';
const GEO_LEGACY_PREFIX = 'p:';
// GEO_TTL_MS = 18 min (já declarado acima, junto do geoStub).
const GEO_SNAP_MAX_CHARS = 100 * 1024; // limite do DO por valor é 128 KiB

export class DriverGeo {
  state: any;
  env: any;
  pos: Map<string, any>;
  // Throttle/hash da difusão do mapa para os espectadores (tag 'pax').
  lastNearbyAt = 0;
  lastNearbyHash = '';
  constructor(state: any, env: any) {
    this.state = state;
    this.env = env;
    this.pos = new Map();
    try { this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch {}
  }
  json(o: any): Response {
    return new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
  }
  socks(): any[] { try { return this.state.getWebSockets(); } catch { return []; } }
  // Centro/raio pedidos por um espectador do mapa (?lat=&lng=&radius=).
  paxCenter(a: any): any {
    if (!a || a.lat == null || a.lng == null || a.lat === '' || a.lng === '') return null;
    const lat = Number(a.lat), lng = Number(a.lng), r = Number(a.radius);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, radius: Number.isFinite(r) && r >= 200 && r <= 50000 ? r : 5000 };
  }
  // Vista do mapa para qualquer autenticado: só id/posição/rumo, nunca
  // nome, telefone ou categorias. Só motoristas online vistos nos últimos 5min.
  // Com um centro, aplica o mesmo Haversine do /drivers/nearby (raio em metros).
  nearbyFrame(center?: any): any {
    const now = Date.now();
    const drivers: any[] = [];
    for (const v of this.pos.values()) {
      if (!v || !v.online) continue;
      if (now - Number(v.ts || 0) >= 5 * 60 * 1000) continue;
      if (center && havKm(center.lat, center.lng, Number(v.lat), Number(v.lng)) > center.radius / 1000) continue;
      drivers.push({
        id: String(v.driverId || v.userId || ''),
        lat: Number(v.lat),
        lng: Number(v.lng),
        h: v.h != null ? Number(v.h) : null,
      });
    }
    return { t: 'nearby', drivers, ts: now };
  }
  // Difusão aos espectadores: no máximo 1x/5s e só quando algo mudou.
  // Cada socket recebe a frame filtrada pelo seu próprio centro (se tiver).
  broadcastNearby(force = false) {
    const now = Date.now();
    if (!force && now - this.lastNearbyAt < 5000) return;
    const frame = this.nearbyFrame();
    const hash = frame.drivers.map((d: any) => `${d.id}:${d.lat.toFixed(4)},${d.lng.toFixed(4)},${d.h == null ? '' : d.h}`).join('|');
    if (hash === this.lastNearbyHash) return;
    this.lastNearbyAt = now;
    this.lastNearbyHash = hash;
    for (const s of this.socks()) {
      let tags: string[] = [];
      let a: any = null;
      try { tags = this.state.getTags(s) || []; } catch {}
      if (tags.indexOf('pax') < 0) continue;
      try { a = (s.deserializeAttachment && s.deserializeAttachment()) || null; } catch {}
      const center = this.paxCenter(a);
      try { s.send(JSON.stringify(center ? this.nearbyFrame(center) : frame)); } catch {}
    }
  }
  // A hibernação do DO limpa a memória. Sem isto, as posições desapareciam
  // quando o objeto ficava ocioso e a passagreira deixava de ver carros.
  loaded = false;
  loadMode = '';        // 'snapshot' | 'legacy-list' | 'empty' (diagnóstico)
  legacyMigrated = false;
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    const now = Date.now();
    try {
      // 1 leitura, seja qual for o nº de motoristas.
      const snap: any = await this.state.storage.get(GEO_SNAP_KEY);
      if (snap && typeof snap === 'object') {
        this.loadMode = 'snapshot';
        for (const uid of Object.keys(snap)) {
          const v = snap[uid];
          if (!v || now - Number(v.ts || 0) > GEO_TTL_MS) continue;
          this.pos.set(uid, v);
        }
        return;
      }
      // Migração única: versões anteriores guardavam 1 chave por motorista.
      // Corre uma vez, apaga as chaves antigas e deixa o snapshot escrito.
      const all: any = await this.state.storage.list({ prefix: GEO_LEGACY_PREFIX });
      if (!all || !all.size) { this.loadMode = 'empty'; return; }
      const kills: string[] = [];
      for (const [k, v] of all) {
        kills.push(String(k));
        const uid = String(k).slice(GEO_LEGACY_PREFIX.length);
        if (v && now - Number(v.ts || 0) <= GEO_TTL_MS) this.pos.set(uid, v);
      }
      this.loadMode = 'legacy-list';
      this.legacyMigrated = true;
      try { await this.state.storage.delete(kills); } catch {}
      try { await this.persistSnapshot(now); } catch {}
    } catch (e) { try { console.warn('geo load falhou', String(e)); } catch {} }
  }
  // Grava o mapa todo numa só chave (1 linha escrita) e poda o que já expirou.
  async persistSnapshot(now = Date.now()) {
    const recs: any[] = [];
    for (const [uid, v] of this.pos) {
      if (!v || now - Number(v.ts || 0) > GEO_TTL_MS) continue;
      recs.push([uid, v]);
    }
    // Mais recentes primeiro: se o valor passar do limite, ficam os mais úteis.
    recs.sort((a: any, b: any) => Number(b[1].ts || 0) - Number(a[1].ts || 0));
    const out: any = {};
    let chars = 2;
    for (const [uid, v] of recs) {
      const rec = v.ps ? v : { ...v, ps: now };
      const size = JSON.stringify(rec).length + String(uid).length + 6;
      if (chars + size > GEO_SNAP_MAX_CHARS) break;
      out[uid] = rec;
      chars += size;
    }
    await this.state.storage.put(GEO_SNAP_KEY, out);
    return Object.keys(out).length;
  }
  // Persistência fora do caminho crítico da resposta (nunca atrasa um pedido).
  persistNow() {
    try { this.state.waitUntil(this.persistSnapshot(Date.now())); }
    catch { try { this.persistSnapshot().catch(() => {}); } catch {} }
  }
  // Aplica uma atualização de posição vinda de HTTP (/set) ou de mensagem WS.
  setPos(userId: string, lat: number, lng: number, cats: any, online: boolean | null, h?: number | null): boolean {
    const prev = this.pos.get(userId) || null;
    const wasOnline = !!prev?.online;
    const now = Date.now();
    const hh = normH(h);
    this.pos.set(userId, {
      userId,
      driverId: prev?.driverId || '',
      lat,
      lng,
      h: hh != null ? hh : (prev?.h ?? null),
      // Categorias só podem mudar com a motorista offline (regra de negócio):
      // com a sessão online, mantém as categorias já em vigor.
      cats: prev && prev.online ? (prev.cats || null) : (cats != null ? cats : (prev?.cats || null)),
      online: online != null ? !!online : !!(prev?.online),
      ts: now,
    });
    // QUOTA DO: persistir no storage só na transição offline→online e no
    // máximo 1x/2min por motorista (via ps). Sem isto, a hibernação/restart
    // do DO perdia o Map em memória e load() encontrava o storage vazio —
    // motoristas continuavam "online" na D1 mas ficavam invisíveis no
    // /drivers/nearby até ao próximo ping (o utilizador via "Sem motoristas
    // de momento" e só sumia com toggle offline→online). ~720 escritas/dia
    // por motorista (2min) mantém-se bem dentro da quota DO (100k/dia).
    const goingOnline = online === true && !wasOnline;
    if (goingOnline || !prev || now - Number(prev.ps || 0) > 120_000) {
      this.pos.set(userId, { ...this.pos.get(userId), ps: now });
      this.persistNow();
    }
    this.broadcastNearby();
    return wasOnline;
  }
  // Espelha a transição online/offline da ligação WS na D1, para o filtro
  // "isOnline" do buildOfferQueue e do /trips/incoming ficar correto (a
  // presença por WS não passava pelo /drivers/position).
  async d1Online(userId: string, online: boolean) {
    try {
      const sql = neon(this.env.DB);
      if (online) {
        const w = await sql`SELECT "walletBlocked" FROM users WHERE id = ${userId} LIMIT 1`;
        if (w.length && Number(w[0].walletBlocked || 0)) {
          this.pos.delete(userId);
          this.persistNow();
          await sql`UPDATE drivers SET "isOnline" = false, "updatedAt" = NOW() WHERE "userId" = ${userId}`;
          return;
        }
      }
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
      const viewer = String(req.headers.get('X-Viewer') || '');
      const pair: any = new WebSocketPair();
      const client = pair[0], server = pair[1];
      if (viewer === 'pax') {
        // Espectador do mapa (nearby-live): recebe o estado atual e só frames
        // sanitizados; nunca envia posições.
        const qLat = u.searchParams.get('lat'), qLng = u.searchParams.get('lng');
        const center = this.paxCenter({ lat: qLat, lng: qLng, radius: u.searchParams.get('radius') });
        try {
          this.state.acceptWebSocket(server, ['pax']);
          server.serializeAttachment({ userId, viewer: 'pax', ...(center || {}) });
        } catch {
          return new Response('WS failed', { status: 500 });
        }
        try { await this.load(); } catch {}
        try { server.send(JSON.stringify(this.nearbyFrame(center))); } catch {}
        return new Response(null, { status: 101, webSocket: client });
      }
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
      const wasOnline = this.setPos(userId, Number(b.lat), Number(b.lng), b.cats, b.online != null ? !!b.online : null, normH(b.h));
      // Ponte para o WS da viagem: sem isto o carro fica parado no mapa da
      // passageira enquanto a app da motorista estǭ fechada (o WS global
      // live-geo e o REST /position nunca tocavam no TripPush).
      try { this.state.waitUntil(geoPushToTrip(this.env, userId, Number(b.lat), Number(b.lng), !!b.noTripPush, normH(b.h))); } catch {}
      return this.json({ wasOnline });
    }
    if (req.method === 'POST' && path.endsWith('/del')) {
      const b: any = await req.json().catch(() => ({}));
      const uid = String(b.userId || '');
      this.pos.delete(uid);
      this.persistNow();
      this.broadcastNearby();
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
    // Diagnóstico (chamado só pelo debug do staging): de onde veio o load()
    // ('snapshot' = chave única, 'legacy-list' = migração das chaves 'p:'
    // antigas) e quantas posições estão em memória.
    if (path.endsWith('/stats')) {
      await this.load();
      let bytes = 0;
      try { bytes = JSON.stringify(Array.from(this.pos.entries())).length; } catch {}
      return this.json({ mode: this.loadMode, migrated: this.legacyMigrated, drivers: this.pos.size, snapshotBytes: bytes, snapshotMaxBytes: GEO_SNAP_MAX_CHARS });
    }
    return new Response('not found', { status: 404 });
  }
  async webSocketMessage(ws: any, raw: any) {
    // Fase 2 — Cap de mensagem (64KB) + token bucket
    const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw).length : (raw?.byteLength || 0);
    if (bytes > WS_MAX_MESSAGE_BYTES) { try { ws.close(1009, 'mensagem grande'); } catch {} return; }
    const a = (ws.deserializeAttachment && ws.deserializeAttachment()) || {};
    const userId = String(a.userId || '');
    if (!userId) return;
    // Espectador do mapa: não escreve posições.
    if (a.viewer === 'pax') return;
    // Token bucket
    if (!a.bucket) a.bucket = newBucket();
    if (!tryConsume(a.bucket)) return;
    ws.serializeAttachment(a);
    let m: any = null;
    try { m = JSON.parse(typeof raw === 'string' ? raw : ''); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.offline) {
      this.pos.delete(userId);
      this.persistNow();
      await this.d1Online(userId, false);
      this.broadcastNearby();
      return;
    }
    const lat = Number(m.lat), lng = Number(m.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const cats = Array.isArray(m.cats) ? m.cats.map((x: any) => String(x).slice(0, 30)).slice(0, 6) : null;
    const hh = normH(m.h);
    await this.load();
    const wasOnline = this.setPos(userId, lat, lng, cats, true, hh);
    if (!wasOnline) await this.d1Online(userId, true);
    // GPS por WebSocket global ��' WS da viagem (mesma ponte do /set).
    try { this.state.waitUntil(geoPushToTrip(this.env, userId, lat, lng, false, hh)); } catch {}
  }
  async webSocketClose(_ws: any, _code: any, _reason: any, _wasClean: any) {
    // Mantém a posição até expirar (TTL na leitura); nova ligação repõe.
  }
  async webSocketError(ws: any, _err: any) { try { ws.close(1011, 'err'); } catch {} }
}

// ════════════════════════════════════════════════════════════════════════════════
// RESERVA COMPARTILHADA — Partida Anunciada
// ════════════════════════════════════════════════════════════════════════════════

// Uma partida deixa de ser válida 2h após o horário marcado.
function sdExpired(status: any, expiresAt: any, nowMs = Date.now()) {
  try {
    if (status !== 'active' && status !== 'full') return false;
    const e = Date.parse(String(expiresAt || ''));
    return Number.isFinite(e) && e <= nowMs;
  } catch (_) { return false; }
}

// POST /api/v1/shared/departures — Motorista anuncia uma partida compartilhada
app.post('/api/v1/shared/departures', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  const did = await driverIdFor(sql, user.sub);
  if (!did) return c.json({ message: 'Sem registo de motorista.' }, 404);
  // Verificar se motorista está bloqueada (saldo negativo) — permite apenas 1 exceção
  const drv = await sql`SELECT "walletBalance", "walletBlocked", "negTrips" FROM users WHERE id = ${user.sub} LIMIT 1`;
  if (drv.length && Number(drv[0].walletBlocked || 0) && Number(drv[0].negTrips || 0) > 0) {
    return c.json({ message: 'Conta bloqueada. Carregue a carteira antes de anunciar.' }, 403);
  }
  const originLat = Number(b.originLat), originLng = Number(b.originLng);
  const destLat = Number(b.destLat), destLng = Number(b.destLng);
  if (!Number.isFinite(originLat) || !Number.isFinite(originLng) || !Number.isFinite(destLat) || !Number.isFinite(destLng)) {
    return c.json({ message: 'Coordenadas inválidas.' }, 400);
  }
  const category = String(b.category || 'Económico').slice(0, 30);
  const totalSeats = Number(b.totalSeats || 1);
  if (!(totalSeats > 0)) return c.json({ message: 'Número de lugares inválido.' }, 400);
  const totalPrice = Number(b.totalPrice || 0);
  const pricePerSeat = Number(b.pricePerSeat || Math.ceil(totalPrice / totalSeats));
  const scheduledAt = String(b.scheduledAt || new Date().toISOString());
  const _schedMs = Date.parse(scheduledAt);
  const expiresAt = new Date((Number.isFinite(_schedMs) ? _schedMs : Date.now()) + 2 * 60 * 60 * 1000).toISOString(); // +2h após a partida
  const id = 'sd_' + crypto.randomUUID().slice(0, 12);
  const d = await sql`SELECT d."userId", u.name, u.phone, u."profilePhoto" FROM drivers d JOIN users u ON u.id = d."userId" WHERE d.id = ${did} LIMIT 1`;
  if (!d.length) return c.json({ message: 'Motorista não encontrada.' }, 404);
  const driverRow = d[0];
  await sql`INSERT INTO shared_departures (id, driver_id, origin_lat, origin_lng, origin_name, dest_lat, dest_lng, dest_name, category, total_price, price_per_seat, total_seats, iban, express_code, whatsapp_number, scheduled_at, expires_at, status, created_at) VALUES (${id}, ${did}, ${originLat}, ${originLng}, ${String(b.originName || '').slice(0, 80)}, ${destLat}, ${destLng}, ${String(b.destName || '').slice(0, 80)}, ${category}, ${totalPrice}, ${pricePerSeat}, ${totalSeats}, ${String(b.iban || '').slice(0, 60)}, ${String(b.expressCode || '').slice(0, 30)}, ${String(driverRow.phone || '')}, ${scheduledAt}, ${expiresAt}, 'active', NOW())`;
  return c.json({ ok: true, id, driver: { id: did, name: driverRow.name, phone: driverRow.phone, photo: photoUrl(c, driverRow.profilePhoto) }, category, totalSeats, pricePerSeat, totalPrice, status: 'active', expiresAt });
});

// GET /api/v1/shared/departures/nearby — Lista partidas próximas (passageira)
app.get('/api/v1/shared/departures/nearby', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const lat = Number(c.req.query('lat')), lng = Number(c.req.query('lng'));
  const user = c.get('user');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return c.json({ message: 'Coordenadas inválidas.' }, 400);
  const now = new Date().toISOString();
  // Não mostrar partidas expiradas (2h após a partida) nem lotadas (full) para passageiras comuns.
  // A motorista vê suas próprias partidas (incluindo full) no painel dela.
  const rows = await sql`SELECT sd.*, d."userId", u.name AS driver_name, u.phone AS driver_phone, u."profilePhoto" AS driver_photo, (SELECT COUNT(*) FROM shared_reservations sr WHERE sr.departure_id = sd.id AND sr.status IN ('pending','paid')) AS queue_count, (SELECT sr.position FROM shared_reservations sr WHERE sr.departure_id = sd.id AND sr.passenger_id = ${user.sub} AND sr.status IN ('pending','paid') LIMIT 1) AS my_position, (SELECT sr.expires_at FROM shared_reservations sr WHERE sr.departure_id = sd.id AND sr.passenger_id = ${user.sub} AND sr.status IN ('pending','paid') LIMIT 1) AS my_expires_at FROM shared_departures sd JOIN drivers d ON d.id = sd.driver_id JOIN users u ON u.id = d."userId" WHERE sd.status = 'active' AND sd.seats_taken < sd.total_seats AND sd.expires_at > ${now} ORDER BY sd.created_at DESC LIMIT 100`;
  const hav = (a1: number, a2: number, b1: number, b2: number) => {
    const R = 6371;
    const dLat = (b1 - a1) * Math.PI / 180;
    const dLng = (b2 - a2) * Math.PI / 180;
    const la1 = a1 * Math.PI / 180, la2 = b1 * Math.PI / 180;
    const x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  };
  const list = (rows || []).map((r: any) => {
    const dist = hav(lat, lng, Number(r.origin_lat), Number(r.origin_lng));
    return {
      id: r.id,
      driverId: r.driver_id,
      driverName: r.driver_name,
      driverPhone: r.driver_phone,
      driverPhoto: photoUrl(c, r.driver_photo),
      originLat: r.origin_lat, originLng: r.origin_lng, originName: r.origin_name,
      destLat: r.dest_lat, destLng: r.dest_lng, destName: r.dest_name,
      category: r.category,
      totalPrice: r.total_price, pricePerSeat: r.price_per_seat,
      totalSeats: r.total_seats, seatsTaken: r.seats_taken, seatsAvailable: Number(r.total_seats) - Number(r.seats_taken),
      iban: r.iban, expressCode: r.express_code, whatsappNumber: r.whatsapp_number,
      scheduledAt: r.scheduled_at, status: r.status,
      distanceKm: Math.round(dist * 10) / 10,
      queueCount: Number(r.queue_count || 0),
      myPosition: (r.my_position == null) ? null : Number(r.my_position),
      myExpiresAt: r.my_expires_at || null,
      createdAt: r.created_at,
    };
  }).sort((a: any, b: any) => a.distanceKm - b.distanceKm);
  return c.json({ departures: list });
});

// POST /api/v1/shared/departures/:id/reserve — Passageira entra na fila
app.post('/api/v1/shared/departures/:id/reserve', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const departureId = c.req.param('id');
  const nowIso = new Date().toISOString();
  const dep = await sql`SELECT * FROM shared_departures WHERE id = ${departureId} AND status = 'active' AND seats_taken < total_seats AND (expires_at IS NULL OR expires_at > ${nowIso}) LIMIT 1`;
  if (!dep.length) return c.json({ message: 'Partida não encontrada, sem vagas ou já expirada.' }, 404);
  const d = dep[0];
  const existing = await sql`SELECT id FROM shared_reservations WHERE departure_id = ${departureId} AND passenger_id = ${user.sub} AND status IN ('pending','paid') LIMIT 1`;
  if (existing.length) return c.json({ message: 'Você já tem uma reserva nesta partida.' }, 400);
  // Calcular posição na fila (por ordem de criação) — atómico no INSERT
  const id = 'sr_' + crypto.randomUUID().slice(0, 12);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const ins = await sql`INSERT INTO shared_reservations (id, departure_id, passenger_id, position, status, expires_at, created_at) VALUES (${id}, ${departureId}, ${user.sub}, (SELECT COUNT(*) + 1 FROM shared_reservations WHERE departure_id = ${departureId} AND status IN ('pending','paid')), 'pending', ${expiresAt}, NOW()) RETURNING position`;
  const position = Number(ins[0]?.position || 0);
  return c.json({ ok: true, id, departureId, position, pricePerSeat: d.price_per_seat, expiresAt, message: 'Reserva criada. Pague em 10 minutos e envie o comprovante no WhatsApp da motorista.' });
});

// GET /api/v1/shared/departures/:id/payment — Dados de pagamento da motorista
app.get('/api/v1/shared/departures/:id/payment', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const departureId = c.req.param('id');
  const user = c.get('user');
  const dep = await sql`SELECT sd.iban, sd.express_code, sd.whatsapp_number, sd.driver_id, sd.price_per_seat, sd.expires_at AS dep_expires_at, sd.scheduled_at, sd.origin_lat, sd.origin_lng, sd.origin_name, sd.dest_lat, sd.dest_lng, sd.dest_name, u.name AS driver_name, u.phone AS driver_phone, u."profilePhoto" AS driver_photo FROM shared_departures sd JOIN drivers d ON d.id = sd.driver_id JOIN users u ON u.id = d."userId" WHERE sd.id = ${departureId} LIMIT 1`;
  if (!dep.length) return c.json({ message: 'Partida não encontrada.' }, 404);
  const r = dep[0];
  // Verificar se o usuário tem reserva nesta partida
  const res = await sql`SELECT id, status, position, expires_at FROM shared_reservations WHERE departure_id = ${departureId} AND passenger_id = ${user.sub} AND status IN ('pending','paid') ORDER BY created_at DESC LIMIT 1`;
  if (!res.length) return c.json({ message: 'Você não tem reserva nesta partida.' }, 403);
  const rr = res[0];
  return c.json({
    driver: { name: r.driver_name, phone: r.driver_phone, photo: photoUrl(c, r.driver_photo) },
    iban: r.iban, expressCode: r.express_code, whatsappNumber: r.whatsapp_number,
    pricePerSeat: r.price_per_seat || 0, expiresAt: rr.expires_at || r.dep_expires_at,
    myPosition: rr.position, myStatus: rr.status, scheduledAt: r.scheduled_at,
    // Coordenadas para a passageira poder ver a rota da partida ("Ver rota").
    originLat: r.origin_lat, originLng: r.origin_lng, originName: r.origin_name,
    destLat: r.dest_lat, destLng: r.dest_lng, destName: r.dest_name,
  });
});

// POST /api/v1/shared/departures/:id/approve — Motorista aprova passageira
app.post('/api/v1/shared/departures/:id/approve', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const departureId = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const passengerId = String(b.passengerId || '');
  if (!passengerId) return c.json({ message: 'ID da passageira é obrigatório.' }, 400);
  // Verificar se o usuário é o motorista da partida
  const dep = await sql`SELECT driver_id FROM shared_departures WHERE id = ${departureId} LIMIT 1`;
  if (!dep.length) return c.json({ message: 'Partida não encontrada.' }, 404);
  const didApr = await driverIdFor(sql, user.sub);
  if (dep[0].driver_id !== user.sub && dep[0].driver_id !== didApr) return c.json({ message: 'Apenas a motorista pode aprovar.' }, 403);
  const res = await sql`SELECT id, status, passenger_id FROM shared_reservations WHERE id = ${passengerId} AND departure_id = ${departureId} AND status = 'pending' LIMIT 1`;
  if (!res.length) return c.json({ message: 'Reserva não encontrada ou já processada.' }, 404);
  const seat = await sql`UPDATE shared_departures SET seats_taken = seats_taken + 1, status = CASE WHEN seats_taken + 1 >= total_seats THEN 'full' ELSE status END WHERE id = ${departureId} AND seats_taken < total_seats RETURNING seats_taken, total_seats, status`;
  if (!seat.length) return c.json({ message: 'Partida não encontrada ou sem vagas.' }, 404);
  await sql`UPDATE shared_reservations SET status = 'approved', approved_at = NOW() WHERE id = ${passengerId}`;
  const newTaken = Number(seat[0].seats_taken);
  const newStatus = seat[0].status;
  const totalSeats = Number(seat[0].total_seats);
  const approvedUser = res[0].passenger_id ? String(res[0].passenger_id) : '';
  const info = await sql`SELECT origin_name, dest_name FROM shared_departures WHERE id = ${departureId} LIMIT 1`;
  const originName = info.length ? String((info[0] as any).origin_name || '') : '';
  const destName = info.length ? String((info[0] as any).dest_name || 'o destino') : 'o destino';
  const rotaTxt = (originName ? ' ' + originName : '') + ' \u2192 ' + destName;
  // A passageira aprovada é avisada (notificação na app + push): antes só descobria ao reabrir a lista.
  if (approvedUser) {
    const t1 = '\ud83e\udd8b Lugar aprovado!';
    const b1 = 'A motorista aprovou o teu lugar na partida' + rotaTxt + '. Bom viagem!';
    try {
      await sql`INSERT INTO notifications (id, "userId", title, body, type, "isRead", data, "createdAt") VALUES (${'nt_' + crypto.randomUUID().slice(0, 12)}, ${approvedUser}, ${t1}, ${b1}, 'shared_approved', 0, ${departureId}, NOW())`;
    } catch {}
    notifPokeSoon(c, approvedUser);
    try { c.executionCtx.waitUntil(pushToUser(sql, approvedUser, t1, b1, { type: 'shared_approved', departureId })); } catch {}
  }
  // Partida completa: quem ficou na fila recebe "Todos os lugares foram preenchidos".
  if (newTaken >= totalSeats) {
    const waiting = await sql`SELECT DISTINCT passenger_id FROM shared_reservations WHERE departure_id = ${departureId} AND status = 'pending'`;
    const ids = (waiting || []).map((r: any) => String(r.passenger_id || '')).filter((x: string) => x && x !== approvedUser);
    if (ids.length) {
      const t2 = 'Todos os lugares foram preenchidos';
      const b2 = 'A partida' + rotaTxt + ' já está completa. Fica atenta às próximas partidas.';
      for (const uid of ids) {
        try {
          await sql`INSERT INTO notifications (id, "userId", title, body, type, "isRead", data, "createdAt") VALUES (${'nt_' + crypto.randomUUID().slice(0, 12)}, ${uid}, ${t2}, ${b2}, 'shared_full', 0, ${departureId}, NOW())`;
        } catch {}
      }
      try { c.executionCtx.waitUntil(notifPokeMany(c.env, ids)); } catch {}
      try { c.executionCtx.waitUntil(Promise.all(ids.map((uid: string) => pushToUser(sql, uid, t2, b2, { type: 'shared_full', departureId })))); } catch {}
    }
  }
  // Notificar próxima da fila (marcar próxima como ativa para pagar)
  const next = await sql`SELECT id, passenger_id FROM shared_reservations WHERE departure_id = ${departureId} AND status = 'pending' ORDER BY position ASC LIMIT 1`;
  return c.json({ ok: true, approved: passengerId, seatsTaken: newTaken, totalSeats: seat[0].total_seats, status: newStatus, nextInQueue: next.length ? next[0] : null });
});

// POST /api/v1/shared/departures/:id/alert — Motorista avisa quem reservou (máx. 2 vezes)
app.post('/api/v1/shared/departures/:id/alert', requireAuth, async (c) => {
  const guard = writeGuard(c);
  if (guard) return guard;
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const departureId = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const dep = await sql`SELECT driver_id, dest_name, alert_count FROM shared_departures WHERE id = ${departureId} LIMIT 1`;
  if (!dep.length) return c.json({ message: 'Partida não encontrada.' }, 404);
  const d = dep[0] as any;
  if (d.driver_id !== user.sub && d.driver_id !== (await driverIdFor(sql, user.sub))) return c.json({ message: 'Apenas a motorista pode alertar.' }, 403);
  const inc = await sql`UPDATE shared_departures SET alert_count = alert_count + 1 WHERE id = ${departureId} AND alert_count < 2 RETURNING alert_count`;
  if (!inc.length) return c.json({ message: 'Já enviou o alerta 2 vezes. Não é possível enviar mais.' }, 429);
  const used = Number(inc[0].alert_count || 0);
  const msg = String((b as any).message || '').slice(0, 200);
  const title = 'A tua partida vai sair';
  const body = msg || ('A partida para ' + (d.dest_name || 'o destino') + ' está completa. Prepara-te para embarcar.');
  const rs = await sql`SELECT DISTINCT passenger_id FROM shared_reservations WHERE departure_id = ${departureId} AND status IN ('pending','paid','approved')`;
  for (const r of (rs || [])) {
    await sql`INSERT INTO notifications (id, "userId", title, body, type, "isRead", data, "createdAt") VALUES (${'nt_' + crypto.randomUUID().slice(0, 12)}, ${(r as any).passenger_id}, ${title}, ${body}, 'shared_alert', 0, ${departureId}, NOW())`;
  }
  try { c.executionCtx.waitUntil(notifPokeMany(c.env, (rs || []).map((r: any) => r.passenger_id))); } catch {}
  return c.json({ ok: true, notified: (rs || []).length, alertsUsed: used, alertsLeft: 2 - used });
});

// GET /api/v1/shared/departures/:id/queue — Ver fila da partida
app.get('/api/v1/shared/departures/:id/queue', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const departureId = c.req.param('id');
  const rows = await sql`SELECT sr.id, sr.passenger_id, sr.position, sr.status, sr.created_at, u.name AS passenger_name, u.phone AS passenger_phone, u."profilePhoto" AS passenger_photo FROM shared_reservations sr JOIN users u ON u.id = sr.passenger_id WHERE sr.departure_id = ${departureId} ORDER BY sr.position ASC`;
  return c.json({ queue: (rows || []).map((r: any) => ({ id: r.id, passengerId: r.passenger_id, passengerName: r.passenger_name, passengerPhone: r.passenger_phone, passengerPhoto: photoUrl(c, r.passenger_photo), position: r.position, status: r.status, createdAt: r.created_at })) });
});

// DELETE /api/v1/shared/departures/:id/reserve — Passageira cancela a sua reserva
app.delete('/api/v1/shared/departures/:id/reserve', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const departureId = c.req.param('id');
  const r = await sql`SELECT id, position FROM shared_reservations WHERE departure_id = ${departureId} AND passenger_id = ${user.sub} AND status IN ('pending','paid') ORDER BY created_at DESC LIMIT 1`;
  if (!r.length) return c.json({ message: 'Sem reserva para cancelar.' }, 404);
  await sql`UPDATE shared_reservations SET status = 'cancelled' WHERE id = ${r[0].id}`;
  return c.json({ ok: true });
});

// GET /api/v1/shared/departures/:id/my-reservation — Estado da minha reserva nesta partida
app.get('/api/v1/shared/departures/:id/my-reservation', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const departureId = c.req.param('id');
  const r = await sql`SELECT sr.id, sr.status, sr.position, sr.expires_at, sd.price_per_seat, sd.scheduled_at FROM shared_reservations sr JOIN shared_departures sd ON sd.id = sr.departure_id WHERE sr.departure_id = ${departureId} AND sr.passenger_id = ${user.sub} AND sr.status IN ('pending','paid','approved') ORDER BY sr.created_at DESC LIMIT 1`;
  return c.json({ reservation: r.length ? { id: r[0].id, status: r[0].status, position: r[0].position, expiresAt: r[0].expires_at, pricePerSeat: r[0].price_per_seat, scheduledAt: r[0].scheduled_at } : null });
});

// POST /api/v1/shared/departures/:id/expire — Marcar reservas expiradas (cron/webhook)
app.post('/api/v1/shared/departures/:id/expire', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const departureId = c.req.param('id');
  const now = new Date().toISOString();
  const expired = await sql`UPDATE shared_reservations SET status = 'expired' WHERE departure_id = ${departureId} AND status = 'pending' AND expires_at < ${now} RETURNING id, passenger_id`;
  return c.json({ ok: true, expired: (expired || []).length, ids: (expired || []).map((r: any) => r.id) });
});

// GET /api/v1/shared/departures/mine — Motorista lista suas próprias partidas
// (full incluídas; as que já passaram 2h do horário de partida desaparecem)
app.get('/api/v1/shared/departures/mine', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const did = await driverIdFor(sql, user.sub);
  if (!did) return c.json({ message: 'Sem registo de motorista.' }, 404);
  const nowIso = new Date().toISOString();
  const rows = await sql`SELECT sd.*, (SELECT COUNT(*) FROM shared_reservations sr WHERE sr.departure_id = sd.id AND sr.status = 'approved') AS approved_count FROM shared_departures sd WHERE sd.driver_id = ${did} AND (sd.expires_at IS NULL OR sd.expires_at > ${nowIso}) ORDER BY sd.created_at DESC LIMIT 100`;
  return c.json({ departures: (rows || []).map((r: any) => ({
    id: r.id, originName: r.origin_name, destName: r.dest_name, category: r.category,
    totalPrice: r.total_price, pricePerSeat: r.price_per_seat, totalSeats: r.total_seats,
    seatsTaken: r.seats_taken, seatsAvailable: Number(r.total_seats) - Number(r.seats_taken),
    status: sdExpired(r.status, r.expires_at) ? 'expired' : r.status, scheduledAt: r.scheduled_at, expiresAt: r.expires_at,
    approvedCount: Number(r.approved_count || 0),
    alertsUsed: Number(r.alert_count || 0),
    canDelete: Number(r.approved_count || 0) === 0 && r.status !== 'full'
  })) });
});

// DELETE /api/v1/shared/departures/:id — Motorista apaga sua partida (bloqueado se houver reservas aprovadas)
app.delete('/api/v1/shared/departures/:id', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const departureId = c.req.param('id');
  const dep = await sql`SELECT driver_id, status FROM shared_departures WHERE id = ${departureId} LIMIT 1`;
  if (!dep.length) return c.json({ message: 'Partida não encontrada.' }, 404);
  const didDel = await driverIdFor(sql, user.sub);
  if (dep[0].driver_id !== user.sub && dep[0].driver_id !== didDel) return c.json({ message: 'Apenas a motorista pode apagar.' }, 403);
  // Bloquear se já há reservas aprovadas (alguém pagou)
  const approved = await sql`SELECT id FROM shared_reservations WHERE departure_id = ${departureId} AND status = 'approved' LIMIT 1`;
  if (approved.length) return c.json({ message: 'Não é possível apagar: já há passageira com assento aprovado nesta partida.' }, 403);
  await sql`DELETE FROM shared_departures WHERE id = ${departureId}`;
  await sql`DELETE FROM shared_reservations WHERE departure_id = ${departureId}`;
  return c.json({ ok: true, message: 'Partida apagada.' });
});

// ═══════════════════════════════════════════════════════════════════════════
// RESERVA PREMIUM / GOLD  —  carros criados pelo ADMIN; usados pelas PASSAGEIRAS
// ═══════════════════════════════════════════════════════════════════════════

function premiumCarOut(r: any) {
  return {
    id: r.id, category: r.category, make: r.make, model: r.model, color: r.color,
    year: r.year, plate: r.plate, pricePerKm: Number(r.price_per_km || 0),
    driverId: r.driver_id || null, driverName: r.driver_name || null, driverPhone: r.driver_phone || null,
    photo: r.photo || null, status: r.status, active: Number(r.active) === 1,
    activeReservations: r.active_res != null ? Number(r.active_res) : undefined,
    reservation: r.res_id ? {
      id: r.res_id, passengerName: r.res_name || null, passengerPhone: r.res_phone || null,
      scheduledAt: r.res_scheduled_at || null, priceTotal: r.res_price_total != null ? Number(r.res_price_total) : null,
      pickup: r.res_pickup || null, dest: r.res_dest || null, createdAt: r.res_created_at || null,
    } : null,
    createdAt: r.created_at,
  };
}

function premiumResOut(r: any) {
  const make = r.make != null ? r.make : r.car_make;
  const model = r.model != null ? r.model : r.car_model;
  const color = r.color != null ? r.color : r.car_color;
  const year = r.year != null ? r.year : r.car_year;
  const plate = r.plate || r.car_plate;
  const photo = r.photo || r.car_photo;
  return {
    id: r.id, carId: r.car_id, category: r.category,
    status: r.status, position: Number(r.position || 1),
    distanceKm: r.distance_km != null ? Number(r.distance_km) : null,
    priceTotal: r.price_total != null ? Number(r.price_total) : null,
    expiresAt: r.expires_at || null, scheduledAt: r.scheduled_at || null,
    pickup: { lat: r.pickup_lat, lng: r.pickup_lng, name: r.pickup_name },
    dest: { lat: r.dest_lat, lng: r.dest_lng, name: r.dest_name },
    car: (r.make || r.car_make || r.plate || r.car_plate) ? {
      make: r.make ?? r.car_make, model: r.model ?? r.car_model, color: r.color ?? r.car_color,
      year: r.year ?? r.car_year, plate: r.plate ?? r.car_plate, photo: r.photo ?? r.car_photo,
      pricePerKm: Number(r.price_per_km || 0), driverName: r.driver_name || null, driverPhone: r.driver_phone || null
    } : null,
    queue: r.queue_n != null ? Number(r.queue_n) : undefined,
    createdAt: r.created_at
  };
}

// Expira reservas pendentes cujo prazo de pagamento passou. O prazo só existe
// para quem está em 1.º da fila (os restantes têm expires_at NULL). Ao expirar,
// a fila do carro sobe e o novo 1.º ganha 10 minutos + aviso.
// Throttle por isolate: o varrimento só corre a cada 30s (antes os endpoints
// premium chamavam-no em TODA chamada — GET incluído). `force` é usado no
// POST/reserva e no cron, para não aceitar uma reserva que já expirou. Só
// escreve se houver mesmo algo a expirar.
let premiumSweepAt = 0;
// Janela de pagamento: só conta para quem está em 1.º da fila.
const PRM_PAY_MS = 10 * 60 * 1000;
// Avisa quem passou a ser o 1.º da fila: notificação no app + push. Só o 1.º
// da fila vê os dados bancários (é ele que tem de pagar agora).
async function premiumHeadNotify(sql: any, env: any, p: any, ctx: any = null) {
  if (!p || !p.userId) return;
  try {
    await sql`INSERT INTO notifications (id, "userId", title, body, type, "isRead", data, "createdAt")
      VALUES (${'nt_' + crypto.randomUUID().slice(0, 12)}, ${p.userId}, ${'\u00c9 a tua vez de pagar'},
      ${'Chegou a tua vez na fila Premium. Tens 10 minutos para pagar \u2014 os dados banc\u00e1rios j\u00e1 est\u00e3o na tua reserva.'}, 'premium', 0, ${p.id}, NOW())`;
    // O push não pode atrasar um GET (o premiumExpire corre também em leituras).
    const send = pushToUser(sql, p.userId, '\ud83e\udd8b \u00c9 a tua vez de pagar',
      'Chegou a tua vez na fila Premium. Tens 10 minutos para pagar \u2014 os dados banc\u00e1rios j\u00e1 est\u00e3o na reserva.',
      { type: 'premium_head', reservationId: p.id });
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(send.catch(() => {}));
    else await send;
    if (env) notifPoke(env, String(p.userId));
  } catch {}
}
// Renumera a fila do carro e acerta o prazo: quem chega a 1.º ganha os 10 min
// agora; quem está à espera não tem contagem a correr.
async function premiumAfterQueue(sql: any, env: any, carId: string, ctx: any = null) {
  if (!carId) return;
  try {
    const rows = await sql`SELECT id, passenger_id, status, position, expires_at FROM premium_reservations WHERE car_id = ${carId} AND status IN ('pending','confirmed') ORDER BY created_at, rowid`;
    const list = (rows || []) as any[];
    const promoted = premiumPromoted(list);
    for (let i = 0; i < list.length; i++) {
      const pos = i + 1;
      await sql`UPDATE premium_reservations SET position = ${pos} WHERE id = ${list[i].id} AND position <> ${pos}`;
    }
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (String(r.status) !== 'pending') continue;
      if (i === 0) {
        // Prazo novo se nunca teve, se já passou, ou se é absurdo (linhas antigas
        // gravavam aqui o dia da reserva — o prazo de pagamento são sempre 10 min,
        // não depende do dia da viagem). Não empurra para a frente um prazo válido
        // quando só saiu alguém de trás.
        const cur = r.expires_at ? Date.parse(String(r.expires_at)) : NaN;
        if (!r.expires_at || !Number.isFinite(cur) || cur <= Date.now() || cur > Date.now() + PRM_PAY_MS + 60000) {
          await sql`UPDATE premium_reservations SET expires_at = ${new Date(Date.now() + PRM_PAY_MS).toISOString()} WHERE id = ${r.id} AND status = 'pending'`;
        }
      } else if (r.expires_at) {
        await sql`UPDATE premium_reservations SET expires_at = NULL WHERE id = ${r.id} AND status = 'pending'`;
      }
    }
    for (const p of promoted) await premiumHeadNotify(sql, env, p, ctx);
  } catch {}
}
// Quem estava em 2.º e passa a 1.º (a reserva à frente expirou/cancelou).
function premiumPromoted(rows: any[]) {
  const out: any[] = [];
  const first = (rows || [])[0];
  if (first && Number(first.position || 0) !== 1 && String(first.status) === 'pending') {
    out.push({ id: first.id, userId: first.passenger_id });
  }
  return out;
}
async function premiumExpire(sql: any, env: any = null, force = false, ctx: any = null) {
  const nowMs = Date.now();
  if (!force && nowMs - premiumSweepAt < 30000) return [];
  premiumSweepAt = nowMs;
  const now = new Date().toISOString();
  // Prazos absurdos (linhas antigas gravavam aqui o dia/hora da reserva) são
  // corrigidos em vez de freados: o prazo de pagamento são sempre 10 minutos.
  const far = new Date(nowMs + PRM_PAY_MS + 60000).toISOString();
  const odd = (await sql`SELECT id, position, expires_at FROM premium_reservations
    WHERE status = 'pending' AND expires_at IS NOT NULL AND (expires_at < ${now} OR expires_at > ${far}) LIMIT 50`) as any[];
  if (!odd.length) return [];
  const fresh = new Date(nowMs + PRM_PAY_MS).toISOString();
  for (const r of odd) {
    if (!(Date.parse(String(r.expires_at)) > Date.parse(far))) continue;
    if (Number(r.position) === 1) {
      await sql`UPDATE premium_reservations SET expires_at = ${fresh} WHERE id = ${r.id} AND status = 'pending'`;
    } else {
      await sql`UPDATE premium_reservations SET expires_at = NULL WHERE id = ${r.id} AND status = 'pending'`;
    }
  }
  const exp = await sql`UPDATE premium_reservations SET status = 'expired' WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ${now} RETURNING id, car_id, passenger_id`;
  // Quem deixou passar os 10 minutos tem de saber porque desapareceu a reserva.
  for (const r of (exp || []) as any[]) {
    if (!r.passenger_id) continue;
    try {
      await sql`INSERT INTO notifications (id, "userId", title, body, type, "isRead", data, "createdAt")
        VALUES (${'nt_' + crypto.randomUUID().slice(0, 12)}, ${r.passenger_id}, ${'Reserva Premium expirada'},
        ${'O prazo de 10 minutos para pagar passou. A reserva saiu da fila e o lugar foi para a pr\u00f3xima passageira.'}, 'premium', 0, ${r.id}, NOW())`;
      if (env) notifPoke(env, String(r.passenger_id));
    } catch {}
  }
  const cars: string[] = Array.from(new Set(((exp || []) as any[]).map((r: any) => r.car_id).filter(Boolean))) as string[];
  for (const carId of cars) await premiumAfterQueue(sql, env, carId, ctx);
  return exp || [];
}
// Dados bancários da operação (definidos pelo admin). Só o 1.º da fila os recebe.
async function premiumPaymentGet(sql: any) {
  try {
    const rows = await sql`SELECT k, v FROM app_settings WHERE k LIKE 'premium.%'`;
    const m: any = {};
    for (const r of rows || []) m[String(r.k)] = r.v == null ? '' : String(r.v);
    const out = { iban: m['premium.iban'] || '', expressCode: m['premium.express'] || '', holder: m['premium.holder'] || '', note: m['premium.note'] || '' };
    if (!out.iban && !out.expressCode) return null;
    return out;
  } catch { return null; }
}

// ── ADMIN: frota premium ──────────────────────────────────────────────────
app.get('/api/v1/admin/premium/fleet', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  const rows = await sql`
    SELECT pf.*, u.name AS driver_name, u.phone AS driver_phone,
      (SELECT COUNT(*) FROM premium_reservations pr WHERE pr.car_id = pf.id AND pr.status IN ('pending','confirmed')) AS active_res,
      r.id AS res_id, r.scheduled_at AS res_scheduled_at, r.price_total AS res_price_total,
      r.pickup_name AS res_pickup, r.dest_name AS res_dest, r.created_at AS res_created_at,
      ru.name AS res_name, ru.phone AS res_phone
    FROM premium_fleet pf
    LEFT JOIN drivers d ON d.id = pf.driver_id
    LEFT JOIN users u ON u.id = d."userId"
    LEFT JOIN premium_reservations r ON r.id = (
      SELECT pr.id FROM premium_reservations pr WHERE pr.car_id = pf.id AND pr.status = 'confirmed' ORDER BY pr.created_at DESC LIMIT 1
    )
    LEFT JOIN users ru ON ru.id = r.passenger_id
    ORDER BY pf.category, pf.sort, pf.created_at DESC`;
  return c.json({ cars: (rows || []).map(premiumCarOut) });
});

app.post('/api/v1/admin/premium/fleet', adminMiddleware, async (c) => {
  const guard = writeGuard(c); if (guard) return guard;
  const sql = neon(c.env.DB);
  const b = await c.req.json().catch(() => ({}));
  const category = (String(b.category || '').trim().slice(0, 24)) || 'Gold';
  const make = String(b.make || '').trim().slice(0, 40);
  const model = String(b.model || '').trim().slice(0, 40);
  const color = String(b.color || '').trim().slice(0, 30);
  const plate = String(b.plate || '').trim().slice(0, 20);
  const year = Number(b.year) || null;
  const pricePerKm = Math.round(Number(b.pricePerKm));
  if (!plate && !model) return c.json({ message: 'Indica pelo menos o modelo ou a matrícula.' }, 400);
  if (!(pricePerKm > 0) || pricePerKm > 100000) return c.json({ message: 'Preço por km inválido.' }, 400);
  let driverId = b.driverId ? String(b.driverId) : null;
  if (driverId) {
    const dv = await sql`SELECT id FROM drivers WHERE id = ${driverId} LIMIT 1`;
    if (!dv.length) driverId = null;
  }
  const photo = (typeof b.photo === 'string' && b.photo.startsWith('data:image')) ? b.photo.slice(0, 200000) : null;
  const id = 'pc_' + crypto.randomUUID().slice(0, 12);
  await sql`INSERT INTO premium_fleet (id, category, make, model, color, year, plate, price_per_km, driver_id, photo, status, active, sort, created_at)
    VALUES (${id}, ${category}, ${make}, ${model}, ${color}, ${year}, ${plate}, ${pricePerKm}, ${driverId}, ${photo}, 'available', 1, 0, NOW())`;
  const rows = await sql`SELECT pf.*, u.name AS driver_name, u.phone AS driver_phone FROM premium_fleet pf LEFT JOIN drivers d ON d.id = pf.driver_id LEFT JOIN users u ON u.id = d."userId" WHERE pf.id = ${id}`;
  return c.json({ ok: true, car: premiumCarOut(rows[0]) });
});

app.put('/api/v1/admin/premium/fleet/:id', adminMiddleware, async (c) => {
  const guard = writeGuard(c); if (guard) return guard;
  const sql = neon(c.env.DB);
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const cur = (await sql`SELECT * FROM premium_fleet WHERE id = ${id} LIMIT 1`)[0];
  if (!cur) return c.json({ message: 'Carro premium não encontrado.' }, 404);
  const category = b.category != null ? (String(b.category).trim().slice(0, 24) || cur.category) : cur.category;
  const make = b.make != null ? String(b.make).trim().slice(0, 40) : cur.make;
  const model = b.model != null ? String(b.model).trim().slice(0, 40) : cur.model;
  const color = b.color != null ? String(b.color).trim().slice(0, 30) : cur.color;
  const plate = b.plate != null ? String(b.plate).trim().slice(0, 20) : cur.plate;
  const year = b.year != null ? (Number(b.year) || null) : cur.year;
  const pricePerKm = b.pricePerKm != null ? Math.round(Number(b.pricePerKm)) : Number(cur.price_per_km);
  if (!(pricePerKm > 0) || pricePerKm > 100000) return c.json({ message: 'Preço por km inválido.' }, 400);
  let driverId = cur.driver_id;
  if (b.driverId !== undefined) {
    driverId = b.driverId ? String(b.driverId) : null;
    if (driverId) { const dv = await sql`SELECT id FROM drivers WHERE id = ${driverId} LIMIT 1`; if (!dv.length) driverId = null; }
  }
  let status = cur.status;
  if (b.status != null && ['available', 'unavailable', 'reserved'].includes(String(b.status))) status = String(b.status);
  if (b.status != null && status !== cur.status && status !== 'reserved') {
    const conf = await sql`SELECT id FROM premium_reservations WHERE car_id = ${id} AND status = 'confirmed' LIMIT 1`;
    if (conf.length) return c.json({ message: 'Este carro tem uma reserva confirmada. Usa "Libertar" para o voltares a disponibilizar.' }, 409);
  }
  const active = b.active != null ? (b.active ? 1 : 0) : cur.active;
  const photo = (typeof b.photo === 'string' && b.photo.startsWith('data:image')) ? b.photo.slice(0, 200000) : cur.photo;
  await sql`UPDATE premium_fleet SET category = ${category}, make = ${make}, model = ${model}, color = ${color}, year = ${year}, plate = ${plate}, price_per_km = ${pricePerKm}, driver_id = ${driverId}, photo = ${photo}, status = ${status}, active = ${active} WHERE id = ${id}`;
  const rows = await sql`SELECT pf.*, u.name AS driver_name, u.phone AS driver_phone FROM premium_fleet pf LEFT JOIN drivers d ON d.id = pf.driver_id LEFT JOIN users u ON u.id = d."userId" WHERE pf.id = ${id}`;
  return c.json({ car: premiumCarOut(rows[0]) });
});

app.delete('/api/v1/admin/premium/fleet/:id', adminMiddleware, async (c) => {
  const guard = writeGuard(c); if (guard) return guard;
  const sql = neon(c.env.DB);
  const id = c.req.param('id');
  const active = await sql`SELECT id FROM premium_reservations WHERE car_id = ${id} AND status IN ('pending','confirmed') LIMIT 1`;
  if (active.length) return c.json({ message: 'Este carro tem reservas activas. Libera-o primeiro.' }, 409);
  await sql`DELETE FROM premium_fleet WHERE id = ${id}`;
  return c.json({ ok: true });
});

app.post('/api/v1/admin/premium/fleet/:id/release', adminMiddleware, async (c) => {
  const guard = writeGuard(c); if (guard) return guard;
  const sql = neon(c.env.DB);
  const id = c.req.param('id');
  await sql`UPDATE premium_fleet SET status = 'available' WHERE id = ${id}`;
  await sql`UPDATE premium_reservations SET status = 'completed' WHERE car_id = ${id} AND status = 'confirmed'`;
  await sql`UPDATE premium_reservations SET status = 'expired' WHERE car_id = ${id} AND status = 'pending'`;
  return c.json({ ok: true });
});

// POST /api/v1/admin/premium/reservations/:id/confirm — admin confirma o pagamento
// (comprovante enviado fora da app). A reserva fica confirmada e o carro passa a
// 'reserved' (indisponível) até o admin o libertar.
app.post('/api/v1/admin/premium/reservations/:id/confirm', adminMiddleware, async (c) => {
  const guard = writeGuard(c); if (guard) return guard;
  const sql = neon(c.env.DB);
  const id = c.req.param('id');
  const rows = await sql`SELECT id, car_id, passenger_id FROM premium_reservations WHERE id = ${id} AND status = 'pending' LIMIT 1`;
  if (!rows.length) return c.json({ message: 'Reserva não encontrada ou já processada.' }, 404);
  const carId = rows[0].car_id;
  const pid = rows[0].passenger_id;
  await sql`UPDATE premium_reservations SET status = 'confirmed' WHERE id = ${id} AND status = 'pending'`;
  // Pago + confirmado: o carro fica indisponível (reservado) para as outras.
  await sql`UPDATE premium_fleet SET status = 'reserved' WHERE id = ${carId}`;
  try {
    if (pid) {
      await sql`INSERT INTO notifications (id, "userId", title, body, type, "isRead", data, "createdAt")
        VALUES (${'nt_' + crypto.randomUUID().slice(0, 12)}, ${pid}, ${'Reserva Premium confirmada'}, ${'O teu carro premium está confirmado. Vê os detalhes no app.'}, 'premium', 0, ${id}, NOW())`;
      notifPokeSoon(c, String(pid));
      await pushToUser(sql, String(pid), '\ud83e\udd8b Reserva Premium confirmada', 'O teu carro premium está confirmado. Vê os detalhes no app.', { type: 'premium_confirmed', reservationId: id });
    }
  } catch {}
  // A fila desse carro deixa de fazer sentido: o carro está reservado.
  try {
    const rest = await sql`SELECT id, passenger_id FROM premium_reservations WHERE car_id = ${carId} AND status = 'pending' AND id <> ${id}`;
    for (const q of rest || []) {
      await sql`UPDATE premium_reservations SET status = 'cancelled', expires_at = NULL WHERE id = ${q.id} AND status = 'pending'`;
      if (!q.passenger_id) continue;
      await sql`INSERT INTO notifications (id, "userId", title, body, type, "isRead", data, "createdAt")
        VALUES (${'nt_' + crypto.randomUUID().slice(0, 12)}, ${q.passenger_id}, ${'Carro Premium indisponível'}, ${'O carro que reservaste foi confirmado para outra passageira. Escolhe outro carro premium.'}, 'premium', 0, ${q.id}, NOW())`;
      notifPokeSoon(c, String(q.passenger_id));
      await pushToUser(sql, String(q.passenger_id), '\ud83d\ude97 Carro Premium indisponível', 'O carro que reservaste foi confirmado para outra passageira. Escolhe outro carro premium.', { type: 'premium', reservationId: q.id });
    }
  } catch {}
  return c.json({ ok: true, status: 'confirmed' });
});

// POST /api/v1/admin/premium/reservations/:id/reject — admin recusa a reserva pendente.
app.post('/api/v1/admin/premium/reservations/:id/reject', adminMiddleware, async (c) => {
  const guard = writeGuard(c); if (guard) return guard;
  const sql = neon(c.env.DB);
  const id = c.req.param('id');
  const upd = await sql`UPDATE premium_reservations SET status = 'cancelled', expires_at = NULL WHERE id = ${id} AND status = 'pending' RETURNING id, car_id`;
  if (!upd.length) return c.json({ message: 'Reserva não encontrada ou já processada.' }, 404);
  await premiumAfterQueue(sql, c.env, String((upd[0] as any).car_id || ''), (c as any).executionCtx);
  return c.json({ ok: true, status: 'cancelled' });
});

app.get('/api/v1/admin/premium/reservations', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  const rows = await sql`
    SELECT pr.*, pf.make, pf.model, pf.color, pf.year, pf.plate, pf.price_per_km, u.name AS passenger_name, u.phone AS passenger_phone
    FROM premium_reservations pr
    LEFT JOIN premium_fleet pf ON pf.id = pr.car_id
    LEFT JOIN users u ON u.id = pr.passenger_id
    ORDER BY pr.created_at DESC LIMIT 200`;
  return c.json({ reservations: (rows || []).map((r: any) => ({ ...premiumResOut(r), passengerName: r.passenger_name || null, passengerPhone: r.passenger_phone || null })) });
});

// ── ADMIN: dados bancários do Premium ────────────────────────────────────
app.get('/api/v1/admin/premium/payment', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  const pay = await premiumPaymentGet(sql);
  return c.json({ payment: pay || { iban: '', expressCode: '', holder: '', note: '' } });
});
app.put('/api/v1/admin/premium/payment', adminMiddleware, async (c) => {
  const guard = writeGuard(c); if (guard) return guard;
  const sql = neon(c.env.DB);
  const b = await c.req.json().catch(() => ({}));
  const iban = String(b.iban || '').trim().slice(0, 60);
  const expressCode = String(b.expressCode || '').trim().slice(0, 30);
  const holder = String(b.holder || '').trim().slice(0, 60);
  const note = String(b.note || '').trim().slice(0, 160);
  const now = new Date().toISOString();
  const pairs: [string, string][] = [['premium.iban', iban], ['premium.express', expressCode], ['premium.holder', holder], ['premium.note', note]];
  for (const [k, v] of pairs) {
    await sql`INSERT INTO app_settings (k, v, updated_at) VALUES (${k}, ${v}, ${now})
      ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`;
  }
  return c.json({ ok: true, payment: { iban, expressCode, holder, note } });
});

// ── PASSAGEIRA: catálogo premium ──────────────────────────────────────────
app.get('/api/v1/premium/cars', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const rows = await sql`
    SELECT pf.*, u.name AS driver_name, u.phone AS driver_phone,
      (SELECT COUNT(*) FROM premium_reservations pr WHERE pr.car_id = pf.id AND pr.status IN ('pending','confirmed')) AS queue_n
    FROM premium_fleet pf
    LEFT JOIN drivers d ON d.id = pf.driver_id
    LEFT JOIN users u ON u.id = d."userId"
    WHERE pf.active = 1
    ORDER BY pf.category, pf.sort, pf.created_at`;
  const cats: any = {};
  for (const r of rows) {
    const cat = r.category || 'Gold';
    if (!cats[cat]) cats[cat] = { category: cat, pricePerKm: 0, total: 0, available: 0, cars: [] };
    const g = cats[cat];
    g.total++;
    const pk = Number(r.price_per_km || 0);
    if (g.pricePerKm === 0 || (pk > 0 && pk < g.pricePerKm)) g.pricePerKm = pk;
    if (r.status === 'available') {
      g.available++;
      g.cars.push({ id: r.id, make: r.make, model: r.model, color: r.color, year: r.year, plate: r.plate, photo: r.photo || null, driverName: r.driver_name || null, pricePerKm: pk, queue: Number(r.queue_n || 0) });
    }
  }
  return c.json({ categories: Object.values(cats) });
});

// POST /api/v1/premium/reservations — passageira reserva um carro premium
app.post('/api/v1/premium/reservations', requireAuth, async (c) => {
  const guard = writeGuard(c); if (guard) return guard;
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const b = await c.req.json().catch(() => ({}));
  const carId = String(b.carId || '');
  const car = await sql`SELECT * FROM premium_fleet WHERE id = ${carId} AND active = 1 LIMIT 1`;
  if (!car.length) return c.json({ message: 'Carro premium não encontrado.' }, 404);
  const cr = car[0];
  if (cr.status !== 'available') return c.json({ message: 'Este carro já não está disponível. Escolhe outro.' }, 409);
  const plat = Number(b.pickupLat), plng = Number(b.pickupLng), dlat = Number(b.destLat), dlng = Number(b.destLng);
  if (![plat, plng, dlat, dlng].every((n) => Number.isFinite(n))) return c.json({ message: 'Indica o ponto de busca e o destino.' }, 400);
  // Varredura forçada: não deixar entrar na fila com o 1.º já morto (senão
  // nascia em 2.º sem prazo e sem nunca ser promovida até ao sweep seguinte).
  await premiumExpire(sql, c.env, true, (c as any).executionCtx);
  // O carro pode ter sido reposto a 'available' no painel com uma reserva já
  // confirmada — nesse caso o lugar está ocupado na mesma.
  const busy = await sql`SELECT id FROM premium_reservations WHERE car_id = ${carId} AND status = 'confirmed' LIMIT 1`;
  if (busy.length) return c.json({ message: 'Este carro já está reservado. Escolhe outro.' }, 409);
  const dup = await sql`SELECT id FROM premium_reservations WHERE car_id = ${carId} AND passenger_id = ${user.sub} AND status IN ('pending','confirmed') LIMIT 1`;
  if (dup.length) return c.json({ message: 'Já tens uma reserva para este carro.' }, 409);
  // Antecedência: a única aceite é 1 hora. O prazo de pagamento são 10 minutos
  // a contar de quando a reserva chega a 1.º da fila (não do dia marcado); só o
  // admin a confirma, após o comprovante, fora da app.
  const schedMs = Date.parse(String(b.scheduledAt || ''));
  if (!Number.isFinite(schedMs)) return c.json({ message: 'Indica a data e a hora da reserva.' }, 400);
  if (schedMs < Date.now() + 60 * 60 * 1000) return c.json({ message: 'As reservas Premium exigem pelo menos 1 hora de antecedência.' }, 400);
  const scheduledIso = new Date(schedMs).toISOString();
  const km = Math.max(1, Math.round(havKm(plat, plng, dlat, dlng) * 10) / 10);
  const price = Math.max(1, Math.round(km * Number(cr.price_per_km || 0)));
  // Janela de pagamento: 10 minutos, mas só a contar a partir do momento em que
  // a reserva chega a 1.º da fila. Quem está à espera não tem prazo a correr:
  // o prazo é-lhe aberto quando a reserva à frente sai (expira/cancela).
  // A posição é calculada DENTRO do INSERT (um só statement) para que duas
  // reservas no mesmo instante não fiquem as duas em 1.º lugar.
  const expiresAtFirst = new Date(Date.now() + PRM_PAY_MS).toISOString();
  const id = 'pr_' + crypto.randomUUID().slice(0, 12);
  await sql`INSERT INTO premium_reservations (id, car_id, category, passenger_id, pickup_lat, pickup_lng, pickup_name, dest_lat, dest_lng, dest_name, scheduled_at, distance_km, price_total, position, status, expires_at, created_at)
    SELECT ${id}, ${carId}, ${cr.category}, ${user.sub}, ${plat}, ${plng}, ${String(b.pickupName || '').slice(0, 120)}, ${dlat}, ${dlng}, ${String(b.destName || '').slice(0, 120)}, ${scheduledIso}, ${km}, ${price},
      COALESCE(MAX(position), 0) + 1, 'pending',
      CASE WHEN COALESCE(MAX(position), 0) = 0 THEN ${expiresAtFirst} ELSE NULL END, NOW()
    FROM premium_reservations WHERE car_id = ${carId} AND status IN ('pending','confirmed')`;
  const mine = (await sql`SELECT position, expires_at FROM premium_reservations WHERE id = ${id} LIMIT 1`)[0] || {};
  const position = Number(mine.position || 1);
  const expiresAt = mine.expires_at || null;
  return c.json({ ok: true, reservation: { id, carId, category: cr.category, position, distanceKm: km, priceTotal: price, scheduledAt: scheduledIso, expiresAt, status: 'pending' } });
});

// GET /api/v1/premium/reservations/mine — minhas reservas premium
app.get('/api/v1/premium/reservations/mine', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  await premiumExpire(sql, c.env, false, (c as any).executionCtx);
  const rows = await sql`
    SELECT pr.*, pf.make, pf.model, pf.color, pf.year, pf.plate, pf.price_per_km, pf.photo, u.name AS driver_name, u.phone AS driver_phone,
      (SELECT COUNT(*) FROM premium_reservations pr2 WHERE pr2.car_id = pr.car_id AND pr2.status IN ('pending','confirmed')) AS queue_n
    FROM premium_reservations pr
    LEFT JOIN premium_fleet pf ON pf.id = pr.car_id
    LEFT JOIN drivers d ON d.id = pf.driver_id
    LEFT JOIN users u ON u.id = d."userId"
    WHERE pr.passenger_id = ${user.sub} AND pr.status IN ('pending','confirmed')
    ORDER BY pr.created_at DESC LIMIT 50`;
  const list = (rows || []) as any[];
  // Dados bancários só para quem está em 1.º da fila (é o único que paga agora).
  let pay: any = null;
  if (list.some((r) => r.status === 'pending' && Number(r.position) === 1)) pay = await premiumPaymentGet(sql);
  return c.json({
    reservations: list.map((r) => {
      const out = premiumResOut(r);
      return (r.status === 'pending' && Number(r.position) === 1) ? { ...out, payment: pay } : out;
    }),
  });
});

// GET /api/v1/premium/reservations/:id — detalhe de uma reserva
app.get('/api/v1/premium/reservations/:id', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const user = c.get('user');
  await premiumExpire(sql, c.env, false, (c as any).executionCtx);
  const id = c.req.param('id');
  const rows = await sql`
    SELECT pr.*, pf.make AS car_make, pf.model AS car_model, pf.color AS car_color, pf.year AS car_year, pf.plate AS car_plate, pf.photo AS car_photo, pf.price_per_km, u.name AS driver_name, u.phone AS driver_phone,
      (SELECT COUNT(*) FROM premium_reservations pr2 WHERE pr2.car_id = pr.car_id AND pr2.status IN ('pending','confirmed')) AS queue_n
    FROM premium_reservations pr
    LEFT JOIN premium_fleet pf ON pf.id = pr.car_id
    LEFT JOIN drivers d ON d.id = pf.driver_id
    LEFT JOIN users u ON u.id = d."userId"
    WHERE pr.id = ${id} LIMIT 1`;
  if (!rows.length) return c.json({ message: 'Reserva não encontrada.' }, 404);
  const r = rows[0];
  if (r.passenger_id !== user.sub && user.role !== 'ADMIN') return c.json({ message: 'Sem acesso a esta reserva.' }, 403);
  const out: any = premiumResOut(r);
  // Dados bancários só para quem está em 1.º da fila e ainda a pagar.
  if (r.status === 'pending' && Number(r.position) === 1) out.payment = await premiumPaymentGet(sql);
  return c.json({ reservation: out });
});

// DELETE /api/v1/premium/reservations/:id — passageira cancela a sua reserva
app.delete('/api/v1/premium/reservations/:id', requireAuth, async (c) => {
  const guard = writeGuard(c); if (guard) return guard;
  const sql = neon(c.env.DB);
  const user = c.get('user');
  const id = c.req.param('id');
  const r = await sql`SELECT id, car_id, status FROM premium_reservations WHERE id = ${id} AND passenger_id = ${user.sub} LIMIT 1`;
  if (!r.length) return c.json({ message: 'Reserva não encontrada.' }, 404);
  const st = String(r[0].status || '');
  if (st !== 'pending' && st !== 'confirmed') return c.json({ message: 'Esta reserva já não pode ser cancelada.' }, 409);
  const wasConfirmed = st === 'confirmed';
  await sql`UPDATE premium_reservations SET status = 'cancelled', expires_at = NULL WHERE id = ${id} AND status IN ('pending','confirmed')`;
  if (wasConfirmed) {
    await sql`UPDATE premium_fleet SET status = 'available' WHERE id = ${r[0].car_id} AND status = 'reserved'`;
  } else {
    // Saiu da fila: quem estava atrás sobe (e o novo 1.º ganha os 10 min agora).
    await premiumAfterQueue(sql, c.env, String(r[0].car_id || ''), (c as any).executionCtx);
  }
  return c.json({ ok: true });
});

async function ringStart(env: any) {
  try {
    const stub = env.RINGER.get(env.RINGER.idFromName('global'));
    await stub.fetch('https://ringer/kick');
  } catch {}
}

// Retenção do histórico de posições (30 dias) e do log do guarda de viagens (7 dias).
// Corre 1x/dia via Cron Trigger. `try` separados: se um falhar o outro continua.
async function purgeTripPoints(env: any) {
  const sql = neon(env.DB);
  try {
    await sql`DELETE FROM trip_points WHERE ts < ${Date.now() - 30 * 24 * 60 * 60 * 1000}`;
  } catch {}
  try {
    // O log do guarda é diagnóstico: 7 dias chegam (e a tabela fica pequena).
    await sql`DELETE FROM stale_guard_log WHERE "createdAt" < NOW() - INTERVAL '7 days'`;
  } catch {}
}

// ─── Guarda de viagens esquecidas ───────────────────────────────────────────
// PROBLEMA: uma viagem que fica aberta sem ninguém a mexer nela gasta quota 24/7 —
// o WS da viagem, o ciclo de GPS e o polling dos dois lados continuam a correr.
// Medido (2026-10-30): ~600 pedidos de Durable Object por hora e por viagem aberta.
// Fechar à 4.ª hora custa ~15 linhas escritas; deixá-la 10 h abertas custa ~4 300
// pedidos de DO + ~1 900 escritas.
//
// REGRAS guiadas pelo GPS, não pelo relógio: o sinal de vida de uma viagem é o
// último ponto em `trip_points` (1 ponto/180 s durante a viagem), não o `updatedAt`
// — as ofertas e as leituras também refrescam o `updatedAt`.
//
//   REQUESTED                  aberta há >6 min ........................... fechar
//   ACCEPTED                   sem GPS há >20 min (piso 25 min) ........... fechar
//   DRIVER_ARRIVED             sem GPS há >30 min (piso 40 min) ........... fechar
//   IN_PROGRESS                sem GPS há >45 min (piso 60 min) ........... fechar
//   REQUESTED/ACCEPTED/ARRIVED aberta há >4 h ............................. fechar
//   IN_PROGRESS                aberta há >8 h ............................. fechar
//
// O `REQUESTED` é o único guiado pelo RELÓGIO, e de propósito: a passageira está
// na tela "A procurar motorista…" e 6 min sem ninguém aceitar é tempo demais
// (a oferta roda a cada 30 s e o raio já expandiu 3×). Os restantes são guiados
// pelo GPS e com pisos generosos: fechar a viagem de quem está DENTRO do carro é
// pior do que deixá-la aberta mais uma hora. Um `IN_PROGRESS` só morre depois de
// 45 min sem uma única posição (ou 8 h de vida).
//
// MODOS (`system_flags.stale_guard`, 1 linha/execução):
//   'off'    não faz nada;
//   'shadow' só regista as candidatas em `stale_guard_log` — é o DEFAULT (também
//            quando a flag ou a tabela não existem), para o dono rever antes;
//   'on'     fecha as viagens.
// Nunca toca em COMPLETED/CANCELLED. Viagem com `scheduledAt` no futuro é ignorada
// em QUALQUER estado (foi marcada para mais tarde, não está esquecida).
// Corre no cron POR MINUTO (o que já existe) e não 1×/hora: com a regra dos 6 min
// uma passagem horária deixaria a passageira 6–66 min à espera. Custo de uma
// passagem sem candidatas: 1 linha (flag) + 5 (scan) = 6 leituras, 0 escritas.
// Até STALE_MAX_PER_RUN por passagem: o limite do plano Free é 50 SUBREQUESTS por
// invocação e cada fecho custa ~6 (UPDATE + DO + 2 pushes + SELECT da motorista +
// linha do log). 2 por minuto = 120/h (muito mais do que é preciso) e deixam
// margem para `premiumExpire` e para o agendador de notificações, que correm na
// MESMA invocação do cron.
const STALE_REQ_MIN = 6;
const STALE_NOGPS_ACCEPTED_MIN = 20;
const STALE_NOGPS_ARRIVED_MIN = 30;
const STALE_NOGPS_INPROGRESS_MIN = 45;
const STALE_MIN_LIFE_ACCEPTED_MIN = 25;
const STALE_MIN_LIFE_ARRIVED_MIN = 40;
const STALE_MIN_LIFE_INPROGRESS_MIN = 60;
const STALE_CAP_MIN = 240;
const STALE_CAP_IN_PROGRESS_MIN = 480;
const STALE_MAX_PER_RUN = 2;
const STALE_SCAN_LIMIT = 50;

// Datas da D1 são TEXT ISO (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`); aceitamos
// também epoch em segundos/ms para linhas antigas ou de importação.
function staleMs(v: any): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number' || /^-?\d+$/.test(String(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (n > 1e12) return n;            // ms
    if (n > 1e9) return n * 1000;      // segundos
    return 0;
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

// Modo do guarda. Falha de D1 (tabela ausente, quota) -> 'off': nunca fechar
// viagens por causa de um erro de leitura.
async function staleGuardMode(env: any): Promise<string> {
  try {
    const sql = neon(env.DB);
    const rows: any[] = await sql`SELECT value FROM system_flags WHERE key = 'stale_guard'`;
    const v = String((rows && rows[0] && rows[0].value) || '').trim().toLowerCase();
    if (v === 'on' || v === 'off' || v === 'shadow') return v;
    return 'shadow';
  } catch {
    return 'off';
  }
}

// 1 linha por decisão. Escrita IMEDIATAMENTE a seguir ao fecho (antes dos avisos):
// se o push falhar, a decisão não se perde.
async function staleLogOne(env: any, mode: string, e: any): Promise<boolean> {
  try {
    const sql = neon(env.DB);
    await sql`INSERT INTO stale_guard_log (id, "createdAt", mode, "tripId", status, reason, "ageMin", "idleMin", action)
      VALUES (${crypto.randomUUID()}, NOW(), ${mode}, ${String(e.tripId)}, ${String(e.status)}, ${String(e.reason).slice(0, 120)},
        ${Math.round(Number(e.ageMin) || 0)}, ${Number.isFinite(Number(e.idleMin)) ? Math.round(Number(e.idleMin)) : null},
        ${mode === 'on' ? 'closed' : 'shadow'})`;
    return true;
  } catch {
    return false;
  }
}

async function staleLogWrite(env: any, mode: string, entries: any[]): Promise<number> {
  let n = 0;
  for (const e of entries) if (await staleLogOne(env, mode, e)) n += 1;
  return n;
}

// Varre as viagens ativas e (conforme o modo) fecha as esquecidas.
// `opts.dry` = só pré-visualizar: nunca escreve, nunca fecha, ignora o modo.
async function sweepStaleTrips(env: any, opts?: { mode?: string; max?: number; dry?: boolean }) {
  const dry = !!opts?.dry;
  const reqMode = String(opts?.mode || '').trim().toLowerCase();
  const mode = reqMode === 'on' || reqMode === 'off' || reqMode === 'shadow' ? reqMode : await staleGuardMode(env);
  const max = Math.max(1, Math.min(50, Math.trunc(Number(opts?.max)) || STALE_MAX_PER_RUN));
  const out: any = { mode, dry, scanned: 0, candidates: [], closed: 0, logged: 0 };
  if (mode === 'off' && !dry) return out;

  const sql = neon(env.DB);
  const now = Date.now();
  let rows: any[] = [];
  try {
    // QUOTA: `INDEXED BY trips_status_idx` (status, createdAt) — só as viagens em
    // estado ativo, não o histórico (ver "Terceira vaga" no AGENTS.md).
    rows = await sql`SELECT t.id, t.status, t."passengerId", t."driverId", t."createdAt", t."updatedAt", t."scheduledAt",
        (SELECT MAX(p.ts) FROM trip_points p WHERE p."tripId" = t.id) AS "lastTs"
      FROM trips t INDEXED BY trips_status_idx
      WHERE t.status IN ('REQUESTED','ACCEPTED','DRIVER_ARRIVED','IN_PROGRESS')
      ORDER BY t."createdAt" ASC LIMIT ${STALE_SCAN_LIMIT}`;
  } catch {
    out.error = 'leitura falhou';
    return out;
  }
  out.scanned = rows.length;

  const hits: any[] = [];
  for (const r of rows) {
    const st = String(r.status || '');
    const createdMs = staleMs(r.createdAt) || staleMs(r.updatedAt);
    if (!createdMs) continue;
    // Viagem agendada para o futuro é ignorada em QUALQUER estado: foi marcada
    // para mais tarde, não está esquecida. (A app envia `scheduledAt: 0`, mas a
    // API aceita uma hora marcada.)
    const schedMs = staleMs(r.scheduledAt);
    if (schedMs && schedMs > now) continue;
    const ageMin = (now - createdMs) / 60000;
    // Sinal de vida = última posição gravada OU a última transição de estado
    // (o que for mais recente). Assim nunca fechamos uma viagem viva.
    const lastSeen = Math.max(Number(r.lastTs) || 0, staleMs(r.updatedAt) || 0) || createdMs;
    const idleMin = (now - lastSeen) / 60000;
    let reason = '';
    if (st === 'REQUESTED') {
      if (ageMin >= STALE_REQ_MIN) reason = `Nenhuma motorista aceitou em ${STALE_REQ_MIN} minutos.`;
    } else if (st === 'ACCEPTED') {
      if (ageMin >= STALE_MIN_LIFE_ACCEPTED_MIN && idleMin >= STALE_NOGPS_ACCEPTED_MIN) reason = 'Perdemos o sinal da motorista.';
    } else if (st === 'DRIVER_ARRIVED') {
      // A motorista já chegou: se o GPS morreu com a passageira à espera, o piso
      // é mais alto (há sempre alguém no sítio a poder fechar à mão).
      if (ageMin >= STALE_MIN_LIFE_ARRIVED_MIN && idleMin >= STALE_NOGPS_ARRIVED_MIN) reason = 'A motorista chegou mas a viagem não avançou.';
    } else if (st === 'IN_PROGRESS') {
      if (ageMin >= STALE_MIN_LIFE_INPROGRESS_MIN && idleMin >= STALE_NOGPS_INPROGRESS_MIN) reason = 'Perdemos o sinal do carro durante a viagem.';
    }
    // Teto duro por estado: `IN_PROGRESS` ganha mais 4 h (pode ser uma viagem
    // longa); os outros caem às 4 h mesmo com GPS a chegar.
    if (!reason) {
      const cap = st === 'IN_PROGRESS' ? STALE_CAP_IN_PROGRESS_MIN : STALE_CAP_MIN;
      if (ageMin >= cap) reason = 'A viagem ficou aberta demasiado tempo.';
    }
    if (!reason) continue;
    hits.push({
      tripId: String(r.id),
      status: st,
      passengerId: r.passengerId ? String(r.passengerId) : null,
      driverId: r.driverId ? String(r.driverId) : null,
      reason: reason.slice(0, 80),
      ageMin,
      idleMin,
    });
    if (hits.length >= max) break;
  }

  out.candidates = hits.map((h) => ({
    tripId: h.tripId, status: h.status, ageMin: Math.round(h.ageMin),
    idleMin: Number.isFinite(h.idleMin) ? Math.round(h.idleMin) : null, reason: h.reason,
  }));
  if (!hits.length) return out;
  if (dry) return out;
  if (mode === 'shadow') {
    out.logged = await staleLogWrite(env, 'shadow', hits);
    return out;
  }

  const closed: any[] = [];
  let wasRequested = false;
  for (const h of hits) {
    let upd: any[] = [];
    try {
      // Idempotente: só fecha se ainda estiver ATIVA e no mesmo estado lido (a
      // motorista pode ter aceitado/avançado entretanto).
      upd = await sql`UPDATE trips SET status = 'CANCELLED', "cancelledBy" = 'system', "cancelReason" = ${h.reason}, "updatedAt" = NOW()
        WHERE id = ${h.tripId} AND status = ${h.status}
        RETURNING "passengerId", "driverId"`;
    } catch {
      continue;
    }
    if (!upd.length) continue;
    out.closed += 1;
    const paxId = upd[0].passengerId ? String(upd[0].passengerId) : h.passengerId;
    const drvId = upd[0].driverId ? String(upd[0].driverId) : h.driverId;
    const row = { ...h, passengerId: paxId, driverId: drvId };
    // A linha do log é escrita JÁ a seguir ao fecho (custo 1 escrita): se o push
    // falhar, a decisão fica registada à mesma.
    out.logged += (await staleLogOne(env, 'on', row)) ? 1 : 0;
    closed.push(row);
    if (h.status === 'REQUESTED') wasRequested = true;
    // Aviso imediato aos dois lados (o `by:'system'` chega ao cliente como ''
    // e o banner mostra "Viagem cancelada" + "Motivo: …").
    try { await notifyTripPush(env, h.tripId, 'CANCELLED', { by: 'system', reason: h.reason }); } catch {}
    try {
      const body = `Motivo: ${h.reason}`;
      await pushToUser(sql, paxId, 'Viagem cancelada', body, { tripId: h.tripId, type: 'cancelled' });
      if (drvId) {
        const d = await sql`SELECT "userId" FROM drivers WHERE id = ${drvId} LIMIT 1`;
        const du = d.length ? String(d[0].userId || '') : '';
        if (du) await pushToUser(sql, du, 'Corrida cancelada', body, { tripId: h.tripId, type: 'cancelled' });
      }
    } catch {}
  }
  // Pedidos que saíram do feed: uma única difusão no fim (não 1 por viagem) —
  // cada `hubBroadcast` é um subrequest.
  if (wasRequested) { try { await hubBroadcast(env); } catch {} }
  return out;
}

// GET /api/v1/admin/stale-guard — modo atual, últimas decisões e pré-visualização
// (dry-run: nunca fecha nem escreve).
app.get('/api/v1/admin/stale-guard', adminMiddleware, async (c) => {
  const sql = neon(c.env.DB);
  const mode = await staleGuardMode(c.env);
  // `max` só alarga a pré-visualização (1..50); nunca altera o limite do cron.
  const max = Math.max(1, Math.min(50, Math.trunc(Number(c.req.query('max')) || STALE_MAX_PER_RUN)));
  // `dry` + `mode` para não voltar a ler a flag (1 leitura em vez de 2).
  const preview = await sweepStaleTrips(c.env, { dry: true, mode, max });
  let log: any[] = [];
  try {
    log = await sql`SELECT "tripId", status, reason, mode, "ageMin", "idleMin", action, "createdAt"
      FROM stale_guard_log ORDER BY "createdAt" DESC LIMIT 40`;
  } catch {}
  return c.json({
    mode,
    rules: {
      requestedMin: STALE_REQ_MIN,
      noGpsAcceptedMin: STALE_NOGPS_ACCEPTED_MIN,
      noGpsArrivedMin: STALE_NOGPS_ARRIVED_MIN,
      noGpsInProgressMin: STALE_NOGPS_INPROGRESS_MIN,
      minLifeAcceptedMin: STALE_MIN_LIFE_ACCEPTED_MIN,
      minLifeArrivedMin: STALE_MIN_LIFE_ARRIVED_MIN,
      minLifeInProgressMin: STALE_MIN_LIFE_INPROGRESS_MIN,
      capMin: STALE_CAP_MIN,
      capInProgressMin: STALE_CAP_IN_PROGRESS_MIN,
      maxPerRun: STALE_MAX_PER_RUN,
    },
    active: preview.scanned,
    candidates: preview.candidates,
    log,
  });
});

// ── Vigilante da quota no próprio Worker (30/10/2026) ────────────────────────
// O agendador do GitHub não cumpre neste repositório (medido: `keep-alive` com
// `*/10 * * * *` fez 29 execuções em 6,8 dias, com intervalos de 3–10 h; o
// `quota-watch` de 3 em 3 horas ficou a 0 nos dois primeiros slots). O cron por
// minuto do Worker já existe, por isso a vigilância passa a viver aqui: 1 leitura
// da GraphQL Analytics de 3 em 3 horas e o corte de carga em `system_flags`.
app.get('/api/v1/admin/quota', adminMiddleware, async (c) => {
  return c.json(await lastQuotaState(c.env));
});
// Forçar uma leitura agora (admin). Custa 1 chamada à GraphQL; não toca na app.
app.post('/api/v1/admin/quota/check', adminMiddleware, async (c) => {
  const r = await runQuotaWatch(c.env, true);
  return c.json({ ...r, state: await lastQuotaState(c.env) });
});
// Teste do caminho CRÍTICO sem gastar quota a sério (só staging + ADMIN):
// injeta uma leitura de 93% e corre o alerta + corte de carga verdadeiros.
app.post('/api/v1/debug/quota/alert', adminMiddleware, async (c) => {
  if (String(c.env.ENVIRONMENT || '') !== 'staging') return c.json({ message: 'Not found.' }, 404);
  const now = Date.now();
  const fake: any = {
    ts: now,
    account: String(c.env.CF_ACCOUNT_ID || ''),
    level: 3,
    levelName: 'CRÍTICO',
    worst: { key: 'reads', used: 4_650_000, max: 5_000_000, pct: 0.93 },
    metrics: [
      { key: 'requests', used: 30_000, max: 100_000, pct: 0.3 },
      { key: 'reads', used: 4_650_000, max: 5_000_000, pct: 0.93 },
      { key: 'writes', used: 20_000, max: 100_000, pct: 0.2 },
      { key: 'doRequests', used: 5_000, max: 100_000, pct: 0.05 },
      { key: 'doGbSeconds', used: 300, max: 13_000, pct: 0.02 },
    ],
    shed: 2,
  };
  const r = await runQuotaWatch(c.env, true, fake);
  return c.json({ ...r, fake: true, state: await lastQuotaState(c.env) });
});

export default {
  fetch: app.fetch,
  async scheduled(event: any, env: any, _ctx: any) {
    // Fila Premium: expira o 1.º que não pagou e promove/avisa o seguinte.
    try { await premiumExpire(neon(env.DB), env, true, _ctx); } catch {}
    // Agendadas: em try/catch para um erro aqui não impedir o guarda (e vice-versa).
    try { await runNotificationSchedules(env); } catch {}
    // Guarda de viagens esquecidas: corre a CADA MINUTO (o cron já bate ao
    // minuto, logo 0 pedidos extra) porque a regra do `REQUESTED` é de 6 min —
    // 1×/hora deixaria a passageira até 66 min na tela "A procurar motorista…".
    try {
      if (event && event.cron === '* * * * *') await sweepStaleTrips(env);
    } catch {}
    if (!event || event.cron === '17 3 * * *') {
      await purgeTripPoints(env);
      await rotateTurnCredential(env);
    }
    // Quota: ao minuto 0 dos slots de 3 em 3 horas (00/03/06/…/21Z). O "claim" em
    // `system_flags.quota_watch` (90 min) impede repetições com vários isolates.
    try {
      const now = new Date();
      if (now.getUTCMinutes() === 0 && now.getUTCHours() % 3 === 0) await runQuotaWatch(env);
    } catch {}
  },
};
