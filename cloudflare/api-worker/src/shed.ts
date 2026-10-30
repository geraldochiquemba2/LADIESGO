// src/shed.ts — nível de "corte de carga" vindo da tabela `system_flags`.
//
// O vigilante (scripts/quota-watch.mjs --apply-shed) lê a quota REAL da conta na
// GraphQL Analytics API e escreve aqui o nível. Os contadores de budget.ts são
// por isolate e não servem para decidir isto — este é o único sinal da CONTA.
//
//   0  normal
//   1  pesquisa de lugares não toca na D1 (usa cache; Photon/Nominatim no lugar)
//   2  + histórico devolve 8 viagens em vez de 30
//
// Custo: 1 linha lida por isolate a cada 60 s (no máximo ~1,4 mil linhas/dia).
// Se a tabela não existir (staging antes da migração 0021) ou a D1 falhar, o
// nível fica em 0 e não se volta a tentar durante 5 min — nunca parte a app.
import { makeSql as neon } from './db';

const TTL_MS = 60_000;
const FAIL_MS = 300_000;

let level = 0;
let readAt = 0;
let failUntil = 0;

export async function shedLevel(env: any): Promise<number> {
  const now = Date.now();
  if (now < failUntil) return level;
  if (readAt && now - readAt < TTL_MS) return level;
  readAt = now;
  try {
    const sql = neon(env.DB);
    const rows: any[] = await sql`SELECT value FROM system_flags WHERE key = 'quota_shed'`;
    const v = Number(rows && rows[0] && rows[0].value);
    level = Number.isFinite(v) ? Math.max(0, Math.min(2, Math.trunc(v))) : 0;
  } catch {
    failUntil = now + FAIL_MS;
  }
  return level;
}

// Só para os testes / /health: último nível lido neste isolate.
export function shedState(): { level: number; readAt: number } {
  return { level, readAt };
}
