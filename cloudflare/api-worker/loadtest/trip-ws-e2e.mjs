// E2E: valida o WS da viagem (/trips/:id/live -> DO TripPush) e a politica de
// posicao: so envia quando o carro ANDA (>=150m) antes da recolha e NAO envia
// posicao depois de IN_PROGRESS (a passageira vai dentro do carro).
// Correr: node loadtest/trip-ws-e2e.mjs
const REST = process.env.REST || 'https://ladiesgo-api.ladiesgo-ao.workers.dev/api/v1';
const WS_BASE = REST.replace(/^http/, 'ws');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (o) => JSON.stringify(o);

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(REST + path, { method, headers, body: body !== undefined ? J(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}
function openWs(url, sink) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    if (sink) ws.onmessage = (ev) => { try { sink.push(JSON.parse(ev.data)); } catch {} };
    const to = setTimeout(() => reject(new Error('WS timeout a abrir')), 15000);
    ws.onopen = () => { clearTimeout(to); resolve(ws); };
    ws.onerror = (e) => { clearTimeout(to); reject(new Error('WS error: ' + (e && e.message ? e.message : 'erro'))); };
  });
}
const driverFrames = (arr) => arr.filter((m) => m && m.t === 'driver').length;
function pinForTrip(id) { let h = 0; for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return String(1000 + (h % 9000)); }
async function waitFor(arr, pred, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const f = arr.find(pred); if (f) return f; await delay(250); } return null; }

const RUN = (Date.now() % 1e9).toString().padStart(9, '0');
const results = [];
function check(name, ok, extra) { results.push({ name, ok, extra }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + JSON.stringify(extra) : '')); }

async function main() {
  const adm = await api('POST', '/auth/login', { body: { phone: '999999999', password: '1234567890' } });
  if (!adm.ok) throw new Error('admin login: ' + adm.text);
  const ah = adm.json.accessToken;

  const dPhone = `+24496${RUN}`;
  const cr = await api('POST', '/admin/drivers/create', { token: ah, body: { phone: dPhone, name: 'TripE2EDrv', licenseNumber: 'T' + RUN, carPlate: 'TP-' + RUN, carMake: 'Kia', carModel: 'Rio', carYear: 2021, carColor: 'Preto' } });
  if (!cr.ok) throw new Error('create driver: ' + cr.text);
  const dl = await api('POST', '/auth/login', { body: { phone: dPhone, password: '0987654321' } });
  const dTok = dl.json.accessToken;
  await api('PUT', '/drivers/toggle-online', { token: dTok, body: { isOnline: true } });

  const pPhone = `+24497${RUN}`;
  const reg = await api('POST', '/auth/register', { body: { phone: pPhone, password: 'teste1234', name: 'TripE2EPax' } });
  const pTok = reg.json.accessToken;

  const tr = await api('POST', '/trips/request', { token: pTok, body: { pickupAddress: 'Ponto E2E', pickupLat: -8.85, pickupLng: 13.25, dropoffAddress: 'Destino E2E', dropoffLat: -8.86, dropoffLng: 13.26, rideType: 'ECONOMY', paymentMethod: 'CASH' } });
  if (!tr.ok) throw new Error('trip request: ' + tr.text);
  const id = tr.json.id;
  const ac = await api('PUT', `/trips/${id}/accept`, { token: dTok, body: {} });
  check('motorista aceita a viagem', ac.ok, { status: ac.status });

  const pax = [], drv = [];
  const pws = await openWs(`${WS_BASE}/trips/${id}/live?token=${encodeURIComponent(pTok)}`, pax);
  const dws = await openWs(`${WS_BASE}/trips/${id}/live?token=${encodeURIComponent(dTok)}`, drv);
  check('WS da viagem abre', pws.readyState === 1 && dws.readyState === 1);

  const hello = await waitFor(pax, (m) => m && m.t === 'hello', 8000);
  check("passageira recebe 'hello'", !!hello);

  // 1) Primeiro fix do motorista (ACCEPTED) -> passageira recebe.
  dws.send(J({ t: 'gps', role: 'driver', lat: -8.85, lng: 13.25 }));
  const f1 = await waitFor(pax, (m) => m && m.t === 'driver', 12000);
  check('posicao inicial do motorista chega a passageira', !!f1, f1 ? { lat: f1.lat } : {});

  // 2) Fix que NAO anda (<150m) -> sem novo frame (respeita o throttle de 10s).
  await delay(11000);
  const before2 = driverFrames(pax);
  dws.send(J({ t: 'gps', role: 'driver', lat: -8.8505, lng: 13.2505 })); // ~75m
  await delay(4000);
  check('fix curto (<150m) NAO redesenha o carro', driverFrames(pax) === before2, { before: before2, after: driverFrames(pax) });

  // 3) Fix que ANDA (>150m) -> novo frame.
  await delay(11000);
  const before3 = driverFrames(pax);
  dws.send(J({ t: 'gps', role: 'driver', lat: -8.856, lng: 13.256 })); // ~800m
  const f3 = await waitFor(pax, (m) => m && m.t === 'driver' && Math.abs(m.lat - -8.856) < 1e-6, 6000);
  check('fix longo (>=150m) redesenha o carro', !!f3, { before: before3, after: driverFrames(pax) });

  // 4) GPS da passageira continua a chegar a motorista.
  pws.send(J({ t: 'gps', role: 'pax', lat: -8.851, lng: 13.251 }));
  const fp = await waitFor(drv, (m) => m && m.t === 'pax', 12000);
  check('posicao da passageira chega a motorista', !!fp, fp ? { lat: fp.lat } : {});

  // 5) Mesmo em IN_PROGRESS a motorista e monitorizada: a posicao continua a chegar.
  const ar = await api('PUT', `/trips/${id}/arrived`, { token: dTok, body: {} });
  const st = await api('PUT', `/trips/${id}/start`, { token: dTok, body: { pin: pinForTrip(id) } });
  check('viagem arranca (IN_PROGRESS)', st.ok, { arrived: ar.status, start: st.status });
  await waitFor(pax, (m) => m && m.t === 'status' && String(m.status).toUpperCase() === 'IN_PROGRESS', 8000);
  await delay(11000);
  const before4 = driverFrames(pax);
  dws.send(J({ t: 'gps', role: 'driver', lat: -8.87, lng: 13.27 }));
  const f4 = await waitFor(pax, (m) => m && m.t === 'driver' && Math.abs(m.lat - -8.87) < 1e-6, 6000);
  check('em IN_PROGRESS a posicao da motorista continua a ser monitorizada', !!f4, { before: before4, after: driverFrames(pax) });

  try { pws.close(); } catch {} try { dws.close(); } catch {}
  try { await api('PUT', `/trips/${id}/complete`, { token: dTok, body: {} }); } catch {}
  try { await api('PUT', '/drivers/toggle-online', { token: dTok, body: { isOnline: false } }); } catch {}

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (failed.length ? 'RESULTADO: FAIL (' + failed.length + ')' : 'RESULTADO: ALL PASS'));
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
