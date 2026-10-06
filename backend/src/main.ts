import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import * as path from 'path';
import * as fs from 'fs';

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

  // Behind Railway's proxy, X-Forwarded-For is "<real client>, <edge>" and the
  // edge IP ROTATES every request. `trust proxy: 1` keyed the rate limiter on
  // that rotating edge (so it never accumulated); `true` makes req.ip the
  // leftmost/real client, which is stable per user.
  app.getHttpAdapter().getInstance().set('trust proxy', true);

  app.enableCors({ origin: '*' });

  // Single-service Render free: API + Web LadiesGo! no mesmo processo/porta.
  const httpAdapter = app.getHttpAdapter();

  // Keep-alive leve — sem BD, sem log pesado (UptimeRobot / GitHub Actions)
  httpAdapter.get('/ping', (_req: any, res: any) => {
    res.json({ ok: true, ts: Date.now() });
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
      res.setHeader('Cache-Control', 'no-store');
      res.json({ zone: z });
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
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        points: g.map((p: number[]) => [p[1], p[0]]),
        distance_m: j.routes[0].distance,
        duration_s: j.routes[0].duration,
      });
    } catch {
      res.status(502).json({ message: 'Sem rota de momento.' });
    }
  });

  // Frontend LadiesGo! (antes do prefixo global para não cair em /api/v1)
  httpAdapter.get('/app', (_req: any, res: any) => sendWeb(res, 'ladiesgo-login.html'));
  httpAdapter.get('/home', (_req: any, res: any) => sendWeb(res, 'ladiesgo-home.html'));
  httpAdapter.get('/demo', (_req: any, res: any) => sendWeb(res, 'ladiesgo-app.html'));
  httpAdapter.get('/admin', (_req: any, res: any) => sendWeb(res, 'admin.html'));
  httpAdapter.get('/historia', (_req: any, res: any) => sendWeb(res, 'ladiesgo.html'));

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
}
bootstrap();
