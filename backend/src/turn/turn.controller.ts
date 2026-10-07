import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

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

@UseGuards(JwtAuthGuard)
@Controller('turn')
export class TurnController {
  constructor(private config: ConfigService) {}

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
}
