// E2E: o link de partilha da viagem (/t?id=... -> GET /trips/public/:id) mostra a
// posicao viva da motorista, incl. durante IN_PROGRESS (monitorizacao de ponta a ponta).
// A posicao vem do DO DriverGeo (mesmo caminho do WS /drivers/live-geo).
// Correr: node loadtest/pub-track-e2e.mjs
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
    const to = setTimeout(() => reject(new Error('WS timeout')), 15000);
    ws.onopen = () => { clearTimeout(to); resolve(ws); };
    ws.onerror = (e) => { clearTimeout(to); reject(new Error('WS error')); };
  });
}
function pinForTrip(id) { let h = 0; for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return String(1000 + (h % 9000)); }
async function waitPublic(id, pred, ms) {
  const t0 = Date.now(); let last = null;
  while (Date.now() - t0 < ms) {
    const r = await api('GET', `/trips/public/${encodeURIComponent(id)}`);
    last = r.json;
    if (pred(last)) return last;
    await delay(700);
  }
  return last;
}
const RUN = (Date.now() % 1e9).toString().padStart(9, '0');
const results = [];
function check(name, ok, extra) { results.push({ name, ok, extra }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + JSON.stringify(extra) : '')); }

async function main() {
  const adm = await api('POST', '/auth/login', { body: { phone: '999999999', password: '1234567890' } });
  if (!adm.ok) throw new Error('admin login: ' + adm.text);
  const ah = adm.json.accessToken;

  const dPhone = `+24497${RUN}`;
  const cr = await api('POST', '/admin/drivers/create', { token: ah, body: { phone: dPhone, name: 'PubTrkDrv', licenseNumber: 'P' + RUN, carPlate: 'PT-' + RUN, carMake: 'Kia', carModel: 'Rio', carYear: 2021, carColor: 'Preto' } });
  if (!cr.ok) throw new Error('create driver: ' + cr.text);
  const dl = await api('POST', '/auth/login', { body: { phone: dPhone, password: '0987654321' } });
  const dTok = dl.json.accessToken;
  const dst = await api('GET', '/drivers/status', { token: dTok });
  const dId = dst.json && dst.json.id;
  await api('PUT', '/drivers/toggle-online', { token: dTok, body: { isOnline: true } });

  const pPhone = `+24498${RUN}`;
  const pr = await api('POST', '/auth/register', { body: { phone: pPhone, password: '123456', name: 'PubTrkPax' } });
  if (!pr.ok) throw new Error('register pax: ' + pr.text);
  const pTok = pr.json.accessToken;

  const t = await api('POST', '/trips/request', { token: pTok, body: { pickupLat: -8.85, pickupLng: 13.25, pickupAddress: 'Origem', dropoffLat: -8.9, dropoffLng: 13.3, dropoffAddress: 'Destino', fare: 1000 } });
  if (!t.ok) throw new Error('request trip: ' + t.text);
  const id = t.json.id;

  await api('PUT', `/trips/${id}/accept`, { token: dTok, body: {} });
  await api('PUT', `/trips/${id}/arrived`, { token: dTok, body: {} });
  const st = await api('PUT', `/trips/${id}/start`, { token: dTok, body: { pin: pinForTrip(id) } });
  check('viagem em IN_PROGRESS', st.ok && String(st.json && st.json.status) === 'IN_PROGRESS', { status: st.status });

  const ws = await openWs(`${WS_BASE}/drivers/live-geo?token=${encodeURIComponent(dTok)}`);
  check('WS DriverGeo da motorista aberto', ws.readyState === 1);

  ws.send(J({ lat: -8.8712, lng: 13.2812, cats: ['Económico'] }));
  const pub = await waitPublic(id, (p) => p && p.driver && Math.abs(Number(p.driver.lat) - -8.8712) < 0.002, 15000);
  check('link partilhado ve a motorista durante IN_PROGRESS', !!(pub && pub.driver && Math.abs(Number(pub.driver.lat) - -8.8712) < 0.002), pub && pub.driver ? { lat: pub.driver.lat, lng: pub.driver.lng, status: pub.status } : { status: pub && pub.status });

  ws.send(J({ lat: -8.8830, lng: 13.2930, cats: ['Económico'] }));
  const pub2 = await waitPublic(id, (p) => p && p.driver && Math.abs(Number(p.driver.lat) - -8.8830) < 0.002, 15000);
  check('link partilhado atualiza a posicao (movimento)', !!(pub2 && pub2.driver && Math.abs(Number(pub2.driver.lat) - -8.8830) < 0.002), pub2 && pub2.driver ? { lat: pub2.driver.lat } : {});

  try { ws.close(); } catch {}
  await api('PUT', `/trips/${id}/complete`, { token: dTok, body: {} }).catch(() => {});
  await api('PUT', '/drivers/toggle-online', { token: dTok, body: { isOnline: false } }).catch(() => {});

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (failed.length ? 'RESULTADO: FAIL (' + failed.length + ')' : 'RESULTADO: ALL PASS'));
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
