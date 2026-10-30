// src/quota.ts — vigilante da quota DIÁRIA da conta Free, a correr no Worker.
//
// Porque existe: o workflow `.github/workflows/quota-watch.yml` está certo, mas o
// AGENDADOR do GitHub não cumpre neste repositório. Prova medida (30/10/2026): o
// antigo `keep-alive` tinha `cron: '*​/10 * * * *'` (144 execuções/dia esperadas) e
// fez **29 execuções em 6,8 dias**, com intervalos de **3 a 10 horas**. O
// `quota-watch` (de 3 em 3 horas) ficou com **0 execuções** nos slots das 12:00Z e
// 15:00Z do dia em que entrou na `main`. Um guarda que não corre não guarda nada.
//
// Aqui corre dentro do cron por minuto que o Worker JÁ tem (`* * * * *`), portanto
// **0 pedidos extra** ao Worker: só nos minutos HH:00 de 3 em 3 horas é que faz o
// trabalho (1 chamada à GraphQL Analytics) e há um "claim" em D1 que impede
// repetições mesmo com vários isolates a bater ao mesmo tempo.
//
// Segredo necessário: `CF_ANALYTICS_TOKEN` (Account Analytics: Read + D1: Edit).
// Sem ele, isto não faz nada (no-op silencioso) — nunca parte a app.
//
// Custo: 1 subrequest GraphQL + ~4 linhas lidas/escritas em D1, de 3 em 3 horas.
import { makeSql as neon } from './db';

export const QUOTA_LIMITS = {
  requests: 100_000, // Workers pedidos/dia (erro 1027)
  reads: 5_000_000, // D1 linhas lidas/dia
  writes: 100_000, // D1 linhas escritas/dia (erro 7500)
  doRequests: 100_000, // Durable Objects pedidos/dia
  doGbSeconds: 13_000, // Durable Objects duração/dia
};

// Níveis = fração do teto (os mesmos limites do scripts/quota-watch.mjs).
const LEVELS = [
  { level: 0, name: 'OK', min: 0 },
  { level: 1, name: 'AVISO', min: 0.7 },
  { level: 2, name: 'ALTO', min: 0.85 },
  { level: 3, name: 'CRÍTICO', min: 0.92 },
  { level: 4, name: 'ESGOTADO', min: 1.0 },
];

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const DEFAULT_ACCOUNT = '016a8f9ed58a5cd10e9be697944905f0';
const MIN_GAP_MS = 90 * 60 * 1000; // não repetir antes de 90 min
const ALERT_GAP_MS = 6 * 3600 * 1000; // repetir o mesmo alerta no máximo 1x/6h

export type QuotaReading = {
  ts: number;
  account: string;
  level: number;
  levelName: string;
  worst: { key: string; used: number; max: number; pct: number };
  metrics: { key: string; used: number; max: number; pct: number }[];
  shed: number;
};

function levelOf(pct: number): number {
  let out = 0;
  for (const l of LEVELS) if (pct >= l.min) out = l.level;
  return out;
}

function levelName(level: number): string {
  return (LEVELS.find((l) => l.level === level) || LEVELS[0]).name;
}

function shedFor(level: number): number {
  // 0 = normal · 1 = pesquisa de lugares não toca na D1 (85%) · 2 = + histórico 8 (92%)
  // O AVISO (70%) só alerta — não corta nada.
  if (level >= 3) return 2;
  if (level >= 2) return 1;
  return 0;
}

async function gql(env: any, query: string, vars: any): Promise<any> {
  const token = String(env.CF_ANALYTICS_TOKEN || '');
  const r = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: vars }),
    signal: AbortSignal.timeout(20000),
  });
  const j: any = await r.json().catch(() => null);
  if (j && Array.isArray(j.errors) && j.errors.length) {
    throw new Error('graphql: ' + String(j.errors[0].message || 'erro'));
  }
  if (!r.ok || !j) throw new Error('graphql http ' + r.status);
  return j.data;
}

// Lê a quota do dia (00:00Z até agora) para a CONTA inteira.
export async function readQuota(env: any, account = String(env.CF_ACCOUNT_ID || DEFAULT_ACCOUNT)): Promise<QuotaReading> {
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const q = `query($a:String!,$s:Time!,$u:Time!){
    viewer { accounts(filter:{accountTag:$a}) {
      workersInvocationsAdaptive(limit:100, filter:{datetime_geq:$s, datetime_leq:$u}) { sum { requests } }
      d1AnalyticsAdaptiveGroups(limit:100, filter:{datetime_geq:$s, datetime_leq:$u}) { sum { rowsRead rowsWritten } }
      durableObjectsInvocationsAdaptiveGroups(limit:100, filter:{datetime_geq:$s, datetime_leq:$u}) { sum { requests } }
      durableObjectsPeriodicGroups(limit:100, filter:{datetime_geq:$s, datetime_leq:$u}) { sum { duration } }
    } }
  }`;
  const d = await gql(env, q, { a: account, s: since.toISOString(), u: now.toISOString() });
  const acc = d && d.viewer && d.viewer.accounts && d.viewer.accounts[0];
  if (!acc) throw new Error('sem dados de analytics');
  const sum = (arr: any[], pick: (r: any) => number) => (arr || []).reduce((t, r) => t + pick(r), 0);
  const requests = sum(acc.workersInvocationsAdaptive, (r) => Number(r.sum.requests || 0));
  const reads = sum(acc.d1AnalyticsAdaptiveGroups, (r) => Number(r.sum.rowsRead || 0));
  const writes = sum(acc.d1AnalyticsAdaptiveGroups, (r) => Number(r.sum.rowsWritten || 0));
  const doRequests = sum(acc.durableObjectsInvocationsAdaptiveGroups, (r) => Number(r.sum.requests || 0));
  // `sum.duration` já vem em GB-s (é o que o scripts/quota-watch.mjs soma direto).
  const doGbSeconds = sum(acc.durableObjectsPeriodicGroups, (r) => Number(r.sum.duration || 0));
  const raw = [
    { key: 'requests', used: requests, max: QUOTA_LIMITS.requests },
    { key: 'reads', used: reads, max: QUOTA_LIMITS.reads },
    { key: 'writes', used: writes, max: QUOTA_LIMITS.writes },
    { key: 'doRequests', used: doRequests, max: QUOTA_LIMITS.doRequests },
    { key: 'doGbSeconds', used: doGbSeconds, max: QUOTA_LIMITS.doGbSeconds },
  ];
  const metrics = raw.map((m) => ({ ...m, pct: m.max ? m.used / m.max : 0 }));
  const worst = metrics.reduce((a, b) => (b.pct > a.pct ? b : a));
  const level = levelOf(worst.pct);
  return { ts: Date.now(), account, level, levelName: levelName(level), worst, metrics, shed: shedFor(level) };
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + ' M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + ' k';
  return String(Math.round(n));
}

const NAMES: any = {
  requests: 'Workers pedidos',
  reads: 'D1 linhas lidas',
  writes: 'D1 linhas escritas',
  doRequests: 'DO pedidos',
  doGbSeconds: 'DO duração (GB-s)',
};

export function quotaText(r: QuotaReading): string {
  const lines = [`LadiesGo — quota Free (${new Date(r.ts).toISOString().slice(0, 16).replace('T', ' ')}Z)`];
  lines.push(`Nível: ${r.levelName} (${(r.worst.pct * 100).toFixed(1)}% em ${NAMES[r.worst.key] || r.worst.key})`);
  for (const m of r.metrics) {
    lines.push(`· ${NAMES[m.key] || m.key}: ${fmt(m.used)} / ${fmt(m.max)} = ${(m.pct * 100).toFixed(1)}%`);
  }
  if (r.shed) lines.push(`Corte de carga aplicado: quota_shed=${r.shed}`);
  return lines.join('\n');
}

async function tgSend(env: any, text: string): Promise<boolean> {
  try {
    const tok = String(env.TG_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || '');
    const chat = String(env.TG_CHAT_ID || env.TELEGRAM_CHAT_ID || '');
    if (!tok || !chat) return false;
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 3900), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Ponto de entrada chamado pelo cron. `force` ignora o intervalo mínimo.
// `fake` (só testes em staging) substitui a leitura real — prova o alerta e o
// corte de carga sem ter de gastar 85% da quota do dia.
// Nunca lança: qualquer erro é devolvido em `{ error }` e o cron segue.
export async function runQuotaWatch(env: any, force = false, fake?: QuotaReading | null): Promise<any> {
  const sql = neon(env.DB);
  try {
    if (!fake && !env.CF_ANALYTICS_TOKEN) return { skipped: 'sem CF_ANALYTICS_TOKEN' };
    // 1) último estado (também serve de "claim": se foi há < 90 min, não repete).
    let prev: any = null;
    try {
      const rows: any[] = await sql`SELECT value FROM system_flags WHERE key = 'quota_watch'`;
      if (rows && rows[0] && rows[0].value) prev = JSON.parse(String(rows[0].value));
    } catch {}
    if (!force && prev && prev.ts && Date.now() - Number(prev.ts) < MIN_GAP_MS) {
      return { skipped: 'recente', lastTs: prev.ts };
    }
    // 2) leitura da conta
    const r = fake || (await readQuota(env));
    // 3) alerta (Telegram) quando é ALTO+ ou quando o nível subiu — com anti-spam.
    const prevLevel = prev ? Number(prev.level || 0) : 0;
    const shouldAlert = r.level >= 2 || (r.level > prevLevel && r.level >= 1);
    let alerted = false;
    if (shouldAlert) {
      const lastAlert = prev && prev.alertTs ? Number(prev.alertTs) : 0;
      const escalate = r.level > prevLevel;
      if (escalate || Date.now() - lastAlert > ALERT_GAP_MS) {
        alerted = await tgSend(env, quotaText(r));
      }
    }
    // 4) corte de carga — escreve SEMPRE o nível mapeado (0 quando a conta está
    // calma), senão um dia mau deixava a app degradada para sempre. É a mesma
    // tabela/chave que o scripts/quota-watch.mjs usa, com o mesmo mapeamento.
    try {
      await sql`INSERT INTO system_flags (key, value, updatedAt) VALUES ('quota_shed', ${String(r.shed)}, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = CURRENT_TIMESTAMP`;
    } catch {}
    // 5) guardar o estado (1 linha escrita de 3 em 3 horas)
    const state = { ts: r.ts, level: r.level, levelName: r.levelName, pct: r.worst.pct, worst: r.worst.key, alertTs: alerted ? r.ts : (prev && prev.alertTs) || 0 };
    try {
      await sql`INSERT INTO system_flags (key, value, updatedAt) VALUES ('quota_watch', ${JSON.stringify(state)}, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = CURRENT_TIMESTAMP`;
    } catch {}
    return { ok: true, level: r.level, levelName: r.levelName, worst: r.worst, alerted, shed: r.shed };
  } catch (e) {
    return { error: String(e) };
  }
}

// Último estado guardado (para `GET /api/v1/admin/quota`).
export async function lastQuotaState(env: any): Promise<any> {
  try {
    const sql = neon(env.DB);
    const rows: any[] = await sql`SELECT key, value, updatedAt FROM system_flags WHERE key IN ('quota_watch','quota_shed')`;
    const out: any = { configured: !!env.CF_ANALYTICS_TOKEN };
    for (const row of rows || []) out[String(row.key)] = { value: row.value, updatedAt: row.updatedAt };
    return out;
  } catch (e) {
    return { configured: !!env.CF_ANALYTICS_TOKEN, error: String(e) };
  }
}
