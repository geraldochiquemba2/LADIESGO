#!/usr/bin/env node
/**
 * Auditoria da tabela `places` contra o autocompletar da Yango.
 *
 * Para cada POI da nossa base, pergunta à Yango pelo nome a partir das
 * coordenadas atuais e decide:
 *   ok       — mesmo nome a <= --ok (150 m)          → nada a fazer
 *   corrigir — mesmo nome a <= --max (8 km)          → UPDATE lat/lng/município
 *   sinalizar— mesmo nome mais longe                 → revisão manual
 *   ausente  — a Yango não conhece o nome            → fica como está
 *
 * Não escreve na D1. Produz:
 *   <out>.jsonl     uma linha por POI auditado (decisão + candidato)
 *   <out>.sql       UPDATEs das correções + DELETEs dos duplicados
 *   <out>.csv       relatório legível
 *   <out>.state.json  retoma
 *
 * Uso:
 *   node scripts/audit-places.mjs --places=places.json --out=./audit
 *   node scripts/audit-places.mjs --places=places.json --out=./audit --resume --rps=3
 *
 * `places.json` é o resultado de:
 *   npx wrangler d1 execute ladiesgo --remote --json \
 *     --command="SELECT id,name,lat,lng,type,municipality FROM places" > places.json
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const MOBCF = 'default%25turboapp_yango_web_default_3%25default';
const ORIGIN = 'https://yango.com';
const API = 'https://ya-authproxy.yango.com';

// Tipos de estrada do OSM: as coordenadas são o centro do troço, não há POI para validar.
const ROAD = new Set(['residential', 'tertiary', 'secondary', 'trunk', 'primary', 'unclassified',
  'service', 'footway', 'path', 'track', 'motorway', 'motorway_link', 'trunk_link', 'primary_link',
  'secondary_link', 'tertiary_link', 'living_street', 'pedestrian', 'steps', 'construction', 'cycleway',
  'road', 'bridleway', 'corridor', 'bus_stop', 'yes', 'no', 'proposed', 'raceway', 'escape', 'elevator']);

function parseArgs(argv) {
  const o = {
    places: './places.json',
    out: './audit',
    rps: 3,
    ok: 150,          // m — até aqui consideramos confirmado
    max: 8000,        // m — até aqui corrigimos automaticamente
    chain: 1000,      // m — mesmo nome em dois pontos mais distantes que isto = filial (não corrigir)
    safe: 2000,       // m — acima disto a correção exige corroboração na nossa base
    proof: 250,       // m — raio em que outro sítio nosso serve de prova
    minSim: 0.72,     // semelhança mínima do nome para aceitar o candidato
    limit: 0,         // 0 = todos
    resume: false,
    report: false,    // só regerar .sql/.csv a partir do .jsonl (sem rede)
    only: 'pois'      // pois | all
  };
  for (const a of argv.slice(2)) {
    const m = /^--([a-zA-Z]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'places') o.places = v;
    else if (k === 'out') o.out = v;
    else if (k === 'rps') o.rps = Number(v);
    else if (k === 'ok') o.ok = Number(v);
    else if (k === 'max') o.max = Number(v);
    else if (k === 'chain') o.chain = Number(v);
    else if (k === 'safe') o.safe = Number(v);
    else if (k === 'proof') o.proof = Number(v);
    else if (k === 'minSim') o.minSim = Number(v);
    else if (k === 'limit') o.limit = Number(v);
    else if (k === 'only') o.only = v;
    else if (k === 'resume') o.resume = true;
    else if (k === 'report') o.report = true;
    else if (k === 'help') {
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 30).join('\n'));
      process.exit(0);
    }
  }
  return o;
}

const args = parseArgs(process.argv);
const outBase = resolve(args.out);
mkdirSync(dirname(outBase), { recursive: true });
const paths = {
  jsonl: outBase + '.jsonl',
  sql: outBase + '.sql',
  csv: outBase + '.csv',
  state: outBase + '.state.json'
};

// ---------- sessão Yango ----------
const jar = new Map();
const saveCookies = res => {
  for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
    const [p] = c.split(';');
    const i = p.indexOf('=');
    if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
  }
};
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const baseHeaders = { 'user-agent': UA, 'accept-language': 'pt', referer: ORIGIN + '/', origin: ORIGIN };
let session = null;

async function openSession() {
  jar.clear();
  let r = await fetch(ORIGIN + '/pt_int/order/?from=order_AO', { headers: baseHeaders });
  saveCookies(r);
  r = await fetch(`${API}/csrf_token?mobcf=${MOBCF}`, {
    method: 'POST', headers: { ...baseHeaders, 'content-type': 'application/json', cookie: cookieHeader() }, body: '{}'
  });
  saveCookies(r);
  const sk = (await r.json().catch(() => ({}))).sk;
  if (!sk) throw new Error('sem csrf token');
  r = await fetch(`${API}/3.0/launch?mobcf=${MOBCF}`, {
    method: 'POST',
    headers: { ...baseHeaders, 'content-type': 'application/json', cookie: cookieHeader(), 'x-csrf-token': sk, 'x-taxi': UA + ' turboapp_taxi brand_yango' },
    body: '{}'
  });
  saveCookies(r);
  const uid = (await r.json().catch(() => ({}))).id;
  if (!uid) throw new Error('sem user id');
  session = { sk, uid };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0;

async function suggest(part, lat, lng, tries = 3) {
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
          part, type: 'b', client_id: 'turboapp-taxi',
          state: { accuracy: 0, location: [lng, lat] },
          action: 'user_input', suggest_serpid: crypto.randomUUID(),
          client_reqid: Date.now() + '_' + crypto.randomUUID()
        })
      });
    } catch {
      await sleep(800 * (attempt + 1));
      continue;
    }
    if (res.status === 401 || res.status === 403) { session = null; await sleep(500); continue; }
    if (res.status === 429 || res.status >= 500) { await sleep(1500 * (attempt + 1) ** 2); continue; }
    if (!res.ok) return [];
    const j = await res.json().catch(() => ({}));
    return Array.isArray(j.results) ? j.results : [];
  }
  return [];
}

// ---------- nomes ----------
const fold = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// semelhança: 0.6·jaccard de palavras + 0.4·prefixo comum (tolera acrónimos e abreviaturas)
function similarity(a, b) {
  const A = fold(a), B = fold(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const ta = new Set(A.split(' ')), tb = new Set(B.split(' '));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jac = inter / (ta.size + tb.size - inter);
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  const pref = p / Math.max(A.length, B.length);
  // acrónimo entre parênteses: "… (isptec)" vs "isptec"
  const acro = /\(([a-z0-9]{2,12})\)/.exec(A);
  const acroHit = acro && (B.includes(acro[1]) || tb.has(acro[1])) ? 0.25 : 0;
  return Math.min(1, 0.6 * jac + 0.4 * pref + acroHit);
}

const hav = (a1, o1, a2, o2) => {
  const R = 6371000, r = Math.PI / 180;
  const dA = (a2 - a1) * r, dO = (o2 - o1) * r;
  const h = Math.sin(dA / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dO / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const cleanMuni = s => String(s || '').replace(/\s+/g, ' ').replace(/^(?:de|do|da|dos|das)\s+/i, '')
  .replace(/[,\s]+(?:Angola|AO)$/i, '').trim() || null;

function candidateOf(r, fromLat, fromLng) {
  const p = r.position;
  if (!Array.isArray(p) || p.length < 2) return null;
  const lng = Number(p[0]), lat = Number(p[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const sub = (r.subtitle && r.subtitle.text) || '';
  return {
    name: ((r.title && r.title.text) || r.text || '').replace(/\s+/g, ' ').trim(),
    lat: +lat.toFixed(6),
    lng: +lng.toFixed(6),
    municipality: cleanMuni((/Munic[íi]pio\s+([^,·]+)/i.exec(sub) || [])[1]),
    uri: r.uri || null,
    dist: Math.round(hav(fromLat, fromLng, lat, lng))
  };
}

// ---------- entrada ----------
function loadPlaces(file) {
  const raw = readFileSync(resolve(file), 'utf8');
  const start = raw.indexOf('[');
  if (start < 0) throw new Error('ficheiro de places inválido (sem JSON)');
  const j = JSON.parse(raw.slice(start));
  // wrangler devolve [{ results: [...] }]
  const rows = Array.isArray(j) && j[0] && Array.isArray(j[0].results) ? j[0].results : j;
  return rows;
}

const all = loadPlaces(args.places);
const isPoi = p => {
  const t = String(p.type || '');
  if (/Portas-addr|Entradas\+Edificios/i.test(t)) return false; // número de porta / rótulo de edifício no sítio do tipo
  if (ROAD.has(t)) return false;
  return true;
};
let targets = (args.only === 'all' ? all : all.filter(isPoi)).filter(p => fold(p.name).length >= 4);

// Índice de nomes da NOSSA base: se o mesmo nome existe noutro sítio a >1 km,
// é cadeia/filial ou nome genérico ("Zumba", "Recauchutagem") — a distância até
// à Yango não prova que a nossa coordenada está errada. A Yango só devolve a
// filial mais próxima (máx. 7 resultados), por isso a guarda de cadeia da
// resposta não apanha estes casos; esta apanha.
const siblingIndex = new Map();
for (const p of all) {
  const k = fold(p.name);
  if (!k) continue;
  (siblingIndex.get(k) || siblingIndex.set(k, []).get(k)).push(p);
}
function siblingCount(p) {
  const arr = siblingIndex.get(fold(p.name)) || [];
  let n = 0;
  for (const q of arr) if (q.id !== p.id && hav(q.lat, q.lng, p.lat, p.lng) > args.chain) n++;
  return n;
}
// Corroboração: uma correção longa só é aceite se a nossa própria base já tiver
// um sítio no ponto de destino (nome parecido, <= --proof metros). Sem isso,
// "seven" ou "Lavanderia" a 7 km é outra loja qualquer, não uma coordenada errada.
// É esta regra que deixa passar o ISPTEC (a linha "ISPTC" já está a 61 m do sítio
// certo) e trava os nomes genéricos.
function corroborated(p, cand) {
  for (const q of all) {
    if (q.id === p.id) continue;
    if (hav(q.lat, q.lng, cand.lat, cand.lng) > args.proof) continue;
    if (similarity(q.name, cand.name) >= 0.6) return true;
  }
  return false;
}
if (args.limit > 0) targets = targets.slice(0, args.limit);

// ---------- estado ----------
let state = { done: [] };
if (args.resume && existsSync(paths.state)) {
  state = JSON.parse(readFileSync(paths.state, 'utf8'));
} else if (!args.resume && !args.report) {
  for (const p of [paths.jsonl, paths.state]) if (existsSync(p)) writeFileSync(p, '');
}
const done = new Set(state.done);
const saveState = () => writeFileSync(paths.state, JSON.stringify({ done: [...done] }));

// ---------- auditoria ----------
const t0 = Date.now();
const results = [];
// ao retomar, o relatório final tem de incluir o que já foi auditado (vive no .jsonl)
if ((args.resume || args.report) && existsSync(paths.jsonl)) {
  for (const line of readFileSync(paths.jsonl, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { results.push(JSON.parse(line)); } catch {}
  }
}
let lastSave = Date.now();
const minGap = 1000 / args.rps;
let nextSlot = Date.now();

async function audit(p) {
  const now = Date.now();
  if (now < nextSlot) await sleep(nextSlot - now);
  nextSlot = Math.max(Date.now(), nextSlot) + minGap;

  const rs = await suggest(p.name, p.lat, p.lng);
  const cands = [];
  for (const r of rs) {
    const c = candidateOf(r, p.lat, p.lng);
    if (!c) continue;
    const sim = similarity(p.name, c.name);
    if (sim >= args.minSim) cands.push({ ...c, sim });
  }
  cands.sort((a, b) => b.sim - a.sim || a.dist - b.dist);
  const best = cands[0] || null;
  const bestSim = best ? best.sim : 0;

  // Cadeia/filial: o mesmo nome aparece em dois sítios distantes entre si.
  // Nesse caso a distância não prova que a nossa coordenada está errada.
  let ambiguous = false;
  for (let a = 0; a < cands.length && !ambiguous; a++) {
    for (let b = a + 1; b < cands.length; b++) {
      if (hav(cands[a].lat, cands[a].lng, cands[b].lat, cands[b].lng) > args.chain) { ambiguous = true; break; }
    }
  }

  let decision = 'ausente';
  if (best) {
    if (best.dist <= args.ok) decision = 'ok';
    else if (ambiguous) decision = 'sinalizar';   // filial: nunca corrigir sozinho
    else if (best.dist <= args.max) decision = 'corrigir';
    else decision = 'sinalizar';
  } else if (rs.length) {
    decision = 'sinalizar'; // houve resultados, mas nenhum nome bate o suficiente
  }

  // cadeia/filial na nossa própria base: nunca corrigir sozinho
  let sib = 0, proof = null;
  if (decision === 'corrigir') {
    sib = siblingCount(p);
    if (sib > 0) decision = 'sinalizar';
    else if (best.dist > args.safe) {
      // desvio grande: só com corroboração de outro sítio nosso no destino
      proof = corroborated(p, best);
      if (!proof) decision = 'sinalizar';
    }
  }

  const row = {
    id: p.id, name: p.name, type: p.type, municipality: p.municipality,
    lat: p.lat, lng: p.lng, decision,
    sim: +bestSim.toFixed(3),
    alts: cands.length,
    chain: ambiguous,
    sib,
    proof,
    cand: best ? { name: best.name, lat: best.lat, lng: best.lng, municipality: best.municipality, uri: best.uri, dist: best.dist } : null
  };
  results.push(row);
  appendFileSync(paths.jsonl, JSON.stringify(row) + '\n');
  done.add(p.id);
  if (Date.now() - lastSave > 5000) { lastSave = Date.now(); saveState(); }
}

let i = 0;
const CONCURRENCY = 2;
async function worker() {
  while (i < targets.length) {
    const p = targets[i++];
    if (done.has(p.id)) continue;
    try { await audit(p); } catch { /* segue */ }
    if (i % 25 === 0) {
      const el = (Date.now() - t0) / 1000;
      process.stdout.write(`\r${i}/${targets.length} · ${requests} pedidos · ${(requests / el).toFixed(1)} req/s   `);
    }
  }
}

console.log(`alvo: ${targets.length} POIs de ${all.length} linhas (${all.length - targets.length} ignoradas: ruas/portas)`);
if (args.report) {
  console.log(`modo --report: ${results.length} linhas lidas do .jsonl (sem rede)`);
} else {
  if (!targets.length) process.exit(0);
  await Promise.all([worker(), worker()]);
  saveState();
}

// ---------- relatório ----------
// A guarda de irmãos volta a ser aplicada a TODAS as linhas: o .jsonl pode ter
// sido escrito por uma versão anterior do script (sem a regra). É idempotente.
for (const r of results) {
  if (r.decision !== 'corrigir') continue;
  const n = siblingCount(r);
  if (n > 0) { r.decision = 'sinalizar'; r.sib = n; continue; }
  if (r.cand && r.cand.dist > args.safe && !corroborated(r, r.cand)) {
    r.decision = 'sinalizar';
    r.proof = false;
  }
}
const by = results.reduce((a, r) => ((a[r.decision] = (a[r.decision] || 0) + 1), a), {});
const secs = (Date.now() - t0) / 1000;

// O .jsonl passa a refletir as decisões JÁ filtradas. Sem isto, uma corrida ao vivo
// grava `corrigir` nas linhas que o relatório depois despromove a `sinalizar`, e quem
// ler o .jsonl (verificadores, relatórios) vê correções que nunca foram escritas.
writeFileSync(paths.jsonl, results.map(r => JSON.stringify(r)).join('\n') + (results.length ? '\n' : ''));

// duplicados: depois de corrigir, duas linhas com o MESMO nome podem cair no mesmo sítio.
// Só se apaga quando o nome é exatamente igual (sem acentos/maiúsculas); nomes diferentes
// no mesmo ponto (ex. ISPTEC vs ISPTC) ficam para revisão, não se apagam sozinhos.
const groups = new Map();
for (const r of results) {
  if (r.decision !== 'corrigir' && r.decision !== 'ok') continue;
  const lat = r.decision === 'corrigir' ? r.cand.lat : r.lat;
  const lng = r.decision === 'corrigir' ? r.cand.lng : r.lng;
  // 4 casas decimais ≈ 11 m: só se apaga o que está mesmo no mesmo ponto.
  // Com 3 casas (~110 m) apagavam-se entradas distintas do mesmo sítio.
  const k = `${fold(r.name)}|${lat.toFixed(4)}|${lng.toFixed(4)}`;
  (groups.get(k) || groups.set(k, []).get(k)).push({ ...r, nlat: lat, nlng: lng });
}
const dupDeletes = [];
for (const g of groups.values()) {
  if (g.length < 2) continue;
  // fica o que tem o nome canónico da Yango; senão o mais antigo (id menor)
  g.sort((a, b) => {
    const ca = a.cand && fold(a.cand.name) === fold(a.name) ? 0 : 1;
    const cb = b.cand && fold(b.cand.name) === fold(b.name) ? 0 : 1;
    return ca - cb || a.id - b.id;
  });
  for (const extra of g.slice(1)) dupDeletes.push(extra);
}

const esc = v => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const sqlLines = [
  '-- Correções geradas por scripts/audit-places.mjs — REVER antes de aplicar.',
  '-- Aplicar em staging primeiro: wrangler d1 execute ladiesgo-staging --remote --file=<este ficheiro>'
];
for (const r of results) {
  if (r.decision !== 'corrigir') continue;
  const c = r.cand;
  sqlLines.push(
    `-- ${r.name} (id ${r.id}) · ${r.lat},${r.lng} → ${c.lat},${c.lng} (${c.dist} m) · ${c.name}`
  );
  // só mexer no município quando a Yango dá um — nunca apagar o que já lá está
  sqlLines.push(c.municipality
    ? `UPDATE places SET lat=${c.lat}, lng=${c.lng}, municipality=${esc(c.municipality)} WHERE id=${r.id};`
    : `UPDATE places SET lat=${c.lat}, lng=${c.lng} WHERE id=${r.id};`);
}
if (dupDeletes.length) {
  sqlLines.push('', '-- Duplicados (mesmo nome e coordenada após correção) — apagar o menos completo');
  for (const d of dupDeletes) sqlLines.push(`-- duplicado de: ${d.name} (id ${d.id})`);
  sqlLines.push(`DELETE FROM places WHERE id IN (${dupDeletes.map(d => d.id).join(',')});`);
}

const csvEsc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
const csv = ['id,name,type,municipality,lat,lng,decision,sim,alts,chain,cand_name,cand_lat,cand_lng,cand_municipality,cand_dist_m']
  .concat(results.map(r => [r.id, r.name, r.type, r.municipality, r.lat, r.lng, r.decision, r.sim, r.alts, r.chain,
    r.cand?.name, r.cand?.lat, r.cand?.lng, r.cand?.municipality, r.cand?.dist].map(csvEsc).join(',')))
  .join('\n');

writeFileSync(paths.sql, sqlLines.join('\n') + '\n');
writeFileSync(paths.csv, csv);

console.log(`\n\nresultado: ${JSON.stringify(by)}`);
console.log(`duplicados a apagar: ${dupDeletes.length}`);
console.log(`pedidos: ${requests} em ${secs.toFixed(0)}s (${(requests / secs).toFixed(1)}/s)`);
console.log(`ficheiros: ${paths.jsonl} | ${paths.sql} | ${paths.csv}`);
if (by.corrigir) console.log(`aviso: ${by.corrigir} UPDATEs ≈ ${by.corrigir * 6} linhas escritas na D1 (índices + trigger do FTS)`);
