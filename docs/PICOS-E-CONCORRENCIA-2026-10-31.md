# Como as outras plataformas lidam com muitas viagens ao mesmo tempo e com o pico

**Data:** 2026-10-31
**Pergunta:** como é que Uber, Lyft, Grab, DiDi e DoorDash aguentam milhares de viagens
simultâneas e os picos — e o que disso se aplica à LADIESGO no plano Free.

**Resposta curta:** quase tudo o que eles fazem serve para problemas que a LADIESGO **não tem**
(10⁴–10⁷ pedidos por minuto). Mas há **quatro** ideias que transferem directamente, e a LADIESGO
**já tem três delas**. O que falta é uma: **shard geográfico** do estado vivo. E a alavanca mais
forte de pico deles — **preço dinâmico** — é a única que a LADIESGO ainda não usa e que **não custa
um único pedido**.

---

## 1. O que cada plataforma faz (com os números que publicam)

### 1.1 Uber — emparelhamento em lote + índice hexagonal

**O problema que resolveram primeiro.** No início, o passageiro era emparelhado **imediatamente**
com a motorista mais próxima. Funcionava para a maioria, mas deixava alguns à espera muito tempo —
e "somado na cidade inteira, isso dá muito tempo perdido".

**A viragem — *batched matching*.** Uber passou a **esperar alguns segundos** depois do pedido para
acumular um lote de pares passageiro↔motorista e resolver o lote **como um todo**, minimizando a
espera **média de todos**, não a do par mais próximo. "Uns segundos chegam para acumular um lote de
emparelhamentos possíveis."

**A infra-estrutura — H3.** Índice geoespacial **hexagonal hierárquico**: qualquer (lat,lng) cai
num hexágono com um `H3Index`; a distância passa a ser medida em **número de hexágonos**, não em
trigonometria. É a chave de partição que usam para "pedidos perto de ti" e para analytics
geográficas de alto QPS. Hexágonos em vez de quadrados porque um hexágono tem **6 vizinhos
equidistantes** (um quadrado tem 4 iguais + 4 na diagonal) — não há descontinuidade na borda.

**A re-arquitectura — *Fulfillment Platform*.** Separaram o modelo de domínio em **Trip** (unidade
de trabalho, serviço `rt-demand`) e **Supply** (pessoa capaz de fazer o trabalho, serviço
`rt-supply`), com fluxo dirigido a eventos. É isso que lhes permite ter UberX, reservas, filas de
aeroporto e Uber Eats no mesmo motor.

### 1.2 Lyft — oferta exclusiva vs. não-exclusiva

O paper de 2026 (`arXiv:2603.21531`, "Non-Exclusive Notifications for Ride-Hailing at Lyft II")
formaliza exactamente a decisão que a LADIESGO tomou por instinto:

| Modelo | Como funciona | Custo | Efeito no pico |
|---|---|---|---|
| **Exclusiva** | A oferta vai a **1** motorista de cada vez, com timeout; se recusar/expirar, passa à seguinte | Nada (1 push) | Bom para a plataforma, mau para a espera quando a frota é pequena |
| **Não-exclusiva** | A oferta vai a **N** motoristas ao mesmo tempo; **o primeiro que aceita leva** | N pushes | Espera mínima; a frota fica a levar notificações a mais |

O resultado do paper: o modelo não-exclusivo **melhora a taxa de aceitação e reduz a espera**, ao
custo de "spam" para as motoristas e de mais aceitações em simultâneo (que é preciso arbitrar).
A conclusão prática deles é que **não há um vencedor único** — depende da densidade de frota.

### 1.3 Grab — geohash e o mapa de oferta/procura

Grab agrega tudo a um **geohash** de precisão pequena e distribui **cada unidade de oferta por todas
as unidades de procura nos geohashes vizinhos, com peso inverso à distância**. Isso dá-lhes um
"mapa de calor" de oferta/procura por célula — a base para incentivos, para onde mandar as motoristas
e para medir se um bairro está a afogar-se em pedidos sem carros.

É o mesmo papel do H3 da Uber, com uma célula rectangular (geohash) em vez de hexagonal. Mais
simples de implementar, e **suficiente** para sharding.

### 1.4 DiDi — o caso mais parecido com a LADIESGO

Números: **>30 milhões de pedidos/dia**, **>60 000 pedidos/minuto** no pico, **centenas a milhares de
motoristas emparelhados a cada 2 segundos**.

A evolução deles é a lição mais directa:

1. **Começaram com *broadcast***: cada pedido ia a **todas** as motoristas disponíveis num raio
   pré-definido; a primeira a aceitar ficava com ele.
2. **Passaram a despacho centralizado** (emparelhamento em lote, grafo bipartido, minimizar distância
   total de recolha).
3. **Chain dispatch**: quando uma motorista está a acabar uma viagem, o sistema verifica se o destino
   dela fica perto de um pedido novo e **já lhe passa o próximo** — comprime o tempo morto entre
   viagens, que é o pior desperdício no pico.
4. **Regras duras** que qualquer implementação acaba por precisar:
   - **um pedido só é enviado uma vez à mesma motorista**;
   - não mandar pedidos em tempo real a quem só tem reservas marcadas;
   - categorias diferentes não se cruzam (económico não leva premium).

**Ganhos medidos da mudança:** taxa de resposta **+20 pontos percentuais** (para **>90 % no pico**),
tempo de recolha **−15 % no pico**, **+1 milhão de viagens/dia** de capacidade.

### 1.5 DoorDash — o pico é 4× a capacidade de cálculo

O caso mais brutal e o mais instrutivo sobre **o que acontece quando o pico chega**:

- No pico (sexta à noite, Super Bowl), a procura era **quase 4× a capacidade de processamento** do
  despacho → o sistema tinha de **decidir com informação incompleta**.
- Os algoritmos escalavam **quadraticamente** (o espaço de atribuições cresce ao quadrado): duplicar o
  volume quadruplicava o tempo de decisão. **"Atirar mais hardware a um monólito não vence uma curva
  superlinear."**
- Solução: **separar coordenação de cálculo** — um coordenador que decide, e um **conjunto de nós de
  cálculo** que resolvem em paralelo. O coordenador **não difunde o estado global** ao conjunto todo;
  manda a cada nó **só a fatia local** que ele precisa.
- Resultado: **10× de débito**, **99,9 % das execuções abaixo de 20 s**.
- Trocaram o motor em produção com **shadow testing**: o tráfego real era **duplicado** para o motor
  novo em tempo real, comparando decisões antes de o ligar.

---

## 2. Os padrões que se repetem (e o que cada um resolve)

| # | Padrão | Resolve | Quem usa |
|---|---|---|---|
| 1 | **Oferta exclusiva sequencial com timeout e expansão de raio** | spam à frota, aceitações duplicadas | Uber, DiDi (depois), Lyft (exclusive) |
| 2 | **Oferta não-exclusiva (primeiro que aceita leva)** | espera mínima com frota pequena | DiDi (início), Lyft (non-exclusive) |
| 3 | **Emparelhamento em lote (janela de segundos)** | espera *média* da cidade; tira o "primeiro que chega" | Uber, DiDi |
| 4 | **Chain dispatch** (próxima corrida para quem está a acabar) | tempo morto entre viagens | DiDi |
| 5 | **Célula geográfica como chave de shard** (H3 / geohash) | estado vivo deixa de caber num sítio só | Uber, Grab |
| 6 | **Separar coordenação de cálculo**; mandar a cada nó só a fatia local | curva quadrática do pico | DoorDash, Uber |
| 7 | **Preço dinâmico / incentivos** para equilibrar oferta e procura | o pico em si (procura a mais, carros a menos) | Uber, Lyft, Grab, DoorDash |
| 8 | **Previsão de procura + posicionamento de oferta** | chegar ao pico com os carros no sítio certo | Uber, DiDi, Grab |
| 9 | **Backpressure**: degradar em vez de cair | quando a procura passa a capacidade | DoorDash (decidir com informação incompleta), todos |
| 10 | **Shadow testing** antes de trocar o motor | risco de trocar o coração em voo | DoorDash |

---

## 3. LADIESGO hoje, padrão a padrão

Verificado no código (`cloudflare/api-worker/src/index.ts`, `webapp/ladiesgo-home.html`).

| # | Padrão | Estado na LADIESGO | Onde |
|---|---|---|---|
| 1 | Oferta exclusiva sequencial | **JÁ TEM** — `offerQueue` + `offeredDriverId` + `advanceOfferIfNeeded`, roda aos **30 s**, toca-toca até **4×** por motorista, raio expande até 12 km em 1 min | `advanceOfferIfNeeded`, `TripRinger` alarm (4 s → 10 s → 20 s) |
| 2 | Oferta não-exclusiva | **SÓ COMO RECURSO** — quando não há fila exclusiva, `pushTripToDrivers` + `hubBroadcast` (máx. 3 resumos) | `TripRinger` ramo `!offerBroadcast` |
| 3 | Emparelhamento em lote | **NÃO TEM** (e hoje não faz sentido) | — |
| 4 | Chain dispatch | **NÃO TEM** | — |
| 5 | Shard geográfico | **NÃO TEM** — `DriverGeo` é **1 DO global** (`geo:global`), `RequestsHub` é **1 DO global** | `DriverGeo`, `RequestsHub` |
| 6 | Coordenação ≠ cálculo | **JÁ TEM, na forma certa** — `TripPush` por viagem (cálculo) vs. `DriverGeo`/`RequestsHub` (coordenação) | 5 DOs |
| 7 | Preço dinâmico | **NÃO TEM** — preço fixo por categoria e por pessoa (ECONOMY 1500 / COMFORT 2500 / PREMIUM 3500 Kz) | `ride_categories.basePrice` |
| 8 | Previsão / posicionamento | **NÃO TEM** (nem há dados: 121 viagens no total) | — |
| 9 | Backpressure | **JÁ TEM** — `quota_shed` 0/1/2 (lido do `system_flags`), 429 no rate limit, `stale_guard` a fechar viagens esquecidas | `src/shed.ts`, `src/quota.ts` |
| 10 | Shadow testing | **JÁ TEM** — staging completo + `stale_guard` em modo `shadow` + `quota_shed` por flag, sem deploy | `[env.staging]`, `docs/QUOTA-PROTECAO.md` |

**Leitura:** dos 10 padrões, a LADIESGO já pratica **5** (1, 6, 9, 10 e o 2 como rede de segurança).
Faltam **5** — e só **um** deles é urgente.

---

## 4. O tecto real da LADIESGO, e porque é em **minutos de viagem**

Números medidos (ver `AGENTS.md` §13–§14 e `docs/MAIS-CORRIDAS-POR-DIA-2026-10-30.md`):

| Recurso | Por viagem de 15 min | Tecto Free/dia | Viagens/dia |
|---|---|---|---|
| Pedidos às **Durable Objects** (facturados) | ≈**35** | 100 000 | **≈2 850** |
| **Escritas** na D1 | ≈**34** | 100 000 | ≈2 940 |
| Pedidos ao **Worker** | ≈20 | 100 000 | ≈5 000 |

O que trava primeiro são as **DO** (≈2 850), com as escritas da D1 logo atrás (≈2 940).

**O detalhe que muda tudo:** o custo de uma viagem é ≈**5 pedidos fixos + ≈2 por minuto**
(5 + 2×15 = 35). Ou seja, o tecto não é em *viagens*, é em **minutos de carro na estrada**:

| Duração média da viagem | Pedidos DO/viagem | Viagens/dia no Free | **Horas de carro/dia** |
|---|---|---|---|
| 10 min | ≈25 | **≈4 000** | ≈667 h |
| 15 min | ≈35 | **≈2 850** | ≈714 h |
| 20 min | ≈45 | ≈2 220 | ≈741 h |
| 30 min | ≈65 | ≈1 540 | ≈769 h |

As **horas de carro** ficam praticamente constantes (~700–770 h/dia). É o número a dizer ao dono:
**o plano Free aguenta ~700 horas de carro por dia** — 50 motoristas a 14 h, ou 25 a 28 h (impossível),
ou 10 a 70 h. A 15 min por corrida, isso são **~2 850 corridas/dia**. A 85 % (margem de segurança),
**~2 400**.

---

## 5. O que vale a pena adoptar — por ordem de retorno

### 5.1 Preço por hora/zona (padrão 7) — **o único lever que reduz pedidos**

Todos os outros cortes das vagas 1–14 reduziram o **custo por viagem**. Este reduz o **número de
viagens** — e é o único que o faz.

- Custo em pedidos: **0** (o preço já vem de `ride_categories`).
- Custo em código: uma tabela `surge(hour, zone)` e um multiplicador no cálculo da tarifa.
- Efeito no pico: procura desce, motoristas aparecem. É exactamente o que Uber, Lyft, Grab e
  DoorDash fazem — e o DoorDash chama-lhe *peak pay*.
- **Contra:** em Angola, com pagamento em dinheiro e frota de 1, é uma **decisão de negócio**, não de
  engenharia. Mas é a que dá mais capacidade por menos trabalho.

### 5.2 Shard geográfico do estado vivo (padrão 5) — **o próximo muro verdadeiro**

Hoje `DriverGeo` é **um** DO para **toda** a frota, e guarda tudo numa **única chave** `snapshot:v1`
limitada a **100 KiB** (o limite do DO por valor é 128 KiB). Cada motorista ocupa ~150 bytes →
o snapshot enche a **~600–700 motoristas**. E o `RequestsHub` também é global: um broadcast percorre
**todos** os sockets ligados.

Não é problema com 1 motorista. É o primeiro a partir.

- Custo em pedidos: **0** (o shard é escolhido no *nome* do DO, `geo:<geohash4>`).
- Custo em código: moderado — `/drivers/nearby` passa a consultar a célula do passageiro + as 8
  vizinhas (ou 6, se for hexágono), em paralelo.
- **Não precisa da biblioteca H3.** Um **geohash de 4–5 caracteres** (≈ 39 km × 19,5 km a 4, ≈ 4,9 km
  × 4,9 km a 5) resolve, e é aritmética simples. Luanda inteira cabe em poucas células de 4 caracteres.
- Nota: `GEO_TTL_MS` de 18 min já existe — um shard vazio **não custa nada** porque o objeto
  simplesmente não é criado.

### 5.3 Chain dispatch (padrão 4) — barato, mas só rende com frota ocupada

Dar a próxima corrida a quem está a acabar a actual, se o destino dela ficar perto.

- Custo: **1 leitura** à D1 por pedido (procurar viagens `IN_PROGRESS` do motorista) — ao câmbio do
  plano (50 leituras = 1 escrita) é praticamente de graça.
- Rende: quando a maioria da frota está **ocupada**. Com 1 motorista, zero. Guardar para quando houver
  ≥10–20 motoristas em simultâneo.

### 5.4 Emparelhamento em lote (padrão 3) — **não agora**

Só faz sentido quando há **muitos** pedidos e **muitas** motoristas na mesma janela de segundos. Com
poucos, adiciona **latência** (esperar 3–5 s antes de oferecer) sem ganho de espera média — e a
LADIESGO já resolve o mesmo problema por outra via: a fila exclusiva com expansão de raio.

**Quando passar a valer:** quando houver sistematicamente >5 pedidos `REQUESTED` em simultâneo na
mesma zona. Nessa altura, o lote **também poupa pedidos** (uma decisão em vez de N ofertas), por isso
é uma optimização de custo, não só de qualidade.

### 5.5 Previsão e posicionamento (padrão 8) — precisa de dados que não existem

Precisa de semanas de histórico por zona e hora. A base tem **121 viagens no total**. Não é uma
questão de esforço, é de matéria-prima.

---

## 6. O que **não** vale a pena copiar (para não se perder tempo)

| Coisa deles | Porque não se aplica |
|---|---|
| **Spanner / Ringpop / sharding de base de dados** | A D1 da LADIESGO tem **121 viagens** e **26 utilizadores**. O maior problema de leitura era `places` (23 332 linhas) e já foi resolvido com FTS5-only. |
| **Kafka + Flink** (DoorDash, 100 mil milhões de eventos/dia) | Não há fluxo de eventos para processar. O equivalente da LADIESGO é o cron por minuto, que já corre. |
| **Reinforcement learning no despacho** | Precisa de milhões de episódios. DiDi e DoorDash treinam com dados que a LADIESGO só terá com anos de operação. |
| **Emparelhamento em lote com solver de grafo bipartido** | Custa CPU e latência; com 1–10 motoristas o resultado é igual ao "mais próxima". |
| **Réplica multi-região / multi-cloud** | O Free é uma conta, uma região. Nem é opção. |
| **Sharding do `NotifHub` por utilizador** | Já é 1 DO por utilizador. O problema conhecido (`notifPokeMany` rebenta o limite de subrequests com >45 destinatários) é real mas **não acontece com 26 utilizadores** — está documentado e não corrigido de propósito. |

---

## 7. A lição do DoorDash, traduzida

O DoorDash diz: **quando a procura passa a capacidade, decides com informação incompleta — e isso é
melhor do que fazer fila.**

A LADIESGO já tem essa válvula, com outro nome: `quota_shed`.

| Nível | O que faz |
|---|---|
| 0 | normal |
| 1 | `/api/places/search` deixa de consultar `places_fts` (só cache + Photon/Nominatim) |
| 2 | `/trips/history` devolve 8 em vez de 30 (**e lê 22 linhas em vez de 319**) |

E o `stale_guard` é o mesmo princípio aplicado às viagens: uma viagem `REQUESTED` sem ninguém há
6 min **é fechada** — porque uma viagem aberta sem ninguém custa **~600 pedidos de DO por hora**, e
"não deixar correr" é mais barato do que "aguentar".

Isto é exactamente o anel que a maior parte das plataformas pequenas **não** tem e que a LADIESGO
tem desde 30/10.

---

## 8. Ordem de ataque recomendada

1. **Preço por hora/zona** (decisão de negócio; 0 pedidos, poucas linhas de código).
2. **Shard do `DriverGeo` + `RequestsHub` por geohash de 4 caracteres** — prepara o muro dos
   ~600–700 motoristas antes de ele aparecer. 0 pedidos extra.
3. **Chain dispatch** — 1 leitura por pedido, só quando houver ≥10 motoristas simultâneas.
4. **Emparelhamento em lote** — só quando houver >5 pedidos `REQUESTED` em simultâneo na mesma zona.
5. **Nada de RL, forecast, Kafka/Flink, Spanner.**

E, antes de qualquer um destes: **as escritas da D1 (≈34/viagem) são o segundo tecto a ≈2 940** —
qualquer ganho adicional além das ~2 850 viagens/dia tem de vir de **escritas**, não de pedidos.

---

## 9. Fontes

- Uber — *Marketplace Matching* (`uber.com/marketplace/matching`): emparelhamento em lote, "primeiro
  a pedir" vs. lote.
- Uber — *Fulfillment Platform: Ground-up Re-architecture* (`uber.com/blog/fulfillment-platform-rearchitecture`):
  separação Trip / Supply, fluxo dirigido a eventos.
- Uber — *H3* (`h3geo.org`, `uber.com/blog/h3`) e *Orders Near You* (índice geoespacial no Pinot,
  distância em hexágonos).
- Lyft — *Non-Exclusive Notifications for Ride-Hailing at Lyft II: Simulations and Marketplace
  Analysis*, `arXiv:2603.21531v2` (2026).
- Grab — *Understanding Supply & Demand in Ride-hailing Through the Lens of Data*
  (`engineering.grab.com`, 2019): geohash, oferta distribuída pela procura vizinha com peso inverso à
  distância.
- DiDi — *Large-Scale Order Dispatch in On-Demand Ride-Hailing Platforms* (KDD 2018,
  `doi:10.1145/3219819.3219824`); *Ride-hailing Order Dispatching at DiDi via Reinforcement Learning*
  (2020); resumos técnicos do motor de despacho (broadcast → lote → chain dispatch; >30 M pedidos/dia,
  >60 k/min no pico, >90 % de resposta no pico, −15 % de recolha).
- DoorDash — *How DoorDash Built a Next-Generation Real-Time Dispatch Platform* (2026-10-20):
  procura 4× a capacidade, curva quadrática, coordenação separada do cálculo, fatia local por nó,
  10× débito, 99,9 % <20 s, shadow testing.
- LADIESGO — `AGENTS.md` §12–§15, `docs/MAIS-CORRIDAS-POR-DIA-2026-10-30.md`,
  `docs/QUOTA-PROTECAO.md`, `AUDITORIA-50K-VIAGENS.md`.
