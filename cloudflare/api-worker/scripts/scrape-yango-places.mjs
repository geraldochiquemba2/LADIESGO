#!/usr/bin/env node
/**
 * Recolhe locais de Luanda a partir do autocompletar público do site da Yango
 * (yango.com/pt_int/order) — endpoint 4.0/persuggest/v1/suggest.
 *
 * Uso:
 *   node scripts/scrape-yango-places.mjs --out=./yango-luanda
 *   node scripts/scrape-yango-places.mjs --estimate            (só conta pedidos)
 *   node scripts/scrape-yango-places.mjs --step=0.03 --rps=2 --resume
 *
 * Saída: <out>.json (lista), <out>.jsonl (append-safe), <out>.csv,
 *        <out>.sql (INSERTs para a tabela places) e <out>.state.json.
 *
 * Limites do serviço: cada resposta devolve no máximo 7 resultados, ordenados
 * por distância ao ponto enviado. Por isso a cobertura vem de duas coisas:
 * uma grelha de pontos sobre o município e prefixos de pesquisa diferentes
 * em cada ponto. Sem `--deep` não há recursão — é uma passagem única.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const MOBCF = 'default%25turboapp_yango_web_default_3%25default';
const ORIGIN = 'https://yango.com';
const API = 'https://ya-authproxy.yango.com';

// Área metropolitana de Luanda (lat/lng). Fora disto é descartado.
const BBOX = { latMin: -9.06, latMax: -8.74, lngMin: 13.04, lngMax: 13.42 };
const SATURATED = 7; // resposta cheia = vale a pena aprofundar (só com --deep)

function parseArgs(argv) {
  const o = {
    out: './yango-luanda',
    step: 0.04,
    rps: 2.5,
    maxReq: 4000,
    deep: false,
    minStep: 0.01,
    resume: false,
    estimate: false,
    expand: false,
    expandMin: 3,
    expandMax: 6000,
    round: 1,
    alphabet: 'abcdefghijklmnopqrstuvwxyz0123456789',
    accents: false,
    bbox: BBOX
  };
  for (const a of argv.slice(2)) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'out') o.out = v;
    else if (k === 'step') o.step = Number(v);
    else if (k === 'rps') o.rps = Number(v);
    else if (k === 'maxReq') o.maxReq = Number(v);
    else if (k === 'minStep') o.minStep = Number(v);
    else if (k === 'alphabet') o.alphabet = v;
    else if (k === 'deep') o.deep = true;
    else if (k === 'accents') o.accents = true;
    else if (k === 'resume') o.resume = true;
    else if (k === 'expand') o.expand = true;
    else if (k === 'round') o.round = Number(v);
    else if (k === 'expandMin') o.expandMin = Number(v);
    else if (k === 'expandMax') o.expandMax = Number(v);
    else if (k === 'estimate') o.estimate = true;
    else if (k === 'help') { console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 26).join('\n')); process.exit(0); }
  }
  if (o.accents) o.alphabet += 'áàâãçéêíóôõú';
  if (!(o.step > 0)) throw new Error('--step inválido');
  if (!(o.rps > 0)) throw new Error('--rps inválido');
  return o;
}

const args = parseArgs(process.argv);
const outBase = resolve(args.out);
mkdirSync(dirname(outBase), { recursive: true });
const paths = {
  jsonl: outBase + '.jsonl',
  json: outBase + '.json',
  csv: outBase + '.csv',
  sql: outBase + '.sql',
  state: outBase + '.state.json'
};

// ---------- sessão ----------
const jar = new Map();
function saveCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const baseHeaders = { 'user-agent': UA, 'accept-language': 'pt', referer: ORIGIN + '/', origin: ORIGIN };

let session = null;

async function openSession() {
  jar.clear();
  let r = await fetch(ORIGIN + '/pt_int/order/?from=order_AO', { headers: baseHeaders });
  saveCookies(r);
  r = await fetch(`${API}/csrf_token?mobcf=${MOBCF}`, {
    method: 'POST',
    headers: { ...baseHeaders, 'content-type': 'application/json', cookie: cookieHeader() },
    body: '{}'
  });
  saveCookies(r);
  const sk = (await r.json().catch(() => ({}))).sk;
  if (!sk) throw new Error('sem csrf token (o serviço mudou?)');
  r = await fetch(`${API}/3.0/launch?mobcf=${MOBCF}`, {
    method: 'POST',
    headers: {
      ...baseHeaders,
      'content-type': 'application/json',
      cookie: cookieHeader(),
      'x-csrf-token': sk,
      'x-taxi': UA + ' turboapp_taxi brand_yango'
    },
    body: '{}'
  });
  saveCookies(r);
  const uid = (await r.json().catch(() => ({}))).id;
  if (!uid) throw new Error('sem user id no launch (o serviço mudou?)');
  session = { sk, uid };
  return session;
}

// ---------- pedidos ----------
let requests = 0;
const t0 = Date.now();

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function suggest(part, lat, lng, tries = 3) {
  if (requests >= args.maxReq) return null;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (!session) await openSession();
    requests++;
    let res;
    try {
      res = await fetch(`${API}/4.0/persuggest/v1/suggest?mobcf=${MOBCF}`, {
        method: 'POST',
        headers: {
          ...baseHeaders,
          'content-type': 'application/json',
          cookie: cookieHeader(),
          'x-csrf-token': session.sk,
          'x-taxi': UA + ' turboapp_taxi brand_yango',
          'x-yataxi-userid': session.uid,
          'x-request-id': crypto.randomUUID()
        },
        body: JSON.stringify({
          part,
          type: 'b',
          client_id: 'turboapp-taxi',
          state: { accuracy: 0, location: [lng, lat] },
          action: 'user_input',
          suggest_serpid: crypto.randomUUID(),
          client_reqid: Date.now() + '_' + crypto.randomUUID()
        })
      });
    } catch (e) {
      await sleep(800 * (attempt + 1));
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      session = null; // sessão caiu: reabre e tenta outra vez
      await sleep(500);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(1500 * (attempt + 1) * (attempt + 1));
      continue;
    }
    if (!res.ok) return [];
    const j = await res.json().catch(() => ({}));
    return Array.isArray(j.results) ? j.results : [];
  }
  return [];
}

// ---------- normalização ----------
const fold = s => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

const inBox = (lat, lng, b) => lat >= b.latMin && lat <= b.latMax && lng >= b.lngMin && lng <= b.lngMax;

function placeOf(r, query, at) {
  const p = r.position;
  if (!Array.isArray(p) || p.length < 2) return null;
  const lng = Number(p[0]), lat = Number(p[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (!inBox(lat, lng, args.bbox)) return null;
  const name = (r.title && r.title.text) || (r.text || '').trim();
  if (!name) return null;
  const sub = (r.subtitle && r.subtitle.text) || '';
  const raw = (() => { try { return JSON.parse(r.log || '{}'); } catch { return {}; } })();
  const full = (raw.where && raw.where.name) || '';
  const blob = `${sub} ${full}`;
  const clean = s => s.replace(/\s+/g, ' ').replace(/^(?:de|do|da|dos|das)\s+/i, '')
    .replace(/[,\s]+(?:Angola|AO)$/i, '').trim();
  const province = clean((/Prov[íi]ncia\s+([^,·]+)/i.exec(blob) || [])[1] || '') || null;
  const municipality = clean((/Munic[íi]pio\s+([^,·]+)/i.exec(blob) || [])[1] || '') || null;
  return {
    name: name.replace(/\s+/g, ' ').trim(),
    nname: fold(name),
    norm: fold(`${name} ${sub} ${full}`),
    lat: +lat.toFixed(6),
    lng: +lng.toFixed(6),
    type: r.type === 'organization' ? 'organization' : 'address',
    tags: Array.isArray(r.tags) ? r.tags : [],
    subtitle: sub.replace(/\s+/g, ' ').trim(),
    municipality,
    province,
    street: null,
    number: null,
    uri: r.uri || null,
    foundBy: { q: query, at: [at[0], at[1]] }
  };
}

const keyOf = p => p.uri || `${p.nname}|${p.lat.toFixed(5)}|${p.lng.toFixed(5)}`;

// ---------- plano ----------
const { latMin, latMax, lngMin, lngMax } = args.bbox;
const nLat = Math.max(1, Math.round((latMax - latMin) / args.step));
const nLng = Math.max(1, Math.round((lngMax - lngMin) / args.step));
const cells = [];
for (let i = 0; i < nLat; i++) {
  for (let j = 0; j < nLng; j++) {
    cells.push([+(latMin + (i + 0.5) * args.step).toFixed(5), +(lngMin + (j + 0.5) * args.step).toFixed(5)]);
  }
}
const prefixes = ['', ...args.alphabet.split('')];
const baseJobs = cells.length * prefixes.length;

if (args.estimate) {
  if (args.expand) {
    const known = existsSync(paths.jsonl) ? readFileSync(paths.jsonl, 'utf8').split('\n').filter(l => l.trim()).length : 0;
    const jobs = Math.min(known, args.expandMax);
    console.log(`expansão por sementes: ${known} locais conhecidos → ${jobs} pedidos (teto --expandMax=${args.expandMax})`);
    console.log(`a ${args.rps} pedidos/s ≈ ${Math.ceil(jobs / args.rps / 60)} min`);
  } else {
    console.log(`grelha ${args.step}° → ${cells.length} pontos × ${prefixes.length} pesquisas = ${baseJobs} pedidos`);
    console.log(`a ${args.rps} pedidos/s ≈ ${Math.ceil(baseJobs / args.rps / 60)} min (sem --deep)`);
  }
  console.log(`teto --maxReq=${args.maxReq}`);
  process.exit(0);
}

// ---------- estado (retoma) ----------
let state = { done: [], seen: [] };
if (args.resume && existsSync(paths.state)) {
  state = JSON.parse(readFileSync(paths.state, 'utf8'));
  console.log(`retoma: ${state.done.length} pesquisas já feitas, ${state.seen.length} locais conhecidos`);
} else if (!args.resume) {
  for (const p of [paths.jsonl, paths.state]) if (existsSync(p)) writeFileSync(p, '');
}
const doneSet = new Set(state.done);
const seen = new Set(state.seen);
const seenPlaces = [];
// ao retomar, os locais já recolhidos vivem no .jsonl (o .state só guarda chaves)
if (args.resume && existsSync(paths.jsonl)) {
  for (const line of readFileSync(paths.jsonl, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { seenPlaces.push(JSON.parse(line)); } catch {}
  }
}
let fresh = 0;
let failed = 0;
let saturatedCells = 0;

const saveState = () => writeFileSync(paths.state, JSON.stringify({ done: [...doneSet], seen: [...seen] }));

// ---------- varredura ----------
const queue = [];
if (args.expand) {
  // Passagem por sementes: cada local já conhecido é uma pesquisa própria, feita a
  // partir das suas coordenadas. É o que apanha nomes que a grelha não vê (ex. ISPTEC).
  const seeds = seenPlaces
    .filter(p => p.name && p.name.length >= args.expandMin)
    .sort((a, b) => a.nname.length - b.nname.length);
  for (const p of seeds.slice(0, args.expandMax)) queue.push({ lat: p.lat, lng: p.lng, q: p.name, depth: 1 + args.round });
} else {
  for (const [lat, lng] of cells) for (const q of prefixes) queue.push({ lat, lng, q, depth: 0 });
}

let lastSave = Date.now();
const minGap = 1000 / args.rps;
let nextSlot = Date.now();

async function run(job) {
  const key = `${job.lat.toFixed(3)},${job.lng.toFixed(3)}|${job.q}|${job.depth}`;
  if (doneSet.has(key)) return;
  const now = Date.now();
  if (now < nextSlot) await sleep(nextSlot - now);
  nextSlot = Math.max(Date.now(), nextSlot) + minGap;
  const results = await suggest(job.q, job.lat, job.lng);
  doneSet.add(key);
  if (!results) { failed++; return; }
  if (results.length >= SATURATED && job.depth === 0) saturatedCells++;
  for (const r of results) {
    const p = placeOf(r, job.q, [job.lat, job.lng]);
    if (!p) continue;
    const k = keyOf(p);
    if (seen.has(k)) continue;
    seen.add(k);
    seenPlaces.push(p);
    fresh++;
    appendFileSync(paths.jsonl, JSON.stringify(p) + '\n');
  }
  // aprofundamento opcional: resposta cheia → tenta prefixos de 2 letras nesta célula
  if (args.deep && results.length >= SATURATED && job.q.length === 1 && job.depth === 0 && args.step > args.minStep) {
    for (const c of args.alphabet) queue.push({ lat: job.lat, lng: job.lng, q: job.q + c, depth: 1 });
  }
  if (Date.now() - lastSave > 5000) { lastSave = Date.now(); saveState(); }
}

let i = 0;
const CONCURRENCY = 2;
async function worker() {
  while (i < queue.length && requests < args.maxReq) {
    const job = queue[i++];
    await run(job);
    if (i % 50 === 0) {
      const el = (Date.now() - t0) / 1000;
      process.stdout.write(`\r${i}/${queue.length} pesquisas · ${fresh} locais novos · ${(requests / el).toFixed(1)} req/s   `);
    }
  }
}

console.log(args.expand
  ? `alvo: expansão por sementes · ${queue.length} pedidos (teto ${args.maxReq})`
  : `alvo: ${cells.length} pontos × ${prefixes.length} pesquisas (${queue.length} pedidos, teto ${args.maxReq})`);
await Promise.all([worker(), worker()]);
saveState();

// ---------- relatório ----------
const all = [...seenPlaces];
const byType = all.reduce((a, p) => ((a[p.type] = (a[p.type] || 0) + 1), a), {});
const byMuni = all.reduce((a, p) => { const k = p.municipality || '(sem município)'; a[k] = (a[k] || 0) + 1; return a; }, {});
const secs = (Date.now() - t0) / 1000;

const csvEsc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
const csv = ['name,type,lat,lng,municipality,province,subtitle']
  .concat(all.map(p => [p.name, p.type, p.lat, p.lng, p.municipality, p.province, p.subtitle].map(csvEsc).join(',')))
  .join('\n');
const sqlEsc = v => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const sql = all.map(p =>
  `INSERT INTO places (name,nname,norm,lat,lng,type,municipality,province,street,"number") VALUES (${sqlEsc(p.name)},${sqlEsc(p.nname)},${sqlEsc(p.norm)},${p.lat},${p.lng},${sqlEsc(p.type)},${sqlEsc(p.municipality)},${sqlEsc(p.province)},NULL,NULL);`
).join('\n');

writeFileSync(paths.json, JSON.stringify({ generatedAt: new Date().toISOString(), bbox: args.bbox, count: all.length, places: all }, null, 1));
writeFileSync(paths.csv, csv);
writeFileSync(paths.sql, sql);

console.log(`\n\nlocais únicos: ${all.length}  (${JSON.stringify(byType)})`);
console.log(`municípios: ${JSON.stringify(byMuni, null, 0)}`);
console.log(`pedidos: ${requests} em ${secs.toFixed(0)}s (${(requests / secs).toFixed(1)}/s) · falhas: ${failed} · células saturadas: ${saturatedCells}`);
console.log(`ficheiros: ${paths.jsonl} | ${paths.json} | ${paths.csv} | ${paths.sql}`);
if (all.length) console.log(`aviso: ${all.length} INSERTs ≈ ${all.length * 5} linhas escritas na D1 (índices incluídos) — ver o teto diário de 100k`);
