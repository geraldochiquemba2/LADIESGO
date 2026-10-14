// Testa o RequestsHub: motorista liga WS; passageira pede viagem → espera "refresh".
const REST = 'http://127.0.0.1:8788/api/v1';
const WSURL = 'ws://127.0.0.1:8788/api/v1/trips/requests-live';
const J = (o) => JSON.stringify(o);
async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(REST + path, { method, headers, body: body !== undefined ? J(body) : undefined });
  const t = await res.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { ok: res.ok, status: res.status, json: j, text: t };
}
const RUN = (Date.now() % 1e9).toString().padStart(9, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const adm = await api('POST', '/auth/login', { body: { phone: '999999999', password: '1234567890' } });
  const ah = adm.json.accessToken;
  const dPhone = `+24491${RUN}`;
  await api('POST', '/admin/drivers/create', { token: ah, body: { phone: dPhone, name: 'HubDrv', licenseNumber: 'H1', carPlate: 'HB-00-XX', carMake: 'Kia', carModel: 'Rio', carYear: 2021, carColor: 'Preto' } });
  const dl = await api('POST', '/auth/login', { body: { phone: dPhone, password: '0987654321' } });
  const dTok = dl.json.accessToken, dId = dl.json.user.id;
  await api('PUT', '/drivers/toggle-online', { token: dTok, body: { isOnline: true } });
  await api('POST', '/drivers/position', { body: { id: dId, lat: -8.83, lng: 13.24, cats: ['Económico'] } });

  const pPhone = `+24492${RUN}`;
  const reg = await api('POST', '/auth/register', { body: { phone: pPhone, password: 'teste123', name: 'HubPax', role: 'PASSENGER' } });
  const pTok = reg.json.accessToken;

  const got = [];
  const ws = new WebSocket(`${WSURL}?token=${encodeURIComponent(dTok)}`);
  const opened = await new Promise((res) => {
    const to = setTimeout(() => res(false), 8000);
    ws.onopen = () => { clearTimeout(to); res(true); };
    ws.onerror = () => { clearTimeout(to); res(false); };
    ws.onclose = (e) => { clearTimeout(to); res('close:' + e.code); };
  });
  ws.onmessage = (ev) => { try { got.push(JSON.parse(ev.data)); } catch {} };
  console.log('ws open:', opened);

  // snapshot inicial
  const s0 = await api('GET', '/trips/incoming', { token: dTok });
  console.log('incoming antes:', (s0.json?.trips || []).length);

  // passageira pede
  const req = await api('POST', '/trips/request', { token: pTok, body: { pickupLat: -8.83, pickupLng: 13.24, dropoffLat: -8.90, dropoffLng: 13.30, pickupAddress: 'A', dropoffAddress: 'B', rideType: 'ECONOMY', paymentMethod: 'CASH' } });
  console.log('request:', req.status, req.json?.id ? 'ok' : req.text);

  await wait(1500);
  const s1 = await api('GET', '/trips/incoming', { token: dTok });
  console.log('incoming depois:', (s1.json?.trips || []).length);
  console.log('pokes recebidos:', JSON.stringify(got));

  // ping keep-alive (deve auto-responder pong e não contar)
  ws.send('ping');
  await wait(300);
  console.log('apos ping, msgs:', JSON.stringify(got));
  try { ws.close(); } catch {}
  const pass = opened === true && got.some((m) => m.t === 'refresh') && (s1.json?.trips || []).length >= 1;
  console.log(pass ? 'PASS' : 'FAIL');
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
