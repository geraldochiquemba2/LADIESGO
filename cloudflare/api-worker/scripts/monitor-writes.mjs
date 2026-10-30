#!/usr/bin/env node
/**
 * monitor-writes.mjs — DESCONTINUADO. Usa `scripts/quota-watch.mjs`.
 *
 * PORQUÊ: a versão antiga estava errada em dois pontos que se pagavam caro:
 *   1. "media" as escritas com `SELECT COUNT(*) FROM places` — ou seja, lia as
 *      23 mil linhas de `places` na D1 de produção a cada chamada, exactamente
 *      o tipo de query que esgota a quota de LEITURAS;
 *   2. procurava uma tabela `_write_metrics` que nunca existiu e, quando não a
 *      encontrava, devolvia `0` escritas — um "OK" falso.
 * O número autoritativo de escritas (e de leituras e de pedidos) é o da CONTA,
 * na GraphQL Analytics API. É isso que o quota-watch.mjs lê.
 *
 * Este ficheiro fica só como atalho, para não partir comandos antigos:
 *   --status     -> quota-watch (relatório do dia)
 *   --watch [ms] -> quota-watch em ciclo
 *   --can-write  -> quota-watch --guard writes=1 (sai != 0 se não houver folga)
 *   --verify     -> deixou de existir (não media nada de útil)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const target = path.join(here, 'quota-watch.mjs');
const args = process.argv.slice(2);
const cmd = args[0] || '--status';

function run(extra) {
  const r = spawnSync(process.execPath, [target, ...extra], { stdio: 'inherit' });
  process.exit(r.status == null ? 5 : r.status);
}

console.error('(monitor-writes.mjs está descontinuado — a usar quota-watch.mjs)');
if (cmd === '--status' || cmd === '') run([]);
else if (cmd === '--can-write') run(['--guard', 'writes=1', '--check', '--quiet']);
else if (cmd === '--watch') {
  const ms = Number(args[1]) > 0 ? Number(args[1]) : 60_000;
  console.log(`quota-watch em ciclo (${ms / 1000}s). Ctrl+C para parar.`);
  const tick = () => {
    const r = spawnSync(process.execPath, [target], { stdio: 'inherit' });
    if (r.status === 3 || r.status === 4) console.error('\n⛔ Quota perto do teto ou esgotada.');
  };
  tick();
  setInterval(tick, ms);
} else if (cmd === '--verify') {
  console.error('--verify foi removido: não media a quota. Usa `node scripts/quota-watch.mjs`.');
  process.exit(2);
} else if (cmd === '--help' || cmd === '-h') {
  console.log('Uso: node scripts/monitor-writes.mjs [--status|--watch [ms]|--can-write]  (atalho para quota-watch.mjs)');
} else {
  console.error('Comando desconhecido: ' + cmd);
  process.exit(2);
}
