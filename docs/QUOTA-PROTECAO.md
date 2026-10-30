# Quota diária do plano Free — proteção em 3 anéis

Objectivo: **nunca estourar** os limites diários da conta `rerere…` (Workers, D1, Durable
Objects) sem mudar de plano. Não é uma questão de "ter sorte": há três anéis independentes,
e o primeiro que dispara segura os outros.

```
   ┌─ 1. MEDIR (autoritativo) ─────────────────────────────────────────────┐
   │ scripts/quota-watch.mjs  → GraphQL Analytics da CONTA (o número real) │
   │ GitHub Actions (quota-watch.yml) de 3 em 3 h + Telegram + email       │
   └───────────────────────────────┬───────────────────────────────────────┘
                                   │ escreve `system_flags.quota_shed`
   ┌─ 2. DEGRADAR (a app antes do muro) ───────────────────────────────────┐
   │ Worker lê o nível (1 linha/isolate/60 s) e corta o que é caro:        │
   │   1 → pesquisa de lugares deixa de varrer a D1                       │
   │   2 → histórico devolve 8 viagens em vez de 30                       │
   │ budget.ts → 503 `Retry-After` nas escritas opcionais a partir de 90%  │
   └───────────────────────────────┬───────────────────────────────────────┘
   ┌─ 3. NÃO GASTAR (desenho) ─────▼───────────────────────────────────────┐
   │ cortes já aplicados: FTS-only em `places`, 1 query por viagem, caches │
   │ de nota/pesquisa/perfil, backoff dos 5 WS, `trip_points` 180 s        │
   └───────────────────────────────────────────────────────────────────────┘
```

## Limites do Free (o que dói)

| Recurso | Teto/dia | Ao estourar |
|---|---|---|
| Workers — pedidos | 100 000 | **erro 1027** (HTTP 429), conta inteira fora até 00:00 UTC |
| D1 — linhas lidas | 5 000 000 | **todas** as queries D1 falham até 00:00 UTC |
| D1 — linhas escritas | 100 000 | **erro 7500**: toda a escrita devolve 500 (leitura continua) |
| Durable Objects — pedidos | 100 000 | DO falham; o mapa/chat/notificações param |
| Durable Objects — duração | 13 000 GB-s | idem |

O reset é sempre às **00:00 UTC** (01:00 em Luanda no horário normal).

## 1.º anel — medir (autoritativo)

Os contadores do Worker (`src/budget.ts`) são **por isolate**: reiniciam quando o isolate
morre e cada isolate só vê uma fração do tráfego. Servem para cortar escritas opcionais,
**não** para decidir se a conta está perto do teto. A verdade está na conta:

```bash
cd cloudflare/api-worker

# Relatório do dia (UTC) com projeção das 24 h e hora a que o teto seria atingido
node scripts/quota-watch.mjs

# Só o código de saída (0 OK · 1 aviso · 2 alto · 3 crítico · 4 esgotado · 5 erro)
node scripts/quota-watch.mjs --check --quiet

# Antes de uma operação cara: recusa se não houver folga
node scripts/quota-watch.mjs --guard writes=20000,reads=300000 --quiet

# Alertar no Telegram (credenciais em .dev.vars.telegram ou env)
node scripts/quota-watch.mjs --telegram

# Escrever o nível em D1 (o Worker degrada-se sozinho a partir do ALTO)
node scripts/quota-watch.mjs --apply-shed
```

O `monitor-writes.mjs` antigo está **descontinuado** (media com `SELECT COUNT(*) FROM places`,
gastava quota e mentia); ficou só como atalho para o `quota-watch`.

Automático: `.github/workflows/quota-watch.yml` corre de 3 em 3 horas, manda o resumo ao
Telegram (se houver segredos) e aplica o nível em D1. **Falha** a partir de CRÍTICO, e o
GitHub manda email — é o alarme que não depende de nenhum PC ligado.

Segredos a criar no repositório (Settings → Secrets → Actions), uma vez:

| Segredo | Para quê |
|---|---|
| `CLOUDFLARE_API_TOKEN` | ler Analytics (Account Analytics: Read) e escrever a flag (D1: Edit) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | alerta no telefone (opcional) |

Sem `CLOUDFLARE_API_TOKEN` o workflow termina com um aviso e não falha.

## 2.º anel — degradar antes do muro

`quota-watch --apply-shed` escreve `system_flags.quota_shed` (migração `0021`):

| Nível | Quando (pior métrica da conta) | O que muda na app |
|---|---|---|
| `0` | < 85% | nada |
| `1` | ≥ 85% (ALTO) | `/api/places/search` vai a cache e a Photon/Nominatim; **não** consulta `places_fts` |
| `2` | ≥ 92% (CRÍTICO) | + `/trips/history` devolve 8 viagens em vez de 30 |

- O nível é lido **1×/60 s por isolate** (`src/shed.ts`, cache em memória; 1 linha lida) — custo
  desprezável em troca de parar de gastar antes de 100%.
- **Nunca parte a app**: tabela ausente ou D1 em baixo → nível 0 e não se tenta outra vez
  durante 5 min.
- `.aviso` (70%) **não** corta nada: só alerta. O corte começa no ALTO.
- O contrato JSON não muda em nenhum nível (mesma forma, menos itens).
- `/api/v1/health` mostra `shed` (último nível lido neste isolate — pode ter até 60 s).

As escritas opcionais continuam a ser travadas localmente pelo `budget.ts` (`writeGuard` →
503 + `Retry-After`) a partir de 90 000 escritas no isolate.

## 3.º anel — não gastar (o que já está feito)

- `places` pesquisa só por FTS5 (o `LIKE '%…%'` sem índice foi apagado): 23 332 → 3–39 linhas
  por pesquisa; cache de 7 dias em `caches.default` (chave `places:v14`).
- `GET /trips/:id` numa só query (4 linhas em vez de 2+2+1+97); nota da motorista em cache de
  120 s; `webDriverInfo` sem query quando há `LEFT JOIN`.
- `GET /trips/active` com `INDEXED BY trips_status_idx` (78 → 5 linhas).
- Polling só como rede de segurança com o WebSocket aberto (60 s), backoff exponencial nos 5
  WebSockets, `trip_points` a cada 180 s, `geoPushToTrip` com throttle de 9 s.

## Regras de ouro (para humanos **e** agentes)

1. **Antes** de qualquer coisa que escreva muito (> 1 000 linhas): `node scripts/quota-watch.mjs`,
   e usar `--guard writes=N` no comando seguinte.
2. **Nunca** reimportar a base toda. Um import completo custa **116 798** linhas escritas —
   sozinho passa o teto de 100 000 (ver AGENTS.md, "Custo real de um import completo").
3. Medir SQL com **SELECT** e `meta.rows_read` (wrangler `--remote --json`), nunca com escrita.
4. Uma `UPDATE` sem `RETURNING` também conta; um `INSERT` conta a linha **mais cada índice**.
5. `wrangler d1 execute` e o dashboard **contam para a quota** — não fazer "só para ver".
6. Escritas de teste **só** em `ladiesgo-staging`, apagadas no fim (`LIKE 'ZZ%'`/`drvtest-%`).
7. Se o resultado de um comando for `7500`/`1027`/HTTP 429: **parar** e esperar pelas 00:00 UTC.
   Não repetir o comando "a ver se passa" (cada tentativa conta).

## Se estourar (runbook)

| Sintoma | Significa | Fazer |
|---|---|---|
| `1027` / 429 em tudo | pedidos do dia esgotados | nada a fazer até 00:00 UTC; o `quota_shed` já devia estar em 2 |
| `7500` na escrita, leitura OK | linhas escritas esgotadas | ler funciona; parar escritas até 00:00 UTC |
| Toda a query D1 falha | linhas lidas esgotadas | app em modo leitura-zero: só auth/GPS; esperar 00:00 UTC |

Depois do reset: `node scripts/quota-watch.mjs --apply-shed` para voltar a `0`, e investigar
o que subiu (o relatório mostra por script e por base, e a projecção hora a hora).

## Limitações conhecidas

- A GraphQL Analytics tem **atraso de ~1–2 min** e é agregada por minuto; nas primeiras horas
  do dia (UTC) a projecção é ruidosa.
- Alertas nativos da Cloudflare (Notifications/webhooks) nos planos Free não estão garantidos —
  por isso a vigilância é própria. Email de falha do GitHub Actions é o alarme de recurso.
- O `budget.ts` é por isolate: um pico de tráfego em muitos isolates não é travado por ele.
  É o anel 1 + anel 3 que protegem.
- D1 Read Replication não reduz linhas lidas (é latência); não serve para quota.

## Prova (2026-10-30)

- **Staging** (`ladiesgo-api-staging` `1c7ca699`): `shed=1` → `/api/places/search` responde
  (Photon) **sem** tocar em `places_fts`; `shed=2` → `/trips/history` devolveu **8** de 12
  viagens, contrato `{trips:[…]}` intacto; flag reposta a 0, contas/viagens `ZZ…` apagadas.
- **Produção** (`ladiesgo-api` `e09312ee`, migração `0021` aplicada): `/health` 200 com `shed`,
  `/api/places/search?q=isptec` → ISPTEC à coordenada certa, **4** linhas lidas (3 da pesquisa
  + 1 da flag), ou seja +1 linha por minuto e por isolate em troca do travão.
- Vigilante: relatório do dia 30/10 às 10:20Z — pedidos 4.2 k (4,2%), leituras 430 k (8,6%),
  escritas 518 (0,5%), DO 536 pedidos (0,5%); nível OK.
