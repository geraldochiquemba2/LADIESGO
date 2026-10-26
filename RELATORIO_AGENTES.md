# Relatório — Agentes (Claude Skills) Instalados no LadiesGo

**Projeto:** LadiesGo — Táxi exclusivo para mulheres (Luanda, Angola)  
**Repositório local:** `C:\Users\Geraldo\LADIESGO`  
**Fonte:** [ognjengt/founder-skills](https://github.com/ognjengt/founder-skills) — **560★** (o repositório de founder skills para Claude com mais estrelas no GitHub)  
**Data da instalação:** 20/10/2026  
**Contexto do fundador criado:** `FOUNDER_CONTEXT.md` (raiz do projeto)  
**Pasta dos skills:** `.claude/skills/`

---

## Resumo executivo

Foram instalados **15 agentes (skills)** do repositório `ognjengt/founder-skills` na pasta `.claude/skills/` do projeto LadiesGo. Cada skill é um arquivo `SKILL.md` com instruções detalhadas para o agente de IA executar uma função específica de negócio (marketing, produto, vendas, estratégia, copywriting, etc.).

Os skills funcionam no OpenCode / Claude Code sendo invocados pelo nome, por exemplo:
```
/prd-generator descreva sua ideia de produto
/go-to-market-plan detalhe seu produto e mercado
/verdict (se houver pipeline adversarial)
```

---

## Lista completa dos 15 agentes instalados

| # | Nome (skill) | Pasta | O que faz | Quando usar |
|---|-------------|-------|-----------|-------------|
| 1 | **brand-copywriter** | `brand-copywriter/` | Escreve copy de marketing usando frameworks comprovados (AIDA, PAS, BAB, etc.) em 2 versões para A/B testing | Anúncios Facebook/Instagram, landing pages, emails, posts LinkedIn |
| 2 | **competitor-intel** | `competitor-intel/` | Analisa concorrentes com pesquisa real na web (Crunchbase, LinkedIn, G2, Similarweb, etc.) e identifica fraquezas exploráveis | Análise competitiva, posicionamento, previsão de movimentos do rival |
| 3 | **cro-optimization** | `cro-optimization/` | Audita páginas de destino contra 13 princípios de CRO e entrega recomendações específicas com antes/depois | Otimização de landing pages, aumento de conversão |
| 4 | **go-to-market-plan** | `go-to-market-plan/` | Entrega 3 estratégias de lançamento (GTM) específicas para o produto, estágio e mercado | Plano de entrada no mercado, estratégia de aquisição |
| 5 | **lead-magnet-generator** | `lead-magnet-generator/` | Cria posts virais de lead magnet (2 formatos: rápido e detalhado) com gatilhos mentais | Captura de leads via redes sociais (X, LinkedIn) |
| 6 | **linkedin-writer** | `linkedin-writer/` | Gera 2 posts virais para LinkedIn em formatos diferentes, com voz de fundador | Conteúdo LinkedIn, autoridade de marca |
| 7 | **marketing-ideas** | `marketing-ideas/` | Seleciona as 5 melhores ideias de um banco de 170+ estratégias comprovadas, aplicadas ao seu negócio | Ideias de marketing, crescimento |
| 8 | **outreach-specialist** | `outreach-specialist/` | Cria sequências de outreach (3 mensagens) personalizadas para LinkedIn DM, email, X DM | Vendas, parcerias, captação de motoristas/passageiras |
| 9 | **prd-generator** | `prd-generator/` | Gera um PRD (Product Requirements Document) completo em markdown + PDF, otimizado para IA | Especificação de produto, documentação de requisitos |
| 10 | **pricing-strategist** | `pricing-strategist/` | Constrói estratégia de preços com tiers, pontos de preço, justificativa e táticas psicológicas | Definição de preços, comissão da plataforma |
| 11 | **product-hunt-launch-plan** | `product-hunt-launch-plan/` | Plano completo de lançamento no Product Hunt (pré, durante, pós) com templates | Lançamento de produto, visibilidade |
| 12 | **sop-creator** | `sop-creator/` | Cria SOPs (procedimentos operacionais padrão) escritos em nível de 5ª série, passo a passo | Documentação de processos internos, onboarding |
| 13 | **strategic-planning** | `strategic-planning/` | Identifica os 3 próximos movimentos de maior impacto para o negócio | Estratégia de crescimento, próximos passos |
| 14 | **viral-hook-creator** | `viral-hook-creator/` | Cria 3-5 hooks virais usando 18 padrões psicológicos e palavras gatilho | Aberturas de posts, vídeos, threads |
| 15 | **x-writer** | `x-writer/` | Gera 3 posts virais para X/Twitter em formatos diferentes, com voz de criador correspondente | Conteúdo X/Twitter, crescimento orgânico |

---

## Detalhamento de cada agente

### 1. brand-copywriter
**Propósito:** Gera copy profissional em duas versões — uma usando o framework ideal para a plataforma e outra com framework alternativo para teste A/B.

**Referências obrigatórias:** `copy_frameworks.md` (14 frameworks) + `writing_styles.md` (regras de voz de Ogilvy, Schwartz, Hopkins, etc. + lista de frases banidas).

**Saída:** Copy Brief + Versão A (framework primário) + Versão B (framework alternativo) + Recomendação de qual testar primeiro.

**Regras-chave:** Uma ideia por frase, voz ativa, números específicos, benefícios sobre features, CTA único claro, zero frases banidas (ex: "game-changer", "revolutionário", "seamless").

---

### 2. competitor-intel
**Propósito:** Fornece inteligência competitiva baseada em dados reais da web — sem achismos.

**Fluxo:** Pesquisa web obrigatória em Crunchbase, LinkedIn, G2/Capterra, Similarweb, Ahrefs, Semrush, Google Trends, BuiltWith, GitHub, Meta Ads Library + busca de fraquezas e sentimentos negativos.

**Saída:** Métricas verificadas (com fonte), 3 estratégias de alavancagem baseadas em fraquezas verificadas, 2 previsões de próximos movimentos do concorrente, lacunas de informação.

**Regra crítica:** Toda métrica deve ter link da fonte ou ser marcada como "Não disponível publicamente". Nunca estimar.

---

### 3. cro-optimization
**Propósito:** Auditoria completa de CRO de landing pages.

**Referências obrigatórias:** `cro_principles.md` (13 princípios), `landing_page_patterns.md` (padrões reais de ClickUp, Notion, Stripe, Apple), `element_audit_framework.md`.

**Saída:** Relatório executivo, o que está funcionando, problemas críticos, otimizações de alto impacto, análise seção por seção, quick wins, roadmap de testes, comparação com benchmarks.

---

### 4. go-to-market-plan
**Propósito:** Entrega 3 estratégias de go-to-market específicas para o estágio, produto e mercado do fundador.

**Fluxo:** Lê `FOUNDER_CONTEXT.md`, faz até 10 perguntas diagnósticas se faltar contexto, analisa PMF status e ponto de entrada no mercado, gera 3 estratégias ranqueadas com playbook passo a passo, métricas e ação para fazer hoje.

**Saída:** 3 estratégias com nome, o que é e por que funciona, playbook exato, métricas, marcos esperados, ação de hoje + ordem de execução + critérios de sucesso.

---

### 5. lead-magnet-generator
**Propósito:** Gera 2 posts virais de lead magnet (formato rápido e detalhado) para troca de engajamento por recurso gratuito.

**Referências obrigatórias:** `lead-magnet-patterns.md`, `hook-patterns.md` (18 padrões de viral-hook-creator), `trigger_words.md`.

**Saída:** Lead Magnet Brief, 2 opções de hook, Versão 1 (Quick Format), Versão 2 (Detailed Format), adaptado para Twitter/X ou LinkedIn.

**Regras:** Zero emojis, zero hashtags no corpo, credibilidade com números específicos, valor ancorado, palavra gatilho em maiúsculas.

---

### 6. linkedin-writer
**Propósito:** Gera 2 posts virais para LinkedIn em formatos diferentes (sem repetição), com voz de fundador.

**Referências obrigatórias:** `linkedin-formats.md` (7 formatos), `linkedin-posts.md` (biblioteca de posts virais).

**Formatos disponíveis:** Lessons Learned, Actionable Blueprint, Personal Story, Strategy Breakdown, Case Study, Industry Hot Take, Quick Hack.

**Saída:** 2 posts prontos para copiar e colar, cada um em formato diferente, com hook forte nas primeiras 2 linhas (antes do "see more"), sem hashtags no corpo, sem engagement bait.

---

### 7. marketing-ideas
**Propósito:** Seleciona as 5 melhores ideias de marketing de um banco de 170+ estratégias comprovadas, aplicadas especificamente ao negócio do usuário.

**Referência obrigatória:** `marketing-ideas-database.md` (170+ ideias organizadas por categoria: Leads & Conversions, Buzz Without Paid Ads, Customer Sharing, Crushing Competitors, Retention, Events, etc.).

**Saída:** Top 5 ideias ranqueadas, cada uma com "A Estratégia" (o que é, exemplo real, psicologia) + "Como aplicar ao [Empresa]" (plano ação específico) + Quick-Start Action Plan (uma ideia para fazer hoje).

**Regra:** Toda recomendação deve vir do banco de dados. Nada inventado.

---

### 8. outreach-specialist
**Propósito:** Cria sequências de outreach (padrão 3 mensagens) humanas que booking calls e obtêm respostas.

**Referências obrigatórias:** `outreach-templates.md` (8 templates), `sequence-strategy.md` (estrutura de sequência, timing, regras por plataforma).

**Saída:** Sequência com Message 1 (Dia 1), Message 2 (Dia 3-4), Message 3 (Dia 7-10), cada uma com assunto (se email), texto pronto para enviar, CTA único.

**Regras:** Soar humano, zero em dashes, zero AI slang (leverage, streamline, synergy, etc.), uma frase sobre o prospecto primeiro, CTA de baixo compromisso.

---

### 9. prd-generator
**Propósito:** Transforma uma ideia de produto em um PRD completo (markdown + PDF) otimizado para ferramentas de IA de codificação.

**Referência obrigatória:** `prd_template.md` (estrutura completa de 15 seções).

**Fluxo:** Lê input inicial, faz até 7 perguntas esclarecedoras, gera PRD com acceptance criteria testáveis para cada feature, salva em `./prd_outputs/[Projeto]/`, converte para PDF com `npx md-to-pdf`.

**Seção obrigatória:** "Implementation Notes for AI" (ordem de build, bibliotecas, detalhes críticos de implementação).

---

### 10. pricing-strategist
**Propósito:** Constrói estratégia de preços completa com tiers, pontos de preço, justificativa e táticas psicológicas.

**Referência obrigatória:** `FOUNDER_CONTEXT.md` (bloqueante — deve ser lido primeiro).

**Fluxo:** Lê contexto, faz até 7 perguntas apenas sobre o que falta, determina tipo de estratégia (SaaS Tiered, Consumer Tiered, Usage Tiers, Package, Freemium, Hybrid), constrói até 4 tiers com preço mensal e anual, justificativa de preço, posicionamento, táticas psicológicas, gatilhos de upgrade, otimização de receita, maior risco de preço.

**Princípios:** Preço baseado em valor, não em custo. Máximo 4 tiers. Annual = 20-25% off. Tier do meio é o herói.

---

### 11. product-hunt-launch-plan
**Propósito:** Plano completo de lançamento no Product Hunt para ranquear #1.

**Referência obrigatória:** `ultimate_product_hunt_launch_guide.md` (guia completo de 3 fases: Antes, Durante, Depois).

**Fluxo:** Faz até 10 perguntas de descoberta, avalia força de suporte, prontidão de assets, timeline, gera plano personalizado com execução hora-hora no dia do lançamento, templates prontos (DM para apoiadores, thread do Twitter, email para assinantes), 20+ plataformas alternativas priorizadas.

**Regra de honestidade:** Ser realista sobre chances de ranqueamento baseado na situação atual. Não prometer #1 se base de suporte for pequena.

---

### 12. sop-creator
**Propósito:** Transforma descrições de processos em SOPs claros escritos em nível de 5ª série.

**Saída:** SOP com versão, owner, audiência, propósito, quem executa, ferramentas, requisitos iniciais, instruções passo a passo (uma ação por passo, verbos de ação, resultado esperado), quality check, problemas comuns e correções, notas, histórico de versões.

**Regras:** Frases curtas (10-15 palavras), palavras simples, um ação por passo, começar cada passo com verbo de ação, definir acrônimos, avisos antes de ações destrutivas.

---

### 13. strategic-planning
**Propósito:** Identifica os 3 próximos movimentos de maior impacto para marketing ou vendas.

**Fluxo:** Lê `FOUNDER_CONTEXT.md`, faz perguntas diagnósticas se faltar contexto, analisa estado atual vs desejado, gap analysis, pontos de alavancagem, gera 3 movimentos ranqueados com estratégia, playbook exato, métricas, resultados esperados, ação para fazer hoje.

**Regras:** Zero conselho genérico. Usar nomes reais da empresa, produto, ICP. Cada movimento deve ser executável com recursos atuais. "Would I bet money on this?" test.

---

### 14. viral-hook-creator
**Propósito:** Gera 3-5 hooks virais usando padrões psicológicos comprovados e palavras gatilho.

**Referências obrigatórias:** `hook-patterns.md` (18 padrões), `trigger_words.md` (4 categorias: Insider, Helper, Thinker, Amplifiers).

**Saída:** Hooks com nome do padrão como título, cada um usando padrão diferente, cada um com 1-2 palavras gatilho integradas naturalmente.

**Limites:** Máx 120 caracteres para X/Twitter, 1-2 linhas para vídeo, active voice, present tense, números específicos.

---

### 15. x-writer
**Propósito:** Gera 3 posts virais para X/Twitter em formatos diferentes, com voz de criador correspondente.

**Referências obrigatórias:** `formats.md` (8 formatos), `posts.md` (49+ posts virais), `voices.md` (7 vozes: Hormozi, Naval, Gazdecki, Dakota, Machina, Ognjen, Dan Koe).

**Voices disponíveis:** Alex Hormozi (negócios, pricing, vendas), Naval Ravikant (filosofia, minimalismo), Andrew Gazdecki (startups, CEO), Dakota Robertson (produtividade, hábitos), Machina (IA, ferramentas), Ognjen Gatalo (SaaS growth), Dan Koe (responsabilidade pessoal, foco).

**Formatos:** One-Liners, Two-Part Punch, Numbered Lists, Stacked Progression, Comparison, Example + Takeaway, Reverse Advice, Humor.

**Saída:** 3 posts prontos para X, cada um em formato diferente, cada um com voz correspondente, máximo 280 caracteres cada (ou thread), sem hashtags, sem engagement bait.

**Teste:** "Screenshot Test" — alguém printaria e compartilharia?

---

## Como usar esses agentes no LadiesGo

Cada agente está disponível em `.claude/skills/<nome>/SKILL.md`. Para usar, invoque pelo nome no OpenCode/Claude Code. Exemplos práticos para o LadiesGo:

```
/go-to-market-plan Lançar LadiesGo em Luanda para mais passageiras e motoristas
/pricing-strategist Definir comissão da plataforma e preços das categorias Económico/Conforto/Família
/marketing-ideas Ideias para captar motoristas mulheres em Luanda
/outreach-specialist Sequência para convidar motoristas mulheres a se cadastrar
/cro-optimization Auditar a landing page ladiesgo.html para melhorar cadastro na lista de espera
/brand-copywriter Escrever anúncio no Facebook para LadiesGo
/prd-generator Especificar nova funcionalidade de segurança (SOS, compartilhamento de corrida)
/viral-hook-creator Hooks para post sobre segurança do LadiesGo
/x-writer 3 posts para promover LadiesGo no X
/linkedin-writer 2 posts para divulgar LadiesGo para empresas em Luanda
/competitor-intel Analisar Uber e Bolt em Luanda
/product-hunt-launch-plan Plano para lançar LadiesGo no Product Hunt
/sop-creator Criar SOP de onboarding de nova motorista
/strategic-planning 3 próximos passos para crescer o LadiesGo
/lead-magnet-generator Post para captura de leads (ex: guia de segurança para mulheres)
```

---

## Arquivos criados/modificados no repositório

| Caminho | Ação |
|---------|------|
| `.claude/skills/` | Pasta criada com 15 skills (36 arquivos copiados) |
| `FOUNDER_CONTEXT.md` | Criado com contexto do negócio LadiesGo |

---

## Próximos passos sugeridos

1. **Executar um agente** — Escolha qual skill quer rodar primeiro (ex: `/go-to-market-plan` para estratégia de crescimento do LadiesGo).
2. **Customizar o FOUNDER_CONTEXT.md** — Adicione mais detalhes sobre métricas atuais, número de motoristas/passageiras, metas de receita.
3. **Commit e push** — O repositório está em `main` atualizado com `origin/main`. Lembre-se da regra do AGENTS.md: fazer `git push` depois de cada commit.
4. **Cuidado com quotas Cloudflare** — Não rode testes de carga contra produção. A conta oficial é `rererererererere670@gmail.com`; a conta nova (isabel) está desativada. Ver `AGENTS.md`.

---

**Repositório de origem:** https://github.com/ognjengt/founder-skills (560★, MIT License)  
**Instalação manual feita:** `cp -r founder-skills/skills/* .claude/skills/`
