# FOUNDER_CONTEXT — LadiesGo

## Empresa
- **Nome:** LadiesGo
- **Indústria:** Mobilidade / Táxi por aplicativo (ride-hailing)
- **Produto:** App de táxi exclusivo para mulheres — passageiras e motoristas são mulheres
- **Cidade:** Luanda, Angola
- **Idioma da UI:** Português (pt-PT), tratamento informal ("tu")
- **Site/App web:** https://ladiesgo.pages.dev
- **API:** https://ladiesgo-api.ladiesgo-angola.workers.dev

## Público-alvo (ICP)
- Mulheres em Luanda que precisam de transporte seguro
- Mulheres motoristas que querem trabalhar com transporte por aplicativo
- Foco na segurança: apenas mulheres dirigem e apenas mulheres embarcam

## Modelo de negócio
- Corrida paga por passageira à motorista (numerário ou cartão)
- Plataforma cobra comissão sobre cada corrida
- Categorias: Económico, Conforto, Família

## Etapa do negócio
- Em operação / MVP em Luanda
- App web estática (HTML + JS, sem build step) servida no Cloudflare Pages
- App nativa Expo/React Native é casca WebView que carrega a webapp
- Backend: Cloudflare Workers + Hono + Neon/PostgreSQL (D1)

## Concorrência
- Uber, Bolt (gerais, não exclusivos para mulheres)
- LadiesGo se diferencia por ser exclusivo para mulheres (segurança)

## Recursos
- Equipe pequena (fundador + suporte)
- Orçamento limitado (planos gratuitos Cloudflare com quotas rígidas)
- 100.000 pedidos/dia no Workers Free; 100.000 escritas/dia no D1

## Objetivos atuais
- Estabilizar a plataforma após incidentes de quota (out/2026)
- Aumentar número de passageiras e motoristas ativas em Luanda
- Melhorar conversão da landing page (ladiesgo.html → lista de espera)
- Lançar estratégia de crescimento local

## Voz da marca
- Direta, próxima, confiante, em português informal ("tu")
- Foco na segurança e empoderamento feminino
