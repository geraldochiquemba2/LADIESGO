// E2E de producao: valida o caminho do cliente WebSocket de GPS da motorista.
//   login admin -> cria motorista (auto-aprovado) -> login motorista -> fica online
//   abre WS /drivers/live-geo?token=... -> envia {lat,lng}
//   confirma que /drivers/nearby (lido do DO) reflete a posicao do WS
//   envia nova posicao -> confirma atualizacao
//   envia {offline:true} -> confirma que sai do nearby
// Correr: node loadtest/geo-ws-e2e.mjs
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
async function waitNearby(dId, predicate, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const r = await api('GET', `/drivers/nearby?lat=-8.85&lng=13.25`);
    last = (r.json && r.json.drivers) || [];
    const d = last.find((x) => String(x.id) === String(dId));
    if (predicate(d, last)) return { found: d, list: last };
    await delay(500);
  }
  return { found: null, list: last };
}

const RUN = (Date.now() % 1e9).toString().padStart(9, '0');
const results = [];
function check(name, ok, extra) { results.push({ name, ok, extra }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + JSON.stringify(extra) : '')); }

async function main() {
  const adm = await api('POST', '/auth/login', { body: { phone: '999999999', password: '1234567890' } });
  if (!adm.ok) throw new Error('admin login: ' + adm.text);
  const ah = adm.json.accessToken;

  const dPhone = `+24491${RUN}`;
  const cr = await api('POST', '/admin/drivers/create', { token: ah, body: { phone: dPhone, name: 'E2EDrv', licenseNumber: 'L' + RUN, carPlate: 'E2-' + RUN, carMake: 'Kia', carModel: 'Rio', carYear: 2021, carColor: 'Preto' } });
  if (!cr.ok) throw new Error('create driver: ' + cr.text);
  const dl = await api('POST', '/auth/login', { body: { phone: dPhone, password: '0987654321' } });
  if (!dl.ok) throw new Error('driver login: ' + dl.text);
  const dTok = dl.json.accessToken;
  const dst = await api('GET', '/drivers/status', { token: dTok });
  const dId = dst.json && dst.json.id;
  if (!dId) throw new Error('driver row id: ' + dst.text);
  const to = await api('PUT', '/drivers/toggle-online', { token: dTok, body: { isOnline: true } });
  check('motorista online (D1 isOnline=true)', to.ok, { status: to.status });

  const url = `${WS_BASE}/drivers/live-geo?token=${encodeURIComponent(dTok)}`;
  const ws = await openWs(url);
  check('WS /drivers/live-geo abre', ws.readyState === 1, { state: ws.readyState });

  ws.send(J({ lat: -8.85, lng: 13.25, cats: ['Económico'] }));
  const a = await waitNearby(dId, (d) => d && Math.abs(Number(d.lat) - -8.85) < 0.002, 10000);
  check('nearby reflete posicao enviada pelo WS', !!a.found && Math.abs(Number(a.found.lat) - -8.85) < 0.002, a.found ? { id: a.found.id, lat: a.found.lat, lng: a.found.lng, dist: a.found.distanceKm } : { list: a.list.length });

  ws.send(J({ lat: -8.86, lng: 13.26, cats: ['Económico'] }));
  const b = await waitNearby(dId, (d) => d && Math.abs(Number(d.lat) - -8.86) < 0.002, 10000);
  check('nearby atualiza com nova posicao WS', !!b.found && Math.abs(Number(b.found.lat) - -8.86) < 0.002, b.found ? { lat: b.found.lat } : {});

  ws.send(J({ offline: true }));
  const c = await waitNearby(dId, (d) => !d, 10000);
  check('nearby remove apos {offline:true}', !c.found, { aindaPresente: !!c.found });

  try { ws.close(); } catch {}
  await api('PUT', '/drivers/toggle-online', { token: dTok, body: { isOnline: false } });

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (failed.length ? 'RESULTADO: FAIL (' + failed.length + ')' : 'RESULTADO: ALL PASS'));
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
