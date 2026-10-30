# Checklist de Migração D1

> **INCIDENTE 2026-10-17:** Reimportação completa da BD (~23.345 escritas) esgotou o limite diário de 100K escritas em menos de 2 horas. **NUNCA repetir.**

## Regra de Ferro

```
╔═══════════════════════════════════════════════════════════════╗
║  NUNCA reimportar a BD completa.                              ║
║  Um import total = 23.345 escritas = 23% do limite diário.    ║
║  Limite D1 Free: 100.000 escritas/dia (reset 00:00 UTC).     ║
║  Estouro = erro 7500: TODAS as escritas devolvem 500.        ║
╚═══════════════════════════════════════════════════════════════╝
```

## Pré-Migração (OBRIGATÓRIO)

### 1. Verificar Quota Atual
```bash
cd cloudflare/api-worker
node scripts/monitor-writes.mjs --status
```
- [ ] Escritas hoje < 80.000 (80% do limite)
- [ ] Se >= 80.000: **PARAR** e aguardar reset 00:00 UTC
- [ ] Se >= 90.000: **BLOQUEADO** — import vai falhar

### 2. Backup da BD Atual
```bash
# Exportar snapshot antes de qualquer migração
npx wrangler d1 execute ladiesgo --remote --command "SELECT * FROM places" > backup-places-$(date +%Y%m%d-%H%M%S).json
```
- [ ] Backup feito e verificado
- [ ] Backup guardado fora do repositório (ex: `backups/` local ou Cloudflare R2)

### 3. Testar em Staging
```bash
# Staging tem D1 própria — nunca testar em produção
npx wrangler d1 migrations apply ladiesgo-staging --remote --env staging
node scripts/import-places-incremental.mjs --dry-run --staging
node scripts/import-places-incremental.mjs --staging
```
- [ ] Migração aplicada em staging sem erros
- [ ] Import incremental testado em staging
- [ ] Dados verificados em staging

### 4. Dry-Run em Produção
```bash
node scripts/import-places-incremental.mjs --dry-run --prod
```
- [ ] Dry-run executado
- [ ] Número de escritas estimadas < 500
- [ ] Nenhum registo existente vai ser reescrito desnecessariamente

## Durante a Migração

### 5. Aplicar Migrações Incrementais
```bash
# Migrações de schema (CREATE INDEX, ALTER TABLE, etc.)
npx wrangler d1 migrations apply ladiesgo --remote
```
- [ ] Apenas migrações **novas** foram aplicadas (ver `migrations list`)
- [ ] Nenhum `DROP TABLE` ou `DELETE` em massa

### 6. Import Incremental de Dados
```bash
node scripts/import-places-incremental.mjs --prod
```
- [ ] Apenas registos novos/alterados foram escritos
- [ ] Hash de comparação usado para evitar reescrita
- [ ] Total de escritas < budget configurado

### 7. Monitorizar em Tempo Real
```bash
# Noutra terminal
node scripts/monitor-writes.mjs --watch
```
- [ ] Contador de escritas a subir dentro do esperado
- [ ] Nenhum pico de writes inexplicado

## Pós-Migração

### 8. Verificar Integridade
```bash
node scripts/quota-watch.mjs            # quota REAL da conta (lidas/escritas/pedidos)
node scripts/quota-watch.mjs --guard writes=1   # confirma que ainda há folga para escrever
```
- [ ] Contagem de registos correta (comparar com o `expected` do import, via `SELECT COUNT(*)`)
- [ ] Nenhum duplicado
- [ ] API a responder normalmente (`/api/v1/health`)

### 9. Documentar
- [ ] Migração registada em `migrations/README.md`
- [ ] Número de escritas documentado
- [ ] Qualquer anomalia registada

## Comandos de Emergência

```bash
# Se as escritas falharem (erro 7500):
# 1. PARAR imediatamente todos os imports
# 2. Verificar quota:
node scripts/monitor-writes.mjs --status
# 3. Se estourou: aguardar 00:00 UTC para reset
# 4. Se necessário, rollback:
npx wrangler d1 execute ladiesgo --remote --command "DELETE FROM places WHERE imported_at > '2026-10-17T00:00:00Z'"
```

## Sinais de Alerta

| Sintoma | Ação |
|---------|------|
| `erro 7500` nas escritas | PARAR. Quota estourada. Aguardar reset. |
| `rows_written > 1000` num único batch | Possível reimport. Verificar query. |
| Dry-run mostra > 5000 mudanças | Dados muito desatualizados. Considerar reimport único com aprovação. |
| `migrations list` mostra migração duplicada | Verificar ficheiro SQL — pode não ser idempotente. |

## Referência de Custos

| Operação | Escritas | % do Limite Diário |
|----------|----------|-------------------|
| Migração de schema (índice) | 0-10 | < 0.01% |
| Migração de schema (ADD COLUMN) | 0-50 | < 0.05% |
| Import incremental (10 alterados) | 10 | 0.01% |
| Import incremental (500 alterados) | 500 | 0.5% |
| **Import COMPLETO (23.345 places)** | **23.345** | **23%** |
| **Reimport 4x por dia** | **93.380** | **93% — ESTOURO** |
