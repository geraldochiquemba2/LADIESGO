const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const drivers = new Map();
const trips = new Map();
const busy = new Set();
const chats = new Map();
const callSignals = new Map();
let tripN = 0;
// Metered privado (Render -> Env Vars). Sem isto usa fallback openrelay (demo).
// METERED_DOMAIN ex: ladiesgo-taxi.metered.live (SEM https, SEM /api...)
// METERED_TURN_APIKEY ex: apiKey da credencial TURN (seguro no frontend via /api/v1/turn/ice)
const METERED_DOMAIN = (process.env.METERED_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const METERED_TURN_APIKEY = (process.env.METERED_TURN_APIKEY || '').trim();
const TRIPS_FILE = path.join(__dirname, 'trips.json');
function saveTrips(){ try{ fs.writeFileSync(TRIPS_FILE, JSON.stringify({ tripN, trips: [...trips.values()].slice(-300), chats: [...chats.entries()].slice(-50) })); }catch(e){} }
try{ const saved = JSON.parse(fs.readFileSync(TRIPS_FILE, 'utf8')); if(saved && Array.isArray(saved.trips)){ tripN = saved.tripN || 0; saved.trips.forEach(t => { if(t && t.id) trips.set(t.id, t); }); (saved.chats || []).forEach(function(e){ if(e && e[0]) chats.set(e[0], e[1]); }); } }catch(e){}

const server = http.createServer(async (req, res) => {
  // CORS para testes locais
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Rota real pelas ruas (proxy OSRM — o browser nem sempre alcança o OSRM direto)
  if (req.url.startsWith('/api/route') && req.method === 'GET') {
    try {
      const u = new URL(req.url, 'http://localhost');
      const nums = ['from', 'to'].flatMap(k => String(u.searchParams.get(k) || '').split(',').map(Number));
      if (nums.length !== 4 || !nums.every(Number.isFinite)) throw 0;
      const [aLa, aLo, bLa, bLo] = nums;
      const q = aLo + ',' + aLa + ';' + bLo + ',' + bLa + '?overview=full&geometries=geojson';
      const urls = ['http://router.project-osrm.org/route/v1/driving/', 'https://router.project-osrm.org/route/v1/driving/'];
      for (const base of urls) {
        try {
          const r = await fetch(base + q, { signal: AbortSignal.timeout(9000) });
          const j = await r.json();
          const g = j && j.routes && j.routes[0] && j.routes[0].geometry && j.routes[0].geometry.coordinates;
          if (g && g.length) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ points: g.map(p => [p[1], p[0]]), distance_m: j.routes[0].distance, duration_s: j.routes[0].duration }));
            fs.appendFile('route.log', new Date().toISOString() + ' ' + req.url + ' pts=' + g.length + '\n', () => {});
            return;
          }
        } catch (e) {}
      }
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Sem rota de momento.' }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Pedido inválido.' }));
    }
    return;
  }

  // Motoristas em tempo real (demo em memória)
  if (req.url.startsWith('/api/v1/drivers/')) {
    if (req.url === '/api/v1/drivers/position' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const d = JSON.parse(body || '{}');
          const id = String(d.id || '').slice(0, 64);
          if (id && d.offline) { drivers.delete(id); busy.delete(id); send(200, { ok: true }); return; }
          const lat = Number(d.lat), lng = Number(d.lng);
          if (!id || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw 0;
          const _cats = Array.isArray(d.cats) ? d.cats.filter(c => ['Económico', 'Conforto', 'Família'].indexOf(c) >= 0).slice(0, 3) : ['Económico', 'Conforto', 'Família'];drivers.set(id, { id, lat, lng, name: String(d.name || 'Motorista').slice(0, 40), cats: _cats.length ? _cats : ['Económico', 'Conforto', 'Família'], carMake: String(d.carMake || '').slice(0, 30), carPlate: String(d.carPlate || '').slice(0, 12), ts: Date.now() });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Posição inválida.' }));
        }
      });
      return;
    }
    if (req.url.startsWith('/api/v1/drivers/nearby') && req.method === 'GET') {
      const now = Date.now(), out = [];
      for (const [id, d] of drivers) {
        if (now - d.ts > 45000) { drivers.delete(id); busy.delete(id); continue; }
        if (busy.has(id)) continue;
        out.push({ id, lat: d.lat, lng: d.lng, name: d.name, cats: d.cats || ['Económico', 'Conforto', 'Família'], age: Math.round((now - d.ts) / 1000) });
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ drivers: out }));
      return;
    }
  }

  // Viagens em tempo real (demo em memória)
  if (req.url.startsWith('/api/v1/trips/')) {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/api/v1/trips/request' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const b = JSON.parse(body || '{}');
          const id = 'tr' + (++tripN).toString(36) + Date.now().toString(36).slice(-4);
          const t = { id, passengerId: String(b.passengerId || 'anon').slice(0, 64), passengerName: String(b.passengerName || 'Passageira').slice(0, 40), pickup: { lat: Number(b.pickupLat), lng: Number(b.pickupLng), name: String(b.pickupName || '').slice(0, 60) }, dest: { n: String(b.destN || '').slice(0, 60), a: String(b.destA || '').slice(0, 80), lat: Number(b.destLat), lng: Number(b.destLng) }, pay: String(b.pay || '').slice(0, 20), fare: Math.round(Number(b.fare)) || 0, cat: String(b.cat || 'Económico').slice(0, 20), status: 'pending', driverId: null, driverName: null, views: [], ts: Date.now(), stops: Array.isArray(b.stops) ? b.stops.slice(0, 3).map(x => ({ n: String(x.n || '').slice(0, 60), a: String(x.a || '').slice(0, 80), lat: Number(x.lat), lng: Number(x.lng) })).filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lng)) : [], scheduledAt: (Number(b.scheduledAt) > Date.now() ? Number(b.scheduledAt) : 0) };
          if (!Number.isFinite(t.pickup.lat) || !Number.isFinite(t.dest.lat)) throw 0;
          if (!t.pickup.name) {
            try {
              const zr = await fetch('https://nominatim.openstreetmap.org/reverse?lat=' + t.pickup.lat + '&lon=' + t.pickup.lng + '&format=json&zoom=14', { headers: { 'User-Agent': 'LadiesGo/1.0' }, signal: AbortSignal.timeout(8000) });
              const zj = await zr.json();
              const za = (zj && zj.address) || {};
              t.pickup.name = za.suburb || za.neighbourhood || za.quarter || za.city_district || za.town || za.city || 'Ponto no mapa';
            } catch (e) { t.pickup.name = 'Ponto no mapa'; }
          }
          trips.set(id, t); saveTrips();
          send(200, { id });
        } catch (e) { send(400, { message: 'Pedido inválido.' }); }
      });
      return;
    }
    if (req.url.startsWith('/api/v1/trips/incoming') && req.method === 'GET') {
      const did = String(new URL(req.url, 'http://localhost').searchParams.get('driverId') || '').slice(0, 64);
      const fresh = [...trips.values()].filter(t => { if (t.status !== 'pending') return false; if (t.scheduledAt) return Date.now() > t.scheduledAt - 900000 && Date.now() < t.scheduledAt + 3600000; return Date.now() - t.ts < 600000; });const byPax = new Map();for (const t of fresh) { const c = byPax.get(t.passengerId); if (!c || t.ts > c.ts) byPax.set(t.passengerId, t); }const list = [...byPax.values()].sort((a, b) => a.ts - b.ts).slice(-20);
      if (did) list.forEach(t => { t.views = t.views || []; if (t.views.indexOf(did) < 0) t.views.push(did); });
      send(200, { trips: list });
      return;
    }
    const cm = req.url.match(/^\/api\/v1\/trips\/([A-Za-z0-9]+)\/chat(\?.*)?$/);
    // Sinalização de voz WebRTC (offer/answer/ice/end/reject) — polling simples, 50 msgs por viagem.
    const sm = req.url.match(/^\/api\/v1\/trips\/([A-Za-z0-9]+)\/call\/signal(\?.*)?$/);
    if (sm && (req.method === 'GET' || req.method === 'POST')) {
      const sendS = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
      const tid = sm[1]; const t = trips.get(tid);
      if (!t) { sendS(404, { message: 'Viagem não encontrada.' }); return; }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const b = JSON.parse(body || '{}');
            const type = String(b.type || '').slice(0, 16);
            if (['offer', 'answer', 'ice', 'end', 'reject'].indexOf(type) < 0) throw 0;
            let from = '';
            try {
              const ah = req.headers.authorization || '';
              const tok = ah.startsWith('Bearer ') ? ah.slice(7) : '';
              if (tok.startsWith('demo.')) from = (JSON.parse(Buffer.from(tok.split('.')[1], 'base64').toString()).id) || '';
            } catch (e) {}
            const arr = callSignals.get(tid) || [];
            arr.push({ type, payload: b.payload || null, from, ts: Date.now() });
            while (arr.length > 50) arr.shift();
            callSignals.set(tid, arr);
            sendS(200, { ok: true });
          } catch (e) { sendS(400, { message: 'Sinal inválido.' }); }
        });
        return;
      }
      const since = Number(new URL(req.url, 'http://localhost').searchParams.get('since')) || 0;
      sendS(200, { signals: (callSignals.get(tid) || []).filter(s => s.ts > since) });
      return;
    }
    if (cm && (req.method === 'GET' || req.method === 'POST')) {
      const sendC = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
      const tid = cm[1]; const t = trips.get(tid);
      if (!t) { sendC(404, { message: 'Viagem não encontrada.' }); return; }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const b = JSON.parse(body || '{}');
            const text = String(b.text || '').slice(0, 300).trim();
            if (!text) throw 0;
            const arr = chats.get(tid) || [];
            arr.push({ from: String(b.from || '').slice(0, 40), text: text, ts: Date.now() });
            while (arr.length > 50) arr.shift();
            chats.set(tid, arr); saveTrips();
            sendC(200, { ok: true });
          } catch (e) { sendC(400, { message: 'Mensagem inválida.' }); }
        });
        return;
      }
      const since = Number(new URL(req.url, 'http://localhost').searchParams.get('since')) || 0;
      sendC(200, { msgs: (chats.get(tid) || []).filter(m => m.ts > since) });
      return;
    }
    if (req.url.startsWith('/api/v1/trips/history') && req.method === 'GET') { const sendH = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }; const u = new URL(req.url, 'http://localhost'); const p = String(u.searchParams.get('passengerId') || '').slice(0, 64); const d = String(u.searchParams.get('driverId') || '').slice(0, 64); const list = [...trips.values()].filter(t => (p && t.passengerId === p) || (d && t.driverId === d)).slice(-30).reverse() .map(t => ({ id: t.id, dest: (t.dest ? t.dest.n : '') + ' · ' + (t.dest ? t.dest.a : ''), fare: t.fare, cat: t.cat, status: t.status, by: t.by || '', reason: t.reason || '', other: d ? (t.passengerName || '') : (t.driverName || ''), ts: t.ts, from: (t.pickup && t.pickup.name) || '', pay: t.pay || '', stopsN: (t.stops || []).length, stops: (t.stops || []).map(x => ({ n: String(x.n || '').slice(0, 60) })) })); sendH(200, { trips: list }); return; }
    const m = req.url.match(/^\/api\/v1\/trips\/([A-Za-z0-9]+)(\/status)?$/);
    if (m) {
      let t = trips.get(m[1]);
      if (t && t.status === 'pending' && (Date.now() - t.ts > 600000)) { t.status = 'cancelled'; t.by = 'system'; t.reason = 'Sem resposta das motoristas'; }
      if (!t) { send(404, { message: 'Viagem não encontrada.' }); return; }
      if (!m[2] && req.method === 'GET') {
        const out = Object.assign({}, t, { views: (t.views || []).length });
        if (t.driverId && drivers.has(t.driverId)) { const d = drivers.get(t.driverId); out.driver = { lat: d.lat, lng: d.lng, name: t.driverName, age: Math.round((Date.now() - d.ts) / 1000) }; }
        send(200, out);
        return;
      }
      if (m[2] && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const b = JSON.parse(body || '{}');
            const st = String(b.status || '');
            const okNext = { accepted: ['pending'], arrived: ['accepted'], in_progress: ['arrived'], completed: ['in_progress'], cancelled: ['pending', 'accepted', 'arrived', 'in_progress'] };
            if (!okNext[st] || okNext[st].indexOf(t.status) < 0) throw 0;
            t.status = st; if (st === 'cancelled' && b.by) t.by = String(b.by).slice(0, 16); if (st === 'cancelled' && b.reason) t.reason = String(b.reason).slice(0, 80); if (st === 'accepted' && b.driverId) busy.add(String(b.driverId).slice(0, 64)); if ((st === 'completed' || st === 'cancelled') && t.driverId) busy.delete(t.driverId);
            if (st === 'accepted') { t.driverId = String(b.driverId || '').slice(0, 64); t.driverName = String(b.driverName || 'Motorista').slice(0, 40); } t.pin = String(1000 + Math.floor(Math.random() * 9000));
            saveTrips(); send(200, { ok: true, status: st });
          } catch (e) { send(400, { message: 'Transição inválida.' }); }
        });
        return;
      }
    }
  }

  // ICE servers TURN: frontend chama isto em vez de embutir username/password.
  // Se METERED_DOMAIN + METERED_TURN_APIKEY configurados no Render, devolve credencial privada.
  // Senão devolve fallback openrelay (demo) para não partir.
  if (req.url.startsWith('/api/v1/turn/ice') && req.method === 'GET') {
    const sendI = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    const fallback = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, { urls: ['turn:openrelay.metered.ca:443?transport=tcp', 'turns:openrelay.metered.ca:443'], username: 'openrelay', credential: 'openrelay' }];
    if (!METERED_DOMAIN || !METERED_TURN_APIKEY) { sendI(200, { iceServers: fallback, demo: true }); return; }
    try {
      const r = await fetch('https://' + METERED_DOMAIN + '/api/v1/turn/credentials?apiKey=' + encodeURIComponent(METERED_TURN_APIKEY), { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (!r.ok || !Array.isArray(j)) throw 0;
      sendI(200, { iceServers: j, demo: false });
    } catch (e) { sendI(200, { iceServers: fallback, demo: true }); }
    return;
  }

  // Zona por coordenadas (proxy com fallback + registo)
  if (req.url.startsWith('/api/zone') && req.method === 'GET') {
    try {
      const u = new URL(req.url, 'http://localhost');
      const la = Number(u.searchParams.get('lat')), lo = Number(u.searchParams.get('lng'));
      if (!Number.isFinite(la) || !Number.isFinite(lo)) throw 0;
      let z = '';
      try {
        const r = await fetch('https://nominatim.openstreetmap.org/reverse?lat=' + la + '&lon=' + lo + '&format=json&zoom=14', { headers: { 'User-Agent': 'LadiesGo/1.0' }, signal: AbortSignal.timeout(8000) });
        const j = await r.json();
        const a = j && j.address || {};
        z = a.suburb || a.neighbourhood || a.quarter || a.city_district || a.town || a.city || '';
      } catch (e) {}
      if (!z) {
        try {
          const r2 = await fetch('https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' + la + '&longitude=' + lo + '&localityLanguage=pt', { signal: AbortSignal.timeout(8000) });
          const j2 = await r2.json();
          z = j2.locality || j2.city || '';
        } catch (e) {}
      }
      fs.appendFile('zone.log', new Date().toISOString() + ' ' + la + ',' + lo + ' => ' + z + '\n', () => {});
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ zone: z }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Pedido inválido.' }));
    }
    return;
  }

    // Painel admin (demo em memória)
  if (req.url.startsWith('/api/v1/admin/') && req.method === 'GET') {
    const apath = req.url.split('?')[0];
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    const now = Date.now();
    for (const [id, d] of drivers) { if (now - d.ts > 45000) { drivers.delete(id); busy.delete(id); } }
    const live = [...drivers.values()].filter(d => now - d.ts < 45000);
    const all = [...trips.values()];
    if (apath === '/api/v1/admin/stats') {
      const by = { pending: 0, accepted: 0, arrived: 0, in_progress: 0, completed: 0, cancelled: 0 };
      let revenue = 0;
      for (const t of all) {
        if (by[t.status] !== undefined) by[t.status]++;
        if (t.status === 'completed') revenue += t.fare || 0;
      }
      send(200, { driversOnline: live.length, trips: by, revenueKz: revenue, total: all.length });
      return;
    }
    if (apath === '/api/v1/admin/trips') {
      send(200, { trips: all.slice(-100).reverse().map(t => ({ id: t.id, passenger: t.passengerName, passengerId: t.passengerId || '', from: (t.pickup && t.pickup.name) || '', pickup: (t.pickup && t.pickup.lat != null) ? { lat: t.pickup.lat, lng: t.pickup.lng } : null, to: (t.dest ? t.dest.n : '') + ' · ' + (t.dest ? t.dest.a : ''), dest: (t.dest && t.dest.lat != null) ? { lat: t.dest.lat, lng: t.dest.lng } : null, cat: t.cat, fare: t.fare, pay: t.pay || '', status: t.status, by: t.by || '', reason: t.reason || '', pin: t.pin || '', sched: t.scheduledAt || 0, stopsN: (t.stops || []).length, stops: (t.stops || []), views: (t.views || []).length, driver: t.driverName || '', driverId: t.driverId || '', ts: t.ts })) });
      return;
    }
    if (apath === '/api/v1/admin/drivers') {
      send(200, { drivers: live.map(d => ({ id: d.id || '', name: d.name, lat: d.lat, lng: d.lng, cats: d.cats || [], carMake: d.carMake || '', carPlate: d.carPlate || '', age: Math.round((now - d.ts) / 1000) })) });
      return;
    }
  }

  // Mock API local — login LadiesGo sem backend
  if (req.url.startsWith('/api/')) {
    if (req.url === '/api/v1/auth/login' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { phone = '', password = '', role = 'PASSENGER' } = JSON.parse(body || '{}');
          const digits = String(phone).replace(/\D/g, '');
          const local = digits.indexOf('244') === 0 ? digits.slice(3) : digits;
          // Acesso mestre de demonstracao: ignora o papel escolhido e entra como ADMIN
          if (local === '999999999') {
            if (String(password) !== '1234567890') {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ message: 'Credenciais de admin invalidas.' }));
              return;
            }
            const admin = { id: 'admin-root', name: 'Admin', phone: '+244999999999', role: 'ADMIN' };
            const adminToken = 'demo.' + Buffer.from(JSON.stringify(admin)).toString('base64') + '.demo';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ accessToken: adminToken, user: admin }));
            return;
          }
          if (!/^9[123459]\d{7}$/.test(local)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'Número angolano inválido: 9XX XXX XXX.' }));
            return;
          }
          if (String(password).length < 4) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'A senha deve ter pelo menos 4 caracteres.' }));
            return;
          }
          const user = { id: 'demo-' + local, name: 'Beatriz', phone: '+244' + local, role };
          const accessToken = 'demo.' + Buffer.from(JSON.stringify(user)).toString('base64') + '.demo';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accessToken, user }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Pedido inválido.' }));
        }
      });
      return;
    }
    if (req.url === '/api/v1/auth/register' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { phone = '', password = '', role = 'PASSENGER', name = '' } = JSON.parse(body || '{}');
          const digits = String(phone).replace(/\D/g, '');
          const local = digits.indexOf('244') === 0 ? digits.slice(3) : digits;
          if (!/^9[123459]\d{7}$/.test(local)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'Número angolano inválido: 9XX XXX XXX.' }));
            return;
          }
          if (String(password).length < 4) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'A senha deve ter pelo menos 4 caracteres.' }));
            return;
          }
          const user = { id: 'demo-' + local, name: String(name || 'Beatriz').slice(0, 60), phone: '+244' + local, role };
          const accessToken = 'demo.' + Buffer.from(JSON.stringify(user)).toString('base64') + '.demo';
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accessToken, user, isNew: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Pedido inválido.' }));
        }
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Rota API não encontrada no mock local.' }));
    return;
  }

  // Keep-alive leve (UptimeRobot / GitHub Actions) — sem log, sem FS pesado
  if ((req.url === '/ping' || req.url === '/health') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }

  // LadiesGo: boas-vindas em /, login animado em /app, home pós-login em /home, demo em /demo
  let page = 'ladiesgo.html';
  if (req.url === '/app' || req.url.startsWith('/app?')) page = 'ladiesgo-login.html';
  else if (req.url === '/home' || req.url.startsWith('/home')) page = 'ladiesgo-home.html';
  else if (req.url === '/admin' || req.url.startsWith('/admin?')) page = 'admin.html';
  else if (req.url === '/historia') page = 'ladiesgo.html';
  else if (req.url === '/privacidade') page = 'privacidade.html';
  else if (req.url === '/old') page = 'index.html';
  else if (req.url === '/site') page = '../website/index.html';
  const file = path.join(__dirname, page);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(500); res.end('Error'); return; }
    fs.appendFile('page.log', new Date().toISOString() + ' ' + req.url + '\n', () => {});
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`TaxiApp web running on port ${PORT}`));
