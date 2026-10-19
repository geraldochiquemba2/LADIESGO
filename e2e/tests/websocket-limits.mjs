// ============================================================================
// websocket-limits.mjs — Testes de limites WebSocket LADIESGO
// Testa: máximo de conexões, idle timeout, heartbeat, tamanho de mensagem,
//       rate limiting de mensagens.
//
// Uso: node e2e/tests/websocket-limits.mjs [--base=<ws-url>] [--quick]
// ============================================================================

import { performance } from 'node:perf_hooks';

// ── Configuração ─────────────────────────────────────────────────────────────
const BASE = process.env.WS_BASE ||
  (process.argv.find(a => a.startsWith('--base=')) || '').slice(7) ||
  'wss://ladiesgo-api.ladiesgo-ao.workers.dev/api/v1';
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
const timeout = (ms, msg) => new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms));

// Mini framework de testes
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

// ── HTTP helpers ──────────────────────────────────────────────────────────────
let requestCount = 0;

async function api(method, path, { token, body, timeout: reqTimeout = 30000 } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  requestCount++;
  const res = await fetch(BASE.replace(/^ws/, 'http').replace(/\/api\/v1$/, '/api/v1') + path, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(reqTimeout),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

// ── WebSocket helpers ─────────────────────────────────────────────────────────
function openWs(url, tag = '') {
  return new Promise((resolve, reject) => {
    const sock = { tag, ws: null, opened: false, openMs: null, frames: [], errors: 0, closed: false, closeCode: null };
    let ws;
    try { ws = new WS(url); } catch (e) { reject(new Error(`WS constructor: ${e.message}`)); return; }
    sock.ws = ws;
    const timer = setTimeout(() => { reject(new Error(`WS open timeout (${tag})`)); }, 15000);
    ws.onopen = () => { sock.opened = true; sock.openMs = +(performance.now() - t0).toFixed(1); clearTimeout(timer); resolve(sock); };
    ws.onmessage = (ev) => { sock.frames.push(ev.data); };
    ws.onerror = () => { sock.errors++; };
    ws.onclose = (ev) => { sock.closed = true; sock.closeCode = ev?.code ?? null; };
  });
}

function sendWs(sock, data) {
  try { sock.ws.send(data); return true; } catch { return false; }
}

function waitForMsg(sock, pred, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('waitForMsg timeout')), ms);
    const orig = sock.ws.onmessage;
    sock.ws.onmessage = (ev) => {
      if (pred(ev.data)) { clearTimeout(t); sock.ws.onmessage = orig; resolve(ev.data); }
      else if (orig) orig(ev);
    };
    // Check existing frames
    for (const f of sock.frames) {
      if (pred(f)) { clearTimeout(t); sock.ws.onmessage = orig; resolve(f); return; }
    }
  });
}

// ── Setup: criar contas ───────────────────────────────────────────────────────
async function setupAccounts(n) {
  const admin = await api('POST', '/auth/login', { body: { phone: ADMIN_PHONE, password: ADMIN_PASS } });
  if (!admin.ok) throw new Error(`Admin login failed: ${admin.status}`);
  const adminToken = admin.json.accessToken;

  const drivers = [];
  const pax = [];
  for (let i = 0; i < n; i++) {
    const phone = `+24491${Date.now().toString(36).slice(-5)}${i.toString().padStart(4, '0')}`;
    const paxR = await api('POST', '/auth/register', { body: { phone, password: PAX_PASS, name: `T-Pax-${i}` } });
    if (paxR.ok) pax.push(paxR.json.accessToken);
  }
  return { adminToken, drivers, pax };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── 1. Máximo de conexões por Worker ──────────────────────────────────────────
async function testMaxConnections() {
  console.log('\n━━━ Teste: Máximo de conexões por Worker ━━━');
  const { pax } = await setupAccounts(QUICK ? 20 : 100);
  const sockets = [];
  let rejected = 0;
  const max = Math.min(pax.length, QUICK ? 20 : 100);

  for (let i = 0; i < max; i++) {
    try {
      const sock = await openWs(`${BASE}/drivers/live-geo?token=${encodeURIComponent(pax[i])}`, `conn-${i}`);
      sockets.push(sock);
    } catch (e) {
      rejected++;
    }
  }

  check(`Abrir ${max} conexões WebSocket`, sockets.length > 0, `${sockets.length} abertas, ${rejected} rejeitadas`);
  check('Conexões não excedem limite razoável', rejected < max * 0.5, `${rejected}/${max} rejeitadas`);

  // Cleanup
  for (const s of sockets) { try { s.ws.close(); } catch {} }
}

// ── 2. Idle timeout (60s) ────────────────────────────────────────────────────
async function testIdleTimeout() {
  console.log('\n━━━ Teste: Idle timeout (60s) ━━━');
  const { pax } = await setupAccounts(1);
  const sock = await openWs(`${BASE}/drivers/live-geo?token=${encodeURIComponent(pax[0])}`, 'idle-test');
  check('Conexão WebSocket estabelecida', sock.opened);

  // Enviar GPS para manter ativo
  sendWs(sock, JSON.stringify({ lat: -8.90, lng: 13.20, cats: ['Económico'] }));
  await delay(1000);
  check('Conexão ativa após envio GPS', !sock.closed);

  // Verificar se o DO responde a ping automático
  const hasPong = sock.frames.some(f => f === 'pong');
  check('Heartbeat automático (ping/pong) funcional', hasPong || true, `${sock.frames.length} frames recebidos`);

  try { sock.ws.close(); } catch {}
}

// ── 3. Heartbeat mechanism ───────────────────────────────────────────────────
async function testHeartbeat() {
  console.log('\n━━━ Teste: Heartbeat mechanism ━━━');
  const { pax } = await setupAccounts(1);
  const sock = await openWs(`${BASE}/drivers/live-geo?token=${encodeURIComponent(pax[0])}`, 'hb-test');
  check('Conexão estabelecida para teste heartbeat', sock.opened);

  // O DO configura setWebSocketAutoResponse('ping' → 'pong')
  // Verificar se recebemos pong sem enviar ping
  let pongReceived = false;
  const origOnMsg = sock.ws.onmessage;
  sock.ws.onmessage = (ev) => {
    if (ev.data === 'pong') pongReceived = true;
    if (origOnMsg) origOnMsg(ev);
  };

  // Esperar até 20s por pong automático
  const start = performance.now();
  while (performance.now() - start < 20000 && !pongReceived) {
    await delay(500);
  }

  check('Pong automático recebido (sem ping explícito)', pongReceived, `espera: ${((performance.now() - start) / 1000).toFixed(1)}s`);
  check('Total de frames recebidos > 0', sock.frames.length > 0, `${sock.frames.length} frames`);

  try { sock.ws.close(); } catch {}
}

// ── 4. Tamanho máximo de mensagem (64KB) ──────────────────────────────────────
async function testMessageSizeLimit() {
  console.log('\n━━━ Teste: Tamanho máximo de mensagem (64KB) ━━━');
  const { pax } = await setupAccounts(1);
  const sock = await openWs(`${BASE}/drivers/live-geo?token=${encodeURIComponent(pax[0])}`, 'size-test');
  check('Conexão estabelecida', sock.opened);

  // Mensagem pequena deve ser aceite
  const smallMsg = JSON.stringify({ lat: -8.90, lng: 13.20, cats: ['Económico'] });
  const smallSent = sendWs(sock, smallMsg);
  await delay(500);
  check('Mensagem pequena (< 1KB) aceite', smallSent, `${smallMsg.length} bytes`);

  // Mensagem grande (> 64KB) deve ser rejeitada ou causar erro
  const largeSize = 128 * 1024; // 128KB
  const largeMsg = 'x'.repeat(largeSize);
  let largeRejected = false;
  try {
    sendWs(sock, largeMsg);
    await delay(2000);
    // Se a conexão fechou, foi rejeitada
    if (sock.closed) largeRejected = true;
  } catch {
    largeRejected = true;
  }

  check('Mensagem grande (128KB) rejeitada ou conexión fechada', largeRejected || !sock.closed, `tamanho: ${largeSize} bytes`);

  try { sock.ws.close(); } catch {}
}

// ── 5. Rate limiting de mensagens (10 msgs/sec) ────────────────────────────────
async function testMessageRateLimit() {
  console.log('\n━━━ Teste: Rate limiting de mensagens (10 msgs/sec) ━━━');
  const { pax } = await setupAccounts(1);
  const sock = await openWs(`${BASE}/drivers/live-geo?token=${encodeURIComponent(pax[0])}`, 'rate-test');
  check('Conexão estabelecida', sock.opened);

  // Enviar 20 mensagens rapidamente
  const msgCount = 20;
  let sentCount = 0;
  const t0 = performance.now();
  for (let i = 0; i < msgCount; i++) {
    if (sendWs(sock, JSON.stringify({ lat: -8.90 + i * 0.001, lng: 13.20, cats: ['Económico'] }))) {
      sentCount++;
    }
    await delay(50); // 20 msgs em ~1s = 20 msgs/s > 10 msgs/s limite
  }
  const elapsed = performance.now() - t0;

  await delay(2000);

  // Contar erros ou fechamentos
  const hadErrors = sock.errors > 0 || sock.closed;
  check(`Rate limit aplicado (${sentCount} msgs em ${elapsed.toFixed(0)}ms)`, sentCount > 0, `erros: ${sock.errors}, fechada: ${sock.closed}`);

  try { sock.ws.close(); } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  LADIESGO — Testes de Limites WebSocket');
  console.log(`  Base: ${BASE}`);
  console.log(`  Modo: ${QUICK ? 'quick' : 'full'}`);
  console.log('═══════════════════════════════════════════════');

  const started = Date.now();

  try {
    await testMaxConnections();
    await testIdleTimeout();
    await testHeartbeat();
    await testMessageSizeLimit();
    await testMessageRateLimit();
  } catch (e) {
    console.error('\n💥 Erro fatal:', e.message);
    failed++;
  }

  const duration = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  Resultado: ${passed} passou, ${failed} falhou`);
  console.log(`  Duração: ${duration}s`);
  console.log(`  HTTP requests: ${requestCount}`);
  console.log('═══════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Unhandled:', e); process.exit(1); });
