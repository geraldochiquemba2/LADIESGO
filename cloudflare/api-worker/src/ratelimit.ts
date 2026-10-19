// Fase 2 — Token bucket por socket + limites de conexão
export function newBucket(capacity = 100, refillPerSec = 10) {
  return { tokens: capacity, capacity, refillPerSec, lastRefill: Date.now() };
}
export function tryConsume(bucket: any, n = 1): boolean {
  const now = Date.now();
  const gained = ((now - bucket.lastRefill) / 1000) * bucket.refillPerSec;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + gained);
  bucket.lastRefill = now;
  if (bucket.tokens < n) return false;
  bucket.tokens -= n;
  return true;
}
