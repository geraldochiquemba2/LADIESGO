#!/usr/bin/env node
/**
 * quota-watch.mjs — Vigilante da quota diária do plano Free (conta rerere…).
 *
 * PORQUÊ: os contadores do Worker (src/budget.ts) são POR ISOLATE e, por isso,
 * vêem só uma fração do tráfego. A única medida AUTORITATIVA é a conta, via
 * GraphQL Analytics API (os mesmos números do dashboard). Este script lê esses
 * números e:
 *   1. mostra o uso do dia (UTC) ao lado de cada teto do plano Free;
 *   2. projeta o total das 24 h e a hora a que o teto seria atingido;
 *   3. devolve um código de saída (0..4) para CI/cron;
 *   4. (--telegram) manda um alerta para o Telegram quando o nível sobe;
 *   5. (--guard writes=N) recusa correr operações caras se não houver folga;
 *   6. (--apply-shed) escreve o nível de "corte de carga" em D1 (system_flags),
 *      que o Worker lê para se degradar com elegância ANTES de bater no muro.
 *
 * Uso:
 *   node scripts/quota-watch.mjs                     # relatório do dia (UTC)
 *   node scripts/quota-watch.mjs --json              # só JSON (para scripts)
 *   node scripts/quota-watch.mjs --window=24h        # últimas 24 h (rolante)
 *   node scripts/quota-watch.mjs --check             # sem relatório, só exit code
 *   node scripts/quota-watch.mjs --telegram          # + alerta Telegram se >= aviso
 *   node scripts/quota-watch.mjs --guard writes=20000,reads=300000
 *   node scripts/quota-watch.mjs --apply-shed        # escreve o nível em D1
 *   node scripts/quota-watch.mjs --apply-shed --env=staging
 *
 * Códigos de saída: 0 OK · 1 AVISO (>=70%) · 2 ALTO (>=85%) · 3 CRÍTICO (>=92%)
 *                   4 ESGOTADO (>=100%) · 5 erro (token/rede/GraphQL)
 *
 * Token: variável CLOUDFLARE_API_TOKEN, senão o token OAuth do wrangler.
 * NUNCA correr `wrangler logout` para "resolver" um 10000 de autenticação:
 * correr `npx wrangler@4.151.1 whoami`, que renova o token.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

// ─── Tetos do plano Free (docs Cloudflare, out/2026) ────────────────────────
const LIMITS = {
  requests: 100_000,     // Workers pedidos/dia (erro 1027 ao estourar)
  reads: 5_000_000,      // D1 linhas lidas/dia (todas as queries falham até 00:00 UTC)
  writes: 100_000,       // D1 linhas escritas/dia (erro 7500)
  doRequests: 100_000,   // Durable Objects pedidos/dia
  doGbSeconds: 13_000,   // Durable Objects duração/dia
};

// Níveis (fração do teto). Ordem crescente.
const LEVELS = [
  { level: 0, code: 0, name: 'OK', emoji: '🟢', min: 0 },
  { level: 1, code: 1, name: 'AVISO', emoji: '🟡', min: 0.70 },
  { level: 2, code: 2, name: 'ALTO', emoji: '🟠', min: 0.85 },
  { level: 3, code: 3, name: 'CRÍTICO', emoji: '🔴', min: 0.92 },
  { level: 4, code: 4, name: 'ESGOTADO', emoji: '⛔', min: 1.0 },
];

const ACCOUNT_TAG = process.env.CLOUDFLARE_ACCOUNT_ID || '016a8f9ed58a5cd10e9be697944905f0';
const PROD_DB = 'fab720b7-d96e-423f-8454-bcc9942f6d50'; // ladiesgo
const STAGING_DB = '7e0cf0fd-527f-4e51-8e30-c93a55abddea'; // ladiesgo-staging

// ─── Argumentos ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(name, dflt = null) {
  const i = argv.findIndex((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (i === -1) return dflt;
  const hit = argv[i];
  const eq = hit.indexOf('=');
  if (eq !== -1) return hit.slice(eq + 1);
  // Aceita também a forma separada: `--guard writes=20000` (mas não engole flags).
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const WINDOW = String(arg('window', 'today')); // today | 24h
const JSON_ONLY = !!arg('json', false);
const CHECK_ONLY = !!arg('check', false);
const QUIET = !!arg('quiet', false);
const SEND_TG = !!arg('telegram', false);
const APPLY_SHED = !!arg('apply-shed', false);
const ENV_NAME = String(arg('env', '') || '');
const GUARDS = String(arg('guard', '') || '');
// Com que nível é que --check falha (por omissão: alto).
const FAIL_AT = String(arg('fail-at', 'high'));
const FAIL_LEVEL = FAIL_AT === 'warn' ? 1 : FAIL_AT === 'critical' ? 3 : FAIL_AT === 'never' ? 99 : 2;

if (arg('help', false) || arg('h', false)) {
  const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
  const m = src.match(/\/\*\*([\s\S]*?)\*\//);
  console.log((m ? m[1] : src).replace(/^\s*\* ?/gm, '').trim());
  process.exit(0);
}

// ─── Token ─────────────────────────────────────────────────────────────────
function loadToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return { token: process.env.CLOUDFLARE_API_TOKEN, source: 'env CLOUDFLARE_API_TOKEN' };
  const candidates = [
    path.join(process.env.APPDATA || '', 'xdg.config', '.wrangler', 'config', 'default.toml'),
    path.join(os.homedir(), '.wrangler', 'config', 'default.toml'),
    path.join(process.env.APPDATA || '', 'xdg.config', '.wrangler', 'config', 'default.rerere670account.toml'),
    path.join(os.homedir(), '.wrangler', 'config', 'default.rerere670account.toml'),
  ];
  for (const p of candidates) {
    try {
      const cfg = fs.readFileSync(p, 'utf8');
      const t = (cfg.match(/oauth_token\s*=\s*"([^"]+)"/) || [])[1];
      if (t) return { token: t, source: p };
    } catch {}
  }
  return { token: null, source: null };
}

// ─── GraphQL (com retry curto no limitador de consultas) ────────────────────
async function gql(token, query, variables) {
  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
      const j = await r.json();
      const e = (j.errors || [])[0];
      if (e && /budget|rate limit/i.test(String(e.message))) {
        lastErr = e.message;
        await new Promise((x) => setTimeout(x, 5_000));
        continue;
      }
      return j;
    } catch (err) {
      lastErr = String(err && err.message ? err.message : err);
      await new Promise((x) => setTimeout(x, 2_000));
    }
  }
  return { errors: [{ message: lastErr || 'falha de rede' }] };
}

const QUERY = `
query($a:String!,$s:Time!,$u:Time!){
  viewer { accounts(filter:{accountTag:$a}) {
    workersInvocationsAdaptive(limit:10000, filter:{datetime_geq:$s, datetime_leq:$u}) {
      sum { requests errors subrequests }
      dimensions { scriptName }
    }
    d1AnalyticsAdaptiveGroups(limit:10000, filter:{datetime_geq:$s, datetime_leq:$u}) {
      sum { readQueries writeQueries rowsRead rowsWritten }
      dimensions { databaseId }
    }
    durableObjectsInvocationsAdaptiveGroups(limit:10000, filter:{datetime_geq:$s, datetime_leq:$u}) {
      sum { requests }
      dimensions { name objectId }
    }
    durableObjectsPeriodicGroups(limit:10000, filter:{datetime_geq:$s, datetime_leq:$u}) {
      sum { duration rowsRead rowsWritten }
      dimensions { objectId }
    }
  } }
}`;

// ─── Formatação ────────────────────────────────────────────────────────────
const nf = new Intl.NumberFormat('pt-PT');
function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + ' M';
  if (v >= 10_000) return (v / 1000).toFixed(1) + ' k';
  return nf.format(Math.round(v));
}
function pctOf(v, max) {
  return max > 0 ? v / max : 0;
}
function levelFor(pct) {
  let out = LEVELS[0];
  for (const L of LEVELS) if (pct >= L.min) out = L;
  return out;
}
function levelName(level) {
  return (LEVELS.find((L) => L.level === level) || LEVELS[0]).name;
}
function bar(pct, width = 12) {
  const fill = Math.max(0, Math.min(width, Math.round(pct * width)));
  return '█'.repeat(fill) + '░'.repeat(width - fill);
}
function hm(dateUtc) {
  return dateUtc.toISOString().slice(11, 16) + 'Z';
}
function pctStr(pct) {
  return (pct * 100).toFixed(pct >= 0.995 ? 0 : 1) + '%';
}

// ─── Recolha ───────────────────────────────────────────────────────────────
async function collect(token) {
  const now = new Date();
  const since = WINDOW === '24h'
    ? new Date(now.getTime() - 86_400_000)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const j = await gql(token, QUERY, { a: ACCOUNT_TAG, s: since.toISOString(), u: now.toISOString() });
  if (j.errors) return { ok: false, error: JSON.stringify(j.errors).slice(0, 600), since, now };
  const acc = (j.data && j.data.viewer && j.data.viewer.accounts && j.data.viewer.accounts[0]) || {};

  // -- Workers --
  const scripts = [];
  let requests = 0, errors = 0, subrequests = 0;
  for (const row of acc.workersInvocationsAdaptive || []) {
    const r = { script: row.dimensions.scriptName || '?', requests: row.sum.requests || 0, errors: row.sum.errors || 0, subrequests: row.sum.subrequests || 0 };
    scripts.push(r);
    requests += r.requests; errors += r.errors; subrequests += r.subrequests;
  }
  scripts.sort((a, b) => b.requests - a.requests);

  // -- D1 (o teto é POR CONTA: somar todas as bases) --
  const dbs = [];
  let reads = 0, writes = 0, readQ = 0, writeQ = 0;
  for (const row of acc.d1AnalyticsAdaptiveGroups || []) {
    const d = {
      databaseId: row.dimensions.databaseId,
      name: row.dimensions.databaseId === PROD_DB ? 'ladiesgo (prod)'
        : row.dimensions.databaseId === STAGING_DB ? 'ladiesgo-staging'
        : row.dimensions.databaseId,
      rowsRead: row.sum.rowsRead || 0,
      rowsWritten: row.sum.rowsWritten || 0,
      readQueries: row.sum.readQueries || 0,
      writeQueries: row.sum.writeQueries || 0,
    };
    dbs.push(d);
    reads += d.rowsRead; writes += d.rowsWritten; readQ += d.readQueries; writeQ += d.writeQueries;
  }
  dbs.sort((a, b) => b.rowsRead - a.rowsRead);

  // -- Durable Objects --
  let doRequests = 0, doDuration = 0, doObjects = 0, doRowsRead = 0, doRowsWritten = 0;
  const doByName = new Map();
  const prefixOf = (n) => {
    const s = String(n || '?');
    if (s.startsWith('trip:')) return 'TripPush';
    if (s.startsWith('calls:')) return 'Calls';
    if (s.startsWith('notif:')) return 'NotifHub';
    if (s.startsWith('geo:')) return 'DriverGeo';
    return s;
  };
  for (const row of acc.durableObjectsInvocationsAdaptiveGroups || []) {
    doRequests += row.sum.requests || 0;
    doObjects++;
    const k = prefixOf(row.dimensions.name);
    doByName.set(k, (doByName.get(k) || 0) + (row.sum.requests || 0));
  }
  for (const row of acc.durableObjectsPeriodicGroups || []) {
    doDuration += row.sum.duration || 0;
    doRowsRead += row.sum.rowsRead || 0;
    doRowsWritten += row.sum.rowsWritten || 0;
  }

  // ── Projeção: a que ritmo estamos e a que horas se atinge o teto ──
  const elapsedH = Math.max(0.05, (now.getTime() - since.getTime()) / 3_600_000);
  const remainingH = Math.max(0, 24 - elapsedH);
  const project = (used, max) => {
    const rateH = used / elapsedH;             // por hora (no período medido)
    const projected = used + rateH * remainingH; // estimativa para as 24 h
    const etaMs = rateH > 0 ? since.getTime() + (max / rateH) * 3_600_000 : Infinity;
    return {
      perHour: rateH,
      projected,
      projectedPct: pctOf(projected, max),
      eta: Number.isFinite(etaMs) && etaMs <= now.getTime() + 86_400_000 ? new Date(etaMs) : null,
      hoursLeftAtRate: rateH > 0 ? Math.max(0, (max - used) / rateH) : Infinity,
    };
  };

  const metrics = [
    { key: 'requests', label: 'Workers — pedidos', used: requests, max: LIMITS.requests, extra: `erros ${fmt(errors)} · subrequests ${fmt(subrequests)}` },
    { key: 'reads', label: 'D1 — linhas lidas', used: reads, max: LIMITS.reads, extra: `${fmt(readQ)} queries de leitura` },
    { key: 'writes', label: 'D1 — linhas escritas', used: writes, max: LIMITS.writes, extra: `${fmt(writeQ)} queries de escrita` },
    { key: 'doRequests', label: 'Durable Objects — pedidos', used: doRequests, max: LIMITS.doRequests, extra: `${fmt(doObjects)} objetos·hora` },
    { key: 'doGbSeconds', label: 'Durable Objects — duração', used: doDuration, max: LIMITS.doGbSeconds, extra: 'GB-s' },
  ].map((m) => {
    const pct = pctOf(m.used, m.max);
    return { ...m, pct, level: levelFor(pct).level, proj: project(m.used, m.max), left: Math.max(0, m.max - m.used) };
  });

  const worstLevel = Math.max(...metrics.map((m) => m.level));
  const worstMetric = metrics.find((m) => m.level === worstLevel) || metrics[0];

  return {
    ok: true, now, since, window: WINDOW, elapsedH,
    metrics, worstLevel, worstMetric,
    requests, errors, subrequests, scripts,
    reads, writes, readQ, writeQ, dbs,
    doRequests, doDuration, doObjects, doRowsRead, doRowsWritten,
    doByName: [...doByName.entries()].sort((a, b) => b[1] - a[1]),
  };
}

// ─── Relatório ─────────────────────────────────────────────────────────────
function render(r) {
  const L = levelFor(r.worstMetric.pct);
  const out = [];
  out.push('');
  out.push(`=== Quota Cloudflare (plano Free) — ${r.window === '24h' ? 'últimas 24 h' : 'hoje (UTC)'} ===`);
  out.push(`    ${r.now.toISOString().replace('T', ' ').slice(0, 19)}Z  ·  janela desde ${r.since.toISOString().slice(11, 16)}Z (${r.elapsedH.toFixed(1)} h)  ·  conta ${ACCOUNT_TAG}`);
  out.push('');
  for (const m of r.metrics) {
    const lv = LEVELS.find((x) => x.level === m.level) || LEVELS[0];
    const p = m.proj;
    const etaTxt = m.pct >= 1 ? 'ESGOTADO' : p.eta ? hm(p.eta) : '—';
    out.push(
      `${lv.emoji} ${String(m.label).padEnd(28)} ${String(pctStr(m.pct)).padStart(6)}  [${bar(m.pct)}]  ` +
      `${fmt(m.used).padStart(9)} / ${fmt(m.max).padEnd(9)} restam ${fmt(m.left)}`,
    );
    out.push(
      `   ${' '.repeat(28)} projeção 24 h: ${fmt(p.projected).padStart(9)} (${pctStr(p.projectedPct)})` +
      ` · teto às ${etaTxt} · ${m.extra}`,
    );
  }
  out.push('');
  out.push(`NÍVEL: ${L.emoji} ${L.name}` + (L.level >= 2 ? '  →  reduzir tráfego/operações caras AGORA' : ''));
  if (r.worstLevel >= 3) out.push(`AVISO: a partir de 100% a D1 recusa TODAS as queries e o Worker devolve 1027 até às 00:00 UTC.`);

  if (!QUIET) {
    out.push('');
    out.push('-- Workers por script --');
    for (const s of r.scripts.slice(0, 6)) {
      out.push(`   ${String(s.script).padEnd(28)} ${fmt(s.requests).padStart(9)} pedidos · ${fmt(s.errors)} erros · ${fmt(s.subrequests)} subrequests`);
    }
    out.push('-- D1 por base (o teto é por conta) --');
    for (const d of r.dbs) {
      out.push(`   ${String(d.name).padEnd(28)} lidas ${fmt(d.rowsRead).padStart(9)} · escritas ${fmt(d.rowsWritten).padStart(8)} · ${fmt(d.readQueries)}/${fmt(d.writeQueries)} queries`);
    }
    if (r.requests > 0) out.push(`-- Eficiência -- ${(r.reads / r.requests).toFixed(1)} linhas lidas/pedido · ${(r.writes / Math.max(1, r.requests)).toFixed(3)} escritas/pedido`);
    out.push('-- Durable Objects --');
    out.push(`   pedidos ${fmt(r.doRequests)} · duração ${r.doDuration.toFixed(1)} GB-s · storage lido ${fmt(r.doRowsRead)} / escrito ${fmt(r.doRowsWritten)}`);
    if (r.doByName.length) out.push('   ' + r.doByName.slice(0, 6).map(([k, v]) => `${k}=${fmt(v)}`).join(' · '));
    out.push('');
  }
  return out.join('\n');
}

// ─── Telegram ──────────────────────────────────────────────────────────────
function telegramCreds() {
  let token = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN || '';
  let chat = process.env.TELEGRAM_CHAT_ID || process.env.TG_CHAT_ID || '';
  if (token && chat) return { token, chat };
  const candidates = [
    path.join(process.cwd(), '.dev.vars.telegram'),
    path.join(process.cwd(), 'cloudflare', 'api-worker', '.dev.vars.telegram'),
    path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '.dev.vars.telegram'),
  ];
  for (const p of candidates) {
    try {
      const txt = fs.readFileSync(p, 'utf8');
      const t = (txt.match(/^(?:TELEGRAM_BOT_TOKEN|TG_BOT_TOKEN)\s*=\s*"?([^"\r\n]+)"?/m) || [])[1];
      const c = (txt.match(/^(?:TELEGRAM_CHAT_ID|TG_CHAT_ID)\s*=\s*"?([^"\r\n]+)"?/m) || [])[1];
      if (t && c) return { token: t.trim(), chat: c.trim() };
    } catch {}
  }
  return null;
}

async function sendTelegram(r) {
  const creds = telegramCreds();
  if (!creds) {
    if (!QUIET) console.error('[telegram] sem credenciais (env TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID ou .dev.vars.telegram) — alerta não enviado');
    return false;
  }
  const L = levelFor(r.worstMetric.pct);
  const lines = [
    `${L.emoji} LADIESGO · quota ${L.name}`,
    `${r.window === '24h' ? 'Últimas 24 h' : 'Hoje'} (UTC ${r.now.toISOString().slice(11, 16)})`,
    '',
    ...r.metrics.map((m) => {
      const lv = LEVELS.find((x) => x.level === m.level) || LEVELS[0];
      const eta = m.pct >= 1 ? 'esgotado' : m.proj.eta ? 'teto às ' + hm(m.proj.eta) : 'sem risco hoje';
      return `${lv.emoji} ${m.label}: ${fmt(m.used)} / ${fmt(m.max)} (${pctStr(m.pct)}) — ${eta}`;
    }),
    '',
    r.worstLevel >= 2 ? 'Ação: parar auditorias/imports e reduzir tráfego.' : 'Sem ação necessária.',
  ];
  try {
    const res = await fetch(`https://api.telegram.org/bot${creds.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: creds.chat, text: lines.join('\n'), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) {
      if (!QUIET) console.error('[telegram] falhou: ' + JSON.stringify(j).slice(0, 200));
      return false;
    }
    if (!QUIET) console.log('[telegram] alerta enviado');
    return true;
  } catch (e) {
    if (!QUIET) console.error('[telegram] erro: ' + e.message);
    return false;
  }
}

// ─── Guarda (pré-voo para operações caras) ─────────────────────────────────
function checkGuards(r) {
  const want = {};
  for (const part of GUARDS.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = part.split('=');
    const n = Number(v);
    if (k && Number.isFinite(n)) want[k] = n;
  }
  const problems = [];
  for (const [k, n] of Object.entries(want)) {
    const m = r.metrics.find((x) => x.key === k);
    if (!m) { problems.push(`métrica desconhecida: ${k}`); continue; }
    if (m.left < n) {
      problems.push(`${m.label}: restam ${fmt(m.left)} para o teto, a operação pede ${fmt(n)} — RECUSADO`);
    }
  }
  return { want, problems };
}

// ─── Corte de carga (escreve o nível em D1; o Worker lê e degrada) ─────────
function shedLevelFor(r) {
  // 0 = normal · 1 = pesquisa de lugares não toca na D1 (só cache + Photon/Nominatim)
  // 2 = + histórico devolve 8 viagens em vez de 30
  // O AVISO (70%) NÃO corta nada — só alerta; o corte começa no ALTO (85%).
  if (r.worstLevel >= 3) return 2;
  if (r.worstLevel >= 2) return 1;
  return 0;
}

function applyShed(r) {
  const level = shedLevelFor(r);
  const dbName = ENV_NAME === 'staging' ? 'ladiesgo-staging' : 'ladiesgo';
  const cwd = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const sql =
    `INSERT INTO system_flags (key, value, updatedAt) VALUES ('quota_shed', '${level}', CURRENT_TIMESTAMP) ` +
    `ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = CURRENT_TIMESTAMP`;
  const cmd = `npx wrangler@4.151.1 d1 execute ${dbName} --remote --json --command "${sql.replace(/"/g, '\\"')}"` +
    (ENV_NAME === 'staging' ? ' --env staging' : '');
  try {
    const out = execSync(cmd, { cwd, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!QUIET) console.log(`[shed] ${dbName}: quota_shed=${level} (${levelName(r.worstLevel)})`);
    return { ok: true, level, out: out.slice(0, 200) };
  } catch (e) {
    const msg = String((e && (e.stderr || e.message)) || e).slice(0, 400);
    if (!QUIET) console.error('[shed] falhou: ' + msg);
    return { ok: false, level, error: msg };
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────
const { token, source } = loadToken();
if (!token) {
  console.error('Sem token Cloudflare. Define CLOUDFLARE_API_TOKEN ou corre `npx wrangler@4.151.1 whoami`.');
  process.exit(5);
}
if (!QUIET && !JSON_ONLY && !CHECK_ONLY) console.error(`[fonte] token: ${source}`);

const r = await collect(token);
if (!r.ok) {
  console.error('Falha ao ler a GraphQL Analytics API: ' + r.error);
  if (/10000|auth|Authentication/i.test(r.error)) {
    console.error('Token inválido/expirado. Corre `npx wrangler@4.151.1 whoami` (NUNCA `wrangler logout`).');
  }
  process.exit(5);
}

const level = r.worstLevel;
const code = LEVELS.find((L) => L.level === level).code;

if (JSON_ONLY) {
  console.log(JSON.stringify({
    ok: true, window: r.window, since: r.since.toISOString(), now: r.now.toISOString(),
    level, levelName: levelName(level),
    metrics: r.metrics.map(({ key, label, used, max, pct, left, extra, proj }) => ({
      key, label, used, max, pct: +pct.toFixed(4), left, extra,
      perHour: +proj.perHour.toFixed(1), projected: Math.round(proj.projected),
      eta: proj.eta ? proj.eta.toISOString() : null,
    })),
    scripts: r.scripts.slice(0, 10), databases: r.dbs,
    do: { requests: r.doRequests, gbSeconds: +r.doDuration.toFixed(2), objects: r.doObjects },
  }, null, 2));
} else if (!CHECK_ONLY) {
  console.log(render(r));
}

// Guardas: se falharem, saem com 3 mesmo que o nível seja baixo.
if (GUARDS) {
  const g = checkGuards(r);
  if (g.problems.length) {
    for (const p of g.problems) console.error('GUARDA: ' + p);
    process.exit(3);
  }
  if (!QUIET && !JSON_ONLY) console.log('Guardas OK: ' + Object.entries(g.want).map(([k, v]) => `${k}>=${fmt(v)} disponível`).join(' · ') + '\n');
}

if (SEND_TG && level >= 1) await sendTelegram(r);
if (APPLY_SHED) applyShed(r);

process.exit(code >= FAIL_LEVEL ? code : 0);
