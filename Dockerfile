FROM node:20-alpine
WORKDIR /app

COPY backend/package*.json ./
# Lock gerado com npm 11: alinhar o npm do Docker (10 no node:20) ou o `ci` falha
RUN npm i -g npm@11 && npm ci

COPY backend/ .
COPY webapp/ ./webapp/

# Neon = Postgres: trocar SQLite local pelo schema de produção antes do generate
RUN cp prisma/schema.postgres.prisma prisma/schema.prisma
RUN npx prisma generate
RUN npm run build
RUN ls -la dist/ && echo "Build OK"

EXPOSE 3000
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/src/main"]
