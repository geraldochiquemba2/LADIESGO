#!/usr/bin/env node
/**
 * monitor-writes.mjs — Monitor de quota de escritas D1
 *
 * Uso:
 *   node scripts/monitor-writes.mjs --status     # Ver quota atual
 *   node scripts/monitor-writes.mjs --watch      # Monitor em tempo real
 *   node scripts/monitor-writes.mjs --can-write  # Exit 0 se pode escrever, 1 se bloqueado
 *   node scripts/monitor-writes.mjs --verify     # Verificar integridade da BD
 *
 * Limites D1 Free: 100.000 escritas/dia (reset 00:00 UTC)
 * Alerta: 80% (80.000) | Bloqueio: 90% (90.000)
 */

import { createHash } from 'crypto';

// ─── Configuração ───────────────────────────────────────────────
const LIMIT = 100_000;
const ALERT_THRESHOLD = 0.80; // 80%
const BLOCK_THRESHOLD = 0.90; // 90%
const ALERT_WRITES = Math.floor(LIMIT * ALERT_THRESHOLD);
const BLOCK_WRITES = Math.floor(LIMIT * BLOCK_THRESHOLD);

// ─── Helpers ────────────────────────────────────────────────────
function utcNow() {
  return new Date().toISOString();
}

function utcDayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatNumber(n) {
  return n.toLocaleString('pt-PT');
}

function statusBar(current, max, width = 30) {
  const pct = current / max;
  const filled = Math.round(pct * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const emoji = pct >= BLOCK_THRESHOLD ? '🔴' : pct >= ALERT_THRESHOLD ? '🟡' : '🟢';
  return `${emoji} [${bar}] ${formatNumber(current)}/${formatNumber(max)} (${(pct * 100).toFixed(1)}%)`;
}

// ─── D1 Query Helper ────────────────────────────────────────────
async function getD1() {
  // Em produção, o binding D1 é injetado via workerd
  // Este script corre via wrangler d1 execute ou com binding local
  const { execSync } = await import('child_process');

  // Tenta usar wrangler d1 execute para obter contagem
  try {
    const result = execSync(
      'npx wrangler d1 execute ladiesgo --remote --json --command "SELECT COUNT(*) as total FROM places"',
      { encoding: 'utf-8', timeout: 30000, cwd: new URL('..', import.meta.url).pathname }
    );
    return JSON.parse(result);
  } catch (e) {
    return null;
  }
}

// ─── Contagem de Escritas (via métricas ou estimativa) ─────────
async function getWriteCount() {
  // Opção 1: tabela de métricas no D1 (se existir)
  try {
    const { execSync } = await import('child_process');
    const result = execSync(
      `npx wrangler d1 execute ladiesgo --remote --json --command "SELECT COALESCE(SUM(rows_written), 0) as total FROM _write_metrics WHERE day = '${utcDayKey()}'"`,
      { encoding: 'utf-8', timeout: 30000, cwd: new URL('..', import.meta.url).pathname }
    );
    const data = JSON.parse(result);
    if (data && data[0] && typeof data[0].total === 'number') {
      return { source: '_write_metrics', total: data[0].total };
    }
  } catch {
    // tabela não existe ou erro — usa fallback
  }

  // Opção 2: estimativa baseada em timestamp de import
  try {
    const { execSync } = await import('child_process');
    const result = execSync(
      `npx wrangler d1 execute ladiesgo --remote --json --command "SELECT COUNT(*) as total FROM places WHERE imported_at >= '${utcDayKey()}T00:00:00Z'"`,
      { encoding: 'utf-8', timeout: 30000, cwd: new URL('..', import.meta.url).pathname }
    );
    const data = JSON.parse(result);
    if (data && data[0] && typeof data[0].total === 'number') {
      return { source: 'places.imported_at', total: data[0].total };
    }
  } catch {
    // fallback final
  }

  return { source: 'unknown', total: 0 };
}

// ─── Verificar se pode escrever ─────────────────────────────────
function canWrite(currentWrites) {
  if (currentWrites >= BLOCK_WRITES) {
    return { allowed: false, reason: `BLOQUEADO: ${formatNumber(currentWrites)}/${formatNumber(LIMIT)} (${((currentWrites / LIMIT) * 100).toFixed(1)}%)` };
  }
  if (currentWrites >= ALERT_WRITES) {
    return { allowed: true, reason: `ALERTA: ${formatNumber(currentWrites)}/${formatNumber(LIMIT)} — acima de 80%`, warning: true };
  }
  return { allowed: true, reason: `OK: ${formatNumber(currentWrites)}/${formatNumber(LIMIT)}` };
}

// ─── Comandos ───────────────────────────────────────────────────
async function cmdStatus() {
  const { source, total } = await getWriteCount();
  const { allowed, reason } = canWrite(total);

  console.log(`\n📊 Monitor de Escritas D1 — ${utcNow()}`);
  console.log(`   Fonte: ${source}`);
  console.log(`   ${statusBar(total, LIMIT)}`);
  console.log(`   Estado: ${reason}`);
  console.log(`   Limite: ${formatNumber(LIMIT)} escritas/dia (reset 00:00 UTC)`);
  console.log(`   Alerta: ${formatNumber(ALERT_WRITES)} | Bloqueio: ${formatNumber(BLOCK_WRITES)}`);
  console.log('');
}

async function cmdWatch(intervalMs = 30000) {
  console.log(`\n👁️  Monitor em tempo real (intervalo: ${intervalMs / 1000}s)`);
  console.log(`   Ctrl+C para parar\n`);

  let lastTotal = -1;

  while (true) {
    const { source, total } = await getWriteCount();
    const { allowed, warning } = canWrite(total);

    if (total !== lastTotal) {
      const ts = new Date().toLocaleTimeString('pt-PT');
      console.log(`[${ts}] ${statusBar(total, LIMIT)} — ${allowed ? (warning ? '⚠️ ALERTA' : '✅ OK') : '🔴 BLOQUEADO'}`);
      lastTotal = total;
    }

    if (!allowed) {
      console.error(`\n🛑 ESCRITAS BLOQUEADAS. Quota diária esgotada. Reset às 00:00 UTC.`);
      process.exit(1);
    }

    await sleep(intervalMs);
  }
}

async function cmdCanWrite() {
  const { total } = await getWriteCount();
  const { allowed, reason } = canWrite(total);

  if (!allowed) {
    console.error(`❌ ${reason}`);
    process.exit(1);
  }
  console.log(`✅ ${reason}`);
  process.exit(0);
}

async function cmdVerify() {
  console.log('\n🔍 Verificação de integridade D1\n');

  try {
    const { execSync } = await import('child_process');
    const cwd = new URL('..', import.meta.url).pathname;

    // Contagem de places
    const places = JSON.parse(execSync(
      'npx wrangler d1 execute ladiesgo --remote --json --command "SELECT COUNT(*) as total, COUNT(DISTINCT id) as unique_ids, SUM(CASE WHEN hash IS NULL OR hash = \'\' THEN 1 ELSE 0 END) as missing_hash FROM places"',
      { encoding: 'utf-8', timeout: 30000, cwd }
    ));

    const p = places[0];
    console.log(`   Places: ${formatNumber(p.total)} registos (${formatNumber(p.unique_ids)} únicos)`);
    console.log(`   Hash em falta: ${formatNumber(p.missing_hash)}`);

    if (p.missing_hash > 0) {
      console.log(`   ⚠️  ATENÇÃO: ${formatNumber(p.missing_hash)} registos sem hash — import incremental pode reescrevê-los`);
    }

    // Verificar tabela de métricas
    try {
      const metrics = JSON.parse(execSync(
        'npx wrangler d1 execute ladiesgo --remote --json --command "SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'_write_metrics\'"',
        { encoding: 'utf-8', timeout: 30000, cwd }
      ));
      console.log(`   Tabela _write_metrics: ${metrics.length ? '✅ existe' : '❌ não existe'}`);
    } catch {
      console.log(`   Tabela _write_metrics: ❌ não existe`);
    }

    // Places por dia (últimos 7 dias)
    try {
      const byDay = JSON.parse(execSync(
        `npx wrangler d1 execute ladiesgo --remote --json --command "SELECT date(imported_at) as day, COUNT(*) as count FROM places GROUP BY day ORDER BY day DESC LIMIT 7"`,
        { encoding: 'utf-8', timeout: 30000, cwd }
      ));
      console.log(`\n   Importações por dia (últimos 7):`);
      for (const row of byDay) {
        console.log(`     ${row.day}: ${formatNumber(row.count)}`);
      }
    } catch {
      console.log(`   (imported_at não disponível)`);
    }

    console.log('');
  } catch (e) {
    console.error(`   ❌ Erro: ${e.message}`);
    process.exit(1);
  }
}

// ─── Main ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const command = args[0] || '--status';

switch (command) {
  case '--status':
    await cmdStatus();
    break;
  case '--watch':
    await cmdWatch(parseInt(args[1]) || 30000);
    break;
  case '--can-write':
    await cmdCanWrite();
    break;
  case '--verify':
    await cmdVerify();
    break;
  case '--help':
  case '-h':
    console.log(`
Monitor de Escritas D1 — LADIESGO

Uso:
  node scripts/monitor-writes.mjs [--status|--watch|--can-write|--verify]

Opções:
  --status     Ver quota atual (default)
  --watch [ms]  Monitor em tempo real (intervalo padrão: 30s)
  --can-write   Exit 0 se pode escrever, 1 se bloqueado (para scripts CI/CD)
  --verify      Verificar integridade da BD

Limites:
  D1 Free: ${formatNumber(LIMIT)} escritas/dia (reset 00:00 UTC)
  Alerta: ${formatNumber(ALERT_WRITES)} | Bloqueio: ${formatNumber(BLOCK_WRITES)}
`);
    break;
  default:
    console.error(`Comando desconhecido: ${command}`);
    console.error('Usa --help para ver opções');
    process.exit(1);
}
