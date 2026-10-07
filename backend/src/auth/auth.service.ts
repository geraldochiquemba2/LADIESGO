import { Injectable, UnauthorizedException, BadRequestException, NotFoundException, ConflictException, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  // Conta admin via env (ADMIN_PHONE/ADMIN_PASSWORD): cria no arranque se não
  // existir. Sem estas vars, nada acontece — o painel continua a exigir login.
  async onModuleInit() {
    try {
      const phone = (this.config.get<string>('ADMIN_PHONE', '') || '').trim();
      const pass = this.config.get<string>('ADMIN_PASSWORD', '') || '';
      if (!phone || pass.length < 4) return;
      const existing = await this.prisma.user.findUnique({ where: { phone } });
      if (existing) {
        // Número já registado (ex. como PASSAGEIRA): promove a ADMIN sem mexer na senha.
        if (existing.role !== 'ADMIN') {
          await this.prisma.user.update({ where: { phone }, data: { role: 'ADMIN' } });
          console.log(`Conta ${phone} promovida a ADMIN`);
        }
        return;
      }
      await this.prisma.user.create({
        data: { phone, passwordHash: await bcrypt.hash(pass, 10), role: 'ADMIN', isVerified: true, name: 'Admin' },
      });
      console.log(`Conta admin criada para ${phone}`);
    } catch (e) {
      console.warn('Seed admin ignorado:', (e as Error).message?.slice(0, 120));
    }
  }

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

  // LOGIN: só entra quem já tem conta + senha. Número desconhecido falha.
  async login(phone: string, password: string) {
    const cleanPhone = (phone || '').trim();
    const existing = await this.prisma.user.findUnique({ where: { phone: cleanPhone } });
    if (!existing?.passwordHash || !(await bcrypt.compare(password || '', existing.passwordHash))) {
      throw new UnauthorizedException('Número ou senha incorretos');
    }
    const tokens = await this.generateTokens(existing.id, existing.phone, existing.role);
    return { user: this.withoutHash(existing), ...tokens, isNew: false };
  }

  // REGISTO explícito (Criar conta / admin). Número repetido falha.
  async register(phone: string, password: string, role?: string, name?: string, profilePhoto?: string) {
    const cleanPhone = (phone || '').trim();
    if (!cleanPhone || cleanPhone.length < 9) {
      throw new BadRequestException('Número de telefone inválido');
    }
    if (!password || password.length < 4) {
      throw new BadRequestException('A senha deve ter pelo menos 4 caracteres');
    }
    const wantedRole = role === 'DRIVER' ? 'DRIVER' : 'PASSENGER';
    const cleanName = (name || '').trim().slice(0, 60) || undefined;
    const cleanPhoto =
      typeof profilePhoto === 'string' && profilePhoto.startsWith('data:image/') && profilePhoto.length < 500000
        ? profilePhoto
        : undefined;

    const existing = await this.prisma.user.findUnique({ where: { phone: cleanPhone } });
    if (existing) {
      throw new ConflictException('Este número já está registado. Entra com a tua senha.');
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await this.prisma.user.create({
      data: {
        phone: cleanPhone, passwordHash, role: wantedRole, isVerified: true,
        ...(cleanName ? { name: cleanName } : {}),
        ...(cleanPhoto ? { profilePhoto: cleanPhoto } : {}),
      },
    });
    const tokens = await this.generateTokens(user.id, user.phone, user.role);
    return { user: this.withoutHash(user), ...tokens, isNew: true };
  }

  // Senha padrão das contas criadas pelo admin (motoristas). A app exige a
  // troca no primeiro login (mustChangePassword). Envs: DRIVER_DEFAULT_PASSWORD.
  private defaultDriverPassword() {
    return this.config.get<string>('DRIVER_DEFAULT_PASSWORD', '') || '0987654321';
  }

  // Admin cria conta de motorista: nome + número (+ documentos da viatura).
  // Com carta + matrícula, cria logo o perfil APROVADO (o admin verificou
  // os documentos) — a motorista entra direta, sem "em análise".
  // Sem documentos, cria só a conta e ela completa o registo na página.
  async adminCreateDriver(
    phone: string,
    name?: string,
    docs?: { licenseNumber?: string; carPlate?: string; carMake?: string; carModel?: string; carYear?: number; carColor?: string },
  ) {
    const digits = (phone || '').replace(/\D/g, '');
    const local = digits.startsWith('244') ? digits.slice(3) : digits;
    if (!/^9[123459]\d{7}$/.test(local)) {
      throw new BadRequestException('Número angolano inválido: 9XX XXX XXX.');
    }
    const cleanName = (name || '').trim().slice(0, 60);
    if (cleanName.length < 2) throw new BadRequestException('Nome da motorista inválido.');
    const cleanPhone = `+244${local}`;
    const existing = await this.prisma.user.findUnique({ where: { phone: cleanPhone } });
    if (existing) throw new ConflictException('Este número já está registado.');
    const user = await this.prisma.user.create({
      data: {
        phone: cleanPhone,
        passwordHash: await bcrypt.hash(this.defaultDriverPassword(), 10),
        role: 'DRIVER',
        name: cleanName,
        isVerified: true,
        mustChangePassword: true,
      },
    });
    const lic = (docs?.licenseNumber || '').trim().slice(0, 30);
    const plate = (docs?.carPlate || '').trim().slice(0, 12);
    if (lic && plate) {
      const year = docs?.carYear;
      if (year !== undefined && (!Number.isInteger(year) || year < 1990 || year > new Date().getFullYear() + 1)) {
        throw new BadRequestException('Ano da viatura inválido.');
      }
      try {
        await this.prisma.driver.create({
          data: {
            userId: user.id,
            licenseNumber: lic,
            carPlate: plate,
            carMake: (docs?.carMake || '').trim().slice(0, 40) || null,
            carModel: (docs?.carModel || '').trim().slice(0, 40) || null,
            carYear: year ?? null,
            carColor: (docs?.carColor || '').trim().slice(0, 20) || null,
            status: 'APPROVED',
          },
        });
      } catch (e: any) {
        if (e?.code === 'P2002') {
          throw new ConflictException('Conta criada, mas carta ou matrícula já registadas.');
        }
        throw e;
      }
    }
    return { user: this.withoutHash(user) };
  }

  // Admin repõe a senha para a padrão (força troca no próximo login).
  async resetPassword(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Utilizador não encontrado.');
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await bcrypt.hash(this.defaultDriverPassword(), 10),
        mustChangePassword: true,
      },
    });
    return { success: true };
  }

  // A própria utilizadora define nova senha (banner do primeiro login).
  async changePassword(userId: string, newPassword: string) {
    if (!newPassword || newPassword.length < 4) {
      throw new BadRequestException('A senha deve ter pelo menos 4 caracteres.');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: false },
    });
    return { success: true };
  }

  private async generateTokens(userId: string, phone: string, role: string) {
    const payload = { sub: userId, phone, role };
    const accessToken = this.jwt.sign(payload, {
      expiresIn: this.config.get('JWT_EXPIRES_IN', '7d'),
    });
    return { accessToken };
  }
}
