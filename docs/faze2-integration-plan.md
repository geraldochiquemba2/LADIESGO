# Fase 2 — Integração no index.ts (não aplicado ainda — preservar código atual)

Esse arquivo documenta as alterações que ainda precisam ser feitas no `src/index.ts` para completar a Fase 2.

## O que ainda precisa ser integrado no DriverGeo:

1. **Importar módulos novos:**
   ```ts
   import { geoSet, geoQuery, geoDel, geoGet, geoMetaMany } from './geo-redis';
   import { newBucket, tryConsume } from './ratelimit';
   import { WS_MAX_MESSAGE_BYTES, WS_IDLE_TIMEOUT_MS, WS_HEARTBEAT_MS, armHeartbeat } from './conn-limit';
   import { UpstashRedis } from './upstash';
   ```

2. **Substituir `setPos()` por `geoSet()` do Redis:**
   No `webSocketMessage()` (linha ~2870) e no `/set` do DO:
   ```ts
   await geoSet(this.env, { userId, lat: m.lat, lng: m.lng, cats: m.cats, online: true });
   // Em vez de: this.setPos(userId, ...)
   ```

3. **Substituir `geoAll()` por `geoQuery()`:**
   No `/all` do DO (linha ~2859) e no `buildOfferQueue()`:
   ```ts
   const cands = await geoQuery(this.env, lat, lng, 5, 40);
   // Em vez de: iterar this.pos.values()
   ```

4. **Token bucket no `webSocketMessage`:**
   ```ts
   const att = ws.deserializeAttachment() || {};
   if (!att.bucket) att.bucket = newBucket();
   if (!tryConsume(att.bucket, 1)) { ws.close(1008, 'rate limit'); return; }
   ws.serializeAttachment(att);
   ```

5. **Cap de mensagem (64KB):**
   ```ts
   const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw).length : (raw?.byteLength || 0);
   if (bytes > WS_MAX_MESSAGE_BYTES) { ws.close(1009, 'mensagem grande'); return; }
   ```

6. **Heartbeat via DO alarm:**
   Adicionar `armHeartbeat()` no `fetch()` quando aceita WS, e implementar `alarm()` no DO.

7. **Load shedding (rejeitar a 800):**
   Contador de conexões no Redis (`rl:ws:total`); rejeitar upgrade com 1013 quando atingir 800.

## Porquê ainda não aplicado?
- O código atual (`index.ts`) tem ~2900 linhas e uma estrutura complexa (DOs híbridos com memória + D1).
- A substituição completa leva ~2-3 horas de testes para garantir que não há regressão.
- A Fase 1 já está funcional (rate limiting + backdoor removido) — a Fase 2 pode ser aplicada gradualmente por módulo.

## Recomendação:
Aplicar por partes:
1. Primeiro: `geoSet` no `DriverGeo.webSocketMessage` (baixo risco)
2. Depois: `geoQuery` no `/drivers/nearby` e `/all`
3. Por fim: token bucket + heartbeat + load shedding
