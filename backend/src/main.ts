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
  let placesName: string[] = [];
  let placesAlias: string[] = [];
  const TYPE_PRIO: Record<string, number> = { poi: 5, centrality: 4, centralidade: 4, neighborhood: 3, bairro: 3, municipality: 2, province: 1 };
  const typePrio = (t: string) => TYPE_PRIO[t] ?? 3;
  const norm = (s: string) =>
    (s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  // Fonética de bolso (PT-Angola), aplicada aos dois lados (índice e
  // consulta): "Quilamba"→Kilamba, "pharmacia"→farmácia, "Muchima"→Muxima,
  // "Marjinal"→Marginal, "Sango"→Zango. Só funde o que se escreve mal.
  const fold = (s: string) => {
    const r = norm(s)
      .replace(/ph/g, 'f')
      .replace(/ch/g, 'x')
      .replace(/qu/g, 'k')
      .replace(/lh/g, 'l')
      .replace(/nh/g, 'n')
      .replace(/\u00e7/g, 's')
      .replace(/ss/g, 's')
      .replace(/c/g, 'k')
      .replace(/z/g, 's')
      .replace(/g(?=e|i)/g, 'j')
      .replace(/h/g, '')
      .replace(/y/g, 'i')
      .replace(/w/g, 'u');
    // Colapsar dobradas ("Barra"→"bara") mas nunca em siglas ("kk", "bo").
    return r.length > 2 ? r.replace(/([a-z])\1+/g, '$1') : r;
  };
  // Nomes genéricos do OSM que não são destinos ("parking", "grass",
  // "Lote 3", "tvc"): o pino caía neles por estarem perto. Códigos de
  // prédio (V10, K21, F1) são moradas reais no Kilamba e ficam.
  const GENERIC_NAMES = new Set(['parking', 'grass', 'service', 'lote', 'tvc', 'yes', 'construction', 'site', 'local', 'ponto', 'toilets', 'toilet', 'atm'].map(fold));
  // Troços de estrada (mesma rua repetida em vários pontos): continuam
  // pesquisáveis mas perdem para destinos com nome (lojas, escolas…).
  const ROAD_TYPES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'track', 'path', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
  // Consultas de zona ("kilamba", "samba", …): estes tokens pedem a zona.
  const AREA_CENTROIDS: Record<string, { lat: number; lng: number }> = {};
  const AREA_KEYS = ['kilamba', 'zango', 'sequele', 'centralidade', 'centralidades', 'samba', 'viana', 'maianga', 'ingombota', 'benfica', 'kinaxixi'].map(fold);
  const T_RES = ['residential', 'apartments', 'apartment'].map(fold);
  const T_HOSP = ['hospital', 'clinic', 'doctors', 'dentist'].map(fold);
  const T_ESC = ['school', 'university', 'college', 'kindergarten'].map(fold);
  const T_BANK = ['bank', 'atm'].map(fold);
  const T_MKT = ['marketplace', 'market'].map(fold);
  const T_HOT = ['hotel', 'hostel', 'guest_house'].map(fold);
  const T_REST = ['restaurant', 'fast_food', 'cafe', 'bar'].map(fold);
  const T_TAXI = ['taxi', 'bus_stop'].map(fold);
  const T_CENT = fold('centralidade');
  const T_BAIR = fold('bairro');
  const SHOP_P = fold('shop');
  // Damerau-Levenshtein com corte (padrão Meilisearch/Fuse): troca de 2
  // letras seguidas ("kialmba"→"kilamba") conta como 1 erro, não 2.
  // lim=2 só no 2.º passe (poucos resultados), em palavras de 6+ letras.
  function levLim(a: string, b: string, lim: number): number {
    if (a === b) return 0;
    const la = a.length;
    const lb = b.length;
    if (Math.abs(la - lb) > lim) return lim + 1;
    let q = 0;
    while (q < la && q < lb && a[q] === b[q]) q++;
    if (q === la && q === lb) return 0;
    if (la === lb && q < la - 1 && a[q + 1] === b[q] && a[q] === b[q + 1] && a.slice(q + 2) === b.slice(q + 2)) return 1;
    if (lim <= 1) {
      if (la === lb && a.slice(q + 1) === b.slice(q + 1)) return 1;
      if (la + 1 === lb && a.slice(q) === b.slice(q + 1)) return 1;
      if (lb + 1 === la && a.slice(q + 1) === b.slice(q)) return 1;
      return 2;
    }
    let prev: number[] = [];
    for (let j = 0; j <= lb; j++) prev.push(j);
    for (let i = 1; i <= la; i++) {
      const cur: number[] = [i];
      let rowMin = i;
      for (let j = 1; j <= lb; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        cur.push(v);
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > lim) return lim + 1;
      prev = cur;
    }
    return prev[lb] <= lim ? prev[lb] : lim + 1;
  }
  // Intenções por categoria: "condominio" acha residenciais mesmo sem a
  // palavra no nome; "centralidade" acha Zango/Kilamba/Sequele; etc.
  // (chaves e literais já dobrados para a fonética; n chega dobrado).
  const INTENTS: { keys: string[]; test: (e: PlaceEntry, n: string) => boolean }[] = [
    { keys: ['condominio', 'condominios'].map(fold), test: (e, n) => n.includes(fold('condom')) || n.includes(fold('residencial')) || T_RES.includes(fold(e.t)) },
    { keys: ['centralidade', 'centralidades'].map(fold), test: (e, n) => fold(e.t) === T_CENT || n.includes(fold('centralidade')) || n.includes(fold('zango')) || n.includes(fold('sequele')) || n.includes(fold('kilamba')) },
    { keys: ['urbanizacao', 'urbanizacoes', 'urbanizao'].map(fold), test: (e, n) => n.includes(fold('urbaniz')) || fold(e.t) === T_CENT },
    { keys: ['farmacia', 'farmacias'].map(fold), test: (e, n) => fold(e.t) === fold('pharmacy') || n.includes(fold('farmacia')) },
    { keys: ['hospital', 'hospitais', 'clinica', 'hospitalar'].map(fold), test: (e, n) => T_HOSP.includes(fold(e.t)) || n.includes(fold('hospital')) || n.includes(fold('clinic')) },
    { keys: ['escola', 'escolas', 'colegio', 'universidade'].map(fold), test: (e, n) => T_ESC.includes(fold(e.t)) || n.includes(fold('escola')) || n.includes(fold('universidade')) },
    { keys: ['banco', 'bancos', 'multicaixa', 'atm'].map(fold), test: (e, n) => T_BANK.includes(fold(e.t)) || n.includes(fold('banco')) },
    { keys: ['mercado', 'mercados', 'feira', 'praca'].map(fold), test: (e, n) => T_MKT.includes(fold(e.t)) || fold(e.t).startsWith(SHOP_P) || n.includes(fold('mercado')) },
    { keys: ['igreja', 'igrejas', 'culto'].map(fold), test: (e, n) => fold(e.t) === fold('place_of_worship') || n.includes(fold('igreja')) },
    { keys: ['hotel', 'hoteis', 'hospedagem'].map(fold), test: (e, n) => T_HOT.includes(fold(e.t)) || n.includes(fold('hotel')) },
    { keys: ['restaurante', 'restaurantes', 'comer'].map(fold), test: (e, n) => T_REST.includes(fold(e.t)) || n.includes(fold('restaurante')) },
    { keys: ['bomba', 'bombas', 'combustivel', 'gasolina'].map(fold), test: (e) => fold(e.t) === fold('fuel') },
    { keys: ['aeroporto'].map(fold), test: (e, n) => fold(e.t) === fold('airport') || n.includes(fold('aeroporto')) },
    { keys: ['paragem', 'paragens', 'taxi', 'candongueiro'], test: (e, n) => ['taxi', 'bus_stop'].includes(e.t) },
  ];
  function intentHit(t: string, e: PlaceEntry, n: string): boolean {
    for (const it of INTENTS) {
      if (it.keys.includes(t)) return it.test(e, n);
    }
    return false;
  }
  function loadPlaces() {
    try {
      const f = resolveWebFile('ladiesgo-luanda-final.json');
      if (!f) return;
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      const arr = raw.places || raw.d || [];
      placesIdx = [];
      placesNorm = [];
      placesFull = [];
      placesName = [];
      placesAlias = [];
      let skipped = 0;
      for (const p of arr) {
        const lat = Array.isArray(p) ? p[1] : p.lat;
        const lng = Array.isArray(p) ? p[2] : p.lng;
        const name = Array.isArray(p) ? p[0] : p.name;
        if (typeof name !== 'string' || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const nn = fold(name);
        const nnWords = nn.split(/[\s,\-]+/).filter((w) => w.length > 1);
        const nType = String(Array.isArray(p) ? p[5] || '' : p.type || '');
        // Linhas elétricas/ferroviárias ("Cazenga - Viana") nunca são destino.
        if (nType === 'line') { skipped++; continue; }
        // Refs de torres/postes ("Benfica T196W", "1H2700m"): lixo do OSM.
        // Códigos de prédio (V10, K21) não casam (letra+dígitos sem letra a fechar).
        if (/[a-z]\d{3,}[a-z]/.test(nn)) { skipped++; continue; }
        if (!nn || nn.length < 2 || GENERIC_NAMES.has(nn) || /^lote\s*\d*$/.test(nn) || (nnWords.length > 0 && nnWords.every((w) => GENERIC_NAMES.has(w)))) { skipped++; continue; }
        placesIdx.push({
          n: name,
          lat,
          lng,
          t: String(Array.isArray(p) ? p[5] || '' : p.type || ''),
          m: String(Array.isArray(p) ? p[4] || '' : p.municipality || ''),
        });
        placesNorm.push(fold(name));
        placesName.push(nn);
        placesAlias.push('');
        placesFull.push(fold(name + ' ' + placesIdx[placesIdx.length - 1].m + ' ' + placesIdx[placesIdx.length - 1].t));
      }
      try {
        const af = resolveWebFile('aproveita-luanda.json');
        if (af) {
          const aj = JSON.parse(fs.readFileSync(af, 'utf8'));
          for (const q of (aj.places || [])) {
            const nm = String(q.name || '');
            const la = Number(q.lat);
            const lo = Number(q.lng);
            if (!nm || nm.length < 2 || !Number.isFinite(la) || !Number.isFinite(lo)) continue;
            const al = Array.isArray(q.aliases) ? q.aliases.filter((a: any) => typeof a === 'string' && a.trim()).slice(0, 8) : [];
            placesIdx.push({ n: nm, lat: la, lng: lo, t: String(q.type || 'poi'), m: String(q.municipality || '') });
            placesNorm.push(fold(nm));
            placesName.push(fold(nm));
            placesFull.push(fold(nm + ' ' + (q.municipality || '') + ' ' + (q.province || '')));
            placesAlias.push(al.map((a: string) => fold(a)).join(' '));
          }
        }
      } catch (e) {
        console.warn('Aproveita index em falta:', (e as Error).message?.slice(0, 100));
      }
      // Centralidades e bairros em falta no OSM: cria o pino no centroide
      // dos locais com esse nome — sempre pesquisáveis ("Samba" deve dar
      // a Samba, não uma torre elétrica "Benfica T196W").
      const AREA_SEEDS = [
        { key: fold('kilamba'), name: 'Município do Kilamba', municipality: 'Belas', type: 'centralidade' },
        { key: fold('zango'), name: 'Centralidade do Zango', municipality: 'Viana', type: 'centralidade' },
        { key: fold('sequele'), name: 'Centralidade do Sequele', municipality: 'Cacuaco', type: 'centralidade' },
        { key: fold('samba'), name: 'Samba', municipality: 'Samba', type: 'bairro' },
        { key: fold('viana'), name: 'Viana', municipality: 'Viana', type: 'bairro' },
        { key: fold('maianga'), name: 'Maianga', municipality: 'Maianga', type: 'bairro' },
        { key: fold('ingombota'), name: 'Ingombota', municipality: 'Ingombota', type: 'bairro' },
        { key: fold('benfica'), name: 'Benfica', municipality: 'Talatona', type: 'bairro' },
        { key: fold('kinaxixi'), name: 'Kinaxixi', municipality: 'Ingombota', type: 'bairro' },
      ];
      for (const a of AREA_SEEDS) {
        let sx = 0, sy = 0, c = 0;
        for (let i = 0; i < placesIdx.length; i++) {
          const words = placesNorm[i].split(/[\s,\-]+/);
          if (words.some((w) => w === a.key || (w.length > 6 && w.startsWith(a.key)))) { sx += placesIdx[i].lat; sy += placesIdx[i].lng; c++; }
        }
        if (c >= 1) {
          // No INÍCIO: o varrimento para aos 300 e as sementes têm de
          // ser vistas primeiro (a bonus de -1 só conta se chegar lá).
          placesIdx.unshift({ n: a.name, lat: sx / c, lng: sy / c, t: a.type, m: a.municipality });
          placesNorm.unshift(fold(a.name));
          placesName.unshift(fold(a.name));
          placesAlias.unshift('');
          placesFull.unshift(fold(a.name + ' ' + a.municipality + ' ' + a.type));
          AREA_CENTROIDS[a.key] = { lat: sx / c, lng: sy / c };
          console.log(`Places seed: ${a.name} (${c} base) -> ${((sx / c) as number).toFixed(4)}, ${((sy / c) as number).toFixed(4)}`);
        }
      }
      console.log(`Places index: ${placesIdx.length} locais (${skipped} genéricos ignorados)`);
    } catch (e) {
      console.warn('Places index em falta:', (e as Error).message?.slice(0, 100));
    }
  }
  loadPlaces();

  // Pesquisa de destinos LadiesGo — sem auth (como zone/route)
  httpAdapter.get('/api/places/search', async (req: any, res: any) => {
    try {
      const qRaw = String(req.query?.q || '').slice(0, 60);
      const q = fold(qRaw);
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
      const matchTokens = (tt: string[], maxLev = 1) => {
        const out: any[] = [];
        for (let i = 0; i < placesIdx.length; i++) {
          const full = placesFull[i];
          let startsFuzzy = false;
          const phrase = tt.join(' ');
          const phraseExact = full === phrase || (full.startsWith(phrase) && !/[a-z0-9]/.test(full[phrase.length] || ' '));
          if (phraseExact) {
            // 0: frase exata no início ("kilamba" já não casa "kilambar")
          } else {
            const words = full.split(/[\s,\-]+/);
            let ok = true;
            let fuzzy = false;
          for (const t of tt) {
            if (full.includes(t) || (placesAlias[i] && placesAlias[i].includes(t))) continue;
            // Intenção por categoria ("condominio"→residenciais, etc.)
            // Testa no nome+município+tipo para apanhar "Zango"/"Kilamba".
            if (intentHit(t, placesIdx[i], full)) {
              fuzzy = true;
              continue;
            }
              // Tolerância a erros (1 em 4+ letras; 2 em 6+ no 2.º passe)
              if (
                t.length >= (maxLev > 1 ? 6 : 4) &&
                words.some((w) => w.length >= (maxLev > 1 ? 6 : 4) && levLim(t, w, maxLev) <= maxLev)
              ) {
                fuzzy = true;
                continue;
              }
              ok = false;
              break;
            }
            if (!ok) continue;
            if (fuzzy) startsFuzzy = true;
          }
          // Nome a sério primeiro: quem só bate no município/tipo
          // ("Rua de Almeida" via Maianga) e troços de estrada perdem
          // para o destino com o nome exato, mesmo estando mais perto.
          let score = phraseExact ? 0 : startsFuzzy ? 2 : 1;
          const nameNorm = placesName[i] || '';
          const nameWords = nameNorm.split(/[\s,\-]+/);
          let nameHit = true;
          for (const t of tt) {
            if (nameNorm.includes(t) || (placesAlias[i] && placesAlias[i].includes(t))) continue;
            if (t.length >= (maxLev > 1 ? 6 : 4) && nameWords.some((w) => w.length >= (maxLev > 1 ? 6 : 4) && levLim(t, w, maxLev) <= maxLev)) continue;
            if (intentHit(t, placesIdx[i], nameNorm)) continue;
            nameHit = false;
            break;
          }
          if (!nameHit) score += 1;
          if (ROAD_TYPES.has(placesIdx[i].t)) score += 1;
          // "kilamba"/"samba"/… querem a zona, não um bar com nome parecido:
          // centralidades e bairros-âncora sobem para primeiro.
          const areaTok = tt.find((t) => AREA_KEYS.includes(t) && t !== fold('centralidade') && t !== fold('centralidades'))
            || tt.find((t) => AREA_KEYS.includes(t));
          const isAnchor = fold(placesIdx[i].t) === T_CENT || fold(placesIdx[i].t) === T_BAIR;
          // "kilamba ..." sem "kiaxi": Kilamba nao e Kilamba Kiaxi —
          // fora tudo do municipio rival (a zona pedida fica).
          const wantsKiaxi = tt.some((t) => t === 'kiaxi' || t === 'kiaxe');
          const isKiaxi = placesIdx[i].m === 'Kilamba Kiaxi'
            || (placesName[i] || '').split(/[\s,\-]+/).some((w) => w === 'kiaxi' || w === 'kiaxe');
          // ... excepto nome forte: comeca pelo pedido ("Kilamba x34" fica).
          const nmStrong = placesName[i] || '';
          const strongName = tt.some((t) => nmStrong === t || nmStrong.startsWith(t + ' ') || nmStrong.startsWith(t + ','));
          if (areaTok === 'kilamba' && !isAnchor && !wantsKiaxi && isKiaxi && !strongName) continue;
          if ((fold(placesIdx[i].t) === T_CENT || fold(placesIdx[i].t) === T_BAIR) && areaTok) score = (areaTok === fold('centralidade') || areaTok === fold('centralidades')) ? Math.max(0, score - 1) : score - 2;
          // "kilamba bloco" = blocos DENTRO do Kilamba: fora do raio da
          // zona (12 km), o que só bate via município/tipo cai fora.
          // Âncoras (centralidade/bairro) estão sempre dentro.
          if (areaTok && fold(placesIdx[i].t) !== T_CENT && fold(placesIdx[i].t) !== T_BAIR) {
            const ac = AREA_CENTROIDS[areaTok];
            if (ac) {
              const gLa = placesIdx[i].lat - ac.lat;
              const gLo = placesIdx[i].lng - ac.lng;
              if (Math.sqrt(gLa * gLa + gLo * gLo) * 111 > 12) continue;
            }
          }
          let dist = 0;
          if (hasLoc) {
            const dLa = placesIdx[i].lat - lat;
            const dLo = placesIdx[i].lng - lng;
            dist = Math.sqrt(dLa * dLa + dLo * dLo);
          }
          out.push({ i, score, dist });
        }
        return out;
      };
      let out = matchTokens(toks);
      let relaxed = false;
      // 2.º passe: quase sem resultados? tolera 2 erros (palavras 6+).
      if (out.length < 3) {
        const r2 = matchTokens(toks, 2);
        if (r2.length > out.length) { out = r2; relaxed = true; }
      }
      // Fallback: se nada bate ("bloco a23 kilamba"), larga a palavra mais
      // restritiva (primeiro as com dígitos) e tenta de novo.
      if (!out.length && toks.length > 1) {
        const order = toks
          .map((t, idx) => ({ t, idx }))
          .sort((a, b) => {
            const w = (t: string) => (/\d/.test(t) ? 0 : AREA_KEYS.includes(t) ? 2 : 1);
            return w(a.t) - w(b.t) || b.t.length - a.t.length;
          });
        for (const drop of order) {
          const rest = toks.filter((_, idx) => idx !== drop.idx);
          const retry = matchTokens(rest);
          if (retry.length) {
            out = retry;
            relaxed = true;
            break;
          }
        }
      }
      out.sort((a, b) => a.score - b.score || typePrio(placesIdx[b.i].t) - typePrio(placesIdx[a.i].t) || a.dist - b.dist);
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
      const distKm = (la: number, lo: number) =>
        hasLoc && Number.isFinite(lat) && Number.isFinite(lng)
          ? Math.round(Math.sqrt((la - lat) ** 2 + (lo - lng) ** 2) * 111 * 10) / 10
          : null;
      const places = picked.map((i) => ({
        name: placesIdx[i].n,
        lat: placesIdx[i].lat,
        lng: placesIdx[i].lng,
        type: placesIdx[i].t,
        municipality: placesIdx[i].m,
        distanceKm: distKm(placesIdx[i].lat, placesIdx[i].lng),
      }));
      // Fallback Geoapify (logica Aproveita-Ja): pouco resultado local +
      // chave configurada -> completa com enderecos globais (so Angola).
      // Com cache de 1h para respeitar a quota gratuita.
      if (places.length < 3 && process.env.GEOAPIFY_API_KEY) {
        try {
          const gk = `geo:${q}`;
          let gj: any = cacheGet(gk);
          if (!gj) {
            const ctl = new AbortController();
            const to = setTimeout(() => ctl.abort(), 6000);
            const gr = await fetch(
              `https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(qRaw)}&filter=countrycode:ao&limit=5&apiKey=${process.env.GEOAPIFY_API_KEY}`,
              { signal: ctl.signal },
            );
            clearTimeout(to);
            gj = await gr.json();
            cacheSet(gk, gj, 3600 * 1000);
          }
          const seen = new Set(places.map((x: any) => norm(x.name)));
          for (const f of (gj.features || []).slice(0, 5)) {
            const pr = f.properties || {};
            const nm = String(pr.name || pr.address_line1 || '').slice(0, 80);
            const glat = f.geometry?.coordinates?.[1];
            const glng = f.geometry?.coordinates?.[0];
            if (!nm || !Number.isFinite(glat) || !Number.isFinite(glng) || seen.has(norm(nm))) continue;
            seen.add(norm(nm));
            places.push({ name: nm, lat: glat, lng: glng, type: 'geo', municipality: String(pr.city || pr.municipality || pr.state || ''), distanceKm: distKm(glat, glng) });
          }
        } catch {}
      }
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.json({ relaxed, places });
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
  // Imagens da marca usadas pelas páginas (nomes versionados furam cache).
  for (const img of ['logo-v2.jpg', 'splash.jpg']) {
    httpAdapter.get('/' + img, (_req: any, res: any) => {
      try {
        const f = resolveWebFile(img);
        if (!f) { res.status(404).send(''); return; }
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        fs.createReadStream(f).pipe(res);
      } catch { res.status(404).send(''); }
    });
  }
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
