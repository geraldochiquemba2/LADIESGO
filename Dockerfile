FROM node:20-alpine
WORKDIR /app

COPY backend/package*.json ./
# Lock gerado com npm 11: alinhar o npm do Docker (10 no node:20) ou o `ci` falha
# `install` em vez de `ci` para auto-curar entradas em falta; toolchain para prebuild do better-sqlite3 no musl
RUN apk add --no-cache python3 make g++ && npm i -g npm@11 && npm install

COPY backend/ .
COPY webapp/ ./webapp/

# Neon = Postgres: trocar SQLite local pelo schema de produção antes do generate
RUN cp prisma/schema.postgres.prisma prisma/schema.prisma
RUN npx prisma generate
RUN npm run build
RUN ls -la dist/ && echo "Build OK"

EXPOSE 3000
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/src/main"]
