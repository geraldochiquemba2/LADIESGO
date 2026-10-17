import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REST = 'https://ladiesgo-api.ladiesgo-ao.workers.dev/api/v1';
const WS_BASE = 'wss://ladiesgo-api.ladiesgo-ao.workers.dev/api/v1';

const ADMIN_PHONE = '999999999';
const ADMIN_PASS = '1234567890';
const DRIVER_PASS = '0987654321';
const PAX_PASS = 'Test1234';

const GRID_STEP = 0.05;
const BASE_LAT = -8.90;
const BASE_LNG = 13.20;
const OFFSET = 0.008;

const REQ_TIMEOUT_MS = 30000;
const MAX_CONCURRENT = 5000;

const WS = globalThis.WebSocket;
if (typeof WS !== 'function') {
  console.error('No global WebSocket. Install ws in the temp workspace and rerun with --module=ws.');
  process.exit(2);
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k, d) => {
    const p = a.find((x) => x.startsWith(`--${k}=`));
    return p ? p.slice(k.length + 3) : d;
  };
  const max = Math.min(MAX_CONCURRENT, Math.max(1, parseInt(get('max', '100'), 10) || 100));
  const levelsRaw = get('levels', '5,20,50,100').split(',').map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && x > 0);
  const levels = [...new Set(levelsRaw)].filter((n) => n <= max).sort((x, y) => x - y);
  const out = get('out', '');
  return { max, levels, out };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let requestCount = 0;
const statusCounts = {};

async function api(method, path, { token, body, timeout = REQ_TIMEOUT_MS } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const t0 = performance.now();
  requestCount++;
  try {
    let res = await fetch(REST + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    let text = await res.text();
    for (let a = 0; a < 8 && res.status === 503 && text.includes('exceeded resource'); a++) {
      statusCounts['503-retry'] = (statusCounts['503-retry'] || 0) + 1;
      await new Promise((r) => setTimeout(r, 900));
      requestCount++;
      res = await fetch(REST + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
      text = await res.text();
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
    return { ok: res.ok, status: res.status, json, text, ms: performance.now() - t0 };
  } catch (e) {
    const name = e?.name || 'Error';
    statusCounts[name] = (statusCounts[name] || 0) + 1;
    return { ok: false, status: 0, error: name, json: null, text: String(e?.message || e), ms: performance.now() - t0 };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

const RUN = (Date.now() % 1e9).toString().padStart(9, '0');
const SETUP_CONC = Math.max(1, parseInt((process.argv.slice(2).find((x) => x.startsWith('--setup=')) || '').slice(8), 10) || 16);
const pad2 = (n) => String(n).padStart(4, '0');
const driverPhone = (i) => `+24498${RUN}${pad2(i)}`;
const paxPhone = (i) => `+24497${RUN}${pad2(i)}`;

function point(i) {
  const row = Math.floor(i / 10);
  const col = i % 10;
  return { lat: +(BASE_LAT - row * GRID_STEP).toFixed(6), lng: +(BASE_LNG + col * GRID_STEP).toFixed(6) };
}

function fatal(msg, detail) {
  const err = new Error('FATAL: ' + msg);
  err.detail = detail;
  throw err;
}

async function adminLogin() {
  const r = await api('POST', '/auth/login', { body: { phone: ADMIN_PHONE, password: ADMIN_PASS } });
  if (!r.ok || !r.json?.accessToken) fatal('admin login failed', r.text || r.status);
  if (r.json?.user?.role !== 'ADMIN') fatal('admin login did not return ADMIN role', JSON.stringify(r.json?.user));
  return r.json.accessToken;
}

async function createDrivers(adminToken, n) {
  const items = Array.from({ length: n }, (_, i) => i);
  return await mapLimit(items, SETUP_CONC, async (i) => {
    const phone = driverPhone(i);
    const body = {
      phone,
      name: `LT-Driver-${pad2(i)}`,
      licenseNumber: `LT-LIC-${RUN}-${pad2(i)}`,
      carPlate: `LT-${RUN.slice(-4)}-${pad2(i)}`,
      carMake: 'Toyota',
      carModel: 'Corolla',
      carColor: 'White',
      carYear: 2018,
    };
    const c = await api('POST', '/admin/drivers/create', { token: adminToken, body });
    if (c.status === 401 || c.status === 403) fatal('admin driver creation unauthorized', c.text || c.status);
    if (!c.ok) {
      const login = await api('POST', '/auth/login', { body: { phone, password: DRIVER_PASS } });
      if (!login.ok || !login.json?.accessToken) fatal(`create+login driver ${i} failed`, `create=${c.status} ${c.text} | login=${login.status} ${login.text}`);
      return { i, phone, token: login.json.accessToken };
    }
    const login = await api('POST', '/auth/login', { body: { phone, password: DRIVER_PASS } });
    if (!login.ok || !login.json?.accessToken) fatal(`driver ${i} login failed`, `${login.status} ${login.text}`);
    return { i, phone, token: login.json.accessToken };
  });
}

async function registerPassengers(n) {
  const items = Array.from({ length: n }, (_, i) => i);
  return await mapLimit(items, SETUP_CONC, async (i) => {
    const phone = paxPhone(i);
    const r = await api('POST', '/auth/register', { body: { phone, password: PAX_PASS, name: `LT-Pax-${pad2(i)}`, role: 'PASSENGER' } });
    if (!r.ok || !r.json?.accessToken) fatal(`register pax ${i} failed`, `${r.status} ${r.text}`);
    return { i, phone, token: r.json.accessToken, userId: r.json.user?.id };
  });
}

async function goOnlineAndLocate(drivers) {
  await mapLimit(drivers, 8, async (d) => {
    const p = point(d.i);
    const on = await api('PUT', '/drivers/toggle-online', { token: d.token, body: { isOnline: true } });
    if (!on.ok) fatal(`toggle-online driver ${d.i} failed`, `${on.status} ${on.text}`);
    const loc = await api('PUT', '/drivers/location', { token: d.token, body: { lat: p.lat, lng: p.lng } });
    if (!loc.ok) fatal(`set location driver ${d.i} failed`, `${loc.status} ${loc.text}`);
  });
}

async function refreshLocations(drivers, n) {
  await mapLimit(drivers.slice(0, n), 10, async (d) => {
    const p = point(d.i);
    await api('PUT', '/drivers/location', { token: d.token, body: { lat: p.lat, lng: p.lng } });
  });
}

const activeTrips = new Map();

async function cleanupActive() {
  const ids = [...activeTrips.keys()];
  await mapLimit(ids, 10, async (id) => {
    const info = activeTrips.get(id);
    await api('PUT', `/trips/${id}/cancel`, { token: info.paxToken, body: { reason: 'LT cleanup' } });
    activeTrips.delete(id);
  });
}

function detailOf(r) {
  return `${r.status} ${(r.text || r.error || '').slice(0, 160)}`;
}

async function acceptWithRetry(id, token) {
  let r = await api('PUT', `/trips/${id}/accept`, { token });
  for (let a = 0; a < 3 && !r.ok && r.status === 409; a++) {
    await delay(500);
    r = await api('PUT', `/trips/${id}/accept`, { token });
  }
  return r;
}

async function runPair(i, drivers, pax) {
  const rec = { i, steps: {}, ok: false };
  const dt = drivers[i].token;
  const pt = pax[i].token;
  const pickup = point(i);
  const drop = { lat: +(pickup.lat + OFFSET).toFixed(6), lng: +(pickup.lng + OFFSET).toFixed(6) };
  let step = 'request';
  try {
    let r = await api('POST', '/trips/request', {
      token: pt,
      body: {
        pickupLat: pickup.lat, pickupLng: pickup.lng,
        dropoffLat: drop.lat, dropoffLng: drop.lng,
        pickupAddress: `LT pickup ${i}`, dropoffAddress: `LT drop ${i}`,
        rideType: 'ECONOMY', paymentMethod: 'CASH',
      },
    });
    rec.steps.request = r.ms;
    if (!r.ok) throw { step, r };
    const id = r.json?.id;
    if (!id) throw { step, r };
    rec.tripId = id;
    activeTrips.set(id, { paxToken: pt, drvToken: dt });

    step = 'accept';
    r = await acceptWithRetry(id, dt);
    rec.steps.accept = r.ms;
    if (!r.ok) throw { step, r };

    step = 'arrived';
    r = await api('PUT', `/trips/${id}/arrived`, { token: dt });
    rec.steps.arrived = r.ms;
    if (!r.ok) throw { step, r };

    step = 'getPin';
    r = await api('GET', `/trips/${id}`, { token: pt });
    rec.steps.getPin = r.ms;
    if (!r.ok) throw { step, r };
    const pin = r.json?.pin;
    if (!pin) throw { step, r };

    step = 'start';
    r = await api('PUT', `/trips/${id}/start`, { token: dt, body: { pin } });
    rec.steps.start = r.ms;
    if (!r.ok) throw { step, r };

    step = 'complete';
    r = await api('PUT', `/trips/${id}/complete`, { token: dt });
    rec.steps.complete = r.ms;
    if (!r.ok) throw { step, r };

    activeTrips.delete(id);
    rec.ok = true;
  } catch (e) {
    rec.error = { step: e.step || step, detail: e.r ? detailOf(e.r) : String(e) };
  }
  return rec;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarizeLatencies(values) {
  if (!values.length) return { p50: null, p95: null, max: null, min: null, avg: null };
  const s = [...values].sort((a, b) => a - b);
  return {
    p50: +percentile(s, 50).toFixed(1),
    p95: +percentile(s, 95).toFixed(1),
    max: +s[s.length - 1].toFixed(1),
    min: +s[0].toFixed(1),
    avg: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1),
  };
}

async function runLevel(n, drivers, pax) {
  const tasks = Array.from({ length: n }, (_, i) => runPair(i, drivers, pax));
  const t0 = performance.now();
  const recs = await Promise.all(tasks);
  const wallMs = performance.now() - t0;

  const ok = recs.filter((r) => r.ok);
  const failed = recs.filter((r) => !r.ok);
  const lifecycle = ok.map((r) => Object.values(r.steps).reduce((a, b) => a + b, 0));
  const byType = {};
  for (const f of failed) {
    const key = `${f.error.step}:${f.error.detail.split(' ')[0]}`;
    byType[key] = (byType[key] || 0) + 1;
  }
  const stepAgg = {};
  for (const key of ['request', 'accept', 'arrived', 'getPin', 'start', 'complete']) {
    const vals = ok.map((r) => r.steps[key]).filter((x) => typeof x === 'number');
    stepAgg[key] = summarizeLatencies(vals);
  }
  return {
    n,
    total: recs.length,
    succeeded: ok.length,
    failed: failed.length,
    successRate: +(ok.length / recs.length * 100).toFixed(1),
    wallMs: +wallMs.toFixed(0),
    throughputPerMin: +(ok.length / (wallMs / 60000)).toFixed(1),
    lifecycle: summarizeLatencies(lifecycle),
    steps: stepAgg,
    errorsByType: byType,
    failures: failed.map((f) => ({ i: f.i, step: f.error.step, detail: f.error.detail })),
  };
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WS(url);
    const msgs = [];
    const raw = [];
    const waiters = [];
    let opened = false;
    ws.onmessage = (ev) => {
      const d = typeof ev.data === 'string' ? ev.data : String(ev.data);
      let m;
      try { m = JSON.parse(d); } catch { m = d; }
      raw.push(d);
      msgs.push(m);
      for (const w of waiters.slice()) {
        let hit = false;
        try { hit = w.pred(m); } catch {}
        if (hit) {
          const ix = waiters.indexOf(w);
          if (ix >= 0) waiters.splice(ix, 1);
          w.resolve(m);
        }
      }
    };
    ws.onerror = () => {};
    ws.onopen = () => {
      opened = true;
      resolve({
        ws, msgs, raw,
        wait: (pred, to = 8000) => new Promise((res, rej) => {
          for (const m of msgs) { let h = false; try { h = pred(m); } catch {} if (h) return res(m); }
          const w = { pred, resolve: res };
          waiters.push(w);
          setTimeout(() => {
            const ix = waiters.indexOf(w);
            if (ix >= 0) waiters.splice(ix, 1);
            rej(new Error('ws wait timeout'));
          }, to);
        }),
      });
    };
    setTimeout(() => { if (!opened) reject(new Error('ws open timeout')); }, 12000);
  });
}

async function wsCheck(drivers, pax, idx) {
  const out = { ok: false, checks: {} };
  const dt = drivers[idx].token;
  const pt = pax[idx].token;
  let id = null;
  let paxSock, drvSock;
  try {
    const pickup = point(idx);
    const drop = { lat: pickup.lat + OFFSET, lng: pickup.lng + OFFSET };
    const r = await api('POST', '/trips/request', {
      token: pt,
      body: { pickupLat: pickup.lat, pickupLng: pickup.lng, dropoffLat: drop.lat, dropoffLng: drop.lng, pickupAddress: 'LT ws pickup', dropoffAddress: 'LT ws drop', rideType: 'ECONOMY', paymentMethod: 'CASH' },
    });
    if (!r.ok) throw new Error('ws setup request failed: ' + detailOf(r));
    id = r.json.id;
    activeTrips.set(id, { paxToken: pt, drvToken: dt });
    const acc = await acceptWithRetry(id, dt);
    if (!acc.ok) throw new Error('ws setup accept failed: ' + detailOf(acc));

    paxSock = await openWs(`${WS_BASE}/trips/${id}/live?token=${encodeURIComponent(pt)}`);
    drvSock = await openWs(`${WS_BASE}/trips/${id}/live?token=${encodeURIComponent(dt)}`);

    let helloPax = null;
    try { helloPax = await paxSock.wait((m) => m && m.t === 'hello', 2000); } catch {}
    out.checks.hello = { received: !!helloPax, tripId: helloPax?.tripId, note: helloPax ? undefined : 'server did not send hello (DO webSocketOpen not a hibernation handler)' };

    await delay(600);
    paxSock.ws.send('ping');
    const pong = await paxSock.wait((m) => m === 'pong');
    out.checks.pingPong = pong === 'pong';

    drvSock.ws.send(JSON.stringify({ t: 'gps', role: 'driver', lat: pickup.lat, lng: pickup.lng }));
    const drvFrame = await paxSock.wait((m) => m && m.t === 'driver');
    out.checks.driverGps = { got: !!drvFrame, lat: drvFrame?.lat, lng: drvFrame?.lng };

    paxSock.ws.send(JSON.stringify({ t: 'gps', role: 'pax', lat: pickup.lat, lng: pickup.lng }));
    const paxFrame = await drvSock.wait((m) => m && m.t === 'pax');
    out.checks.paxGps = { got: !!paxFrame };

    paxSock.ws.send(JSON.stringify({ t: 'chat', text: 'LT-ws-hello', from: 'LT-Pax' }));
    const chatFrame = await drvSock.wait((m) => m && m.t === 'chat');
    out.checks.chat = { got: !!chatFrame, text: chatFrame?.text, from: chatFrame?.from };

    out.ok = out.checks.pingPong && out.checks.driverGps.got && out.checks.paxGps.got && out.checks.chat.got;
  } catch (e) {
    out.error = String(e?.message || e);
  } finally {
    try { paxSock?.ws?.close(); } catch {}
    try { drvSock?.ws?.close(); } catch {}
    if (id && activeTrips.has(id)) {
      try { await api('PUT', `/trips/${id}/cancel`, { token: activeTrips.get(id).paxToken, body: { reason: 'LT ws cleanup' } }); } catch {}
      activeTrips.delete(id);
    }
  }
  return out;
}

async function main() {
  const cfg = parseArgs();
  const started = Date.now();
  const report = { target: REST, startedAt: new Date(started).toISOString(), run: RUN, config: cfg, levels: [], ws: null, cleanup: {}, notes: [] };
  console.log(`LadiesGo! concurrency load test  run=${RUN}  max=${cfg.max}  levels=[${cfg.levels.join(',')}]`);

  let drivers = [];
  let pax = [];
  let adminToken = null;
  try {
    adminToken = await adminLogin();
    console.log('[setup] admin OK');

    drivers = await createDrivers(adminToken, cfg.max);
    console.log(`[setup] drivers created+logged in: ${drivers.length}/${cfg.max}`);

    pax = await registerPassengers(cfg.max);
    console.log(`[setup] passengers registered: ${pax.length}/${cfg.max}`);

    await goOnlineAndLocate(drivers);
    console.log('[setup] all drivers online + located');

    for (const n of cfg.levels) {
      console.log(`\n[level] N=${n} : refreshing ${n} driver locations...`);
      await refreshLocations(drivers, n);
      const res = await runLevel(n, drivers, pax);
      report.levels.push(res);
      console.log(`[level] N=${n} done: ${res.succeeded}/${res.total} ok (${res.successRate}%)  wall=${res.wallMs}ms  thr=${res.throughputPerMin}/min  p50=${res.lifecycle.p50}ms p95=${res.lifecycle.p95}ms max=${res.lifecycle.max}ms`);
      if (res.failed) console.log(`[level] N=${n} errors: ${JSON.stringify(res.errorsByType)}`);
      await cleanupActive();
    }

    console.log('\n[ws] running WebSocket + chat check...');
    report.ws = await wsCheck(drivers, pax, 0);
    console.log(`[ws] ${report.ws.ok ? 'PASS' : 'FAIL'}: ${JSON.stringify(report.ws.checks)}${report.ws.error ? ' err=' + report.ws.error : ''}`);
  } catch (e) {
    report.fatal = String(e?.detail || e?.message || e);
    console.error('\n' + report.fatal);
  } finally {
    try { await cleanupActive(); } catch {}
    if (drivers.length) {
      const okOff = await mapLimit(drivers, 10, async (d) => {
        const r = await api('PUT', '/drivers/toggle-online', { token: d.token, body: { isOnline: false } });
        return r.ok;
      });
      report.cleanup.driversOffline = okOff.filter(Boolean).length;
      console.log(`[cleanup] drivers set offline: ${report.cleanup.driversOffline}/${drivers.length}`);
    }
  }

  report.finishedAt = new Date().toISOString();
  report.durationSec = +((Date.now() - started) / 1000).toFixed(1);
  report.totalHttpRequests = requestCount;
  report.statusCounts = statusCounts;

  const successfulLevels = report.levels.filter((l) => l.successRate >= 99.9);
  report.headline = successfulLevels.length ? Math.max(...successfulLevels.map((l) => l.n)) : 0;

  console.log('\n================ RESULTS ================');
  console.log(`total HTTP requests: ${requestCount}`);
  console.log(`HTTP status counts: ${JSON.stringify(statusCounts)}`);
  console.log('N\tok/total\tsucc%\twall(ms)\tp50\tp95\tmax\ttrips/min\terrors');
  for (const l of report.levels) {
    console.log(`${l.n}\t${l.succeeded}/${l.total}\t${l.successRate}\t${l.wallMs}\t${l.lifecycle.p50}\t${l.lifecycle.p95}\t${l.lifecycle.max}\t${l.throughputPerMin}\t${JSON.stringify(l.errorsByType)}`);
  }
  console.log(`WS/chat: ${report.ws?.ok ? 'PASS' : 'FAIL'} ${JSON.stringify(report.ws?.checks || {})}`);
  console.log(`HEADLINE max N with ~100% success: ${report.headline}`);
  if (report.fatal) console.log(`FATAL: ${report.fatal}`);

  const outPath = cfg.out || join(dirname(fileURLToPath(import.meta.url)), `results-${RUN}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`report saved: ${outPath}`);
}

main().catch((e) => {
  console.error('unhandled:', e);
  process.exit(1);
});
