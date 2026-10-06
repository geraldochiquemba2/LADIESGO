import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  // Nunca expor o hash da senha ao cliente.
  private withoutHash<T extends { passwordHash?: string | null }>(u: T) {
    const { passwordHash: _omit, ...safe } = u;
    return safe;
  }

  async guestLogin(name?: string) {
    // Crypto-random, collision-safe id (Math.random was predictable and could
    // collide at scale, silently logging a new user into an existing guest).
    const phone = `+guest${randomBytes(6).toString('hex')}`;
    const user = await this.prisma.user.create({
      data: { phone, role: 'PASSENGER', isVerified: true, name: name || 'Guest' },
    });
    const tokens = await this.generateTokens(user.id, user.phone, user.role);
    return { user: this.withoutHash(user), ...tokens };
  }

  async refreshToken(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    return this.generateTokens(user.id, user.phone, user.role);
  }

  // Número + senha. Se o número ainda não existe, cria a conta (registo
  // implícito) com o papel escolhido; se existe, valida a senha.
  async loginOrRegister(phone: string, password: string, role?: string) {
    const cleanPhone = (phone || '').trim();
    if (!cleanPhone || cleanPhone.length < 9) {
      throw new BadRequestException('Número de telefone inválido');
    }
    if (!password || password.length < 4) {
      throw new BadRequestException('A senha deve ter pelo menos 4 caracteres');
    }
    const wantedRole = role === 'DRIVER' ? 'DRIVER' : 'PASSENGER';

    const existing = await this.prisma.user.findUnique({ where: { phone: cleanPhone } });
    if (!existing) {
      const passwordHash = await bcrypt.hash(password, 10);
      const user = await this.prisma.user.create({
        data: { phone: cleanPhone, passwordHash, role: wantedRole, isVerified: true },
      });
      const tokens = await this.generateTokens(user.id, user.phone, user.role);
      return { user: this.withoutHash(user), ...tokens, isNew: true };
    }

    if (!existing.passwordHash || !(await bcrypt.compare(password, existing.passwordHash))) {
      throw new UnauthorizedException('Número ou senha incorretos');
    }
    const tokens = await this.generateTokens(existing.id, existing.phone, existing.role);
    return { user: this.withoutHash(existing), ...tokens, isNew: false };
  }

  private async generateTokens(userId: string, phone: string, role: string) {
    const payload = { sub: userId, phone, role };
    const accessToken = this.jwt.sign(payload, {
      expiresIn: this.config.get('JWT_EXPIRES_IN', '7d'),
    });
    return { accessToken };
  }
}
