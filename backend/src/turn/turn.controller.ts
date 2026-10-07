import { Body, Controller, ForbiddenException, Get, NotFoundException, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

// GET /api/v1/turn/ice — o frontend busca o ICE aqui em vez de embutir
// username/password. Usa as env vars METERED_DOMAIN + METERED_TURN_APIKEY
// (já configuradas no Render). Sem elas, devolve fallback demo.
const FALLBACK_ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  {
    urls: ['turn:openrelay.metered.ca:443?transport=tcp', 'turns:openrelay.metered.ca:443'],
    username: 'openrelay',
    credential: 'openrelay',
  },
];

// Quota grátis partilhada: 300MB ≈ 0,6 MB/min de voz → 500 min/mês.
// Cada chamada limitada a 2 min (120s) no frontend.
const MB_PER_MIN = 0.6;
const PER_CALL_SEC = 120;

export class CallLogDto {
  @IsString()
  @MaxLength(64)
  tripId!: string;

  @IsInt()
  @Min(0)
  @Max(3600)
  durationSec!: number;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  endedHow?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('turn')
export class TurnController {
  constructor(private config: ConfigService, private prisma: PrismaService) {}

  @Get('ice')
  async ice() {
    const domain = String(this.config.get('METERED_DOMAIN') || '')
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    const apiKey = String(this.config.get('METERED_TURN_APIKEY') || '').trim();
    if (!domain || !apiKey) return { iceServers: FALLBACK_ICE, demo: true };
    try {
      const r = await fetch(
        `https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`,
        { signal: AbortSignal.timeout(8000) },
      );
      const j: unknown = await r.json();
      if (!r.ok || !Array.isArray(j)) throw new Error('metered');
      return { iceServers: j, demo: false };
    } catch {
      return { iceServers: FALLBACK_ICE, demo: true };
    }
  }

  private budgetSec(): number {
    const mb = Number(this.config.get('METERED_FREE_MB')) || 300;
    return Math.floor((mb / MB_PER_MIN) * 60);
  }

  private monthStart(): Date {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  // GET /api/v1/turn/quota — tempo grátis restante (banner) + limite por chamada.
  @Get('quota')
  async quota() {
    const budget = this.budgetSec();
    const agg = await this.prisma.callLog.aggregate({
      where: { createdAt: { gte: this.monthStart() } },
      _sum: { durationSec: true },
    });
    const used = agg._sum.durationSec ?? 0;
    const remaining = Math.max(0, budget - used);
    return { remainingSec: remaining, budgetSec: budget, usedSec: used, perCallSec: PER_CALL_SEC, exhausted: remaining <= 0 };
  }

  // POST /api/v1/turn/log — regista a duração no fim de cada chamada.
  @Post('log')
  async log(@CurrentUser('id') userId: string, @Body() dto: CallLogDto) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: dto.tripId },
      include: { driver: { select: { userId: true } } },
    });
    if (!trip) throw new NotFoundException('Viagem não encontrada.');
    const ok = trip.passengerId === userId || (!!trip.driver && trip.driver.userId === userId);
    if (!ok) throw new ForbiddenException('Sem acesso a esta viagem.');
    await this.prisma.callLog.create({
      data: { tripId: dto.tripId, userId, durationSec: Math.min(3600, Math.max(0, Math.floor(dto.durationSec))) },
    });
    return this.quota();
  }
}
