// E2E: valida o push de pedidos (RequestsHub) que substitui o polling /trips/incoming.
//   admin -> cria motorista -> login -> online -> abre WS /trips/requests-live
//   registra passageira -> cria /trips/request -> espera frame {t:'refresh'} no WS do motorista
// Correr: node loadtest/req-ws-e2e.mjs
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

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const to = setTimeout(() => reject(new Error('WS timeout a abrir')), 15000);
    ws.onopen = () => { clearTimeout(to); resolve(ws); };
    ws.onerror = (e) => { clearTimeout(to); reject(new Error('WS error: ' + (e && e.message ? e.message : 'erro'))); };
  });
}

const RUN = (Date.now() % 1e9).toString().padStart(9, '0');
const results = [];
function check(name, ok, extra) { results.push({ name, ok, extra }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + JSON.stringify(extra) : '')); }

async function main() {
  const adm = await api('POST', '/auth/login', { body: { phone: '999999999', password: '1234567890' } });
  if (!adm.ok) throw new Error('admin login: ' + adm.text);
  const ah = adm.json.accessToken;

  const dPhone = `+24492${RUN}`;
  const cr = await api('POST', '/admin/drivers/create', { token: ah, body: { phone: dPhone, name: 'ReqE2EDrv', licenseNumber: 'R' + RUN, carPlate: 'RQ-' + RUN, carMake: 'Kia', carModel: 'Rio', carYear: 2021, carColor: 'Preto' } });
  if (!cr.ok) throw new Error('create driver: ' + cr.text);
  const dl = await api('POST', '/auth/login', { body: { phone: dPhone, password: '0987654321' } });
  if (!dl.ok) throw new Error('driver login: ' + dl.text);
  const dTok = dl.json.accessToken;
  await api('PUT', '/drivers/toggle-online', { token: dTok, body: { isOnline: true } });
  check('motorista online', true);

  const url = `${WS_BASE}/trips/requests-live?token=${encodeURIComponent(dTok)}`;
  const ws = await openWs(url);
  check('WS /trips/requests-live abre', ws.readyState === 1, { state: ws.readyState });

  const frames = [];
  let refreshSeen = false;
  ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); frames.push(m); if (m && m.t === 'refresh') refreshSeen = true; } catch {} };

  const pPhone = `+24493${RUN}`;
  const reg = await api('POST', '/auth/register', { body: { phone: pPhone, password: 'teste1234', name: 'ReqE2EPax' } });
  if (!reg.ok) throw new Error('register passenger: ' + reg.text);
  const pTok = reg.json.accessToken;

  const tr = await api('POST', '/trips/request', { token: pTok, body: { pickupAddress: 'Ponto E2E', pickupLat: -8.85, pickupLng: 13.25, dropoffAddress: 'Destino E2E', dropoffLat: -8.86, dropoffLng: 13.26, rideType: 'ECONOMY', paymentMethod: 'CASH' } });
  check('pedido de viagem criado', tr.ok, { status: tr.status, id: tr.json && tr.json.id });

  const t0 = Date.now();
  while (!refreshSeen && Date.now() - t0 < 12000) await delay(400);
  check("motorista recebe {t:'refresh'} por WS (sem polling)", refreshSeen, { frames: frames.length });

  try { ws.close(); } catch {}
  try { if (tr.json && tr.json.id) await api('POST', `/trips/${tr.json.id}/cancel`, { token: pTok, body: {} }); } catch {}
  try { await api('PUT', '/drivers/toggle-online', { token: dTok, body: { isOnline: false } }); } catch {}

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (failed.length ? 'RESULTADO: FAIL (' + failed.length + ')' : 'RESULTADO: ALL PASS'));
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
