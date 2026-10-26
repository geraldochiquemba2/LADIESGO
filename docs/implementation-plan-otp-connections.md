# Plano de Implementação — OTP de Viagem + Gestão Avançada de Ligações

> **Nota (2026-10-26):** a conta Cloudflare oficial é `rererererererere670@gmail.com`. Referências a "conta nova" / `wrangler.newaccount.toml` / isabel neste documento são históricas; ver `AGENTS.md`.

**Projeto:** LADIESGO · **Data:** 2026-10-17 · **Estado:** proposta para implementação
**Âmbito:** `cloudflare/api-worker` (Worker de API em produção, conta nova `2ebfcbf70c6ea8d2b84130041528e249`) + cliente `mobile/src/services/socket.ts`

---

## 0. Contexto e diagnóstico

### 0.1 O que já existe (não partir do zero)

| Mecanismo | Onde | Estado |
|---|---|---|
| PIN de 4 dígitos **determinístico** derivado do `tripId` (`pinForTrip`) | `cloudflare/api-worker/src/index.ts:93`, `backend/src/trips/trips.service.ts:22`, webapp (`pinJS`) | ✅ Existe, mas **não é aleatório**, **não expira**, **não tem limite de tentativas** e qualquer pessoa que conheça o `tripId` o consegue calcular |
| Verificação no arranque | `PUT /api/v1/trips/:id/start` (api-worker `index.ts:971`) e `backend/.../trips.service.ts:223` | ✅ Só arranca se `pin === pinForTrip(id)` |
| PIN só é revelado à passageira | `index.ts:853` (`pin` só quando `user.sub === t.passengerId`) e `trips.service.ts:179` | ✅ Correto |
| Push "dita o teu código de segurança" | `pushPaxArrived` (`index.ts:731`) | ✅ Existe (disparado em `DRIVER_ARRIVED`) |
| WebSocket hibernável com auto-pong | `TripPush`, `RequestsHub`, `DriverGeo` (`index.ts:2459/2674/2727`) | ✅ Auto-resposta `ping→pong` (`setWebSocketAutoResponse`), mas **sem heartbeat ativo do servidor, sem idle timeout, sem limite de ligações, sem limite de tamanho de mensagem** |
| Reconnect no cliente | `mobile/src/services/socket.ts:141` (canal viagem) e `:428` (canal pedidos) | ⚠️ **Linear** (`2000ms × tentativa`, máx 15s, aborta após 10) — sem jitter, sem tratamento de código 1013 |

### 0.2 Gaps a fechar

**TAREFA 1 — OTP:**
1. O PIN atual é determinístico e eterno → substituir (no fluxo nativo) por **OTP aleatório gerado no `accept`**, guardado em D1 (não existe Redis no plano Free; ver §1.3).
2. OTP **expira ao fim de 10 min** (`OTP_TTL_SECONDS`).
3. **Limite de tentativas** (ex.: 5) → resposta `400` com `attemptsLeft`.
4. OTP revelado **só à passageira** e **uma única vez por transição de estado** (limpo no `start`/`cancel`/`complete`).
5. Compatibilidade: o webapp continua a usar `pinForTrip` (determinístico) — o `/start` aceita **ou** o OTP válido **ou** o pin legado (ver §1.6).

**TAREFA 2 — Ligações:**
1. **Pool por DO:** máx **1000** sockets WS por Durable Object (o `RequestsHub` e o `DriverGeo` são DOs globais — são o gargalo; `TripPush` é 1 DO/viagem, ≤2 sockets, não precisa de teto).
2. **Shedding:** a **80 %** (800 sockets) o Worker rejeita upgrades com `429 + Retry-After`; no teto rígido (1000) o DO fecha de imediato com **código 1013**.
3. **Heartbeat:** servidor envia `{"t":"ping"}` a cada **30 s** (via `alarm()` — um `interval` não sobrevive à hibernação do DO); o cliente responde `{"t":"pong"}`.
4. **Idle timeout:** 60 s sem **qualquer** dado (inclui pong) → `close(1008, 'idle')`. `lastActivity` vive no attachment do socket (sobrevive à hibernação).
5. **Backoff exponencial com jitter** no cliente (substitui o linear atual).

**TAREFA 3 — Tamanho de mensagem:**
1. Máx **64 KB** por frame WS (`WS_MAX_MESSAGE_BYTES`).
2. Rejeitar com **close 1009** + `console.warn` com contexto (DO, userId, tamanho) para depuração.

### 0.3 Referência

O padrão de verificação de viagem por OTP segue o repositório **SaiKrishnaMulukutla/uber** (clon Uber com ride OTP):

1. Motorista **aceita** o pedido → backend gera OTP aleatório de 4 dígitos e guarda-o **com TTL** (lá: Redis; aqui: D1 — ver §1.3).
2. A **passageira vê o código** na app e **dita-o à motorista** no ponto de recolha.
3. A motorista **introduz o código** para iniciar a viagem; o backend **não transiciona** para `IN_PROGRESS` sem o código correto.
4. O código **expira** (aqui: 10 min) e tem **tentativas limitadas** — depois disso a viagem não arranca e é preciso recomeçar o fluxo.

---

## 1. TAREFA 1 — OTP de viagem (4 dígitos, anti "ghost rides")

### 1.1 Arquitetura

```
PUT /trips/:id/accept                GET /trips/:id (passageira)
        │                                     │
        ▼                                     ▼
┌──────────────────────┐           ┌──────────────────────┐
│ gera OTP aleatório   │           │ devolve { otp }      │
│ (4 dígitos, crypto)  │           │ só se: passageira E  │
│                      │           │ status ∈ {ACCEPTED,  │
│ UPDATE trips SET     │           │   DRIVER_ARRIVED} E  │
│  otpCode=           │           │ não expirado E        │
│  otpExpiresAt=now+  │           │ attempts < MAX        │
│    OTP_TTL_SECONDS   │           └──────────────────────┘
│  otpAttempts=0       │
└──────────────────────┘
        │
        ▼  passageira dita o código à motorista
PUT /trips/:id/start  { pin?, otp? }
        │
        ▼
verificação (status=DRIVER_ARRIVED ∧ não expirado ∧ attempts<MAX ∧ código igual)
   ├─ falha → UPDATE trips SET otpAttempts=otpAttempts+1  → 400 { attemptsLeft }
   └─ ok    → UPDATE trips SET status='IN_PROGRESS', otpCode=NULL, ... (condicional)
```

### 1.2 Decisão de armazenamento: D1 (e porquê não Redis/KV/DO)

- **Redis:** não existe no plano Free dos Workers. ❌
- **KV:** exigiria um binding novo (quota KV separada, ~1k writes/s) —Overkill para 1-2 escritas por viagem. ❌
- **Durable Object (TripPush):** storage do DO não conta para a quota D1 ⚠️, mas o OTP tem de ser verificado **atomicamente com a transição de estado** no `start` (dentro do mesmo `UPDATE ... WHERE status='DRIVER_ARRIVED'`); passar pelo DO adiciona um salto Worker→DO em cada tentativa e complica a corrida de tentativas. ❌
- **D1 (escolhida):** 1 escrita no `accept` + 1 escrita **só em tentativa falhada** (no máximo `OTP_MAX_ATTEMPTS` por viagem). Com ~50 viagens/dia reais isso é `<200 escritas/dia` — ruído nos 100k/dia da quota (ver regras no `AGENTS.md`). ✅

### 1.3 Migração D1

Ficheiro: `cloudflare/api-worker/migrations/0009_trip_otp.sql`

```sql
-- OTP de viagem (4 dígitos): gerado no accept, expira em OTP_TTL_SECONDS.
-- Aplicar com: wrangler d1 migrations apply ladiesgo --config wrangler.newaccount.toml
ALTER TABLE trips ADD COLUMN "otpCode" TEXT;        -- 4 chars (código em claro; ver nota de segurança §1.7)
ALTER TABLE trips ADD COLUMN "otpExpiresAt" TEXT;   -- ISO 8601 UTC; NULL = sem OTP ativo
ALTER TABLE trips ADD COLUMN "otpAttempts" INTEGER; -- tentativas falhadas desde o último accept
```

> Nota: o adaptador `db.ts` (`translate()`) já trata `NOW()` → `strftime(...)` e casts; os `ALTER` acima são executados diretamente pelo `wrangler`, não pelo `translate`.

### 1.4 Módulo `src/otp.ts` (novo)

```ts
// src/otp.ts — OTP de viagem: 4 dígitos aleatórios, expiração e tentativas.
// Padrão: SaiKrishnaMulukutla/uber — gerar no accept, verificar antes do start.

export function otpTtlMs(env: any): number {
  return Math.max(0, Number(env.OTP_TTL_SECONDS || 600)) * 1000; // default 10 min
}
export function otpMaxAttempts(env: any): number {
  return Math.max(1, Math.min(20, Number(env.OTP_MAX_ATTEMPTS || 5)));
}

// 4 dígitos com distribuição uniforme (amostragem por rejeição sobre uint32).
export function generateOtp(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / 10000) * 10000; // 2^32 não é múltiplo de 10000
  let v = 0;
  do { crypto.getRandomValues(buf); v = buf[0]; } while (v >= limit);
  return String(v % 10000).padStart(4, '0');
}

// Comparação em tempo constante (mesmo padrão de verifyPassword do index.ts).
export function otpEquals(a: string, b: string): boolean {
  const sa = String(a || ''), sb = String(b || '');
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

export function otpExpired(t: any): boolean {
  if (!t?.otpExpiresAt) return true;
  const exp = new Date(t.otpExpiresAt).getTime();
  return !Number.isFinite(exp) || Date.now() > exp;
}
```

### 1.5 Alterações no `src/index.ts`

**`Env` (linha 7)** — adicionar `OTP_TTL_SECONDS?: string; OTP_MAX_ATTEMPTS?: string;`.

**a) `PUT /api/v1/trips/:id/accept` (linha ~893)** — gerar OTP após o `UPDATE` atómico bem-sucedido:

```ts
  const rows = await sql`UPDATE trips SET "driverId" = ${did}, status = 'ACCEPTED', "acceptedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${id} AND status = 'REQUESTED' RETURNING *`;
  if (!rows.length) return c.json({ message: 'Viagem indisponível.' }, 400);
  // OTP: 1 escrita D1 por aceitação (quota: ver AGENTS.md — 100k escritas/dia).
  const otp = generateOtp();
  await sql`UPDATE trips SET "otpCode" = ${otp}, "otpExpiresAt" = ${new Date(Date.now() + otpTtlMs(c.env)).toISOString()}, "otpAttempts" = 0, "updatedAt" = NOW() WHERE id = ${id}`;
  pushStatus(c, id, 'ACCEPTED');
  hubPoke(c);
  return c.json(rows[0]);
```

**b) `GET /api/v1/trips/:id` (linha ~853)** — revelar o OTP à passageira (substitui/complementa o `pin` legado):

```ts
  const pin = user.sub === t.passengerId ? pinForTrip(t.id) : undefined;
  // OTP só à passageira, só enquanto é preciso ditar o código (ACCEPTED/DRIVER_ARRIVED),
  // só se estiver válido e com tentativas disponíveis.
  let otp: string | undefined;
  if (user.sub === t.passengerId && (t.status === 'ACCEPTED' || t.status === 'DRIVER_ARRIVED')
    && t.otpCode && !otpExpired(t) && Number(t.otpAttempts || 0) < otpMaxAttempts(c.env)) {
    otp = String(t.otpCode);
  }
  return c.json({ ...t, driver, ...(pin ? { pin } : {}), ...(otp ? { otp } : {}) });
```

**c) `PUT /api/v1/trips/:id/start` (linha ~971)** — verificar OTP antes de arrancar:

```ts
app.put('/api/v1/trips/:id/start', requireAuth, async (c) => {
  const sql = neon(c.env.DB);
  const { pin, otp } = await c.req.json().catch(() => ({}));
  const id = c.req.param('id');
  const cur = await sql`SELECT * FROM trips WHERE id = ${id} LIMIT 1`;
  if (!cur.length || cur[0].status !== 'DRIVER_ARRIVED') return c.json({ message: 'Transição inválida.' }, 400);
  const t = cur[0];
  const code = String(pin || otp || '').trim();
  // Legado: o webapp usa o pin determinístico (pinJS). OTP tem prioridade; o pin legado
  // mantém-se como compatibilidade até o webapp passar a pedir o código à passageira.
  const legacyOk = code !== '' && otpEquals(code, pinForTrip(id));
  const otpOk = code.length === 4 && t.otpCode && !otpExpired(t)
    && Number(t.otpAttempts || 0) < otpMaxAttempts(c.env)
    && otpEquals(code, String(t.otpCode));
  if (!otpOk && !legacyOk) {
    // 1 escrita D1 SÓ em falha (máx OTP_MAX_ATTEMPTS por viagem).
    await sql`UPDATE trips SET "otpAttempts" = COALESCE("otpAttempts", 0) + 1, "updatedAt" = NOW() WHERE id = ${id} AND status = 'DRIVER_ARRIVED'`;
    const left = Math.max(0, otpMaxAttempts(c.env) - (Number(t.otpAttempts || 0) + 1));
    return c.json({ message: left > 0 ? 'Código incorreto. Pede o código de 4 dígitos à passageira.' : 'Código bloqueado por demasiadas tentativas. Cancela e volta a pedir.', attemptsLeft: left }, 400);
  }
  // Guarda de transição: o WHERE status='DRIVER_ARRIVED' faz com que, em corrida
  // (dois toques simultâneos), só um pedido arranque.
  const rows = await sql`UPDATE trips SET status = 'IN_PROGRESS', "startedAt" = NOW(), "updatedAt" = NOW(), "otpCode" = NULL, "otpExpiresAt" = NULL, "otpAttempts" = 0 WHERE id = ${id} AND status = 'DRIVER_ARRIVED' RETURNING *`;
  if (!rows.length) return c.json({ message: 'Transição inválida.' }, 400);
  pushStatus(c, id, 'IN_PROGRESS');
  return c.json(rows[0]);
});
```

**d) `PUT /api/v1/trips/:id/cancel` e `/complete`** — limpar o OTP (higiene; evita reutilização):

```ts
// cancel: acrescentar ao UPDATE:
//   "otpCode" = NULL, "otpExpiresAt" = NULL, "otpAttempts" = 0
// complete: idem (a viagem terminou; o código deixa de ter utilidade).
```

**e) Push (opcional mas recomendado)** — no `accept`, avisar a passageira com o código (o `pushPaxArrived` atual já diz "Dita o teu código de segurança"; passa a incluí-lo):

```ts
// após o UPDATE do accept, best-effort (mesmo padrão de pushPaxArrived):
c.executionCtx.waitUntil((async () => {
  const sql2 = neon(c.env.DB);
  const r = await sql2`SELECT u."fcmToken" FROM trips t JOIN users u ON u.id = t."passengerId" WHERE t.id = ${id} LIMIT 1`;
  const tok = r[0]?.fcmToken;
  if (!tok || !String(tok).startsWith('ExponentPushToken')) return;
  await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ to: tok, sound: 'default', title: '🦋 Motorista a caminho!',
      body: `Dita este código à tua motorista: ${otp}`, data: { tripId: id, type: 'otp-issued' } }]) });
})().catch(() => {}));
```

### 1.6 Regras de verificação

| Regra | Implementação |
|---|---|
| OTP gerado **no accept** (não antes) | §1.5a — só existe após `status='ACCEPTED'` |
| Expira ao fim de **10 min** | `otpExpiresAt = now + OTP_TTL_SECONDS` (default 600) + checagem `otpExpired(t)` no `start` |
| Motorista **não lê** o OTP | `otp` na resposta só quando `user.sub === t.passengerId` (§1.5b) |
| Motorista **não arranca sem código correto** | §1.5c — `UPDATE` condicional só corre após verificação |
| Tentativas limitadas | `otpAttempts < OTP_MAX_ATTEMPTS` (default 5); falha incrementa (1 escrita) |
| Sem reutilização | OTP limpo (`NULL`) no `start` bem-sucedido, no `cancel` e no `complete` |
| Nova viagem → novo OTP | `accept` regressa sempre `otpAttempts=0` e código novo |
| Compatibilidade web | Pin determinístico (`pinForTrip`) continua a ser aceite no `/start` (§1.5c) |

### 1.7 Nota de segurança (código em claro)

O OTP é guardado em claro na D1 (4 dígitos, TTL de 10 min, por viagem). É o mesmo compromisso do padrão de referência (Redis em claro) e é aceitável porque:
a D1 já contém dados bem mais sensíveis (telemóveis, fotos, posições); a superfície de ataque é "quem lê a D1", não o canal cliente-servidor. Se no futuro quiseres hash: `SHA-256(salt + otp)` com `crypto.subtle.digest` (sem custo PBKDF2) — mas aí a **deixa de ser relida pela passageira**, o que quebraria o fluxo "dita o código"; daí a escolha de claro. Documenta esta decisão no PR.

### 1.8 Paridade com o backend NestJS (secundário)

A produção corre no Worker; o `backend/` (NestJS + Prisma) mantém-se como implementação de referência/self-host. Aplicar o mesmo contrato em `backend/src/trips/trips.service.ts`:
- `acceptTrip`: gerar `generateOtp()` e escrever `otpCode/otpExpiresAt/otpAttempts` no `updateMany` (ou num segundo `update`).
- `startTrip`: substituir o `pinForTrip` determinístico pela verificação de OTP (mesma tabela de regras da §1.6), **mantendo** o parâmetro `pin?` como legado web.
- Prisma: adicionar `otpCode`, `otpExpiresAt`, `otpAttempts` ao modelo `Trip` + migration.

---

## 2. TAREFA 2 — Gestão avançada de ligações WebSocket

### 2.1 Arquitetura

```
Cliente ──WS upgrade──► Worker (Hono)                      Durable Object
   │                     │                                     │
   │                     ├─ wsGate(env, DO) ──GET /stats──►  │ count vs shedAt?
   │                     │   429+Retry-After se ≥80%           │ sim → rejeita (não faz upgrade)
   │                     │   null → deixa passar               │
   │                     └─ forward p/ DO (fetch upgrade)     │
   │                                                          ├─ fetch(): gate rígido
   │                                                          │   count ≥ MAX(1000) → accept+close(1013)
   │                                                          ├─ acceptWebSocket + attachment
   │                                                          │   { uid, role, lastActivity, ... }
   │                                                          ├─ setAlarm(now + 30s)  ← heartbeat
   │                                                          ├─ alarm(): p/ cada socket:
   │                                                          │   idle>60s → close(1008)
   │                                                          │   else → send('{"t":"ping"}')
   │                                                          └─ webSocketMessage():
   │                                                              size>64KB → close(1009)+warn
   │                                                              else lastActivity=now
   ◄── {"t":"ping"} ──┘
   ── {"t":"pong"} ──► (qualquer dados reinicia o idle de 60s)
```

**Onde o teto se aplica:** `RequestsHub` (1 DO global, todos os motoristas online) e `DriverGeo` (1 DO global). `TripPush` = 1 DO por viagem (≤2 sockets: motorista + passageira) — não precisa de teto. O Worker conta os sockets **antes** de fazer o upgrade (chamada `GET /stats` ao DO) e aplica o **soft-shed a 80 %**; o **hard-cap de 1000** é aplicado no DO (accept + `close(1013)`).

### 2.2 Módulo `src/ws.ts` (novo) — guarda partilhado

```ts
// src/ws.ts — guarda de ligações WS partilhado pelos DOs (TripPush, RequestsHub,
// DriverGeo). Pool de 1000 sockets por DO, heartbeat 30s, idle 60s, 64KB/frame.
// Os limites vêm de env (WS_*) para staging poder encurtar (ex.: idle=5s em teste).

export const WS_DEFAULTS = {
  MAX_CONNECTIONS: 1000,   // teto rígido por DO
  SHED_PERCENT: 80,        // soft-shed nesta percentagem do teto
  HEARTBEAT_MS: 30_000,    // servidor → {"t":"ping"}
  IDLE_TIMEOUT_MS: 60_000, // sem dados (inclui pong) → close(1008)
  MAX_MESSAGE_BYTES: 65_536, // 64 KB por frame → close(1009)
};

export function wsCfg(env: any) {
  const max = Math.max(1, Number(env.WS_MAX_CONNECTIONS || WS_DEFAULTS.MAX_CONNECTIONS));
  return {
    max,
    shedAt: Math.floor(max * Math.min(100, Math.max(1, Number(env.WS_SHED_PERCENT || WS_DEFAULTS.SHED_PERCENT))) / 100),
    heartbeatMs: Math.max(5_000, Number(env.WS_HEARTBEAT_MS || WS_DEFAULTS.HEARTBEAT_MS)),
    idleMs: Math.max(5_000, Number(env.WS_IDLE_TIMEOUT_MS || WS_DEFAULTS.IDLE_TIMEOUT_MS)),
    maxBytes: Math.max(1024, Number(env.WS_MAX_MESSAGE_BYTES || WS_DEFAULTS.MAX_MESSAGE_BYTES)),
  };
}

export function byteSize(raw: any): number {
  if (raw == null) return 0;
  if (typeof raw === 'string') return new TextEncoder().encode(raw).length;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  return new TextEncoder().encode(String(raw)).length;
}

export function wsLog(env: any, msg: string, extra?: any) {
  // Log estruturado para /debug/logs e para o alerta de sizing (1009).
  console.warn(JSON.stringify({ ws: true, dsn: env.WS_DO_NAME || 'ws', msg, ts: Date.now(), ...(extra || {}) }));
}

export class WsGuard {
  state: any; env: any; cfg: ReturnType<typeof wsCfg>;
  constructor(state: any, env: any) { this.state = state; this.env = env; this.cfg = wsCfg(env); }
  socks(): any[] { try { return this.state.getWebSockets() || []; } catch { return []; } }
  info(ws: any): any { try { return ws.deserializeAttachment() || {}; } catch { return {}; } }
  save(ws: any, att: any) { try { ws.serializeAttachment(att); } catch {} }

  // Soft-shed (80%): chamado pelo Worker antes do upgrade. Devolve true se deve rejeitar.
  async shouldShed(): Promise<boolean> {
    const r = await this.stats();
    return r.count >= this.cfg.shedAt;
  }
  async stats(): Promise<{ count: number; shedAt: number; max: number }> {
    return { count: this.socks().length, shedAt: this.cfg.shedAt, max: this.cfg.max };
  }
  // Hard-cap: chamado no fetch() do DO antes de acceptWebSocket.
  overCapacity(): boolean { return this.socks().length >= this.cfg.max; }

  // Chamado em CADA mensagem recebida: valida tamanho + refresca lastActivity.
  async onMessage(ws: any, raw: any): Promise<boolean> {
    const size = byteSize(raw);
    if (size > this.cfg.maxBytes) {
      wsLog(this.env, 'oversized message rejected', { size, max: this.cfg.maxBytes });
      try { ws.close(1009, 'message too big'); } catch {}
      return false;
    }
    const att = this.info(ws);
    att.lastActivity = Date.now();
    this.save(ws, att);
    return true;
  }

  // Heartbeat (alarm-driven): ping a cada 30s; fecha idle > 60s.
  async tick(): Promise<void> {
    const now = Date.now();
    for (const s of this.socks()) {
      const att = this.info(s);
      if (now - Number(att.lastActivity || 0) > this.cfg.idleMs) {
        wsLog(this.env, 'idle timeout', { idleMs: now - Number(att.lastActivity || 0) });
        try { s.close(1008, 'idle'); } catch {}
        continue;
      }
      try { s.send('{"t":"ping"}'); } catch {}
    }
    try { await this.state.storage.setAlarm(now + this.cfg.heartbeatMs); } catch {}
  }
}
```

> **Porquê `alarm()` e não `setInterval`?** Um DO hibernável não tem timers entre hibernações — o `alarm()` é o único mecanismo de tempo que sobrevive. O `RequestsHub`/`DriverGeo` acordam 1×/30s (custo desprezível). O auto-response `ping→pong` (existente) mantém-se para os 'ping' literais do cliente (não acorda o DO).

### 2.3 Alterações nos Durable Objects (`src/index.ts`)

**`RequestsHub` (linha ~2674):**

```ts
export class RequestsHub {
  state: any; env: any;
  guard: WsGuard;
  constructor(state: any, env: any) {
    this.state = state; this.env = env;
    this.guard = new WsGuard(state, env);
    try { this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch {}
  }
  async fetch(req: any) {
    const u = new URL(req.url);
    if (req.method === 'POST' && u.pathname.endsWith('/broadcast')) { /* …inalterado… */ }
    if (req.method === 'GET' && u.pathname.endsWith('/stats'))
      return new Response(JSON.stringify({ ...(await this.guard.stats()), dsn: 'requests-hub' }), { headers: { 'Content-Type': 'application/json' } });
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket')
      return new Response('Expected websocket', { status: 426 });
    // Hard-cap (1000): handshake aceitado e fechado de imediato com 1013.
    if (this.guard.overCapacity())
      return this.rejectCapacity(req);
    const pair: any = new WebSocketPair();
    const client = pair[0], server = pair[1];
    const driverId = String(req.headers.get('X-Driver-Id') || '');
    let cats: string[] = [];
    try { cats = JSON.parse(req.headers.get('X-Cats') || '[]'); } catch {}
    try {
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ driverId, cats, lastActivity: Date.now() });
      this.guard.save(server, { driverId, cats, lastActivity: Date.now() });
    } catch { return new Response('WS failed', { status: 500 }); }
    try { this.state.storage.setAlarm(Date.now() + this.guard.cfg.heartbeatMs).catch(() => {}); } catch {}
    return new Response(null, { status: 101, webSocket: client });
  }
  // 101 seguido de close 1013 — o cliente vê o código correto ( RFC 6455).
  rejectCapacity(req: any): Response {
    try {
      const pair: any = new WebSocketPair();
      const server = pair[1];
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ rejected: 1013 });
      try { server.close(1013, 'worker at capacity'); } catch {}
      return new Response(null, { status: 101, webSocket: pair[0] });
    } catch { return new Response('WS failed', { status: 500 }); }
  }
  async webSocketMessage(ws: any, raw: any) {
    if (!(await this.guard.onMessage(ws, raw))) return; // 1009 já tratado dentro
    // …lógica de /broadcast inalterada (não há mensagens de cliente neste canal)…
  }
  async webSocketClose(_ws: any, _c: any, _r: any, _w: any) {}
  async webSocketError(ws: any, _e: any) { try { ws.close(1011, 'err'); } catch {} }
  async alarm() { await this.guard.tick(); }
  socks(): any[] { try { return this.state.getWebSockets(); } catch { return []; } }
}
```

**`DriverGeo` (linha ~2727):** mesmo padrão — `guard` no constructor, `/stats` no `fetch`, `overCapacity()` antes do `acceptWebSocket`, `guard.onMessage` no `webSocketMessage` (após o parse, ou antes? — o tamanho é validado **antes** do parse: `guard.onMessage` primeiro, depois o `JSON.parse` existente), `alarm() { await this.guard.tick(); }`. O `lastActivity` é atualizado em **qualquer** frame GPS válido (os fixes de GPS contam como atividade: um motorista a conduzir nunca fica "idle").

**`TripPush` (linha ~2459):** adicionar `guard` apenas para **tamanho de mensagem** (64KB) — o teto de 1000 não se aplica (1 DO/viagem). O `webSocketMessage` existente começa com `JSON.parse`; inserir `if (!(await this.guard.onMessage(ws, raw))) return;` antes.

### 2.4 Soft-shed no Worker (antes do upgrade)

Helper em `src/index.ts`:

```ts
// Soft-shed (80%): pergunta ao DO quantos sockets tem antes de reencaminhar o
// upgrade. Assim o 1013 só acontece se o /stats falhar ou a fila crescer entre
// a pergunta e o accept (corrida) — o DO continua a ser a última linha de defesa.
async function wsGate(c: any, stub: any): Promise<boolean> {
  try {
    const r = await stub.fetch(new Request('https://ws-guard/stats'));
    const j = await r.json().catch(() => null);
    if (j && Number(j.count) >= Number(j.shedAt)) return true;
  } catch {}
  return false;
}
```

Nas três rotas de upgrade (`requests-live` linha ~607, `drivers/live-geo` linha ~641, `trips/:id/live` linha ~797), **antes** de `return stub.fetch(...)`:

```ts
if (await wsGate(c, stub))
  return c.json({ message: 'Servidor ocupado. Tenta em instantes.', retryAfterSec: 30 }, 429, { 'Retry-After': '30' });
```

### 2.5 Cliente — backoff exponencial com jitter + tratamento do 1013

Em `mobile/src/services/socket.ts` (ambos os canais: viagem `:141` e pedidos `:428`):

```ts
// ── Backoff exponencial com jitter (full jitter: 50-100% do exp) ──
const WS_BACKOFF_CAP_MS = 30_000;
function jitterDelay(attempt: number): number {
  const exp = Math.min(1000 * 2 ** attempt, WS_BACKOFF_CAP_MS); // 1s, 2s, 4s, 8s… 30s
  return Math.round(exp * (0.5 + Math.random() * 0.5));
}

private scheduleReconnect(): void {
  if (this.reconnectT || !this.wsTripId) return;
  if (this.wsAttempts >= 15) { this.stopHeartbeat(); return; } // desiste → fallback polling (8s)
  this.wsAttempts += 1;
  const delay = jitterDelay(this.wsAttempts - 1);
  this.reconnectT = setTimeout(async () => { …inalterado… }, delay);
}
```

E no `onclose` dos dois canais:

```ts
sock.onclose = (ev: any) => {
  this.stopHeartbeat();
  if (ev?.code === 1013) {
    // Worker em sobrecarga: backoff longo + fallback a polling durante 60s.
    this.wsAttempts = Math.min(this.wsAttempts + 5, 20);
    this.startRequestsFallback(); // canal pedidos; no canal viagem o fallback é o pollTrip (8s) da app
  }
  …resto inalterado…
};
```

**Resposta ao servidor (ping/pong):** no `onWsMessage` (canal viagem) e no `onmessage` (canal pedidos):

```ts
if (m && m.t === 'ping') this.sendWs({ t: 'pong' });   // qualquer dados reinicia o idle de 60s
```

---

## 3. TAREFA 3 — Validação de tamanho de mensagem

Já incluído na `WsGuard.onMessage` (§2.2) — aplicar nos 3 DOs (§2.3):

- **Limite:** `WS_MAX_MESSAGE_BYTES` (default 65536 = 64 KB).
- **Rejeição:** `ws.close(1009, 'message too big')` — código 1009 = "message too big" (RFC 6455).
- **Log:** `wsLog(...)` com `{ size, max, dsn }` → aparece em `/debug/logs` (e nas métricas do log de `wrangler`). O log **não** inclui o conteúdo da mensagem (apenas tamanho + contexto), para não ampliar a superfície.

---

## 4. Variáveis de ambiente

### 4.1 Tabela

| Variável | Default | Tipo | Função | Onde |
|---|---|---|---|---|
| `OTP_TTL_SECONDS` | `600` | string (segundos) | Expiração do OTP (10 min) | `wrangler.newaccount.toml [vars]` + conta nova |
| `OTP_MAX_ATTEMPTS` | `5` | string (int) | Tentativas falhadas antes de bloquear | idem |
| `WS_MAX_CONNECTIONS` | `1000` | string (int) | Teto rígido de sockets WS por DO | idem |
| `WS_SHED_PERCENT` | `80` | string (int) | Soft-shed (429+Retry-After) nesta % do teto | idem |
| `WS_HEARTBEAT_MS` | `30000` | string (ms) | Intervalo do ping do servidor | idem |
| `WS_IDLE_TIMEOUT_MS` | `60000` | string (ms) | Sem dados → close(1008) | idem |
| `WS_MAX_MESSAGE_BYTES` | `65536` | string (bytes) | Máx por frame → close(1009) | idem |

### 4.2 Em `wrangler.newaccount.toml`

```toml
[vars]
JWT_EXPIRES_IN = "7d"
OTP_TTL_SECONDS = "600"        # OTP expira ao fim de 10 minutos
OTP_MAX_ATTEMPTS = "5"         # tentativas falhadas antes de bloquear o código
WS_MAX_CONNECTIONS = "1000"    # teto rígido de WS por Durable Object
WS_SHED_PERCENT = "80"         # rejeita upgrades a 80% (429 + Retry-After)
WS_HEARTBEAT_MS = "30000"      # servidor pinge a cada 30s
WS_IDLE_TIMEOUT_MS = "60000"   # 60s sem dados → close(1008)
WS_MAX_MESSAGE_BYTES = "65536" # 64KB por frame → close(1009)
```

**Staging (conta de testes / `wrangler dev`):** usar valores curtos para testar sem esperar 10 min: `OTP_TTL_SECONDS=5`, `WS_IDLE_TIMEOUT_MS=10000`, `WS_HEARTBEAT_MS=5000`, `WS_MAX_CONNECTIONS=20`. **Nunca** correr testes de carga contra produção (`AG.md` — incidente de 2026-10-17).

### 4.3 Feature flag de emergência

`OTP_TTL_SECONDS=0` → desliga o OTP (o `/start` volta a aceitar só o pin legado) — útil como rollback rápido sem redeploy.

---

## 5. Estratégia de testes

### 5.1 Unitários (novos, `cloudflare/api-worker/test/`)

Sem runner instalado hoje — adicionar `vitest` (devDep) ou usar `node:test` (node ≥18). Testar **puramente**:

| Função | Casos |
|---|---|
| `generateOtp()` | 4 dígitos, sempre 1000-9999 (padding), sem repetição em 10k amostras |
| `otpEquals(a,b)` | igual/diferente, tempo constante (sem throw em tamanhos diferentes) |
| `otpExpired(t)` | expiração exata, `otpExpiresAt` nulo/malformado |
| `byteSize(raw)` | string (UTF-8 multi-byte conta bytes), ArrayBuffer, object |
| `jitterDelay(n)` | dentro de `[0.5·exp, exp]`, nunca acima do cap |
| `wsCfg(env)` | defaults, limites (mín/max), env inválido |

### 5.2 Integração (staging — conta 2ª / `wrangler dev`)

Script `cloudflare/api-worker/test/otp.e2e.mjs` (node, `fetch` + `ws` — o `e2e/` já usa este padrão). **Nunca contra produção.**

| # | Caso | Esperado |
|---|---|---|
| 1 | passageira pede viagem → motorista aceita | `GET /trips/:id` da passageira traz `otp` (4 dígitos); `attemptsLeft` implícito |
| 2 | motorista (ou terceiros) lê `/trips/:id` | sem campo `otp` (só `pin` legado para a passageira) |
| 3 | `start` com OTP errado ×5 | 400 + `attemptsLeft` 4…1; à 6ª: "bloqueado" |
| 4 | `start` com OTP certo | 200, `status='IN_PROGRESS'`, `otpCode=NULL` |
| 5 | expiração (staging `OTP_TTL_SECONDS=5`) | após 5s: 400 "expirado" |
| 6 | cancel | `otpCode/otpExpiresAt/otpAttempts` limpos |
| 7 | nova viagem após cancel | OTP **diferente** do anterior |
| 8 | pin legado (webapp) | `start` com `pinForTrip(id)` continua a funcionar |
| 9 | `GET /trips/:id` do motorista **após** `start` | sem `otp` (já consumido) |

Script `cloudflare/api-worker/test/ws.e2e.mjs`:

| # | Caso | Esperado |
|---|---|---|
| 1 | servidor pinge | cliente recebe `{"t":"ping"}` em ≤35s; responde pong |
| 2 | idle | sem dados 61s → socket fecha com código **1008** |
| 3 | oversized | frame de 64KB+1 → fecha com **1009**; log no `wrangler tail` mostra tamanho |
| 4 | heartbeat mantém vivo | com pong, socket sobrevive >2 min |
| 5 | hard-cap (staging `WS_MAX_CONNECTIONS=20`) | 21ª ligação fecha com **1013** |
| 6 | soft-shed (staging `WS_MAX_CONNECTIONS=20`, `WS_SHED_PERCENT=80`) | 17ª ligação → HTTP **429** + `Retry-After` |
| 7 | backoff | 10 falhas de ligação → delays 1s,2s,4s… com jitter (assert intervalo, não valor exato) |

### 5.3 Carga (staging apenas)

Adaptar `cloudflare/api-worker/loadtest/ws-storm.mjs` (já existente) para o `RequestsHub` (DO global): 500 sockets simultâneos, 10 min, medir: handshake p95, heartbeat ok, memória DO, close codes. **Proibido** contra `ladiesgo-api.ladiesgo-angola.workers.dev` (regra do `AGENTS.md` — incidentes de 2026-10-17).

### 5.4 Checklist de deploy

1. `wrangler d1 migrations apply ladiesgo --config wrangler.newaccount.toml` (migration 0009) — **antes** do deploy do Worker (colunas têm de existir).
2. `wrangler deploy --config wrangler.newaccount.toml`.
3. Smoke: aceitação gera OTP; passageira lê; motorista arranca com o código (fluxo §5.2 #1-4).
4. `wrangler tail` — confirmar `ws: true` logs e ausência de 1009/1013 em produção.
5. Rollback: `OTP_TTL_SECONDS=0` (feature flag) ou `wrangler rollback`.

---

## 6. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Quota D1 (100k escritas/dia) | OTP = 1 escrita no `accept` + 1 **só em falha** (≤5/viagem). Padrão de uso real: <200 escritas/dia |
| `setAlarm` não dispara se DO hibernar entre alarms | O alarm é reagendado no fim de cada `tick()`; o tráfego de clientes também acorda o DO |
| Heartbeat custa despertar o DO a cada 30s | 1 wake/30s por DO global — desprezível vs. quota de pedidos |
| Soft-shed rejeita clientes legítimos em pico | 429 + `Retry-After` + backoff com jitter no cliente → a carga espalha-se; teto rígido só como último recurso |
| Auto-pong (cliente→servidor) esconde idle real | O idle conta **qualquer** dados, incluindo o pong ao ping do servidor |
| PIN legado continua válido no `/start` | Compatibilidade com o webapp; remover o fallback quando o webapp adotar OTP (registar follow-up) |
| `getWebSockets().length` no soft-shed é assíncrono | O DO é a última defesa (hard-cap) se o `/stats` falhar ou a contagem mudar entre a pergunta e o accept |

---

## 7. Ficheiros a criar/modificar

| Ficheiro | Ação |
|---|---|
| `cloudflare/api-worker/src/otp.ts` | **novo** — `generateOtp`, `otpEquals`, `otpExpired`, `otpTtlMs`, `otpMaxAttempts` |
| `cloudflare/api-worker/src/ws.ts` | **novo** — `WsGuard`, `wsCfg`, `byteSize`, `wsLog` |
| `cloudflare/api-worker/src/index.ts` | **modificar** — `Env`, accept (§1.5a), `GET /:id` (§1.5b), `/start` (§1.5c), cancel/complete (§1.5d), push OTP (§1.5e), `wsGate` (§2.4), `RequestsHub`/`DriverGeo`/`TripPush` (§2.3) |
| `cloudflare/api-worker/migrations/0009_trip_otp.sql` | **novo** — colunas `otpCode/otpExpiresAt/otpAttempts` |
| `cloudflare/api-worker/wrangler.newaccount.toml` | **modificar** — 7 vars novas (§4.2) |
| `mobile/src/services/socket.ts` | **modificar** — `jitterDelay` (§2.5), resposta a `{"t":"ping"}`, tratamento do 1013 |
| `backend/src/trips/trips.service.ts` (secundário) | **modificar** — paridade OTP no NestJS (§1.8) |
| `cloudflare/api-worker/test/otp.e2e.mjs`, `test/ws.e2e.mjs` | **novo** — testes de integração staging (§5.2) |
