# LADIESGO — Rumo a Nível Nacional

> Pesquisa e roadmap para levar a LADIESGO (ride-hailing focado na mulher, Luanda/Angola) a escala nacional.
> Data: 2026-10-14 · Stack: Cloudflare Workers + Durable Objects + Neon Postgres + Expo/React Native.
> Relatórios de apoio (research): `docs/research/01..06`.

## TL;DR — os 10 maiores alavancas

1. **A arquitetura está certa.** DO por viagem + hibernação é o caminho para escala nacional. O maior risco é o **`TripRinger` global único**: a Cloudflare diz explicitamente para **não** ter um DO global; é single-threaded (~1.000 req/s) e ponto único de falha. → **Shard por cidade** (`idFromName("luanda")`).
2. **O teto free é ~1.500–2.000 viagens/dia, não 10k.** O primeiro limite que rebenta é o **Neon (100 CU-h/mês)**, porque viagens contínuas impedem o scale-to-zero. Workers Paid ($5/mês) é infraestrutura base, não otimização.
3. **Custo nacional é baixo *se* respeitares a regra de ouro:** GPS e estado vivo **nunca no Postgres** + **hibernação DO em todas as sockets**. Aí fica ~$180/mês @10k viagens/dia → ~$1.300 @200k. O anti-padrão (DO por viagem sem hibernar) custa **$2k–8,6k/mês**.
4. **"Nacional" = Luanda + 3–4 capitais.** Luanda ~9M (25% do país); Benguela/Huambo/Lubango ~0,5–0,65M cada, só onde há smartphone+4G.
5. **Concorrência é preço/comissão, não segurança.** Yango (13–14%, 3 cidades, ~7k motoristas), inDrive (0%, lançou Luanda mai/2025), Heetch (11,4%, só Luanda), Tupuca (super-app local). **Ninguém ocupa "segurança da mulher" → é a tua cunha.**
6. **Pagamentos são cash-first.** Cash ~85% do volume; **Multicaixa Express é o único rail digital verdadeiramente ubíquo** (via AppyPay/ProxyPay/vPOS). Mobile money ainda é imaturo. **Não há Google Play Merchant em Angola** → não podes usar Play Billing; Multicaixa Express é o caminho.
7. **Regulação:** ainda **nenhuma lei dedicada a ride-hailing** (opera-se sob transporte ocasional, Decreto 128/10, regulador ANTT); **Lei 22/11** de proteção de dados com **registo na APD + autorização para transferência internacional (inclui cloud!)** e multas até ~USD 505k.
8. **Mobile (Angola):** Android quase total. O problema não é código, é **OEM a matar apps** (Xiaomi/Huawei/Samsung/Transsion), redes instáveis e dados caros. Maior vitória barata: **subir para Expo SDK 57** (corrige regressão de memória do Hermes no SDK 56).
9. **Segurança:** device binding + JWT assimétrico + OTP endurecido + Turnstile/rate-limit + KYC de motorista + gravação áudio com cifra no dispositivo + SOS/compartilhar viagem.
10. **Fiabilidade/growth:** SLOs, logs estruturados + Analytics Engine, Sentry + PostHog, status page, runbooks, kill switches. **Fiabilidade *é* retenção.**

## Roadmap priorizado

### P0 — agora (desbloquear escala + correção)

| # | Ação | Eixo | Esforço | Porquê |
|---|---|---|---|---|
| P0.1 | Mudar para **Workers Paid** + alertas de orçamento | infra | 0,2 dv | Remove 100k/dia e CPU 10ms |
| P0.2 | **Shardar `TripRinger` por cidade** | arquit | 1–2 dv | Mata SPOF e teto ~1k req/s |
| P0.3 | **Location hints** nos DOs (região mais próxima de Angola) | arquit | 0,5 dv | Latência |
| P0.4 | **H3 cell column** em trips + presença de motorista, indexado | arquit | 1 dv | Queries de matching por célula |
| P0.5 | **PostGIS + índice GiST** no Neon; particionar `trips` por mês | arquit | 1 dv | Geo-rápido + retenção barata |
| P0.6 | **Shard por cidade/região** + degradação graciosa (matcher → greedy; WS → polling) | arquit | 2–3 dv | Resiliência |
| P0.7 | **Expo SDK 57** + verificar Hermes em release | mobile | 0,5 dv | Corrige regressão memória |
| P0.8 | **WS resiliente:** backoff+jitter, AppState/NetInfo, heartbeat, gap-fill por cursor, idempotency keys | mobile | 2–3 dv | Redes más |
| P0.9 | **Fila offline + UI otimista + fallback REST** | mobile | 2 dv | Aceitar/chat mesmo sem rede |
| P0.10 | **"Ring" robusto:** canal alta-importância + full-screen intent (Notifee; permissão Android 14) | mobile | 1–2 dv | Sem isto perde-se a viagem |
| P0.11 | **JWT assimétrico (RS256/ES256)+JWKS**, refresh rotativo com deteção de reuso; **device binding**; step-up passkey/TOTP | seg | 2–3 dv | ATO/SIM-swap |
| P0.12 | **OTP endurecido** (limites por nº/dispositivo/IP, consume atómico, bloquear VoIP, WhatsApp fallback) + **Turnstile + WAF rate rules** | seg | 2 dv | Pumping/fraude |
| P0.13 | **KYC motorista** (BI+licença+liveness+face match+watchlist), foto de identidade visível à passageira | seg | 3–4 dv | Confiança/segurança |
| P0.14 | **SOS + partilhar viagem + chamada mascarada + PIN de embarque + contactos de confiança + RideCheck** | seg/UX | 3–4 dv | Produto-base de segurança |
| P0.15 | **Neon:** usar role sem BYPASSRLS na app + **RLS** + cifra de campo (telefone/BI/GPS) | seg | 1–2 dv | Defesa em profundidade |
| P0.16 | **Registo APD** + DPO/EPD + representante em Angola + política PT/EN | compliance | 1–2 dv | Legal (multas altas) |
| P0.17 | **Pagamentos:** Multicaixa Express via AppyPay/ProxyPay/vPOS, webhooks assinados + idempotência + reconciliação diária | neg | 2–3 dv | Monetização |
| P0.18 | **Observabilidade:** logs estruturados, Analytics Engine para SLIs, Sentry+PostHog, Instatus, PagerDuty Free, 3 runbooks, kill switches | fiab | 2–3 dv | Ver e agir |

### P1 — 3–9 meses (escalar províncias + endurecer)

| # | Ação | Eixo |
|---|---|---|
| P1.1 | **Matching em lote (janela 2s) bipartido** por cidade + **ETA por OSM (OSRM)** + cache | arquit |
| P1.2 | **DOs de célula H3** + CityMatcher; **replicas de leitura Neon**; **R2** para histórico frio | arquit |
| P1.3 | **Fraude:** motor de risco (GPS feasível, mock-location/root, device ID cross-role, grafos de colusão, velocity de promo) | seg |
| P1.4 | **Gravação áudio** (cifra AES-GCM no dispositivo, apagar em ~7d, só abre se reportado, ambos avisados) | seg |
| P1.5 | **Packs de mapa offline** (Luanda/províncias) + data-saver | mobile |
| P1.6 | **Referral milestone-gated** (prémio após 1ª viagem paga) + push/WhatsApp | growth |
| P1.7 | **SLOs + burn-rate** publicados; k6 smoke em CI + carga semanal; 2 experiências de caos | fiab |

### P2 — 9–36 meses (maturação nacional)

| # | Ação | Eixo |
|---|---|---|
| P2.1 | **Bases por região** (Luanda vs províncias) por roteamento KV | arquit |
| P2.2 | **SIM-swap via CAMARA/GSMA Open Gateway** quando operadoras AO aderirem; passkeys em tudo | seg |
| P2.3 | **Expansão cidade-a-cidade** (Benguela/Lobito → Huambo → Lubango/Cabinda) com "standard launch kit" + gate de contribuição | neg |
| P2.4 | **Monetização em camadas:** comissão 8–12%, assinatura, entregas, contas B2B/corporate, financiamento de viatura | neg |
| P2.5 | Multi-região, ML de matching, ISO 27001/SOC2 | maturidade |

## Realidades específicas de Angola a não ignorar
- **Dados móveis caros** → tudo em batch/compressivo; nunca socket aberto em background.
- **OEM killers** → onboarding de fiabilidade (bateria/autostart) + watchdog de tracking + telemetria por fabricante (`dontkillmyapp.com`).
- **Play Billing indisponível** para merchant em Angola → Multicaixa Express; sideload de APK é canal real (não depender do Play Core para updates).
- **Lei 22/11** → registo/notificação APD, autorização para transferências (Neon/Sentry/PostHog fora do país), direito a apagamento; escolher regiões EU e pseudonimizar.
- **Sem lei de ride-hailing ainda** → operar via parceiros com licença (modelo Yango) enquanto registas a tua licença de operador.

## Próximos passos imediatos
1. **P0.1/P0.2** (Workers Paid + shard do `TripRinger`) — pequenos e desbloqueiam tudo.
2. **P0.11/P0.12** (JWT assimétrico + device binding + OTP/Turnstile) — antes de crescer.
3. **P0.17** (Multicaixa Express) + **P0.16** (APD) — legal e monetização.

## Anexos (research completo, com fontes)
- `docs/research/01-realtime-architecture-dispatch.md` — arquitetura realtime, dispatch/matching, Neon/PostGIS, multi-região.
- `docs/research/02-infra-cost-scaling.md` — pricing Cloudflare/Neon 2026, modelo de custo 1k→200k viagens/dia, armadilhas.
- `docs/research/03-mobile-production-readiness.md` — background location, offline, push/ring, performance, mapas, loja/pagamentos AO.
- `docs/research/04-market-competition-ops-angola.md` — concorrência, pagamentos, unit economics, regulação, playbook de expansão.
- `docs/research/05-security-fraud-compliance.md` — fraude, ATO/SIM-swap, Lei 22/11, KYC, pagamentos, arquitetura de segurança.
- `docs/research/06-reliability-observability-growth.md` — SLOs, observabilidade, incidentes, analytics, growth, plano 90 dias.

## Validações locais pendentes
- Confirmar se a **revisão da Lei 22/11** já passou e se introduz notificação de violação obrigatória.
- Confirmar o **Regulamento ANTT para táxis por aplicação** quando publicado (pode obrigar a tracking/panic/KYC específicos).
- Reconfirmar preços Cloudflare/Neon antes de orçamentar (mudam sem aviso; atenção à transição de pricing de Logs em 2026-12-01).
