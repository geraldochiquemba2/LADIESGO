// LadiesGo fire test — k6 (HTTP + WebSocket) for a DISTRIBUTED generator.
//
// Prereq: generate accounts.json first with the Node provisioner:
//   node loadtest/provision-accounts.mjs --drivers=5000 --pax=5000 --out=loadtest/k6/accounts.json --tag=v1 --online
// Then copy this folder (ladiesgo.js + accounts.json) to each VM.
//
// Run one VM (each VM has its own IP):
//   MODE=both TRIP_VUS=1000 WS_VUS=1000 IDX_START=0 k6 run \
//     --out json=results-vm0.json ladiesgo.js
//
// Env:
//   API         REST base (default prod). Point to STAGING for real tests.
//   WS_BASE     override WS base (default: API with ws://).
//   MODE        trips | ws | both
//   TRIP_VUS    concurrency for the HTTP trip lifecycle scenario
//   WS_VUS      concurrency for the WebSocket scenario
//   WS_POOL     how many distinct driver tokens to spread across WS_VUS (default = WS_VUS)
//   IDX_START   index offset for this VM's account slice
//   GPS_MS      WS GPS frame interval (default 5000)
//   WS_HOLD_S   how long each WS VU keeps sockets open (default 90)
//   RAMP_UP, HOLD, RAMP_DOWN  stage durations for the simple ramp (default 2m/5m/1m)
//
// Campaign (staged ramp to 5000, per VM = share of the total):
//   TRIP_STAGES="30s:100,2m:500,3m:1000,3m:2500,4m:5000,2m:5000,1m:0"
//   WS_STAGES="30s:100,2m:500,3m:1000,3m:2500,4m:5000,2m:5000,1m:0"
//   (overrides RAMP_UP/HOLD/RAMP_DOWN; each target is VUs on THIS VM)
//
// GO/NO-GO gates (overridable):
//   MAX_FAIL_RATE  http_req_failed must be BELOW this (default 0.05)
//   MAX_P95        http_req_duration p95 must be BELOW this in ms (default 1500)
//   MIN_WS_OK      ws_upgrade_ok rate must be ABOVE this (default 0.99)
//   (also: trips_fail must be 0)

import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const API = __ENV.API || 'https://ladiesgo-api.ladiesgo-ao.workers.dev/api/v1';
const WS_BASE = __ENV.WS_BASE || API.replace(/^http/, 'ws');
const MODE = (__ENV.MODE || 'both').toLowerCase();
const TRIP_VUS = Number(__ENV.TRIP_VUS || 0);
const WS_VUS = Number(__ENV.WS_VUS || 0);
const WS_POOL = Number(__ENV.WS_POOL || WS_VUS || 0);
const IDX_START = Number(__ENV.IDX_START || 0);
const GPS_MS = Number(__ENV.GPS_MS || 5000);
const WS_HOLD_S = Number(__ENV.WS_HOLD_S || 90);
const RAMP_UP = __ENV.RAMP_UP || '2m';
const HOLD = __ENV.HOLD || '5m';
const RAMP_DOWN = __ENV.RAMP_DOWN || '1m';
// Staged ramp (campaign): "30s:100,2m:500,3m:1000,3m:2500,4m:5000,2m:5000,1m:0"
const TRIP_STAGES = __ENV.TRIP_STAGES || '';
const WS_STAGES = __ENV.WS_STAGES || '';
// GO/NO-GO gates
const FAIL_RATE = Number(__ENV.MAX_FAIL_RATE || __ENV.FAIL_RATE || 0.05);
const MAX_P95 = Number(__ENV.MAX_P95 || 1500);
const MIN_WS_OK = Number(__ENV.MIN_WS_OK || 0.99);

const accounts = new SharedArray('accounts', () => {
  const o = JSON.parse(open('./accounts.json'));
  const drivers = o.drivers || [];
  const pax = o.pax && o.pax.length ? o.pax : drivers;
  return drivers.map((d, i) => ({ driver: d, pax: pax[i % pax.length] }));
});

const tripLifecycle = new Trend('trip_lifecycle_ms', true);
const stepRequest = new Trend('step_request_ms', true);
const stepAccept = new Trend('step_accept_ms', true);
const stepArrived = new Trend('step_arrived_ms', true);
const stepStart = new Trend('step_start_ms', true);
const stepComplete = new Trend('step_complete_ms', true);
const tripsOk = new Counter('trips_ok');
const tripsFail = new Counter('trips_fail');
const wsOpened = new Rate('ws_opened');
const wsUpgradeOk = new Rate('ws_upgrade_ok');
const wsFrames = new Counter('ws_frames');

// Build stages: explicit "dur:target,..." or a simple ramp up/hold/down to maxTarget.
function buildStages(explicit, maxTarget) {
  if (explicit) {
    return explicit.split(',').map((s) => { const [d, t] = s.split(':'); return { duration: String(d).trim(), target: Math.max(0, Math.round(Number(t) || 0)) }; });
  }
  return [
    { duration: RAMP_UP, target: maxTarget },
    { duration: HOLD, target: maxTarget },
    { duration: RAMP_DOWN, target: 0 },
  ];
}

const scenarios = {};
if (MODE === 'trips' || MODE === 'both') {
  scenarios.trips = { executor: 'ramping-vus', exec: 'tripFlow', startVUs: 0, stages: buildStages(TRIP_STAGES, TRIP_VUS), gracefulRampDown: '20s' };
}
if (MODE === 'ws' || MODE === 'both') {
  scenarios.ws = {
    executor: 'ramping-vus',
    exec: 'wsFlow',
    startVUs: 0,
    stages: buildStages(WS_STAGES, WS_VUS),
    gracefulRampDown: '20s',
  };
}

export const options = {
  scenarios,
  thresholds: {
    http_req_failed: [{ threshold: `rate<${FAIL_RATE}`, abortOnFail: false }],
    http_req_duration: [`p(95)<${MAX_P95}`],
    ws_upgrade_ok: [`rate>${MIN_WS_OK}`],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const r = http.post(`${API}/auth/login`, JSON.stringify({ phone: __ENV.ADMIN_PHONE || '999999999', password: __ENV.ADMIN_PASS || '1234567890' }), {
    headers: { 'Content-Type': 'application/json' },
  });
  check(r, { 'admin login 200': (x) => x.status === 200 && !!r.json('accessToken') });
  return { accounts: accounts.length, idxStart: IDX_START, vus: { trips: TRIP_VUS, ws: WS_VUS } };
}

function api(method, path, token, body) {
  const params = { headers: { 'Content-Type': 'application/json' }, tags: { name: path.replace(/\/[0-9a-f-]{8,}/gi, '/:id') } };
  if (token) params.headers.Authorization = 'Bearer ' + token;
  return http.request(method, API + path, body !== undefined ? JSON.stringify(body) : null, params);
}

function point(i) {
  const row = Math.floor(i / 10);
  const col = i % 10;
  return { lat: +(-8.90 - row * 0.05).toFixed(6), lng: +(13.20 + col * 0.05).toFixed(6) };
}

function body(r) { return String(r && r.body || '').replace(/\s+/g, ' ').slice(0, 180); }

function pairFor(vu) {
  const idx = (IDX_START + (vu - 1)) % accounts.length;
  const a = accounts[idx];
  return { drv: a.driver, pax: a.pax, idx };
}

export function tripFlow() {
  const { drv, pax, idx } = pairFor(__VU);
  const pickup = point(idx);
  const drop = { lat: +(pickup.lat + 0.008).toFixed(6), lng: +(pickup.lng + 0.008).toFixed(6) };
  const t0 = Date.now();
  let id = null;
  try {
    let r = api('POST', '/trips/request', pax.token, {
      pickupLat: pickup.lat, pickupLng: pickup.lng,
      dropoffLat: drop.lat, dropoffLng: drop.lng,
      pickupAddress: `LT ${idx}`, dropoffAddress: `LT ${idx}`,
      rideType: 'ECONOMY', paymentMethod: 'CASH',
    });
    stepRequest.add(r.timings.duration);
    if (r.status !== 200 && r.status !== 201) throw new Error('request ' + r.status + ' ' + body(r));
    id = r.json('id');
    if (!id) throw new Error('no id ' + body(r));

    r = acceptWithRetry(id, drv.token);
    stepAccept.add(r.timings.duration);
    if (r.status !== 200) throw new Error('accept ' + r.status + ' ' + body(r));

    r = api('PUT', `/trips/${id}/arrived`, drv.token);
    stepArrived.add(r.timings.duration);
    if (r.status !== 200) throw new Error('arrived ' + r.status + ' ' + body(r));

    r = api('GET', `/trips/${id}`, pax.token);
    const pin = r.json('pin');
    if (r.status !== 200 || !pin) throw new Error('pin ' + r.status + ' ' + body(r));

    r = api('PUT', `/trips/${id}/start`, drv.token, { pin });
    stepStart.add(r.timings.duration);
    if (r.status !== 200) throw new Error('start ' + r.status + ' ' + body(r));

    r = api('PUT', `/trips/${id}/complete`, drv.token);
    stepComplete.add(r.timings.duration);
    if (r.status !== 200) throw new Error('complete ' + r.status + ' ' + body(r));

    tripsOk.add(1);
    tripLifecycle.add(Date.now() - t0);
  } catch (e) {
    tripsFail.add(1);
    console.error(`tripFlow v${__VU} idx${idx} FAIL: ${e.message} (resp: ${e.resp || '-'})`);
    if (id) { try { api('PUT', `/trips/${id}/cancel`, pax.token, { reason: 'lt cleanup' }); } catch (e2) {} }
    check(null, { 'trip lifecycle ok': () => false });
  }
  sleep(0.5);
}

function acceptWithRetry(id, token) {
  let r = api('PUT', `/trips/${id}/accept`, token);
  for (let a = 0; a < 3 && r.status === 409; a++) {
    sleep(0.5);
    r = api('PUT', `/trips/${id}/accept`, token);
  }
  return r;
}

export function wsFlow() {
  const pool = Math.max(1, WS_POOL || accounts.length);
  const idx = (IDX_START + ((__VU - 1) % pool)) % accounts.length;
  const drv = accounts[idx].driver;
  const geo = accounts[idx].pax;

  let okReq = false;
  const resReq = ws.connect(`${WS_BASE}/trips/requests-live?token=${encodeURIComponent(drv.token)}`, {}, (socket) => {
    socket.on('open', () => { okReq = true; wsOpened.add(true); });
    socket.on('message', () => wsFrames.add(1));
    socket.on('error', () => wsOpened.add(false));
    socket.setInterval(() => socket.send('ping'), 15000);
    socket.setTimeout(() => socket.close(), WS_HOLD_S * 1000);
  });
  wsUpgradeOk.add(resReq && resReq.status === 101);
  check(resReq, { 'requests-live 101': (r) => r && r.status === 101 });

  let okGeo = false;
  const resGeo = ws.connect(`${WS_BASE}/drivers/live-geo?token=${encodeURIComponent(geo.token)}`, {}, (socket) => {
    socket.on('open', () => { okGeo = true; });
    socket.on('error', () => {});
    socket.setInterval(() => {
      const lat = +(geo ? -8.90 + Math.random() * 0.1 : -8.9).toFixed(6);
      const lng = +(13.20 + Math.random() * 0.1).toFixed(6);
      socket.send(JSON.stringify({ lat, lng, cats: ['Económico'] }));
    }, GPS_MS);
    socket.setTimeout(() => socket.close(), WS_HOLD_S * 1000);
  });
  wsUpgradeOk.add(resGeo && resGeo.status === 101);
  check(resGeo, { 'live-geo 101': (r) => r && r.status === 101 });

  sleep(1);
}

function goNoGo(m) {
  const v = (k, p) => (m[k] && m[k].values ? m[k].values[p] : undefined);
  const failRate = v('http_req_failed', 'rate');
  const p95 = v('http_req_duration', 'p(95)');
  const wsOk = v('ws_upgrade_ok', 'rate');
  const tripsFail = v('trips_fail', 'count');
  const gates = [];
  if (failRate !== undefined) gates.push({ gate: `http_req_failed < ${FAIL_RATE}`, ok: failRate < FAIL_RATE, value: failRate });
  if (p95 !== undefined) gates.push({ gate: `http_req_duration_p95 < ${MAX_P95}ms`, ok: p95 < MAX_P95, value: p95 });
  if (wsOk !== undefined) gates.push({ gate: `ws_upgrade_ok > ${MIN_WS_OK}`, ok: wsOk > MIN_WS_OK, value: wsOk });
  if (tripsFail) gates.push({ gate: 'trips_fail == 0', ok: tripsFail === 0, value: tripsFail });
  const go = gates.length > 0 && gates.every((x) => x.ok);
  return { go, gates };
}

export function handleSummary(data) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    [`summary-vm${IDX_START}-${stamp}.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data),
  };
}

function fmt(v) { return typeof v === 'number' ? v.toFixed(4) : v; }

function textSummary(data) {
  const m = data.metrics || {};
  const g = (k, p) => (m[k] && m[k].values ? (m[k].values[p] !== undefined ? m[k].values[p] : '-') : '-');
  const res = goNoGo(m);
  const lines = [];
  lines.push('==== LadiesGo k6 summary ====');
  lines.push(`http_reqs=${g('http_reqs', 'count')} failed=${g('http_req_failed', 'rate')} p95=${g('http_req_duration', 'p(95)')}ms`);
  lines.push(`trips_ok=${g('trips_ok', 'count')} trips_fail=${g('trips_fail', 'count')} lifecycle_p95=${g('trip_lifecycle_ms', 'p(95)')}ms`);
  lines.push(`ws_opened_rate=${g('ws_opened', 'rate')} ws_upgrade_ok=${g('ws_upgrade_ok', 'rate')} ws_frames=${g('ws_frames', 'count')}`);
  for (const x of res.gates) lines.push(`${x.ok ? 'OK  ' : 'FAIL'} ${x.gate}  (got ${fmt(x.value)})`);
  lines.push(`VERDICT: ${res.go ? 'GO' : 'NO-GO'}`);
  return lines.join('\n') + '\n';
}
