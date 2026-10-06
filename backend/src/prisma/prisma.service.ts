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
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
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
