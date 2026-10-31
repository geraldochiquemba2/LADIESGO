# Como ter mais acessos e mais viagens — investigação e propostas

*2026-10-31 · pesquisa de mercado + estado real do repositório*

---

## 0. Resumo em 10 linhas

1. A app **só existe na App Store (iOS)**. Em Angola o **Android é 81,65 %** do tráfego móvel
   (iOS 18,3 %). Ou seja: **4 em cada 5 pessoas não conseguem instalar a LADIESGO**. É o maior
   bloqueio de "acessos" que existe hoje — e não é marketing, é distribuição.
2. Mesmo na Play Store, o **push do Android está partido** (falta `google-services.json`), logo não
   há como trazer de volta quem instalou.
3. Angola tem **17,6 M de utilizadores de internet (44,8 %)**, **5,50 M no Facebook** (42,2 % mulheres
   ≈ **2,3 M**), **3,95 M no TikTok (18+)** e **908 mil no Instagram**. É onde se compra atenção.
4. O **WhatsApp é o canal real** de distribuição em Angola (grupos, listas, comprovativos). A app já
   o usa para pagamentos — mas não para crescer.
5. O concorrente que mais cresce é o **inDrive**: **15 400 → 55 300 utilizadores ativos em ~6 meses**,
   com **preço negociado + dinheiro vivo**. Prova de que o modelo "barato e local" ganha.
6. O incumbente é a **Yango: 7 000 motoristas, 3 cidades**. Paga às motoristas em **3–7 dias** — e essa
   é a fraqueza mais explorável ("recebes no mesmo dia").
7. A **Heetch** (3.º na App Store de Angola) vive de queixas de **cancelamentos e cobranças a mais**.
   É exatamente o problema que a LADIESGO resolve.
8. A LADIESGO já tem ativos de crescimento **construídos e por usar**: link público da viagem,
   Partida Compartilhada, reservas Premium, destinos guardados, carteira, push, 3 categorias.
9. Falta o básico de crescimento: **convite/referral**, **Android**, **push Android**, **analytics/UTM**
   e **pagamento online**.
10. O caminho mais barato para *mais viagens* não é mais tráfego — é **fazer a 2.ª viagem acontecer**
    em quem já instalou (push + repetir viagem + partilha).

---

## 1. O que os números dizem

### 1.1 O mercado angolano (fim de 2025 / 2026)

| Indicador | Valor | Fonte |
|---|---|---|
| População | 39,3 M (idade mediana **16,6 anos**) | DataReportal, Digital 2026: Angola |
| Utilizadores de internet | **17,6 M** (44,8 %) — 21,7 M ainda offline | idem |
| Ligações móveis ativas | **30,6 M** (77,8 %) | idem |
| Facebook | **5,50 M** — **42,2 % mulheres** (≈2,3 M) | idem |
| TikTok (18+) | **3,95 M** (a crescer mais depressa) | idem |
| Instagram | ~908 mil (2025) | idem |
| LinkedIn | 1,40 M | idem |

**Leitura:** o público da LADIESGO (mulheres 18–45 em Luanda) está sobretudo no **Facebook** e no
**TikTok**, e comunica por **WhatsApp**. Instagram é secundário. Anúncios pagos no Facebook/Instagram
chegam a 2,3 M de mulheres — mas pagar tráfego antes de haver oferta é queimar dinheiro (ver §4).

### 1.2 Android vs iOS — o bloqueio nº 1

| Sistema | Quota em Angola (Set/2026) |
|---|---|
| **Android** | **81,65 %** |
| iOS | 18,3 % |

A LADIESGO tem **apenas** build iOS (`.github/workflows/build-ios.yml`; não existe workflow Android).
**Não há app Android publicada.** O webapp (`ladiesgo.pages.dev`) funciona em Android, mas ninguém
"instala" um site — e sem instalação não há push, ícone, nem hábito.

### 1.3 Concorrência (App Store Angola, Top Travel, 22/10/2026)

| # | App | Factos relevantes |
|---|---|---|
| 1 | **Yango** | 7 000 motoristas, 3 cidades (Luanda, Benguela, Lobito), 4 anos. 4,8★ com 138 mil avaliações. **30 % nas 3 primeiras viagens (até 1 000 Kz)** e **1 000 Kz por convite**. Paga às motoristas em **3–7 dias**. |
| 2 | **inDrive** | **15 400 → 55 300 utilizadores ativos** entre o início do 2.º trimestre e o fim de setembro de 2025. Modelo: **o passageiro propõe o preço, a motorista aceita/contrapropõe**. Dinheiro vivo. |
| 3 | **Heetch** | Queixas públicas recorrentes: cancelam depois de aceitar, pedem valor acima do app, cobram bagagem. |
| 4 | Yango Lite | App leve (10× menos espaço) para telemóveis fracos. |
| 5 | Bolt | Presença pequena e estável (3–4 mil downloads/semana em 2025). |
| 6 | Uber | Presente na loja, sem operação local relevante. |

Outros players locais: **UGO** (Multicaixa Express, TPA e dinheiro; autorizado para pessoal da
embaixada dos EUA), **ESPAES** (tem opção "mulheres conduzem mulheres"), **Táxi Map** (candongueiros,
grátis para passageiros, otimizado para rede fraca), **Tupuca+** (super app com táxi).
**ANATA**: 33 000 taxistas associados, **18 000 em Luanda**.

**Leitura:** ninguém em Angola é "a app segura para mulheres" como marca. A ESPAES tem a opção; não é a
identidade. É aí que a LADIESGO ganha — mas só se estiver instalável.

### 1.4 O que a LADIESGO já tem e não está a usar para crescer

| Ativo (já no código) | Como vira crescimento |
|---|---|
| `GET /api/v1/trips/public/:id/live` (link público, sem login) | Cada viagem partilhada no WhatsApp é uma **landing page com a marca** vista por família e grupos |
| **Partida Compartilhada** (`shared_departures`) | "Dividir o táxi" é cultural (candongueiro) e 1 partida = até 4 passageiras |
| **Reserva Premium** | Receita antecipada e cliente recorrente |
| **Guardar destinos** | "Repetir última viagem" a 1 toque |
| **Push Expo** + `NotifHub` | Reativação e 2.ª viagem |
| **Carteira** (`wallet_tx`) | Créditos de convite e cashback |
| **3 categorias com preço/pessoa** | Oferta clara: 1 500 / 2 500 / 3 500 Kz |

**O que falta:** referral, Android, push Android, analytics/UTM, pagamento online.

---

## 2. As propostas

Cada proposta tem: **o que é · porquê · custo · esforço · como medir**.
P0 = desbloqueia tudo o resto. P1 = aquisição quase grátis. P2 = receita recorrente.
P3 = mais viagens sem mais acessos. P4 = oferta (sem carros não há viagens).

### P0 — Desbloquear a distribuição

#### 1. Publicar na Google Play

- **O que:** conta de programador Google Play + workflow de build Android (o `app.json` já tem
  `package: com.ladiesgo.app`, ícones adaptativos e permissões de localização em fundo).
- **Porquê:** 81,65 % do mercado é Android. Hoje a app é invisível para 4 em cada 5 pessoas.
- **Custo:** **25 USD** (≈24 500 Kz) uma vez.
- **Atenção (regra do Google):** contas **pessoais** criadas depois de 13/11/2023 obrigam a um
  **teste fechado com ≥12 testadores durante 14 dias consecutivos** antes da produção. Contas de
  **organização** (com D-U-N-S/NIF de empresa) **não** têm essa exigência. Recomendação: abrir como
  organização; se não der, recrutar 15 testadores (folga para desistências) e começar já — os 14 dias
  correm sozinhos.
- **Esforço:** 1 workflow + 1 keystore + ficha da loja (descrição, 6 capturas, ícone, política de
  privacidade). ~1–2 dias de trabalho.
- **Medir:** instalações Android vs iOS por semana.

#### 2. Corrigir o push no Android

- **O que:** obter o `google-services.json` do projeto Firebase `com.ladiesgo.app`, pô-lo em
  `mobile/` (fora do git) e apontar `android.googleServicesFile` no `app.json`.
- **Porquê:** sem isto, o `getExpoPushTokenAsync()` falha em silêncio no Android — nenhuma notificação
  chega. Publicar na Play sem push é publicar uma app muda.
- **Custo:** 0.
- **Esforço:** 1 hora (dono tem de criar/aceder ao projeto Firebase).
- **Medir:** nº de utilizadores com `fcmToken` preenchido.

#### 3. "Adicionar ao ecrã inicial" (PWA)

- **O que:** `manifest.json` no webapp + prompt de instalação no `/ladiesgo`.
- **Porquê:** instalação **sem loja**, imediata, para quem tem Android antigo ou pouca memória.
  É o que o Táxi Map faz ("funciona com a rede que tem, gasta poucos dados").
- **Custo:** 0. **Esforço:** meio dia.
- **Medir:** instalações PWA (evento `appinstalled`).

### P1 — Aquisição com custo quase zero

#### 4. Convite (referral) — ambos ganham

- **O que:** cada utilizadora tem um código/ligação. Quem convida e quem entra recebem **crédito na
  carteira** (sugestão: **500 Kz cada**, creditado na **1.ª viagem concluída** do novo — não no registo,
  para não pagar contas falsas).
- **Porquê:** é o mecanismo nº 1 de crescimento em ride-hailing. A Yango paga **1 000 Kz por convite**;
  a LADIESGO pode pagar menos e ainda assim ser atrativo porque o convite vem de uma amiga (confiança).
- **Custo:** 1 000 Kz por par convertido. 100 convites = 100 000 Kz.
- **Esforço:** 1 migração (`users.referralCode`, `users.referredBy`) + endpoint + crédito em
  `wallet_tx` no `PUT /trips/:id/complete`. ~2 escritas D1 por convite (irrelevante na quota).
- **Medir:** % de registos com `referredBy`, e quantos fazem a 1.ª viagem.

#### 5. Partilhar a viagem no WhatsApp (o link público já existe)

- **O que:** botão **"Partilhar a minha viagem"** que abre `wa.me/?text=…` com o link
  `/trips/public/<id>/live` e uma frase pronta ("Vou na LadiesGo — podes acompanhar a minha viagem
  aqui"). Quem abre vê o carro no mapa **com a marca** e um botão "Pedir a minha".
- **Porquê:** transforma **cada viagem** num anúncio visto por família e grupos. Custo zero por
  impressão e a mensagem vem de alguém de confiança — o oposto de um anúncio.
- **Custo:** 0. **Esforço:** ~2 horas (botão + texto + CTA na página pública).
- **Medir:** visitas à página pública, e quantas geram registo.

#### 6. WhatsApp como canal oficial

- **O que:** número comercial com **perfil de empresa** (horário, morada, catálogo com as 3 categorias
  e preços), **listas de transmissão** e presença em grupos: condomínios (Talatona, Kilamba, Nova Vida),
  universidades (ISPTEC, UCAN, Uni. Agostinho Neto), igrejas, empresas.
- **Porquê:** em Angola o WhatsApp é onde as pessoas combinam transporte. A app já o usa para
  comprovativos (`PRM_WA`) — falta usar para captar.
- **Custo:** 0. **Esforço:** 1 dia de configuração + disciplina diária.
- **Medir:** conversas iniciadas → registos com UTM `?src=wa`.

#### 7. TikTok e Instagram com histórias reais

- **O que:** 3 vídeos/semana, formatos curtos e repetíveis:
  (a) "a minha motorista chegou" — 15 s do carro a chegar;
  (b) histórias de passageiras (com autorização) sobre chegar segura a casa à noite;
  (c) bastidores da operação (como se escolhe uma motorista);
  (d) respostas a comentários do tipo "mas é caro?" com o preço real.
- **Porquê:** 3,95 M de utilizadores TikTok 18+ em Angola, o público mais jovem, e é o canal onde a
  concorrência **não** está a contar histórias de segurança.
- **Custo:** tempo + dados. Se houver verba: 20–50 mil Kz/mês em impulsionamento dos 2 melhores vídeos.
- **Esforço:** 2–3 h/semana.
- **Medir:** cliques na bio (link com UTM) → instalações.

#### 8. QR físico onde as pessoas esperam táxi

- **O que:** cartaz A5 com QR → `/ladiesgo`, em paradas de táxi, mercados, salões de beleza,
  farmácias, clínicas, universidades, aeroporto.
- **Porquê:** o QR resolve o problema de "não sei o nome da app na loja". E o aeroporto é o ponto de
  maior valor por viagem.
- **Custo:** impressão (≈5–15 mil Kz por 50 cartazes). **Esforço:** 1 dia + distribuição.
- **Medir:** registos com `?src=qr<local>`.

### P2 — Receita recorrente (a que paga a operação)

#### 9. Contas B2B pré-pagas

- **O que:** pacote mensal de viagens pré-pagas para empresas que transportam **funcionárias** em
  turnos (call centers, clínicas, hospitais, bancos, hotéis, petrolíferas) e para **universidades**
  (transporte noturno de estudantes).
- **Porquê:** não depende de o consumidor decidir pedir; é receita contratada e viagens previsíveis.
  1 contrato com 10 pessoas × 20 dias = **200 viagens/mês** — mais do que a operação faz hoje.
- **Custo:** 0 (a app já tem contas e carteira). **Esforço:** comercial (1 reunião por empresa).
- **Medir:** viagens por conta B2B / mês.

#### 10. "Dividir o táxi" como produto (Partida Compartilhada já existe)

- **O que:** promover a Partida Compartilhada como **o produto principal** para rotas fixas
  (Kilamba ↔ Mutamba, Talatona ↔ Marginal, casa ↔ trabalho), com lugar a 1 500–2 500 Kz.
- **Porquê:** com **1 motorista**, 4 passageiras na mesma rota = **4× a receita por hora de carro**.
  E é culturalmente familiar (candongueiro), sem o estigma de "app de rico".
- **Custo:** 0. **Esforço:** comunicação + 3 rotas fixas anunciadas por dia.
- **Medir:** ocupação média por partida (lugares vendidos / lugares).

### P3 — Mais viagens sem mais acessos (o mais barato de tudo)

#### 11. Push de reativação

- **O que:** 3 sequências, com o `NotifHub` que já existe:
  (a) 24 h depois de instalar sem pedir viagem → "A tua primeira viagem tem 20 % de desconto";
  (b) 14 dias sem viajar → "As motoristas perto de ti agora";
  (c) sexta/sábado 21h → "Vais sair? Chega a casa em segurança".
- **Porquê:** o utilizador mais barato de converter é o que já instalou. E a app já tem push
  (iOS a funcionar desde o build #13).
- **Custo:** 0. **Esforço:** 1 endpoint de campanha + cron (o cron por minuto já existe).
- **Medir:** viagens atribuídas a push (`data.type`).

#### 12. "Repetir última viagem" a 1 toque

- **O que:** no `/home`, um cartão com os 2 últimos destinos ("Casa", "Trabalho") que pede a viagem
  com 1 toque. Os destinos guardados já existem.
- **Porquê:** reduz o atrito de pedir — a razão nº 1 de abandono é ter de escrever a morada outra vez.
- **Custo:** 0. **Esforço:** ~1 dia.
- **Medir:** % de viagens iniciadas por atalho.

#### 13. Avaliação → reviews na loja (ciclo ASO)

- **O que:** depois de uma viagem com 5★, pedir review na loja (e nunca depois de uma má).
- **Porquê:** a Yango tem 138 mil avaliações; a LADIESGO tem 1. Sem reviews, ninguém instala.
  Reviews são o fator de conversão mais forte da ficha da loja.
- **Custo:** 0. **Esforço:** 2 horas.
- **Medir:** nº de reviews e nota média.

### P4 — Oferta (sem carros não há viagens)

#### 14. Recrutar motoristas com **pagamento no mesmo dia**

- **O que:** campanha dirigida a mulheres que já conduzem para a Yango/Heetch: **"recebes no fim do
  dia"** + **0 % de comissão nos primeiros 30 dias**.
- **Porquê:** a Yango paga em **3–7 dias** (documentado) e há relatos de motoristas a recusar corridas
  de valor baixo. Pagar no mesmo dia é uma vantagem **operacional**, não de marketing, e é difícil de
  copiar por quem tem liquidação centralizada.
- **Custo:** o custo da comissão perdida no 1.º mês. **Esforço:** comercial + ajuste no fluxo de
  carteira.
- **Medir:** motoristas ativas por semana e viagens por motorista.

#### 15. Financiamento/renting de viatura

- **O que:** parceria com stand/oficina para **renting semanal** com desconto para motoristas LadiesGo
  (a viatura paga-se com as viagens).
- **Porquê:** a falta de carro é a barreira nº 1 para novas motoristas (é apontada como um dos
  desafios estruturais do setor em Angola).
- **Custo:** negociação, não software. **Esforço:** 1–2 parcerias.
- **Medir:** motoristas que entram por esta via.

---

## 3. Ordem recomendada

| Prazo | O que | Porquê agora |
|---|---|---|
| **Semana 1** | Google Play (conta + workflow) · push Android · "adicionar ao ecrã inicial" | Sem isto, tudo o resto é marketing para 18 % do mercado |
| **Semana 2** | Botão "Partilhar viagem" · WhatsApp oficial · QR (primeiros 20 pontos) | Custo 0, efeito imediato |
| **Semana 3–4** | Convite/referral · "repetir última viagem" · push de reativação | O motor de crescimento e retenção |
| **Mês 2** | TikTok/IG (3/semana) · 3 rotas de Partida Compartilhada · 2 contas B2B | Aquisição com prova social + receita recorrente |
| **Mês 3** | Recrutamento de motoristas (pagamento no mesmo dia) · financiamento | Sem oferta, a procura só gera cancelamentos |

**Regra de ouro:** não se compra tráfego enquanto **uma passageira nova não conseguir ser atendida
em <10 min**. Com 1 motorista, mais pedidos = mais cancelamentos = pior nota = menos pedidos.

---

## 4. O que **não** fazer

| Tentação | Porque não |
|---|---|
| **Anúncios pagos no Facebook/Instagram agora** | Paga-se instalação para quem vai desistir na 1.ª tentativa falhada. Só depois de haver oferta e Android. |
| **Guerra de descontos com a Yango** | A Yango dá 30 % nas 3 primeiras viagens e tem 7 000 motoristas. Combate-se com **segurança e confiança**, não com preço. |
| **Comprar seguidores/instalações** | Reviews e números falsos destroem a credibilidade — e a app é sobre confiança. |
| **Abrir Benguela/Lobito antes de Luanda funcionar** | Multiplica a operação (motoristas, suporte) sem resolver o problema base. |
| **Super app (comida, entregas, contas)** | É o caminho do Tupuca/inDrive, mas exige capital e operação. A LADIESGO ganha por ser **estreita e segura**. |
| **Mais servidores/contas Cloudflare** | Os limites do plano Free são **por conta**; contas novas violam os ToS (ver `docs/PICOS-E-CONCORRENCIA-2026-10-31.md` §6). |

---

## 5. Medir: o funil e as metas

Sem medição, tudo isto é opinião. O mínimo a instrumentar:

```
visita → instalação → registo → 1.º pedido → 1.ª viagem concluída → 2.ª viagem em 7 dias
```

- **UTM obrigatório** em todos os links (`?src=tiktok`, `?src=wa`, `?src=qr<local>`, `?src=convite`).
- Guardar `users.source` no registo (1 coluna, 1 escrita) — é o que diz **qual canal paga a pena**.
- **Cloudflare Web Analytics** no Pages (grátis, sem cookies) para visitas e origens.
- A métrica que decide tudo: **% de novos utilizadores que fazem a 2.ª viagem em 7 dias**.
  Abaixo de ~30 % nenhum canal escala; acima de ~40 % vale a pena pagar por instalação.

**Metas sugeridas (primeiros 90 dias, conservadoras):**

| Métrica | Hoje | Meta 90 dias |
|---|---|---|
| Instalações/mês | ~0 novas | 150 |
| Registo → 1.ª viagem concluída | não medido | ≥50 % |
| 2.ª viagem em 7 dias | não medido | ≥35 % |
| Viagens/dia | ~0–1 | 8 |
| Motoristas ativas | 1 | 4 |
| Reviews na loja | 1 | 25 |

---

## 6. Fontes

- DataReportal — *Digital 2026: Angola* (internet, redes sociais, ligações móveis)
- StatCounter — *Mobile Operating System Market Share Angola*, Set/2026 (Android 81,65 % / iOS 18,3 %)
- App Store Tracker — *Top Travel Apps in Angola*, 22/10/2026 (ranking Yango, inDrive, Heetch, Bolt, Uber)
- 360 Angola — *Yango Angola Grows to 7,000 Drivers And Three Cities*, 27/09/2026
- Angola Expert — *Serviços de transporte por aplicação em Luanda* (inDrive 15 400 → 55 300 utilizadores;
  prazos de pagamento da Yango; UGO/embaixada dos EUA)
- Google Play Console Help — *App testing requirements for new personal developer accounts*
- Multicaixa/EMIS — *Gateway de Pagamentos Online*; AppyPay e ProxyPay (APIs: MCX Express, Unitel Money,
  referências; taxas de acquiring típicas 1,5–3,5 %)
- Ver Angola — *ANATA apresenta 'Taxi On'* (33 000 taxistas, 18 000 em Luanda)
