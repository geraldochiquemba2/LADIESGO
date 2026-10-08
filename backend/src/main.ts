import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import * as path from 'path';
import * as fs from 'fs';
import compression from 'compression';

function resolveWebFile(page: string): string | null {
  const candidates = [
    process.env.WEBAPP_DIR ? path.join(process.env.WEBAPP_DIR, page) : null,
    path.join(process.cwd(), 'webapp', page),
    path.join(process.cwd(), '..', 'webapp', page),
    path.join(__dirname, '..', '..', '..', 'webapp', page),
    path.join(__dirname, '..', '..', 'webapp', page),
    path.join('/app', 'webapp', page),
  ].filter(Boolean) as string[];
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) return f;
    } catch {}
  }
  return null;
}

function sendWeb(res: any, page: string) {
  const file = resolveWebFile(page);
  if (!file) {
    res.status(500).send('Frontend em falta no deploy.');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  fs.createReadStream(file).pipe(res);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Gzip: menos banda nos 100GB do Render free (JSON + HTML comprimem ~70%).
  app.use(compression());

  // Behind Railway's proxy, X-Forwarded-For is "<real client>, <edge>" and the
  // edge IP ROTATES every request. `trust proxy: 1` keyed the rate limiter on
  // that rotating edge (so it never accumulated); `true` makes req.ip the
  // leftmost/real client, which is stable per user.
  app.getHttpAdapter().getInstance().set('trust proxy', true);

  app.enableCors({ origin: '*' });

  // Single-service Render free: API + Web LadiesGo! no mesmo processo/porta.
  const httpAdapter = app.getHttpAdapter();

  // Keep-alive INTERNO: o próprio serviço faz ping ao seu URL público
  // a cada 10 min. Tem de ser o URL público (volta pela edge do Render como
  // tráfego inbound) — ping a localhost não evita o sleep. Sem KEEP_ALIVE_URL
  // fica desligado (estado honesto). O GitHub Actions continua como 2ª camada.
  // Não fazemos heartbeat à BD de propósito: Neon acorda em ~300ms e o plano
  // free só tem 100 CU-h/mês — always-on esgotava a meio do mês.
  const keepAlive = {
    enabled: !!process.env.KEEP_ALIVE_URL,
    target: (process.env.KEEP_ALIVE_URL || '').replace(/\/+$/, '') || null,
    intervalMs: Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 10 * 60 * 1000,
    pings: 0,
    failures: 0,
    lastPing: null as string | null,
    lastStatus: null as number | string | null,
  };

  // Keep-alive leve — sem BD, sem log pesado (UptimeRobot / GitHub Actions)
  httpAdapter.get('/ping', (_req: any, res: any) => {
    res.json({ ok: true, ts: Date.now(), keepAlive });
  });

  // Cache em memória (poupa Nominatim/OSRM + banda no Render free).
  // zone: nomes de bairro quase não mudam (24h); route: trânsito muda (10min).
  const tinyCache = new Map<string, { exp: number; body: any }>();
  function cacheGet(key: string): any | null {
    const e = tinyCache.get(key);
    if (!e) return null;
    if (Date.now() > e.exp) {
      tinyCache.delete(key);
      return null;
    }
    return e.body;
  }
  function cacheSet(key: string, body: any, ttlMs: number) {
    if (tinyCache.size > 2000) tinyCache.clear();
    tinyCache.set(key, { exp: Date.now() + ttlMs, body });
  }

  // Índice de locais LadiesGo (23k+ Luanda) em memória: pesquisa instantânea
  // sem gastar BD (0 CU) e sem depender do Nominatim. Carregado do JSON
  // gerado pelo extrator (webapp/ladiesgo-luanda-final.json).
  type PlaceEntry = { n: string; lat: number; lng: number; t: string; m: string };
  let placesIdx: PlaceEntry[] = [];
  let placesNorm: string[] = [];
  let placesFull: string[] = [];
  const norm = (s: string) =>
    (s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  function loadPlaces() {
    try {
      const f = resolveWebFile('ladiesgo-luanda-final.json');
      if (!f) return;
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      const arr = raw.places || raw.d || [];
      placesIdx = [];
      placesNorm = [];
      placesFull = [];
      for (const p of arr) {
        const lat = Array.isArray(p) ? p[1] : p.lat;
        const lng = Array.isArray(p) ? p[2] : p.lng;
        const name = Array.isArray(p) ? p[0] : p.name;
        if (typeof name !== 'string' || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        placesIdx.push({
          n: name,
          lat,
          lng,
          t: String(Array.isArray(p) ? p[5] || '' : p.type || ''),
          m: String(Array.isArray(p) ? p[4] || '' : p.municipality || ''),
        });
        placesNorm.push(norm(name));
        placesFull.push(norm(name + ' ' + placesIdx[placesIdx.length - 1].m + ' ' + placesIdx[placesIdx.length - 1].t));
      }
      console.log(`Places index: ${placesIdx.length} locais`);
    } catch (e) {
      console.warn('Places index em falta:', (e as Error).message?.slice(0, 100));
    }
  }
  loadPlaces();

  // Pesquisa de destinos LadiesGo — sem auth (como zone/route)
  httpAdapter.get('/api/places/search', (req: any, res: any) => {
    try {
      const q = norm(String(req.query?.q || '').slice(0, 60));
      if (q.length < 2) {
        res.json({ places: [] });
        return;
      }
      // Todas as palavras, em qualquer ordem ("kilamba bloco" acha
      // "Escola Bloco D" no Kilamba). Palavras de 1 letra são ignoradas.
      const toks = q.split(/\s+/).filter((t) => t.length >= 2);
      if (!toks.length) {
        res.json({ places: [] });
        return;
      }
      const lat = Number(req.query?.lat);
      const lng = Number(req.query?.lng);
      const hasLoc = Number.isFinite(lat) && Number.isFinite(lng);
      const out: any[] = [];
      for (let i = 0; i < placesIdx.length && out.length < 300; i++) {
        const name = placesNorm[i];
        const full = placesFull[i];
        if (full.startsWith(q)) {
          // 0: frase exata no início
        } else {
          const words = full.split(/[\s,\-]+/);
          let ok = true;
          for (const t of toks) {
            if (!full.includes(t)) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
        }
        const startsFull = full.startsWith(q) ? 0 : 1;
        let dist = 0;
        if (hasLoc) {
          const dLa = placesIdx[i].lat - lat;
          const dLo = placesIdx[i].lng - lng;
          dist = Math.sqrt(dLa * dLa + dLo * dLo);
        }
        out.push({ i, score: startsFull, dist });
      }
      out.sort((a, b) => a.score - b.score || a.dist - b.dist);
      // Anti-duplicados: mesmo nome a <200m conta como um (entradas/saídas).
      const picked: number[] = [];
      for (const c of out) {
        if (picked.length >= 8) break;
        const p = placesIdx[c.i];
        const dupe = picked.some((j) => {
          const k = placesIdx[j];
          return (
            placesNorm[j] === placesNorm[c.i] &&
            Math.abs(k.lat - p.lat) < 0.002 &&
            Math.abs(k.lng - p.lng) < 0.002
          );
        });
        if (dupe) continue;
        picked.push(c.i);
      }
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.json({
        places: picked.map((i) => ({
          name: placesIdx[i].n,
          lat: placesIdx[i].lat,
          lng: placesIdx[i].lng,
          type: placesIdx[i].t,
          municipality: placesIdx[i].m,
        })),
      });
    } catch {
      res.status(400).json({ message: 'Pedido inválido.' });
    }
  });
  // Proxy zona por coordenadas (Nominatim + BigDataCloud fallback) — sem auth
  httpAdapter.get('/api/zone', async (req: any, res: any) => {
    try {
      const la = Number(req.query?.lat);
      const lo = Number(req.query?.lng);
      if (!Number.isFinite(la) || !Number.isFinite(lo)) {
        res.status(400).json({ message: 'Pedido inválido.' });
        return;
      }
      const ck = `z:${la.toFixed(3)},${lo.toFixed(3)}`;
      const hit = cacheGet(ck);
      if (hit) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.json(hit);
        return;
      }
      let z = '';
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${la}&lon=${lo}&format=json&zoom=14`,
          { headers: { 'User-Agent': 'LadiesGo/1.0' }, signal: AbortSignal.timeout(8000) },
        );
        const j: any = await r.json();
        const a = (j && j.address) || {};
        z = a.suburb || a.neighbourhood || a.quarter || a.city_district || a.town || a.city || '';
      } catch {}
      const body = { zone: z };
      cacheSet(ck, body, 24 * 3600 * 1000);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.json(body);
    } catch {
      res.status(400).json({ message: 'Pedido inválido.' });
    }
  });

  // Proxy rota real pelas ruas (OSRM) — sem auth
  httpAdapter.get('/api/route', async (req: any, res: any) => {
    try {
      const from = String(req.query?.from || '').split(',').map(Number);
      const to = String(req.query?.to || '').split(',').map(Number);
      if (from.length !== 2 || to.length !== 2 || ![...from, ...to].every(Number.isFinite)) {
        res.status(400).json({ message: 'Pedido inválido.' });
        return;
      }
      const ck = `r:${from[0].toFixed(4)},${from[1].toFixed(4)}:${to[0].toFixed(4)},${to[1].toFixed(4)}`;
      const hit = cacheGet(ck);
      if (hit) {
        res.setHeader('Cache-Control', 'public, max-age=600');
        res.json(hit);
        return;
      }
      const q = `${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`;
      const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${q}`, {
        signal: AbortSignal.timeout(9000),
      });
      const j: any = await r.json();
      const g = j?.routes?.[0]?.geometry?.coordinates;
      if (!g?.length) {
        res.status(502).json({ message: 'Sem rota de momento.' });
        return;
      }
      const body = {
        points: g.map((p: number[]) => [p[1], p[0]]),
        distance_m: j.routes[0].distance,
        duration_s: j.routes[0].duration,
      };
      cacheSet(ck, body, 10 * 60 * 1000);
      res.setHeader('Cache-Control', 'public, max-age=600');
      res.json(body);
    } catch {
      res.status(502).json({ message: 'Sem rota de momento.' });
    }
  });

  // Frontend LadiesGo! (antes do prefixo global para não cair em /api/v1)
  httpAdapter.get('/app', (_req: any, res: any) => sendWeb(res, 'ladiesgo-login.html'));
  httpAdapter.get('/home', (_req: any, res: any) => sendWeb(res, 'ladiesgo-home.html'));
  httpAdapter.get('/t', (_req: any, res: any) => sendWeb(res, 'track.html')); // acompanhamento público (sem login)
  httpAdapter.get('/logo.jpg', (_req: any, res: any) => {
    try {
      const f = resolveWebFile('logo.jpg');
      if (!f) { res.status(404).send(''); return; }
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(f).pipe(res);
    } catch { res.status(404).send(''); }
  });
  httpAdapter.get('/admin', (_req: any, res: any) => sendWeb(res, 'admin.html'));
  httpAdapter.get('/historia', (_req: any, res: any) => sendWeb(res, 'ladiesgo.html'));
  httpAdapter.get('/privacidade', (_req: any, res: any) => sendWeb(res, 'privacidade.html'));
  httpAdapter.get('/luanda-map', (_req: any, res: any) => sendWeb(res, 'luanda-map.html')); // extrator Overpass (captar Luanda)

  // Info da API (JSON) em /api — landing / passa a servir o LadiesGo!
  httpAdapter.get('/api', (_req: any, res: any) => {
    res.json({
      name: 'LadiesGo! API',
      version: 'v1',
      status: 'online',
      description: 'Táxi para mulheres 🇦🇴',
      base_url: '/api/v1',
      endpoints: {
        auth: '/api/v1/auth/login',
        drivers: '/api/v1/drivers/nearby',
        trips: '/api/v1/trips/estimate',
        health: '/api/v1/health',
        zone: '/api/zone?lat=-8.839&lng=13.289',
        route: '/api/route?from=-8.839,13.289&to=-8.813,13.288',
      },
    });
  });

  // Landing LadiesGo! na raiz (single-service)
  httpAdapter.get('/', (_req: any, res: any) => sendWeb(res, 'ladiesgo.html'));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.setGlobalPrefix('api/v1');

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`LadiesGo single-service running on port ${port}`);

  if (keepAlive.enabled && keepAlive.target) {
    const target = `${keepAlive.target}/ping`;
    const tick = async () => {
      try {
        const r = await fetch(target, { signal: AbortSignal.timeout(20000) });
        keepAlive.pings++;
        keepAlive.lastStatus = r.status;
      } catch (e: any) {
        keepAlive.failures++;
        keepAlive.lastStatus = String(e?.message || e);
      }
      keepAlive.lastPing = new Date().toISOString();
    };
    // Primeiro ping aos 30s (deixa o boot assentar), depois no intervalo
    setTimeout(() => {
      tick();
      setInterval(tick, keepAlive.intervalMs);
    }, 30 * 1000);
    console.log(`Keep-alive interno ligado: ${target} a cada ${keepAlive.intervalMs / 60000} min`);
  } else {
    console.log('Keep-alive interno desligado (sem KEEP_ALIVE_URL).');
  }
}
bootstrap();
