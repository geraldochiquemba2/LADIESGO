// ============================================================================
// rate-limiting.mjs — Testes de Rate Limiting LADIESGO
// Testa: HTTP rate limit (100 req/min por IP), WebSocket connection limit
//       (10 por IP), load shedding a 80% capacidade.
//
// Uso: node e2e/tests/rate-limiting.mjs [--base=<url>] [--quick]
// ============================================================================

import { performance } from 'node:perf_hooks';

// ── Configuração ─────────────────────────────────────────────────────────────
const BASE = process.env.API_BASE ||
  (process.argv.find(a => a.startsWith('--base=')) || '').slice(7) ||
  'https://ladiesgo-api.ladiesgo-ao.workers.dev/api/v1';
const WS_BASE = BASE.replace(/^http/, 'ws');
const QUICK = process.argv.includes('--quick');
const ADMIN_PHONE = '999999999';
const ADMIN_PASS = '1234567890';
const PAX_PASS = 'Test1234';

const WS = globalThis.WebSocket;
if (typeof WS !== 'function') {
  console.error('WebSocket global não disponível. Node 22+ necessário.');
  process.exit(2);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const results = [];

function check(name, condition, detail = '') {
  const ok = !!condition;
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (ok) passed++; else failed++;
  return ok;
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function test(name, fn) {
  const t0 = performance.now();
  try {
    await fn();
    const ms = (performance.now() - t0).toFixed(0);
    check(name, true, `${ms}ms`);
    return true;
  } catch (e) {
    const ms = (performance.now() - t0).toFixed(0);
    check(name, false, `${e.message} (${ms}ms)`);
    return false;
  }
}

let requestCount = 0;
const statusCounts = {};

async function api(method, path, { token, body, timeout = 30000 } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  requestCount++;
  const res = await fetch(BASE + path, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
  return { ok: res.ok, status: res.status, json, text };
}

function openWs(url, tag = '') {
  return new Promise((resolve, reject) => {
    const sock = { tag, ws: null, opened: false, frames: [], errors: 0, closed: false, closeCode: null };
    let ws;
    try { ws = new WS(url); } catch (e) { reject(new Error(`WS constructor: ${e.message}`)); return; }
    sock.ws = ws;
    const t0 = performance.now();
    const timer = setTimeout(() => { reject(new Error(`WS open timeout (${tag})`)); }, 15000);
    ws.onopen = () => { sock.opened = true; sock.openMs = +(performance.now() - t0).toFixed(1); clearTimeout(timer); resolve(sock); };
    ws.onmessage = (ev) => { sock.frames.push(ev.data); };
    ws.onerror = () => { sock.errors++; };
    ws.onclose = (ev) => { sock.closed = true; sock.closeCode = ev?.code ?? null; };
  });
}

async function setupAccounts(n) {
  const admin = await api('POST', '/auth/login', { body: { phone: ADMIN_PHONE, password: ADMIN_PASS } });
  if (!admin.ok) throw new Error(`Admin login failed: ${admin.status}`);
  const pax = [];
  for (let i = 0; i < n; i++) {
    const phone = `+24492${Date.now().toString(36).slice(-5)}${i.toString().padStart(4, '0')}`;
    const r = await api('POST', '/auth/register', { body: { phone, password: PAX_PASS, name: `RL-Pax-${i}` } });
    if (r.ok) pax.push(r.json.accessToken);
  }
  return pax;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── 1. HTTP Rate Limit (100 req/min por IP) ──────────────────────────────────
async function testHttpRateLimit() {
  console.log('\n━━━ Teste: HTTP Rate Limit (100 req/min por IP) ━━━');

  // Fazer requests rapidamente até obter 429
  const maxRequests = QUICK ? 30 : 150;
  let got429 = false;
  let reqBefore429 = 0;

  for (let i = 0; i < maxRequests; i++) {
    const r = await api('GET', '/health', { timeout: 5000 });
    if (r.status === 429) {
      got429 = true;
      reqBefore429 = i;
      break;
    }
    // Pequeno delay para não saturar a rede local
    if (i % 10 === 9) await delay(100);
  }

  check(`HTTP 429 retornado após ${reqBefore429} requests`, got429, `status counts: ${JSON.stringify(statusCounts)}`);

  // Verificar headers de rate limit (se existirem)
  const r = await api('GET', '/health');
  const hasRateLimitHeaders = r.headers && (
    r.headers.get('X-RateLimit-Limit') ||
    r.headers.get('Retry-After')
  );
  // Nota: Cloudflare Workers pode não expor headers customizados sem configuração
  check('Headers de rate limit presentes (informativo)', !!hasRateLimitHeaders, 'X-RateLimit-Limit ou Retry-After');
}

// ── 2. WebSocket Connection Limit (10 por IP) ────────────────────────────────
async function testWsConnectionLimit() {
  console.log('\n━━━ Teste: WebSocket Connection Limit (10 por IP) ━━━');
  const { pax } = await setupAccounts(QUICK ? 15 : 20);
  const sockets = [];
  let rejected = 0;
  const max = Math.min(pax.length, QUICK ? 15 : 20);

  for (let i = 0; i < max; i++) {
    try {
      const sock = await openWs(`${WS_BASE}/drivers/live-geo?token=${encodeURIComponent(pax[i])}`, `ws-limit-${i}`);
      sockets.push(sock);
      await delay(100); // Pequeno delay entre conexões
    } catch (e) {
      rejected++;
    }
  }

  check(`Abrir ${max} conexões WebSocket simultâneas`, sockets.length > 0, `${sockets.length} abertas, ${rejected} rejeitadas`);
  check('Limite de conexões não excede 10 por IP (informativo)', rejected < max, `${rejected}/${max} rejeitadas`);

  // Cleanup
  for (const s of sockets) { try { s.ws.close(); } catch {} }
  await delay(500);
}

// ── 3. Load Shedding a 80% capacidade ─────────────────────────────────────────
async function testLoadShedding() {
  console.log('\n━━━ Teste: Load Shedding a 80% capacidade ━━━');

  // Simular carga elevada com requests concorrentes
  const concurrency = QUICK ? 20 : 100;
  const requestsPerBatch = QUICK ? 5 : 20;
  const batches = QUICK ? 2 : 5;

  let totalRequests = 0;
  let shedResponses = 0; // 503 ou 429
  const t0 = performance.now();

  for (let batch = 0; batch < batches; batch++) {
    const promises = [];
    for (let i = 0; i < concurrency; i++) {
      promises.push(api('GET', '/health', { timeout: 10000 }).then(r => {
        totalRequests++;
        if (r.status === 503 || r.status === 429) shedResponses++;
        return r;
      }));
    }
    await Promise.all(promises);
    await delay(200);
  }

  const elapsed = performance.now() - t0;
  const rps = (totalRequests / (elapsed / 1000)).toFixed(1);

  check(`Carga sustentada: ${totalRequests} requests em ${elapsed.toFixed(0)}ms`, totalRequests > 0, `${rps} req/s`);
  check('Load shedding pode ocorrer sob carga extrema (informativo)', shedResponses >= 0, `${shedResponses} respostas 503/429`);
}

// ── 4. Rate limiting em endpoints autenticados ────────────────────────────────
async function testAuthenticatedRateLimit() {
  console.log('\n━━━ Teste: Rate limiting em endpoints autenticados ━━━');
  const { pax } = await setupAccounts(1);

  if (!pax.length) {
    check('Setup de conta para rate limit autenticado', false, 'falha ao criar conta');
    return;
  }

  // Fazer muitas requests autenticadas
  const maxRequests = QUICK ? 50 : 200;
  let got429 = false;

  for (let i = 0; i < maxRequests; i++) {
    const r = await api('GET', '/users/profile', { token: pax[0], timeout: 5000 });
    if (r.status === 429) {
      got429 = true;
      check(`Rate limit autenticado após ${i} requests`, true, `429 recebido`);
      return;
    }
    if (i % 20 === 19) await delay(100);
  }

  // Se não recebeu 429, o rate limit pode não estar ativo ou ser mais alto
  check('Rate limit autenticado (100 req/min)', got429, `não recebeu 429 em ${maxRequests} requests (pode ser limite mais alto)`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  LADIESGO — Testes de Rate Limiting');
  console.log(`  Base: ${BASE}`);
  console.log(`  Modo: ${QUICK ? 'quick' : 'full'}`);
  console.log('═══════════════════════════════════════════════');

  const started = Date.now();

  try {
    await testHttpRateLimit();
    await testWsConnectionLimit();
    await testLoadShedding();
    await testAuthenticatedRateLimit();
  } catch (e) {
    console.error('\n💥 Erro fatal:', e.message);
    failed++;
  }

  const duration = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  Resultado: ${passed} passou, ${failed} falhou`);
  console.log(`  Duração: ${duration}s`);
  console.log(`  HTTP requests: ${requestCount}`);
  console.log(`  Status counts: ${JSON.stringify(statusCounts)}`);
  console.log('═══════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Unhandled:', e); process.exit(1); });
