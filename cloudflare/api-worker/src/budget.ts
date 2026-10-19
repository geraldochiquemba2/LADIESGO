// src/budget.ts — Contadores por isolate (pedidos HTTP + LINHAS lidas/escritas na D1),
// com reset diário às 00:00 UTC (alinha com o reset de quota da Cloudflare).
// Avisa aos 80% de cada teto; circuit-breaker de ESCRITAS aos 100% (as leituras
// continuam — o teto de leituras é 50x maior, só avisa).
// NOTA: os Durable Objects correm em isolates próprios e têm os seus próprios
// contadores; este módulo cobre o isolate da API (o tráfego principal).
const SOFT = 0.8;
const BLOCK_RATIO = 0.9;
const DEFAULT_REQ_MAX = 90000;    // 100k pedidos/dia (Free) — com margem
const DEFAULT_WRITE_MAX = 90000;  // 100k linhas escritas/dia (Free) — com margem
const DEFAULT_READ_MAX = 4500000; // 5M linhas lidas/dia (Free) — com margem

let day = '';
let requests = 0;
let writes = 0;
let reads = 0;
let warnedReq = false;
let warnedWrite = false;
let warnedRead = false;
let reqLimit = DEFAULT_REQ_MAX;
let writeLimit = DEFAULT_WRITE_MAX;
let readLimit = DEFAULT_READ_MAX;

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
    reads = 0;
    warnedReq = false;
    warnedWrite = false;
    warnedRead = false;
  }
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function configureBudget(env: any): void {
  const r = num(env && env.BUDGET_REQ_MAX);
  if (r) reqLimit = r;
  const w = num(env && env.BUDGET_WRITE_MAX);
  if (w) writeLimit = w;
  const rd = num(env && env.BUDGET_READ_MAX);
  if (rd) readLimit = rd;
}

export function bumpRequest(env?: any): void {
  configureBudget(env);
  roll();
  requests++;
  if (!warnedReq && requests >= warnAt(reqLimit)) {
    warnedReq = true;
    console.error(`[budget] pedidos/dia a ${requests} (teto ${reqLimit})`);
  }
}

export function markWrite(n = 1): void {
  roll();
  writes += Math.max(1, n | 0);
  if (!warnedWrite && writes >= warnAt(writeLimit)) {
    warnedWrite = true;
    console.error(`[budget] LINHAS ESCRITAS/dia a ${writes} (teto ${writeLimit})`);
  }
}

export function markRead(n = 1): void {
  roll();
  reads += Math.max(0, n | 0);
  if (!warnedRead && reads >= warnAt(readLimit)) {
    warnedRead = true;
    console.error(`[budget] LINHAS LIDAS/dia a ${reads} (teto ${readLimit})`);
  }
}

export function budgetState(): { requests: number; writes: number; reads: number; reqLimit: number; writeLimit: number; readLimit: number; warn: boolean; blocked: boolean } {
  roll();
  return {
    requests,
    writes,
    reads,
    reqLimit,
    writeLimit,
    readLimit,
    warn: requests >= warnAt(reqLimit) || writes >= warnAt(writeLimit) || reads >= warnAt(readLimit),
    blocked: writes >= writeLimit,
  };
}

export function isWriteBlocked(): boolean {
  roll();
  return writes >= writeLimit;
}

export function shouldWarn(): boolean {
  roll();
  return requests >= warnAt(reqLimit) || writes >= warnAt(writeLimit) || reads >= warnAt(readLimit);
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
