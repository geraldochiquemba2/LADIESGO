// ============================================================================
// AVISO (incidente 2026-10-17): teste de carga que ajuda a esgotar a quota de
// Workers Free (100.000 pedidos/dia -> erro 1027) da conta em REST. NAO correr
// contra producao nem contra a conta que serve a API. Ver AGENTS.md.
// ============================================================================
// LadiesGo fire test: WebSocket storm against the global singleton DOs.
//   - requests-live  -> RequestsHub (idFromName('requests:global'))   [needs driver JWT]
//   - live-geo       -> DriverGeo   (idFromName('geo:global'))        [any JWT]
// Creates its own accounts, opens N sockets per channel, hammers GPS frames,
// measures open success + pong RTT + frame throughput, then cleans up.
//
// Usage:
//   node ws-storm.mjs --n=500 --channels=both --hold=60 --gps=2000 --setup=20
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REST = process.env.REST || 'https://ladiesgo-api.ladiesgo-ao.workers.dev/api/v1';
const WS_BASE = process.env.WS_BASE || 'wss://ladiesgo-api.ladiesgo-ao.workers.dev/api/v1';

const ADMIN_PHONE = '999999999';
const ADMIN_PASS = '1234567890';
const DRIVER_PASS = '0987654321';
const PAX_PASS = 'Test1234';

const MODULE = (process.argv.slice(2).find((x) => x.startsWith('--module=')) || '').slice(9) || 'native';
let WS = globalThis.WebSocket;
if (MODULE === 'ws') {
  const { pathToFileURL } = await import('node:url');
  const p = process.env.WS_PKG || 'C:/Users/Geraldo/AppData/Local/Temp/opencode/node_modules/ws/index.js';
  const mod = await import(pathToFileURL(p).href);
  WS = mod.WebSocket || mod.default || (mod.default && mod.default.WebSocket);
}
if (typeof WS !== 'function') {
  console.error('No WebSocket impl. Use --module=ws (install ws) or Node 22+.');
  process.exit(2);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (k, d) => {
  const p = process.argv.slice(2).find((x) => x.startsWith(`--${k}=`));
  return p ? p.slice(k.length + 3) : d;
};
const N = Math.max(1, parseInt(arg('n', '300'), 10) || 300);
const HOLD = Math.max(1, parseInt(arg('hold', '45'), 10) || 45);
const GPS_MS = Math.max(200, parseInt(arg('gps', '2000'), 10) || 2000);
const SETUP = Math.max(1, parseInt(arg('setup', '24'), 10) || 24);
const OPEN_CONC = Math.max(1, parseInt(arg('open', '32'), 10) || 32);
const UNIQ = String(arg('uniq', '1')) !== '0';
const CHANNELS = String(arg('channels', 'both'));
const OUT = arg('out', '');

let requestCount = 0;
const statusCounts = {};

async function api(method, path, { token, body, timeout = 30000 } = {}) {
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
    return { ok: res.ok, status: res.status, json, text };
  } catch (e) {
    const name = e?.name || 'Error';
    statusCounts[name] = (statusCounts[name] || 0) + 1;
    return { ok: false, status: 0, error: name, text: String(e?.message || e) };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() { while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

const RUN = (Date.now() % 1e9).toString().padStart(9, '0');
const pad5 = (i) => String(i).padStart(5, '0');
const driverPhone = (i) => `+24490${RUN}${pad5(i)}`;
const paxPhone = (i) => `+24491${RUN}${pad5(i)}`;

function fatal(m, d) { const e = new Error('FATAL: ' + m); e.detail = d; throw e; }

async function adminLogin() {
  const r = await api('POST', '/auth/login', { body: { phone: ADMIN_PHONE, password: ADMIN_PASS } });
  if (!r.ok || !r.json?.accessToken) fatal('admin login failed', r.text || r.status);
  return r.json.accessToken;
}

async function createDrivers(adminToken, n) {
  const items = Array.from({ length: n }, (_, i) => i);
  return mapLimit(items, SETUP, async (i) => {
    const phone = driverPhone(i);
    const c = await api('POST', '/admin/drivers/create', { token: adminToken, body: {
      phone, name: `WS-Drv-${pad5(i)}`, licenseNumber: `WS-LIC-${RUN}-${pad5(i)}`,
      carPlate: `WS-${RUN.slice(-4)}-${pad5(i)}`, carMake: 'Toyota', carModel: 'Corolla', carColor: 'White', carYear: 2018 } });
    if (c.status === 401 || c.status === 403) fatal('driver create unauthorized', c.text);
    const login = await api('POST', '/auth/login', { body: { phone, password: DRIVER_PASS } });
    if (!login.ok || !login.json?.accessToken) fatal(`driver ${i} login failed`, `${c.status}/${login.status} ${c.text} ${login.text}`);
    return { i, phone, token: login.json.accessToken };
  });
}

async function registerPax(n) {
  const items = Array.from({ length: n }, (_, i) => i);
  return mapLimit(items, SETUP, async (i) => {
    const phone = paxPhone(i);
    const r = await api('POST', '/auth/register', { body: { phone, password: PAX_PASS, name: `WS-Pax-${pad5(i)}`, role: 'PASSENGER' } });
    if (!r.ok || !r.json?.accessToken) fatal(`register pax ${i} failed`, `${r.status} ${r.text}`);
    return { i, phone, token: r.json.accessToken };
  });
}

function openSocket(url, tag) {
  const t0 = performance.now();
  return new Promise((resolve) => {
    let done = false;
    const sock = { tag, ws: null, opened: false, openMs: null, frames: 0, errors: 0, closed: false, closeCode: null, rejected: false, stall: false, pongRtt: null, lastPongT: 0 };
    let ws;
    try { ws = new WS(url); } catch (e) { sock.error = String(e?.message || e); return resolve(sock); }
    sock.ws = ws;
    const to = setTimeout(() => { if (!done) { done = true; sock.stall = true; try { ws.close(); } catch {} resolve(sock); } }, 15000);
    ws.onopen = () => { if (done) return; done = true; clearTimeout(to); sock.opened = true; sock.openMs = +(performance.now() - t0).toFixed(1); resolve(sock); };
    ws.onmessage = () => { sock.frames++; };
    ws.onerror = () => { sock.errors++; };
    ws.onclose = (ev) => { sock.closed = true; sock.closeCode = ev?.code ?? null; if (!done) { done = true; clearTimeout(to); sock.rejected = true; resolve(sock); } };
  });
}

async function main() {
  const started = Date.now();
  const report = { target: REST, run: RUN, config: { n: N, hold: HOLD, gpsMs: GPS_MS, setup: SETUP, channels: CHANNELS }, startedAt: new Date(started).toISOString(), phases: [], statusCounts, cleanup: {}, notes: [] };
  console.log(`LadiesGo WS storm  run=${RUN}  n=${N}  hold=${HOLD}s  gps=${GPS_MS}ms  channels=${CHANNELS}`);

  let drivers = [], pax = [], adminToken = null;
  const sockets = [];
  let gpsTimer = null;
  try {
    adminToken = await adminLogin();
    console.log('[setup] admin OK');
    const wantReq = CHANNELS === 'both' || CHANNELS === 'req';
    const wantGeo = CHANNELS === 'both' || CHANNELS === 'geo';
    const acctCount = UNIQ ? N : 1;
    report.config.uniq = UNIQ;
    drivers = await createDrivers(adminToken, wantReq ? acctCount : 0);
    if (wantReq) console.log(`[setup] drivers ${drivers.length}/${acctCount}`);
    pax = await registerPax(wantGeo ? acctCount : 0);
    if (wantGeo) console.log(`[setup] pax ${pax.length}/${acctCount}`);

    if (wantReq) {
      console.log(`[open] requests-live x${N} (uniq=${UNIQ} open=${OPEN_CONC}) ...`);
      const t0 = performance.now();
      const res = await mapLimit(Array.from({ length: N }, (_, i) => i), OPEN_CONC, async (i) => {
        const d = drivers[UNIQ ? i : 0];
        const s = await openSocket(`${WS_BASE}/trips/requests-live?token=${encodeURIComponent(d.token)}`, 'req');
        return s;
      });
      res.forEach((s) => sockets.push(s));
      report.phases.push(summarizeOpen('requests-live', res, performance.now() - t0));
      console.log(formatOpen('requests-live', report.phases[report.phases.length - 1]));
    }

    if (wantGeo) {
      console.log(`[open] live-geo x${N} (uniq=${UNIQ} open=${OPEN_CONC}) ...`);
      const t0 = performance.now();
      const res = await mapLimit(Array.from({ length: N }, (_, i) => i), OPEN_CONC, async (i) => {
        const p = pax[UNIQ ? i : 0];
        const s = await openSocket(`${WS_BASE}/drivers/live-geo?token=${encodeURIComponent(p.token)}`, 'geo');
        return s;
      });
      res.forEach((s) => sockets.push(s));
      report.phases.push(summarizeOpen('live-geo', res, performance.now() - t0));
      console.log(formatOpen('live-geo', report.phases[report.phases.length - 1]));
    }

    const live = sockets.filter((s) => s.opened);
    console.log(`[hold] ${live.length} sockets open for ${HOLD}s, GPS every ${GPS_MS}ms`);

    // GPS frames from geo sockets (driver position over WS -> DriverGeo singleton)
    let gpsSent = 0;
    if (wantGeo) {
      const geoSocks = live.filter((s) => s.tag === 'geo');
      gpsTimer = setInterval(() => {
        const lat = -8.90 + (Math.random() - 0.5) * 0.1;
        const lng = 13.20 + (Math.random() - 0.5) * 0.1;
        const msg = JSON.stringify({ lat: +lat.toFixed(6), lng: +lng.toFixed(6), cats: ['Económico'] });
        for (const s of geoSocks) { try { s.ws.send(msg); gpsSent++; } catch { s.errors++; } }
      }, GPS_MS);
    }

    // pong RTT sampling: ping every second on a sample of sockets
    const sample = live.slice(0, Math.min(50, live.length));
    const rtts = [];
    for (let i = 0; i < HOLD; i++) {
      await Promise.all(sample.map((s) => new Promise((res) => {
        let settled = false;
        const t0 = performance.now();
        const orig = s.ws.onmessage;
        const to = setTimeout(() => { if (!settled) { settled = true; s.ws.onmessage = orig; res(); } }, 3000);
        s.ws.onmessage = (ev) => {
          try { orig && orig(ev); } catch {}
          const d = typeof ev.data === 'string' ? ev.data : '';
          if (d === 'pong' && !settled) { settled = true; clearTimeout(to); rtts.push(+(performance.now() - t0).toFixed(1)); s.ws.onmessage = orig; res(); }
        };
        try { s.ws.send('ping'); } catch { settled = true; clearTimeout(to); s.ws.onmessage = orig; res(); }
      })));
      await delay(1000);
    }
    if (gpsTimer) { clearInterval(gpsTimer); gpsTimer = null; }

    const opened = sockets.filter((s) => s.opened).length;
    const stillOpen = sockets.filter((s) => s.opened && !s.closed).length;
    report.hold = {
      opened, total: sockets.length, stillOpenAtEnd: stillOpen,
      closedDuringHold: opened - stillOpen,
      gpsFramesSent: gpsSent,
      gpsPerSec: +(gpsSent / HOLD).toFixed(1),
      totalFramesReceived: sockets.reduce((a, s) => a + s.frames, 0),
      socketErrors: sockets.reduce((a, s) => a + s.errors, 0),
      pongSamples: rtts.length,
      pongRtt: summarize(rtts),
    };
    console.log(`[hold] still open ${stillOpen}/${opened}  gps/s ${report.hold.gpsPerSec}  frames ${report.hold.totalFramesReceived}  pong n=${rtts.length} p50=${report.hold.pongRtt.p50} p95=${report.hold.pongRtt.p95}`);

  } catch (e) {
    report.fatal = String(e?.detail || e?.message || e);
    console.error('\n' + report.fatal);
  } finally {
    if (gpsTimer) clearInterval(gpsTimer);
    for (const s of sockets) { try { s.ws?.close(); } catch {} }
    await delay(500);
  }

  report.finishedAt = new Date().toISOString();
  report.durationSec = +((Date.now() - started) / 1000).toFixed(1);
  report.totalHttpRequests = requestCount;
  console.log('\n================ RESULTS ================');
  console.log(`total HTTP requests: ${requestCount}  status: ${JSON.stringify(statusCounts)}`);
  for (const p of report.phases) console.log(formatOpen(p.channel, p));
  if (report.hold) console.log(`HOLD opened=${report.hold.opened} stillOpen=${report.hold.stillOpenAtEnd} closed=${report.hold.closedDuringHold} gps/s=${report.hold.gpsPerSec} frames=${report.hold.totalFramesReceived} pong(p50/p95)=${report.hold.pongRtt.p50}/${report.hold.pongRtt.p95}`);
  if (report.fatal) console.log(`FATAL: ${report.fatal}`);

  const outPath = OUT || join(dirname(fileURLToPath(import.meta.url)), `wsstorm-${RUN}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`report saved: ${outPath}`);
}

function percentile(s, p) { if (!s.length) return null; const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1)); return s[i]; }
function summarize(v) { if (!v.length) return { n: 0, p50: null, p95: null, max: null, min: null, avg: null }; const s = [...v].sort((a, b) => a - b); return { n: s.length, p50: +percentile(s, 50).toFixed(1), p95: +percentile(s, 95).toFixed(1), max: +s[s.length - 1].toFixed(1), min: +s[0].toFixed(1), avg: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1) }; }
function summarizeOpen(channel, res, wallMs) {
  const ok = res.filter((s) => s.opened); const fail = res.filter((s) => !s.opened);
  const opens = ok.map((s) => s.openMs);
  return { channel, attempted: res.length, opened: ok.length, failed: fail.length, successRate: +(ok.length / res.length * 100).toFixed(1), wallMs: +wallMs.toFixed(0), openMs: summarize(opens), failDetail: { rejectedCount: fail.filter((s) => s.rejected).length, stallCount: fail.filter((s) => s.stall).length } };
}
function formatOpen(channel, p) {
  return `${channel}: opened ${p.opened}/${p.attempted} (${p.successRate}%) in ${p.wallMs}ms  open p50=${p.openMs.p50} p95=${p.openMs.p95} max=${p.openMs.max}`;
}

main().catch((e) => { console.error('unhandled:', e); process.exit(1); });
