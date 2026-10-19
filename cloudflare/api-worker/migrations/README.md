# Migrações D1 — Estratégia Incremental

> **REGRA ABSOLUTA:** NUNCA reimportar a BD completa. Cada import total = ~23.345 escritas (23% do limite diário de 100K).

## Estratégia

```
┌─────────────────────────────────────────────────────────┐
│  1. MIGRAÇÕES (schema) → wrangler d1 migrations apply   │
│     - Incrementais, versionadas, idempotentes           │
│     - ~0-100 escritas por migração                      │
│                                                         │
│  2. DADOS (places, etc.) → import incremental           │
│     - UPSERT com ON CONFLICT (só escreve se mudou)      │
│     - Compara hash/timestamp antes de escrever          │
│     - ~0-500 escritas por atualização                   │
│                                                         │
│  3. MONITORESÇÃO → scripts/monitor-writes.mjs           │
│     - Alerta a 80%, bloqueia a 90%                      │
│     - Reset diário 00:00 UTC                            │
└─────────────────────────────────────────────────────────┘
```

## Como Criar uma Migração

1. Ficheiro SQL em `cloudflare/api-worker/migrations/`
2. Nomenclatura: `NNNN_description.sql` (ex: `0009_add_places_index.sql`)
3. Usar `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
4. Nunca usar `DROP TABLE` sem aprovação explícita

## Template de Migração SQL

```sql
-- migrations/0009_add_places_index.sql
-- Descrição: Ad índice FTS para busca de places
-- Escritas estimadas: 0 (índice não conta como escrita de linha)
-- Autor: [nome]
-- Data: 2026-10-17

-- Idempotente: pode correr múltiplas vezes sem efeito colateral
CREATE INDEX IF NOT EXISTS idx_places_name ON places(name);

-- Se precisares de coluna nova (SQLite ADD COLUMN):
-- ALTER TABLE places ADD COLUMN IF NOT EXISTS metadata TEXT;
```

## Template de Migração de Dados (Node.js)

```javascript
// scripts/import-places-incremental.mjs
// Uso: node scripts/import-places-incremental.mjs --dry-run
//      node scripts/import-places-incremental.mjs --staging
//      node scripts/import-places-incremental.mjs --prod

import { createHash } from 'crypto';

const DB_WRITES_BUDGET = 500; // máximo de escritas por execução

function hashRow(row) {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

async function getExistingHashes(db) {
  const { results } = await db.prepare('SELECT id, hash FROM places').all();
  return new Map(results.map(r => [r.id, r.hash]));
}

async function importIncremental(db, newPlaces, { dryRun = false } = {}) {
  const existing = await getExistingHashes(db);
  let writes = 0;
  const toInsert = [];
  const toUpdate = [];

  for (const place of newPlaces) {
    const h = hashRow(place);
    const prev = existing.get(place.id);
    if (!prev) {
      toInsert.push({ ...place, hash: h });
    } else if (prev !== h) {
      toUpdate.push({ ...place, hash: h });
    }
  }

  const total = toInsert.length + toUpdate.length;
  console.log(`[import] Novos: ${toInsert.length}, Alterados: ${toUpdate.length}, Iguais: ${newPlaces.length - total}`);

  if (dryRun) {
    console.log('[import] DRY RUN — nada foi escrito');
    return { inserted: 0, updated: 0, skipped: newPlaces.length - total };
  }

  if (writes > DB_WRITES_BUDGET) {
    console.error(`[import] ABORTADO: ${total} mudanças excede budget de ${DB_WRITES_BUDGET} escritas`);
    process.exit(1);
  }

  // Batch INSERT (1 statement = N rows, conta como N escritas)
  if (toInsert.length) {
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO places (id, name, lat, lng, hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const p of toInsert) {
      await stmt.bind(p.id, p.name, p.lat, p.lng, p.hash, new Date().toISOString()).run();
      writes++;
    }
  }

  // Batch UPDATE (só se mudou)
  if (toUpdate.length) {
    const stmt = db.prepare(
      'UPDATE places SET name=?, lat=?, lng=?, hash=?, updated_at=? WHERE id=?'
    );
    for (const p of toUpdate) {
      await stmt.bind(p.name, p.lat, p.lng, p.hash, new Date().toISOString(), p.id).run();
      writes++;
    }
  }

  console.log(`[import] Concluído: ${writes} escritas`);
  return { inserted: toInsert.length, updated: toUpdate.length, skipped: newPlaces.length - total };
}
```

## Comandos

```bash
# Aplicar migrações de schema (incremental, seguro)
cd cloudflare/api-worker
npx wrangler d1 migrations apply ladiesgo --remote

# Ver migrations aplicadas
npx wrangler d1 migrations list ladiesgo --remote

# Import incremental (dry-run primeiro!)
node scripts/import-places-incremental.mjs --dry-run
node scripts/import-places-incremental.mjs --prod

# Ver quota de escritas
node scripts/monitor-writes.mjs --status
```

## Referências

- [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Wrangler D1 Migrations](https://developers.cloudflare.com/d1/worker-api/d1-database/#migrations)
- AGENTS.md secção "Incidentes de quota (2026-10-17)"
