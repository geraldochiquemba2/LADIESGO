// LadiesGo fire test: generate the account pool that the k6 script consumes.
// Creates N drivers (admin) + N passengers, optionally marks drivers online and
// sets their location, then writes accounts.json (SharedArray-ready) for k6.
//
// Usage (one machine, once — then copy accounts.json to every generator VM):
//   node provision-accounts.mjs --drivers=5000 --pax=5000 --out=k6/accounts.json --online
//   node provision-accounts.mjs --drivers=50   --pax=50   --out=k6/accounts.json --online --setup=8
//
// For a WebSocket-only test a small pool is enough:
//   node provision-accounts.mjs --drivers=50 --pax=50 --out=k6/accounts.json --online
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REST = process.env.REST || process.env.API || 'https://ladiesgo-api.ladiesgo-ao.workers.dev/api/v1';
const WS_BASE = process.env.WS_BASE || REST.replace(/^http/, 'ws');

const ADMIN_PHONE = '999999999';
const ADMIN_PASS = '1234567890';
const DRIVER_PASS = '0987654321';
const PAX_PASS = 'Test1234';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (k, d) => { const p = process.argv.slice(2).find((x) => x.startsWith(`--${k}=`)); return p ? p.slice(k.length + 3) : d; };
const flag = (k) => process.argv.slice(2).includes(`--${k}`);

const DRIVERS = Math.max(0, parseInt(arg('drivers', '100'), 10) || 0);
const PAX = Math.max(0, parseInt(arg('pax', '100'), 10) || 0);
const SETUP = Math.max(1, parseInt(arg('setup', '16'), 10) || 16);
const ONLINE = flag('online');
const RUN = arg('tag', '') || (Date.now() % 1e9).toString().padStart(9, '0');
const OUT = arg('out', join(dirname(fileURLToPath(import.meta.url)), 'k6', 'accounts.json'));

let requestCount = 0;
const statusCounts = {};

async function api(method, path, { token, body, timeout = 30000 } = {}, attempt = 0) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  requestCount++;
  try {
    const res = await fetch(REST + path, {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
    if (res.status === 503 && attempt < 8) { await delay(900); return api(method, path, { token, body, timeout }, attempt + 1); }
    return { ok: res.ok, status: res.status, json, text };
  } catch (e) {
    const name = e?.name || 'Error';
    statusCounts[name] = (statusCounts[name] || 0) + 1;
    if (attempt < 8) { await delay(900); return api(method, path, { token, body, timeout }, attempt + 1); }
    return { ok: false, status: 0, error: name, text: String(e?.message || e) };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() { while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, () => worker()));
  return out;
}

const pad5 = (i) => String(i).padStart(5, '0');
const driverPhone = (i) => `+24490${RUN}${pad5(i)}`;
const paxPhone = (i) => `+24491${RUN}${pad5(i)}`;
const point = (i) => { const row = Math.floor(i / 10), col = i % 10; return { lat: +(-8.90 - row * 0.05).toFixed(6), lng: +(13.20 + col * 0.05).toFixed(6) }; };

function fatal(m, d) { const e = new Error('FATAL: ' + m); e.detail = d; throw e; }

async function main() {
  const started = Date.now();
  console.log(`LadiesGo account pool  target=${REST}  run=${RUN}  drivers=${DRIVERS}  pax=${PAX}  online=${ONLINE}`);
  const admin = await api('POST', '/auth/login', { body: { phone: ADMIN_PHONE, password: ADMIN_PASS } });
  if (!admin.ok || !admin.json?.accessToken) fatal('admin login failed', `${admin.status} ${admin.text}`);
  const adminToken = admin.json.accessToken;
  console.log('[setup] admin OK');

  const drivers = await mapLimit(Array.from({ length: DRIVERS }, (_, i) => i), SETUP, async (i) => {
    const phone = driverPhone(i);
    const c = await api('POST', '/admin/drivers/create', { token: adminToken, body: {
      phone, name: `LT-Drv-${RUN}-${pad5(i)}`, licenseNumber: `LT-LIC-${RUN}-${pad5(i)}`,
      carPlate: `LT-${RUN.slice(-4)}-${pad5(i)}`, carMake: 'Toyota', carModel: 'Corolla', carColor: 'White', carYear: 2018 } });
    if (c.status === 401 || c.status === 403) fatal('driver create unauthorized', c.text);
    const login = await api('POST', '/auth/login', { body: { phone, password: DRIVER_PASS } });
    if (!login.ok || !login.json?.accessToken) fatal(`driver ${i} login failed`, `${c.status}/${login.status} ${login.text}`);
    return { i, phone, token: login.json.accessToken };
  });
  console.log(`[setup] drivers ${drivers.length}/${DRIVERS}`);

  if (ONLINE && DRIVERS) {
    await mapLimit(drivers, SETUP, async (d) => {
      const p = point(d.i);
      await api('PUT', '/drivers/toggle-online', { token: d.token, body: { isOnline: true } });
      await api('PUT', '/drivers/location', { token: d.token, body: { lat: p.lat, lng: p.lng } });
    });
    console.log(`[setup] drivers online + located ${drivers.length}`);
  }

  const pax = await mapLimit(Array.from({ length: PAX }, (_, i) => i), SETUP, async (i) => {
    const phone = paxPhone(i);
    const r = await api('POST', '/auth/register', { body: { phone, password: PAX_PASS, name: `LT-Pax-${RUN}-${pad5(i)}`, role: 'PASSENGER' } });
    if (!r.ok || !r.json?.accessToken) fatal(`register pax ${i} failed`, `${r.status} ${r.text}`);
    return { i, phone, token: r.json.accessToken };
  });
  console.log(`[setup] pax ${pax.length}/${PAX}`);

  const payload = {
    api: REST, wsBase: WS_BASE, run: RUN, createdAt: new Date().toISOString(),
    drivers: drivers.map((d) => ({ phone: d.phone, token: d.token })),
    pax: pax.map((p) => ({ phone: p.phone, token: p.token })),
  };
  writeFileSync(OUT, JSON.stringify(payload));
  console.log(`\nHTTP requests: ${requestCount}  status: ${JSON.stringify(statusCounts)}`);
  console.log(`accounts saved: ${OUT}  (${payload.drivers.length} drivers, ${payload.pax.length} pax)`);
  console.log(`duration: ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(e.detail || e.message || e); process.exit(1); });
