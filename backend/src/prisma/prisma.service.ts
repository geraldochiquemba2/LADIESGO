import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { Pool } from 'pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    if (process.env.DATABASE_URL?.startsWith('file:')) {
      const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL });
      super({ adapter }); // SQLite local
    } else {
      // Pool pequeno: 1 instância Render free + Neon free. Poucas ligações
      // + idle curto ajudam a BD a adormecer (scale-to-zero) fora dos picos.
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });
      pool.on('error', (e) => console.warn('pg pool:', e.message?.slice(0, 120)));
      const adapter = new PrismaPg(pool);
      super({ adapter });
    }
  }

  async onModuleInit() {
    try {
      await this.$connect();
    } catch (e) {
      // Local dev sem base de dados: arranca na mesma, endpoints de DB falham até haver DATABASE_URL válida.
      console.warn('Database unavailable, running without DB:', (e as Error).message?.slice(0, 120));
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
