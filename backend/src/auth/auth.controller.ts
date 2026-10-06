import { Controller, Post, Body, UseGuards, Request } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('guest')
  guestLogin(@Body('name') name?: string) {
    return this.auth.guestLogin(name);
  }

  @Post('login')
  passwordLogin(
    @Body('phone') phone: string,
    @Body('password') password: string,
    @Body('role') role?: string,
    @Body('name') name?: string,
    @Body('profilePhoto') profilePhoto?: string,
  ) {
    return this.auth.loginOrRegister(phone, password, role, name, profilePhoto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('refresh-token')
  refreshToken(@Request() req) {
    return this.auth.refreshToken(req.user.id);
  }
}
