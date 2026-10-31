# Capacidade no plano Free — mais viagens e mais horas por dia (2026-10-31)

Objectivo: **aumentar o número de viagens activas por dia e, sobretudo, as horas de carro
activas por dia**, sem sair do plano Free da Cloudflare.

Este documento assenta em três coisas: (1) o que a documentação oficial diz hoje, (2) o que
está medido neste projecto (`AGENTS.md`, vagas 10–17) e (3) o que ainda **não** está medido e
tem de ser medido antes de se cortar.

---

## 1. Resumo executivo

| | Hoje (medido) | Depois dos Pacotes A+B | Ganho |
|---|---|---|---|
| Tecto de **viagens/dia** (15 min cada) | **3 571** | **≈4 348** | +22 % |
| Tecto de **horas de carro/dia** | **893 h** | **≈4 000 h** | **+4,5×** |
| Motoristas a tempo inteiro (8 h, viagens de 15 min) | ~149 | ~181 | +22 % |
| Motoristas a tempo inteiro (8 h, viagens de 45–60 min) | ~110 | **~500** | **+4,5×** |

Duas conclusões que mudam a forma de pensar o problema:

1. **"Viagens" e "horas" são alavancas diferentes.** O custo da D1 é *por viagem*; o custo das
   Durable Objects é *por minuto*. Encurtar a viagem média dá mais viagens e menos horas;
   alongar dá mais horas e menos viagens. **A viagem média é o lever.**
2. **A quota não é uma parede, é um preço.** A partir de ~4 000 h/dia, o plano pago custa
   **~$5/mês** para o mesmo tráfego (contas em §7). O Free aguenta o negócio inteiro até
   ~180 motoristas a tempo inteiro.

---

## 2. O que a documentação oficial diz (verificado a 2026-10-31)

Fontes: `developers.cloudflare.com/workers/platform/{limits,pricing}`,
`/d1/platform/{pricing,limits}`, `/durable-objects/platform/{pricing,limits}`,
`/queues/platform/pricing`, `/r2/pricing`, `/kv/platform/limits`.

| Recurso | Free (por **conta**, reset 00:00 UTC) | Notas |
|---|---|---|
| Pedidos Worker | **100 000/dia** | partilhado com Pages Functions; erro **1027** ao estourar |
| Subrequests por invocação | **50** | é o que limita fan-out (`notifPokeMany`) |
| CPU por invocação | **10 ms** | não é o nosso problema (0,76 ms medidos) |
| D1 linhas lidas | **5 000 000/dia** | |
| D1 linhas escritas | **100 000/dia** | erro **7500**: todas as escritas dão 500 |
| D1 bases de dados | 10 | temos 2 |
| DO pedidos | **100 000/dia** | inclui HTTP, RPC, **mensagens WS** e **alarmes** |
| DO duração | **13 000 GB-s/dia** | com hibernação fica perto de 0 |
| DO SQLite — linhas lidas | **5 000 000/dia** | **quota separada da D1** |
| DO SQLite — linhas escritas | **100 000/dia** | **quota separada da D1**; `setAlarm` = 1 linha |
| DO SQLite — armazenamento | 5 GB (1 GB por objecto) | |
| KV | 100 k leituras/dia, **1 000 escritas/dia** | escritas demasiado baixas para o nosso caso |
| Queues | **10 000 operações/dia** (~3 333 mensagens) | pouco útil |
| R2 | 10 GB, **1 M Class A/mês** (~33 k/dia), 10 M Class B/mês | bom para arquivo (rasto) |
| Assets estáticos (Pages / Worker estático) | ilimitados e grátis | não contam para os 100 k |

### Factos de facturação que são alavancas (não são trivia)

- **Mensagem WebSocket de entrada vale 1/20 de pedido** na factura (a métrica mostra 1:1).
  100 mensagens = 5 pedidos. **Mensagens de saída são grátis** — um `send()` para 50 sockets
  custa 0; só a mensagem que entra conta.
- **Pings do protocolo WebSocket e `setWebSocketAutoResponse()` são grátis** (nem pedido nem
  duração). É o que o `calls:` já usa.
- **Hibernação**: objecto inactivo não paga duração. Medimos **3 GB-s/dia** (0,02 % do tecto).
- **Cada `setAlarm()` é 1 linha escrita** no storage do DO (quota separada da D1).
- **Cada índice custa +1 linha escrita** quando a coluna indexada é escrita (D1 e DO SQLite).
- **Um alarme é 1 pedido** ao DO.

---

## 3. As quatro alavancas reais

### 3.1 Repartir trabalho por quotas diferentes

A D1 e o storage dos DO têm **quotas separadas** (100 k escritas/dia cada). Hoje a D1 faz
**28 escritas por viagem** e o storage dos DO faz ~1 (o `lastPointAt`). Há **100 k escritas/dia
de DO storage praticamente intactas**.

➜ O rasto (`trip_points`, 6 escritas/viagem) é o candidato óbvio a mudar de quota.

### 3.2 Converter HTTP em WebSocket

Cada pedido HTTP ao DO custa **1**; a mesma informação por uma WS já aberta custa **1/20**.
Foi isto que as vagas 11 e 17 já exploraram (ponte só quando o WS cala, `heading` a 1/15 s).
O que resta converter: nada de grande — o que resta é **eliminar** tráfego, não convertê-lo.

### 3.3 Não pagar duração

Já feito (hibernação nos 5 DOs + auto-response do `calls:`). Duração = 3 GB-s/dia.

### 3.4 Remover o custo que cresce com o **minuto**

É a única alavanca que ainda não foi tocada com rigor, e é **a que decide as horas**.
Hoje: `DO ≈ 17 + 0,73 × minutos`. O termo `0,73/min` é o que faz uma viagem de 60 min custar
61 pedidos em vez de 28.

---

## 4. Modelo actual (medido) e de onde vem cada pedido

Por viagem de 15 min (medido nas vagas 16 e 17):

| Recurso | Custo | Composição |
|---|---|---|
| **DO** | **28** | base ≈17 (2–3 ligações WS + 4–5 `/notify` de transição + leituras de estado) + ≈11 do regime (`0,73/min`) |
| **D1 escritas** | **28** | INSERT 4 · ACCEPTED 3 · ARRIVED 2 · IN_PROGRESS 2 · COMPLETED 8 · avaliação 3 · 2 pontos de rasto 6 |
| **Worker** | ≈20 | polling `GET /trips/:id` a 120 s com WS aberto, `/boot`, `/nearby`, chat, etc. |

Tecto actual = `100 000 ÷ 28` = **3 571 viagens/dia**, com as duas travas **empatadas**.

O termo `0,73/min` das DO é o alvo. Contribuintes plausíveis (a **confirmar por medição**):

| Fonte | Cadência | Custo/min |
|---|---|---|
| frame `gps` no WS da viagem | 1/15 s | 0,20 |
| frame `heading` no WS da viagem | 1/15 s + 20° | 0,20 |
| `nearby-live` (`broadcastNearby`) | 1/5 s, quando há fix | até 0,60 |
| espelho `geo:global` | 1/180 s | 0,02 |
| ponte `DriverGeo→TripPush` | 1/30 s (só sem WS) | 0 hoje |

**Nota importante:** o `nearby-live` fecha quando a passageira entra na viagem
(`nearbyWsClose()` no `show()`), por isso o `0,60/min` **não** deve estar todo lá dentro. O que
sobra tem de ser medido com a GraphQL por objecto antes de se cortar — é o primeiro passo do
Pacote A.

---

## 5. Pacotes propostos

### Pacote A — cortar o custo por minuto (baixo risco, só números de gate)

| # | Alteração | Onde | Efeito |
|---|---|---|---|
| A1 | `broadcastNearby` 5 s → **15 s** (com envio imediato se o hash mudar ≥ X) | `index.ts` ~4505 | DO −0,4/min |
| A2 | **Eliminar o frame `heading`** — o `h` já vai no frame `gps` (provado: 36/36 frames `driver` com `h`) | `ladiesgo-home.html` `liveSendHdg` | DO −0,2/min |
| A3 | Rasto: 1 ponto por viagem em vez de 1/10 min | `persistPoint` | D1 deixa de crescer com a duração |

Resultado: `DO ≈ 17 + 0,13 × min`, `D1 = 22 + 1` (constante).

### Pacote B — tirar o rasto da D1 (média complexidade)

| # | Alteração | Efeito |
|---|---|---|
| B1 | Polilinha da viagem acumulada no **storage do DO da viagem** (quota separada) e escrita na D1 **1 vez**, no fim | D1 −5/viagem, e **constante** com a duração |
| B2 | `GET /trips/:id/route` passa a ler do DO (1 pedido ao DO, raro) | +1 DO por visualização do rasto |

Alternativa a B1 sem mexer no servidor: o cliente já recebe todos os fixes — envia a polilinha
completa no `complete` (1 pedido, 1–3 escritas). Perde-se o rasto se a app fechar a meio.

### Pacote C — carteira em lote (arriscado, só se A+B não chegarem)

`COMPLETED` escreve 8 linhas (viagem 3 + motorista 1 + utilizadora 2 + `wallet_tx` 3). Passar
`users`/`wallet_tx` para um cron de 60 s reduz a 3 → **D1 17/viagem**. Custo: o saldo da
motorista fica até 60 s atrasado (e o bloqueio de carteira depende dele). **Não recomendo
antes de haver mais de ~1 000 viagens/dia.**

---

## 6. Números

`DO = 17 + 0,73d` (hoje) / `17 + 0,13d` (A) · `D1 = 22 + 3·⌈d/10⌉` (hoje) / `23` (A+B)

| Duração | DO hoje | D1 hoje | viagens/dia hoje | **horas/dia hoje** | DO A+B | D1 A+B | **viagens/dia A+B** | **horas/dia A+B** |
|---|---|---|---|---|---|---|---|---|
| 10 min | 24 | 25 | 4 000 | 667 h | 18 | 23 | 4 348 | 725 h |
| **15 min** | **28** | **28** | **3 571** | **893 h** | **19** | **23** | **4 348** | **1 087 h** |
| 30 min | 39 | 31 | 2 564 | 1 282 h | 21 | 23 | 4 348 | 2 174 h |
| 45 min | 50 | 37 | 2 000 | 1 500 h | 23 | 23 | **4 348** | **3 261 h** |
| 60 min | 61 | 40 | 1 639 | 1 639 h | 25 | 23 | 4 000 | **4 000 h** |

Leituras:

- **Viagens/dia**: 3 571 → 4 348 (+22 %), e o tecto passa a ser a **D1** (23), não as DO.
- **Horas/dia**: 893 → **4 000** (+4,5×), e o tecto passa a ser as **DO** a partir dos ~45 min.
- **45 min é o ponto de equilíbrio**: DO = D1 = 23 ⇒ 4 348 viagens **e** 3 261 h.
- O Worker fica em ~87 % do tecto (≈20 × 4 348 = 87 k), por isso é a **terceira** parede e a
  próxima a atacar depois de A+B.

---

## 7. E se um dia não chegar? (o preço da parede)

No plano pago ($5/mês, 10 M pedidos incluídos), a 4 000 viagens/dia (~120 k viagens/mês):

| Recurso | Uso/mês | Incluído | Custo |
|---|---|---|---|
| Worker | 2,4 M pedidos | 10 M | $0 |
| DO pedidos | 3,0 M | 1 M | **$0,30** |
| DO duração (com hibernação) | ~2 k GB-s | 400 k | $0 |
| D1 escritas | 2,8 M | 50 M | $0 |
| D1 leituras | ~150 M | 25 000 M | $0 |

➜ **≈$5/mês** (o mínimo da conta). A "parede" do Free é, na prática, um preço de $5.

---

## 8. O que NÃO fazer (já analisado)

- **Contas novas** para multiplicar a quota: viola os ToS e obriga a migrar a BD outra vez.
- **Cache Rules / Workers Cache** à frente do Worker: poupa 0 pedidos (o Worker corre antes).
- **KV** para o que escreve: 1 000 escritas/dia não dá para nada nosso.
- **Queues** para notificações: 10 k operações/dia ≈ 3 333 mensagens, e não tira as escritas da D1.
- **Sharding do `DriverGeo`**: só passa a valer com ~600–700 motoristas (é o próximo muro real,
  e resolve-se com geohash de 4 caracteres no nome do DO, 0 pedidos extra).
- **`notifPokeMany` com >45 destinatários**: rebenta o limite de 50 subrequests — bug real, só
  aparece com muitos utilizadores.

---

## 9. Ordem de execução

1. **Medir** o regime actual de uma viagem de 15 min em staging, por objecto DO e por statement
   (`%TEMP%\opencode\m-ride-cost.mjs`, `do-window.mjs`) — sem isto, A1 e A2 são tiros no escuro.
2. **A2** (eliminar `heading`) — 1 linha, efeito imediato, já provado redundante.
3. **A1** (`nearby` 5 → 15 s) — 1 número; medir antes/depois com a GraphQL por objecto.
4. **A3** (1 ponto de rasto) — 1 número no gate; verificar o `stale_guard` (usa `MAX(ts)`).
5. **B1** (polilinha no DO) — só depois de A provar o ganho; é a única alteração estrutural.
6. Re-medir e actualizar `AGENTS.md` (secção "Capacidade a 50.000 viagens/dia").

Cada passo: deploy em staging → medição → produção → smoke só de `GET` → actualizar doc.
