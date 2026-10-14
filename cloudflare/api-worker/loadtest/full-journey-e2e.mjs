// E2E do fluxo completo com 4 ATORES:
//   1) admin           2) passageira     3) motorista     4) contacto c/ link de partilha
// Cada ator corre o seu próprio cliente (REST + WebSockets reais) e registamos o que vê.
// O 4º ator faz polling a GET /trips/public/:id a cada 4s (como a página /t).
// Correr: node loadtest/full-journey-e2e.mjs
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
function actor(name, msg) { console.log(`   [${name}] ${msg}`); }
function openWs(url, name, sink) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const to = setTimeout(() => reject(new Error('WS timeout ' + name)), 15000);
    ws.onopen = () => { clearTimeout(to); resolve(ws); };
    ws.onerror = () => { clearTimeout(to); reject(new Error('WS error ' + name)); };
    if (sink) ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); sink.push(m); actor(name, 'recebeu ' + JSON.stringify(m)); } catch {} };
  });
}
async function waitFor(arr, pred, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const f = arr.find(pred); if (f) return f; await delay(200); } return null; }
function pinForTrip(id) { let h = 0; for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return String(1000 + (h % 9000)); }

const results = [];
function check(name, ok, extra) { results.push({ name, ok, extra }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + JSON.stringify(extra) : '')); }
const RUN = (Date.now() % 1e9).toString().padStart(9, '0');

async function main() {
  const ping = await api('GET', '/health');
  actor('sistema', 'API ' + (ping.ok ? 'online' : 'OFFLINE'));
  const adm = await api('POST', '/auth/login', { body: { phone: '999999999', password: '1234567890' } });
  if (!adm.ok) throw new Error('admin login: ' + adm.text);
  const ah = adm.json.accessToken;
  actor('admin', 'sessão iniciada');

  // Ator 3 — motorista (criada pelo admin)
  const dPhone = `+24491${RUN}`;
  const cr = await api('POST', '/admin/drivers/create', { token: ah, body: { phone: dPhone, name: 'Ana Motorista', licenseNumber: 'LG' + RUN, carPlate: 'LD-' + RUN, carMake: 'Toyota', carModel: 'Corolla', carYear: 2020, carColor: 'Branco' } });
  if (!cr.ok) throw new Error('create driver: ' + cr.text);
  actor('admin', 'motorista criada/aprovada');
  const dl = await api('POST', '/auth/login', { body: { phone: dPhone, password: '0987654321' } });
  const dTok = dl.json.accessToken;
  const dId = (await api('GET', '/drivers/status', { token: dTok })).json.id;
  actor('motorista', 'login feito (driverId=' + String(dId).slice(0, 8) + '…)');

  // Ator 2 — passageira
  const pPhone = `+24492${RUN}`;
  const pr = await api('POST', '/auth/register', { body: { phone: pPhone, password: '123456', name: 'Joana Passageira' } });
  if (!pr.ok) throw new Error('register pax: ' + pr.text);
  const pTok = pr.json.accessToken;
  actor('passageira', 'conta criada / login');

  // motorista fica online + WSs
  await api('PUT', '/drivers/toggle-online', { token: dTok, body: { isOnline: true } });
  const reqFrames = [];
  const geoWs = await openWs(`${WS_BASE}/drivers/live-geo?token=${encodeURIComponent(dTok)}`, 'motorista', []);
  const reqWs = await openWs(`${WS_BASE}/trips/requests-live?token=${encodeURIComponent(dTok)}`, 'motorista', reqFrames);
  actor('motorista', 'online; WS GPS + WS pedidos abertos');
  geoWs.send(J({ lat: -8.85, lng: 13.25, cats: ['Económico'] }));
  actor('motorista', 'posição inicial -8.8500,13.2500');

  // Ator 2 vê carros
  const nb = await api('GET', '/drivers/nearby?lat=-8.85&lng=13.25');
  const mine = ((nb.json && nb.json.drivers) || []).find((d) => String(d.id) === String(dId));
  actor('passageira', 'nearby: ' + ((nb.json && nb.json.drivers) || []).length + ' carro(s)' + (mine ? ' — a motorista a ' + mine.distanceKm + 'km' : ''));
  check('passageira vê a motorista no mapa', !!mine);

  // Ator 2 pede viagem
  const rq = await api('POST', '/trips/request', { token: pTok, body: { pickupLat: -8.85, pickupLng: 13.25, pickupAddress: 'Casa da Joana', dropoffLat: -8.90, dropoffLng: 13.30, dropoffAddress: 'Mercado', rideType: 'Económico', fare: 1500 } });
  if (!rq.ok) throw new Error('request: ' + rq.text);
  const id = rq.json.id;
  const pin = pinForTrip(id);
  actor('passageira', 'pediu viagem (id=' + id.slice(0, 8) + '…) estado=' + rq.json.status + ' preço=' + rq.json.fareEstimate + 'Kz pin=' + pin);

  // Ator 4 — quem tem o link de partilha (começa a acompanhar agora)
  let tracking = true, lastStatus = '', lastDLL = '';
  const trackAsync = (async () => {
    while (tracking) {
      try {
        const r = await api('GET', `/trips/public/${encodeURIComponent(id)}`);
        const t = r.json;
        if (t) {
          const st = String(t.status || '');
          const dll = t.driver && t.driver.lat != null ? Number(t.driver.lat).toFixed(4) + ',' + Number(t.driver.lng).toFixed(4) : '-';
          if (st !== lastStatus || dll !== lastDLL) {
            lastStatus = st; lastDLL = dll;
            const who = t.driver && t.driver.name ? t.driver.name + ' @ ' + dll : 'sem carro';
            actor('link', 'estado=' + st + ' · ' + who);
          }
        }
      } catch (e) {}
      await delay(4000);
    }
  })();
  actor('link', 'link de partilha aberto, a acompanhar a cada 4s');

  // Ator 3 recebe o pedido por push
  const refresh = await waitFor(reqFrames, (m) => m && m.t === 'refresh', 6000);
  actor('motorista', refresh ? 'aviso do pedido recebido por push (WS)' : 'NÃO recebeu aviso por WS');
  check('motorista avisada do pedido por push', !!refresh);
  const inc = await api('GET', '/trips/incoming', { token: dTok });
  const incTrip = ((inc.json && inc.json.trips) || []).find((t) => String(t.id) === String(id));
  actor('motorista', 'lista: ' + ((inc.json && inc.json.trips) || []).length + ' pedido(s)' + (incTrip ? ' — o da Joana' : ' — não está'));
  check('pedido aparece na lista da motorista', !!incTrip);

  // Ator 2 abre socket da viagem
  const paxFrames = [];
  const paxWs = await openWs(`${WS_BASE}/trips/${id}/live?token=${encodeURIComponent(pTok)}`, 'passageira', paxFrames);
  actor('passageira', 'socket da viagem aberto');

  // Ator 3 aceita
  const acc = await api('PUT', `/trips/${id}/accept`, { token: dTok, body: {} });
  actor('motorista', 'aceitou → ' + (acc.json && acc.json.status));
  const accFrame = await waitFor(paxFrames, (m) => m && m.t === 'status' && String(m.status).toUpperCase() === 'ACCEPTED', 8000);
  actor('passageira', accFrame ? 'viu "Motorista a caminho"' : 'NÃO recebeu estado');
  check('passageira vê o aceitar em tempo real', !!accFrame);

  const drvFrames = [];
  const drvWs = await openWs(`${WS_BASE}/trips/${id}/live?token=${encodeURIComponent(dTok)}`, 'motorista', drvFrames);
  actor('motorista', 'socket da viagem aberto');

  // movimento (aproximação) — geo (para o link) + trip WS (para a passageira)
  await delay(10500);
  geoWs.send(J({ lat: -8.8460, lng: 13.2460, cats: ['Económico'] }));
  drvWs.send(J({ t: 'gps', role: 'driver', lat: -8.8460, lng: 13.2460 }));
  actor('motorista', 'a caminho: -8.8460,13.2460');
  const dFrame = await waitFor(paxFrames, (m) => m && m.t === 'driver', 8000);
  actor('passageira', dFrame ? 'carro a aproximar-se @ ' + dFrame.lat.toFixed(4) + ',' + dFrame.lng.toFixed(4) : 'NÃO viu o carro');
  check('posição da motorista chega à passageira', !!dFrame);

  // passageira envia a sua posição
  paxWs.send(J({ t: 'gps', role: 'pax', lat: -8.8510, lng: 13.2510 }));
  actor('passageira', 'enviou a sua posição');
  const pFrame = await waitFor(drvFrames, (m) => m && m.t === 'pax', 8000);
  actor('motorista', pFrame ? 'vê a passageira @ ' + pFrame.lat.toFixed(4) + ',' + pFrame.lng.toFixed(4) : 'NÃO vê');
  check('posição da passageira chega à motorista', !!pFrame);

  // chat
  await api('POST', `/trips/${id}/chat`, { token: pTok, body: { text: 'Boa tarde, estou na porta.' } });
  await delay(500);
  const dc = await api('GET', `/trips/${id}/chat?since=0`, { token: dTok });
  check('chat passageira → motorista', ((dc.json && dc.json.msgs) || []).some((m) => /porta/.test(m.text)));
  actor('motorista', 'leu no chat: "' + (((dc.json && dc.json.msgs) || []).slice(-1)[0] || {}).text + '"');
  await api('POST', `/trips/${id}/chat`, { token: dTok, body: { text: 'A chegar, 2 minutos.' } });
  await delay(500);
  const pc = await api('GET', `/trips/${id}/chat?since=0`, { token: pTok });
  check('chat motorista → passageira', ((pc.json && pc.json.msgs) || []).some((m) => /chegar/.test(m.text)));
  actor('passageira', 'leu no chat: "A chegar, 2 minutos."');

  // chegada
  await api('PUT', `/trips/${id}/arrived`, { token: dTok, body: {} });
  const arrFrame = await waitFor(paxFrames, (m) => m && m.t === 'status' && String(m.status).toUpperCase() === 'DRIVER_ARRIVED', 8000);
  actor('motorista', 'marcou "cheguei"');
  actor('passageira', arrFrame ? 'viu "Motorista chegou"' : 'NÃO recebeu');
  check('passageira vê "motorista chegou"', !!arrFrame);

  // arranque com PIN
  const st = await api('PUT', `/trips/${id}/start`, { token: dTok, body: { pin } });
  const stFrame = await waitFor(paxFrames, (m) => m && m.t === 'status' && String(m.status).toUpperCase() === 'IN_PROGRESS', 8000);
  actor('motorista', 'código ' + pin + ' → ' + (st.json && st.json.status));
  actor('passageira', stFrame ? 'viu "Em viagem"' : 'NÃO recebeu');
  check('viagem arranca em IN_PROGRESS (PIN)', st.ok && !!stFrame);

  // durante a viagem — monitorização (geo p/ link + trip WS p/ passageira)
  await delay(10500);
  geoWs.send(J({ lat: -8.8700, lng: 13.2700, cats: ['Económico'] }));
  drvWs.send(J({ t: 'gps', role: 'driver', lat: -8.8700, lng: 13.2700 }));
  actor('motorista', 'em viagem: -8.8700,13.2700');
  const monFrame = await waitFor(paxFrames, (m) => m && m.t === 'driver' && Math.abs(m.lat - -8.87) < 1e-6, 8000);
  actor('passageira', monFrame ? 'vê o carro a andar' : 'NÃO vê o carro');
  check('motorista monitorizada durante IN_PROGRESS', !!monFrame);

  // link vê a posição durante a viagem
  let pubSeen = false;
  for (let i = 0; i < 12; i++) { const r = await api('GET', `/trips/public/${id}`); const t = r.json; if (t && t.driver && Math.abs(Number(t.driver.lat) - -8.87) < 0.002) { pubSeen = true; break; } await delay(700); }
  check('link de partilha mostra a motorista durante a viagem', pubSeen);

  // conclusão
  await api('PUT', `/trips/${id}/complete`, { token: dTok, body: {} });
  const cpFrame = await waitFor(paxFrames, (m) => m && m.t === 'status' && String(m.status).toUpperCase() === 'COMPLETED', 8000);
  actor('motorista', 'concluiu a viagem');
  actor('passageira', cpFrame ? 'viu "Viagem concluída"' : 'NÃO recebeu');
  check('viagem conclui em COMPLETED', !!cpFrame);

  // avaliação
  const rt = await api('POST', '/ratings', { token: pTok, body: { tripId: id, score: 5, comment: 'Muito bom!' } });
  actor('passageira', 'avaliou 5★');
  check('avaliação registada', rt.ok);

  await delay(4500); // deixa o link apanhar o COMPLETED
  tracking = false;
  await trackAsync;

  // admin observa
  const stats = await api('GET', '/admin/stats', { token: ah });
  actor('admin', 'stats: ' + JSON.stringify(stats.json));

  try { geoWs.close(); } catch {}
  try { reqWs.close(); } catch {}
  try { drvWs.close(); } catch {}
  try { paxWs.close(); } catch {}
  await api('PUT', '/drivers/toggle-online', { token: dTok, body: { isOnline: false } }).catch(() => {});

  const failed = results.filter((r) => !r.ok);
  console.log('\n───────────────');
  console.log('CHECKLIST: ' + results.filter((r) => r.ok).length + '/' + results.length + ' passaram');
  results.forEach((r) => console.log('  ' + (r.ok ? 'OK   ' : 'FALHA') + ' ' + r.name));
  console.log(failed.length ? '\nRESULTADO: FAIL (' + failed.length + ')' : '\nRESULTADO: ALL PASS');
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
