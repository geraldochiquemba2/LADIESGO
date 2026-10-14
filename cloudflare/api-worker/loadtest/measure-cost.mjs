// Mede o custo real em queries/linhas D1 de uma viagem completa e dos polls.
// Correr contra o dev server instrumentado: node loadtest/measure-cost.mjs
const REST = process.env.REST || 'http://127.0.0.1:8788/api/v1';
const KEY = process.env.DEBUG_KEY || 'devdebug';
const N = Number(process.env.N || 20);

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

async function metrics() { const r = await fetch(`http://127.0.0.1:8788/debug/d1?key=${KEY}`); return r.json(); }
async function resetM() { await fetch(`http://127.0.0.1:8788/debug/d1/reset?key=${KEY}`, { method: 'POST' }); }

const RUN = (Date.now() % 1e9).toString().padStart(9, '0');

async function main() {
  const out = {};
  // setup
  const adm = await api('POST', '/auth/login', { body: { phone: '999999999', password: '1234567890' } });
  if (!adm.ok) throw new Error('admin login: ' + adm.text);
  const ah = adm.json.accessToken;
  const dPhone = `+24491${RUN}`;
  await api('POST', '/admin/drivers/create', { token: ah, body: { phone: dPhone, name: 'MeasureDrv', licenseNumber: 'M1', carPlate: 'MD-00-XX', carMake: 'Kia', carModel: 'Rio', carYear: 2021, carColor: 'Preto' } });
  const dl = await api('POST', '/auth/login', { body: { phone: dPhone, password: '0987654321' } });
  const dTok = dl.json.accessToken, dId = dl.json.user.id;
  await api('PUT', '/drivers/toggle-online', { token: dTok, body: { isOnline: true } });
  await api('POST', '/drivers/position', { body: { id: dId, lat: -8.83, lng: 13.24, cats: ['Económico'] } });

  const pPhone = `+24492${RUN}`;
  const reg = await api('POST', '/auth/register', { body: { phone: pPhone, password: 'teste123', name: 'MeasurePax', role: 'PASSENGER' } });
  const pTok = reg.json.accessToken;

  // ---- custo de UMA viagem completa (sequencial) ----
  await resetM();
  let ok = 0, fail = 0;
  for (let i = 0; i < N; i++) {
    try {
      const r = await api('POST', '/trips/request', { token: pTok, body: { pickupLat: -8.83, pickupLng: 13.24, dropoffLat: -8.90, dropoffLng: 13.30, pickupAddress: 'A', dropoffAddress: 'B', rideType: 'ECONOMY', paymentMethod: 'CASH' } });
      if (!r.ok) throw new Error('request ' + r.text);
      const id = r.json.id;
      const ac = await api('PUT', `/trips/${id}/accept`, { token: dTok });
      if (!ac.ok) throw new Error('accept ' + ac.text);
      await api('PUT', `/trips/${id}/arrived`, { token: dTok });
      const g = await api('GET', `/trips/${id}`, { token: pTok });
      const pin = g.json?.pin;
      await api('PUT', `/trips/${id}/start`, { token: dTok, body: { pin } });
      await api('PUT', `/trips/${id}/complete`, { token: dTok });
      await api('POST', '/ratings', { token: pTok, body: { tripId: id, score: 5, comment: 'ok', ratedId: 'x' } });
      ok++;
    } catch (e) { fail++; }
  }
  const tripM = await metrics();
  out.trip = { n: ok, fail, perTrip: { queries: +(tripM.queries / ok).toFixed(2), rowsRead: +(tripM.rowsRead / ok).toFixed(2), rowsWritten: +(tripM.rowsWritten / ok).toFixed(2) }, total: tripM };

  // ---- custo de UM poll incoming ----
  await resetM();
  for (let i = 0; i < N; i++) await api('GET', '/trips/incoming', { token: dTok });
  const inM = await metrics();
  out.incomingPoll = { perPoll: { queries: +(inM.queries / N).toFixed(2), rowsRead: +(inM.rowsRead / N).toFixed(2) } };

  // ---- custo de UM poll nearby ----
  await resetM();
  for (let i = 0; i < N; i++) await api('GET', '/drivers/nearby?lat=-8.83&lng=13.24', { token: pTok });
  const nbM = await metrics();
  out.nearbyPoll = { perPoll: { queries: +(nbM.queries / N).toFixed(2), rowsRead: +(nbM.rowsRead / N).toFixed(2) } };

  // ---- custo de UM ping de posição da motorista (POST /drivers/position → D1) ----
  // GPS_N = pings por viagem (15 min a cada 5s ≈ 180); POSTS = amostra por medição.
  const GPS_N = Number(process.env.GPS_N || 180);
  const POSTS = Number(process.env.POSTS || 60);
  const N2 = Number(process.env.N2 || 3);
  const tripBody = { pickupLat: -8.83, pickupLng: 13.24, dropoffLat: -8.90, dropoffLng: 13.30, pickupAddress: 'A', dropoffAddress: 'B', rideType: 'ECONOMY', paymentMethod: 'CASH' };

  await resetM();
  for (let i = 0; i < POSTS; i++) {
    await api('POST', '/drivers/position', { body: { id: dId, lat: -8.83 + i * 0.0001, lng: 13.24 + i * 0.0001, cats: ['Económico'] } });
  }
  const dpM = await metrics();
  out.driverPositionPost = { perPost: { queries: +(dpM.queries / POSTS).toFixed(3), rowsRead: +(dpM.rowsRead / POSTS).toFixed(3), rowsWritten: +(dpM.rowsWritten / POSTS).toFixed(3), geoCalls: +((dpM.geo?.calls || 0) / POSTS).toFixed(3) }, total: dpM };

  // ---- custo de UM ping de posição da passageira (POST /trips/:id/position → memória) ----
  await resetM();
  for (let i = 0; i < POSTS; i++) {
    await api('POST', `/trips/DUMMY${RUN}/position`, { token: pTok, body: { lat: -8.83, lng: 13.24 } });
  }
  const ppM = await metrics();
  out.passengerPositionPost = { perPost: { queries: +(ppM.queries / POSTS).toFixed(3), rowsRead: +(ppM.rowsRead / POSTS).toFixed(3), rowsWritten: +(ppM.rowsWritten / POSTS).toFixed(3) }, total: ppM };

  // ---- viagem completa COM GPS (lifecycle + GPS_N pings da motorista) ----
  await resetM();
  let ok2 = 0, fail2 = 0;
  for (let i = 0; i < N2; i++) {
    try {
      const r = await api('POST', '/trips/request', { token: pTok, body: tripBody });
      if (!r.ok) throw new Error('request ' + r.text);
      const id = r.json.id;
      const ac = await api('PUT', `/trips/${id}/accept`, { token: dTok });
      if (!ac.ok) throw new Error('accept ' + ac.text);
      for (let k = 0; k < GPS_N; k++) {
        await api('POST', '/drivers/position', { body: { id: dId, lat: -8.83 + k * 0.0001, lng: 13.24 + k * 0.0001, cats: ['Económico'] } });
      }
      await api('PUT', `/trips/${id}/arrived`, { token: dTok });
      const g = await api('GET', `/trips/${id}`, { token: pTok });
      await api('PUT', `/trips/${id}/start`, { token: dTok, body: { pin: g.json?.pin } });
      await api('PUT', `/trips/${id}/complete`, { token: dTok });
      await api('POST', '/ratings', { token: pTok, body: { tripId: id, score: 5, comment: 'ok', ratedId: 'x' } });
      ok2++;
    } catch (e) { fail2++; }
  }
  const gpsM = await metrics();
  out.tripWithGps = { n: ok2, fail: fail2, gpsPerTrip: GPS_N, perTrip: { queries: +(gpsM.queries / ok2).toFixed(2), rowsRead: +(gpsM.rowsRead / ok2).toFixed(2), rowsWritten: +(gpsM.rowsWritten / ok2).toFixed(2) }, total: gpsM };

  // ---- síntese ----
  const lifeW = out.trip.perTrip.rowsWritten;
  const gpsW = out.driverPositionPost.perPost.rowsWritten * GPS_N;
  const totalW = lifeW + gpsW;
  // Pedidos ao DO DriverGeo (limite free 100k/dia, igual às escritas D1).
  const geoLife = (out.trip.total.geo?.calls || 0) / (ok || 1);
  const geoPerPost = (out.driverPositionPost.total.geo?.calls || 0) / POSTS;
  const geoTotal = geoLife + geoPerPost * GPS_N;
  out.summary = {
    lifecycleWritesPerTrip: lifeW,
    gpsWritesPerTrip: +gpsW.toFixed(2),
    totalWritesPerTrip: +totalW.toFixed(2),
    lifecycleGeoReqPerTrip: +geoLife.toFixed(2),
    gpsGeoReqPerTrip: +(geoPerPost * GPS_N).toFixed(2),
    totalGeoReqPerTrip: +geoTotal.toFixed(2),
    dayCeilingLifecycleOnly: Math.floor(100000 / lifeW),
    dayCeilingWithGpsByD1Writes: Math.floor(100000 / totalW),
    dayCeilingWithGpsByDoRequests: Math.floor(100000 / geoTotal),
    gpsPingsPerTrip: GPS_N,
  };

  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
