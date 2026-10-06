import { Injectable, NotFoundException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const SEED_CODES = [
  { code: 'WELCOME50', label: '50% off — new user welcome gift', discountPct: 50, maxUses: 10000 },
  { code: 'FIRST30', label: '30% off your first ride', discountPct: 30, maxUses: 10000 },
  { code: 'TAXIAPP20', label: '20% off — app launch special', discountPct: 20, maxUses: 50000 },
  { code: 'RAMADAN25', label: '25% off during Ramadan', discountPct: 25, maxUses: 20000 },
];

@Injectable()
export class PromosService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    try {
      for (const c of SEED_CODES) {
        await this.prisma.promoCode.upsert({
          where: { code: c.code },
          create: c,
          update: {},
        });
      }
    } catch (e) {
      // Local dev sem base de dados: o seed falha mas o servidor arranca na mesma.
      console.warn('Promo seed skipped (no database):', (e as Error).message?.slice(0, 120));
    }
  }

  async validate(code: string) {
    const promo = await this.prisma.promoCode.findUnique({ where: { code: code.toUpperCase() } });
    if (!promo || !promo.isActive) throw new NotFoundException('Promo code not found or expired');
    if (promo.usedCount >= promo.maxUses) throw new BadRequestException('Promo code has reached its limit');
    if (promo.expiresAt && promo.expiresAt < new Date()) throw new BadRequestException('Promo code has expired');
    return { code: promo.code, discountPct: promo.discountPct, label: promo.label, id: promo.id };
  }

  async apply(id: string) {
    await this.prisma.promoCode.update({ where: { id }, data: { usedCount: { increment: 1 } } });
  }
}
