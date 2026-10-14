// src/db.ts — Adaptador D1 com a MESMA API do @neondatabase/serverless (sql`...`).
// Traduz o subconjunto Postgres usado pelo worker (index.ts) para SQLite/D1,
// para que os ~185 call-sites `sql\`...\`` não precisem de ser reescritos.
//
// - NOW()/date_trunc/to_timestamp/INTERVAL -> strftime(...) com formato ISO UTC
// - gen_random_uuid() -> UUID gerado no JS (inlined)
// - casts ::type removidos; TIMESTAMPTZ/JSONB/BOOLEAN/NUMERIC -> tipos SQLite
// - colunas JSON conhecidas são re-parseadas (Postgres devolve JSONB já parseado)
// - booleans/Date normalizados para o binding

const JSON_COLS = new Set([
  'cats', 'offerQueue', 'offerSkipped', 'offerMissed',
  'stops', 'viewedBy', 'payload', 'data',
]);

function nowExpr(mod?: string): string {
  return `strftime('%Y-%m-%dT%H:%M:%fZ','now'${mod ? `,'${mod}'` : ''})`;
}

function translate(input: string): string {
  let s = input;
  // datas primeiro (antes de NOW() genérico)
  s = s.replace(/date_trunc\(\s*'month'\s*,\s*NOW\(\)\s*\)/gi, nowExpr('start of month'));
  s = s.replace(/NOW\(\)\s*-\s*INTERVAL\s*'([^']+)'/gi, (_m, iv) => nowExpr('-' + iv));
  s = s.replace(/\bNOW\(\)/gi, nowExpr());
  s = s.replace(/to_timestamp\(([^)]+)\)/gi, (_m, a) => `strftime('%Y-%m-%dT%H:%M:%fZ',${a},'unixepoch')`);
  // tipos Postgres -> SQLite
  s = s.replace(/\bTIMESTAMPTZ\b/gi, 'TEXT');
  s = s.replace(/\bJSONB\b/gi, 'TEXT');
  s = s.replace(/\bBOOLEAN\b/gi, 'INTEGER');
  s = s.replace(/\bNUMERIC\b/gi, 'REAL');
  // ILIKE -> LIKE (SQLite LIKE já é case-insensitive para ASCII)
  s = s.replace(/\bILIKE\b/gi, 'LIKE');
  // ALTER ... ADD COLUMN IF NOT EXISTS não existe em SQLite -> ADD COLUMN
  // (ficam em try/catch no index.ts e as colunas são criadas no schema).
  s = s.replace(/ADD COLUMN IF NOT EXISTS/gi, 'ADD COLUMN');
  // UUID gerado no JS
  s = s.replace(/gen_random_uuid\(\)/gi, () => `'${crypto.randomUUID()}'`);
  // remover casts ::type (e ::type[])
  s = s.replace(/::\s*[A-Za-z_][A-Za-z0-9_]*(?:\[\])?/g, '');
  return s;
}

function normalize(v: any): any {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v;
}

// ─── métricas D1 (diagnóstico) ───────────────────────────────
// Acumula por isolate (suficiente para medição local via /debug/d1).
export const d1metrics: any = { queries: 0, rowsRead: 0, rowsWritten: 0, changes: 0, ms: 0, writesBy: {}, readsBy: {} };
export function resetD1Metrics(): void {
  d1metrics.queries = 0; d1metrics.rowsRead = 0; d1metrics.rowsWritten = 0; d1metrics.changes = 0; d1metrics.ms = 0;
  d1metrics.writesBy = {}; d1metrics.readsBy = {};
}

function labelOf(q: string): string {
  const m = q.match(/^\s*(insert\s+into|update|delete\s+from|select)\s+["`]?([A-Za-z_]+)/i);
  if (!m) return q.slice(0, 24);
  return m[1].split(/\s+/)[0].toUpperCase() + ' ' + m[2];
}

export function makeSql(db: any) {
  return async function sql(strings: TemplateStringsArray, ...values: any[]): Promise<any[]> {
    let query = strings[0];
    for (let i = 0; i < values.length; i++) query += '?' + strings[i + 1];
    query = translate(query);
    const stmt = values.length ? db.prepare(query).bind(...values.map(normalize)) : db.prepare(query);
    const res: any = await stmt.all();
    const meta = res && res.meta;
    if (meta) {
      d1metrics.queries++;
      d1metrics.rowsRead += meta.rows_read || 0;
      d1metrics.rowsWritten += meta.rows_written || 0;
      d1metrics.changes += meta.changes || 0;
      d1metrics.ms += meta.duration || 0;
      const lbl = labelOf(query);
      if (meta.rows_written) d1metrics.writesBy[lbl] = (d1metrics.writesBy[lbl] || 0) + meta.rows_written;
      if (meta.rows_read) d1metrics.readsBy[lbl] = (d1metrics.readsBy[lbl] || 0) + meta.rows_read;
    }
    const rows: any[] = (res && res.results) || [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      for (const k of Object.keys(row)) {
        if (JSON_COLS.has(k) && typeof row[k] === 'string') {
          try { row[k] = JSON.parse(row[k]); } catch { /* deixa como string */ }
        }
      }
    }
    return rows;
  };
}
