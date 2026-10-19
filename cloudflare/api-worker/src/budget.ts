// src/budget.ts — Contadores por isolate (pedidos HTTP + escritas D1) com
// reset diário às 00:00 UTC (alinha com o reset de quota da Cloudflare).
// Tripwire aos 80% (console.error uma única vez) e circuit-breaker de
// escritas opcionais aos 100% (leituras continuam a funcionar).
const SOFT = 0.8;
const BLOCK_RATIO = 0.9;
const DEFAULT_MAX = 90000;

let day = '';
let requests = 0;
let writes = 0;
let warnedReq = false;
let warnedWrite = false;
let reqLimit = DEFAULT_MAX;
let writeLimit = DEFAULT_MAX;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function warnAt(limit: number): number {
  return Math.floor((limit / BLOCK_RATIO) * SOFT);
}

function roll(): void {
  const d = utcDay();
  if (d !== day) {
    day = d;
    requests = 0;
    writes = 0;
    warnedReq = false;
    warnedWrite = false;
  }
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function configureBudget(env: any): void {
  const r = num(env && env.BUDGET_REQ_MAX);
  const w = num(env && env.BUDGET_WRITE_MAX);
  if (r) reqLimit = r;
  if (w) writeLimit = w;
}

export function bumpRequest(env?: any): void {
  if (env) configureBudget(env);
  roll();
  requests++;
  if (!warnedReq && requests >= warnAt(reqLimit)) {
    warnedReq = true;
    console.error(`[budget] pedidos ${requests}/${reqLimit} — 80% da quota diária (tripwire)`);
  }
}

export function markWrite(env?: any): void {
  if (env) configureBudget(env);
  roll();
  writes++;
  if (!warnedWrite && writes >= warnAt(writeLimit)) {
    warnedWrite = true;
    console.error(`[budget] escritas ${writes}/${writeLimit} — 80% da quota diária (tripwire)`);
  }
}

export function budgetState(): { requests: number; writes: number; reqLimit: number; writeLimit: number; warn: boolean; blocked: boolean } {
  roll();
  return {
    requests,
    writes,
    reqLimit,
    writeLimit,
    warn: requests >= warnAt(reqLimit) || writes >= warnAt(writeLimit),
    blocked: writes >= writeLimit,
  };
}

export function isWriteBlocked(): boolean {
  roll();
  return writes >= writeLimit;
}

export function shouldWarn(): boolean {
  roll();
  return requests >= warnAt(reqLimit) || writes >= warnAt(writeLimit);
}

export function retryAfterSec(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

// Guarda de escritas: devolve a resposta 503 quando a quota está no teto,
// null quando se pode escrever. Só deve ser chamada em writes OPCIONAIS.
export function writeGuard(c: any): Response | null {
  if (!isWriteBlocked()) return null;
  const sec = retryAfterSec();
  return c.json(
    { message: 'Quota de escrita diária esgotada. Tenta de novo mais tarde.', retryAfterSec: sec },
    503,
    { 'Retry-After': String(sec) },
  );
}
