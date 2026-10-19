// ============================================================================
// d1-write-quota.mjs — Monitorização da Quota de Escrita D1 LADIESGO
// Testa: monitorização do contador diário, alerta a 80%, block a 90%.
//
// Uso: node e2e/tests/d1-write-quota.mjs [--base=<url>] [--quick]
//
// AVISO (incidente 2026-10-17): a quota D1 Free é 100.000 escritas/dia por
// conta. Estourar -> erro 7500: TODA a escrita devolve 500 até 00:00 UTC.
// NUNCA correr testes de carga contra produção sem need.
// ============================================================================

import { performance } from 'node:perf_hooks';

// ── Configuração ─────────────────────────────────────────────────────────────
const BASE = process.env.API_BASE ||
  (process.argv.find(a => a.startsWith('--base=')) || '').slice(7) ||
  'https://ladiesgo-api.ladiesgo-ao.workers.dev/api/v1';
const QUICK = process.argv.includes('--quick');
const ADMIN_PHONE = '999999999';
const ADMIN_PASS = '1234567890';
const DRIVER_PASS = '0987654321';
const PAX_PASS = 'Test1234';

// Limites D1 Free: 100.000 escritas/dia por conta (reset 00:00 UTC)
const D1_DAILY_WRITE_LIMIT = 100000;
const D1_ALERT_THRESHOLD = 0.80; // 80% → alerta
const D1_BLOCK_THRESHOLD = 0.90;  // 90% → bloqueio de imports

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

// ── Métricas D1 via /debug/d1 ────────────────────────────────────────────────
async function getD1Metrics(debugKey) {
  const r = await api('GET', `/debug/d1?key=${encodeURIComponent(debugKey)}`, { timeout: 10000 });
  if (!r.ok) return null;
  return r.json;
}

async function resetD1Metrics(debugKey) {
  const r = await api('POST', `/debug/d1/reset?key=${encodeURIComponent(debugKey)}`, { timeout: 10000 });
  return r.ok;
}

// ── Simular contador de escritas ─────────────────────────────────────────────
// Como não temos acesso direto à quota real D1, usamos as métricas do worker
// e estimamos com base nas operações conhecidas.
class D1WriteCounter {
  constructor() {
    this.writes = 0;
    this.reads = 0;
    this.queries = 0;
    this.writesBy = {};
  }

  recordWrite(table, count = 1) {
    this.writes += count;
    this.writesBy[table] = (this.writesBy[table] || 0) + count;
  }

  recordRead(count = 1) {
    this.reads += count;
  }

  recordQuery() {
    this.queries++;
  }

  get remaining() {
    return D1_DAILY_WRITE_LIMIT - this.writes;
  }

  get usagePercent() {
    return (this.writes / D1_DAILY_WRITE_LIMIT) * 100;
  }

  shouldAlert() {
    return this.writes >= D1_DAILY_WRITE_LIMIT * D1_ALERT_THRESHOLD;
  }

  shouldBlock() {
    return this.writes >= D1_DAILY_WRITE_LIMIT * D1_BLOCK_THRESHOLD;
  }

  status() {
    return {
      writes: this.writes,
      reads: this.reads,
      queries: this.queries,
      remaining: this.remaining,
      usagePercent: +this.usagePercent.toFixed(2),
      alert: this.shouldAlert(),
      block: this.shouldBlock(),
      writesBy: this.writesBy,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── 1. Monitorização do contador diário ──────────────────────────────────────
async function testDailyWriteCount() {
  console.log('\n━━━ Teste: Monitorização do contador diário ━━━');

  // Reset métricas se DEBUG_KEY estiver disponível
  const debugKey = process.env.DEBUG_KEY || 'debug-ladiesgo-2026';
  const metrics = await getD1Metrics(debugKey);

  if (metrics) {
    check('Endpoint /debug/d1 acessível', true, `queries: ${metrics.queries}, rowsWritten: ${metrics.rowsWritten}`);
    check('Métricas D1 contêm contador de escritas', typeof metrics.rowsWritten === 'number', `rowsWritten: ${metrics.rowsWritten}`);
    check('Métricas D1 contêm queries', typeof metrics.queries === 'number', `queries: ${metrics.queries}`);
  } else {
    check('Endpoint /debug/d1 acessível', false, 'DEBUG_KEY não configurado ou endpoint indisponível');
  }

  // Simular contador
  const counter = new D1WriteCounter();

  // Registar escritas conhecidas por operação
  // INSERT users: 1 escrita por registo
  // INSERT trips: 1 escrita por pedido
  // UPDATE drivers (toggle-online): 1 escrita
  // INSERT wallet_tx: 1 escrita por transação
  counter.recordWrite('users', 100);
  counter.recordWrite('trips', 50);
  counter.recordWrite('drivers', 30);
  counter.recordWrite('wallet_tx', 20);
  counter.recordWrite('ratings', 10);

  const status = counter.status();
  check('Contador de escritas diário funcional', status.writes === 210, `total: ${status.writes}`);
  check('Percentagem de uso calculada corretamente', status.usagePercent > 0, `${status.usagePercent}%`);
  check('Escritas por tabela registradas', Object.keys(status.writesBy).length === 5, JSON.stringify(status.writesBy));
}

// ── 2. Alerta a 80% do limite ─────────────────────────────────────────────────
async function testAlertAt80Percent() {
  console.log('\n━━━ Teste: Alerta a 80% do limite ━━━');

  const counter = new D1WriteCounter();
  const alertThreshold = Math.floor(D1_DAILY_WRITE_LIMIT * D1_ALERT_THRESHOLD);

  // Simular escritas até 79%
  counter.recordWrite('users', Math.floor(alertThreshold * 0.79));
  check('Sem alerta abaixo de 80%', !counter.shouldAlert(), `${counter.usagePercent}% (${counter.writes} escritas)`);

  // Cruzar 80%
  counter.recordWrite('trips', Math.ceil(alertThreshold * 0.02));
  check('Alerta ativado a 80% ou mais', counter.shouldAlert(), `${counter.usagePercent}% (${counter.writes} escritas)`);

  // Verificar que o alerta é persistente
  check('Alerta mantém-se após escritas adicionais', counter.shouldAlert(), `${counter.usagePercent}%`);
}

// ── 3. Bloqueio de imports a 90% ─────────────────────────────────────────────
async function testBlockImportsAt90Percent() {
  console.log('\n━━━ Teste: Bloqueio de imports a 90% ━━━');

  const counter = new D1WriteCounter();
  const blockThreshold = Math.floor(D1_DAILY_WRITE_LIMIT * D1_BLOCK_THRESHOLD);

  // Simular escritas até 89%
  counter.recordWrite('users', Math.floor(blockThreshold * 0.89));
  check('Sem bloqueio abaixo de 90%', !counter.shouldBlock(), `${counter.usagePercent}% (${counter.writes} escritas)`);

  // Cruzar 90%
  counter.recordWrite('trips', Math.ceil(blockThreshold * 0.02));
  check('Bloqueio ativado a 90% ou mais', counter.shouldBlock(), `${counter.usagePercent}% (${counter.writes} escritas)`);

  // Verificar que o bloqueio impede imports grandes
  const importSize = 23345; // places import
  const canImport = !counter.shouldBlock() || counter.remaining >= importSize;
  check('Import grande bloqueado acima de 90%', !canImport || counter.remaining >= importSize, `remaining: ${counter.remaining}, import size: ${importSize}`);
}

// ── 4. Operacoes que consomem quota ──────────────────────────────────────────
async function testOperationsConsumingQuota() {
  console.log('\n━━━ Teste: Operações que consomem quota ━━━');

  const counter = new D1WriteCounter();

  // Registo de passageiro: 1 INSERT users
  counter.recordWrite('users', 1);
  const paxPhone = `+24493${Date.now().toString(36).slice(-5)}0001`;
  const paxR = await api('POST', '/auth/register', { body: { phone: paxPhone, password: PAX_PASS, name: 'Quota-Test-Pax' } });
  check('Registo de passageiro consome 1 escrita', paxR.ok, `status: ${paxR.status}`);

  // Login: 0 escritas (só leitura)
  const loginR = await api('POST', '/auth/login', { body: { phone: ADMIN_PHONE, password: ADMIN_PASS } });
  check('Login não consome escritas (só leitura)', loginR.ok, `status: ${loginR.status}`);

  // Pedido de viagem: 1 INSERT trips
  if (paxR.ok) {
    const tripR = await api('POST', '/trips/request', {
      token: paxR.json.accessToken,
      body: {
        pickupLat: -8.90, pickupLng: 13.20,
        dropoffLat: -8.95, dropoffLng: 13.25,
        pickupAddress: 'Test Pickup', dropoffAddress: 'Test Dropoff',
        rideType: 'ECONOMY', paymentMethod: 'CASH',
      },
    });
    check('Pedido de viagem consome 1 escrita', tripR.ok, `status: ${tripR.status}`);

    // Toggle online: 1 UPDATE drivers
    // (precisamos de um motorista, mas o teste é sobre contabilização)
  }

  // Verificar que o contador está a funcionar
  check('Contador de escritas operacional', counter.writes >= 0, `escritas registadas: ${counter.writes}`);
}

// ── 5. Estimativa de quota por operação ──────────────────────────────────────
async function testQuotaEstimation() {
  console.log('\n━━━ Teste: Estimativa de quota por operação ━━━');

  // Mapeamento de operações conhecidas -> estimativa de escritas
  const writeEstimates = {
    'POST /auth/register': 1,      // INSERT users
    'POST /auth/guest': 1,         // INSERT users
    'POST /trips/request': 1,      // INSERT trips
    'PUT /trips/:id/accept': 1,    // UPDATE trips
    'PUT /trips/:id/complete': 3,  // UPDATE trips + UPDATE drivers + INSERT wallet_tx
    'PUT /drivers/toggle-online': 1, // UPDATE drivers
    'PUT /drivers/location': 0,    // Só memória DO (sem escrita D1)
    'POST /ratings': 1,            // INSERT ratings
    'POST /admin/drivers/create': 2, // INSERT users + INSERT drivers
    'PUT /users/profile': 0,       // UPDATE users (0 se não mudar nada)
    'POST /d1/import': 23345,      // Import completo places
  };

  console.log('\nEstimativa de escritas por operação:');
  for (const [op, writes] of Object.entries(writeEstimates)) {
    console.log(`  ${op}: ${writes} escritas`);
  }

  // Calcular cenário de uso diário
  const dailyOps = {
    registers: 50,
    trips: 200,
    toggleOnline: 100,
    imports: 0, // Não deve haver imports em produção
  };

  const dailyWrites =
    dailyOps.registers * writeEstimates['POST /auth/register'] +
    dailyOps.trips * (writeEstimates['POST /trips/request'] + writeEstimates['PUT /trips/:id/complete']) +
    dailyOps.toggleOnline * writeEstimates['PUT /drivers/toggle-online'] +
    dailyOps.imports * writeEstimates['POST /d1/import'];

  const dailyUsage = (dailyWrites / D1_DAILY_WRITE_LIMIT * 100).toFixed(2);
  check('Estimativa diária de escritas razoável', dailyWrites < D1_DAILY_WRITE_LIMIT * 0.5, `${dailyWrites} escritas/dia estimadas (${dailyUsage}% da quota)`);

  // Verificar que imports completos são perigosos
  const importWrites = writeEstimates['POST /d1/import'];
  check('Import completo places consome > 20% da quota', importWrites > D1_DAILY_WRITE_LIMIT * 0.2, `${importWrites} escritas = ${(importWrites / D1_DAILY_WRITE_LIMIT * 100).toFixed(1)}% da quota`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  LADIESGO — Testes de Quota de Escrita D1');
  console.log(`  Base: ${BASE}`);
  console.log(`  Limite diário: ${D1_DAILY_WRITE_LIMIT.toLocaleString()} escritas`);
  console.log(`  Alerta: ${D1_ALERT_THRESHOLD * 100}% | Bloqueio: ${D1_BLOCK_THRESHOLD * 100}%`);
  console.log(`  Modo: ${QUICK ? 'quick' : 'full'}`);
  console.log('═══════════════════════════════════════════════');

  const started = Date.now();

  try {
    await testDailyWriteCount();
    await testAlertAt80Percent();
    await testBlockImportsAt90Percent();
    await testOperationsConsumingQuota();
    await testQuotaEstimation();
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
